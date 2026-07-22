import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyPatch,
  assertCleanCheckout,
  calculateStageDelta,
  captureBinaryPatch,
  changedPaths,
  createCheckpointCommit,
  createWorktree,
  currentHead,
  ensureGitRepository,
  git,
  isIgnorableDirtyPath,
  isRuntimePath,
  removeWorktree,
  repositoryRoot,
  runValidationCommands,
  sha256,
  snapshotChangedPathStates,
  stageAndCommitOwnedPaths,
} from "./git.ts";
import { assertPathCovered, isHighRiskPath, normalizeRepoPath } from "./paths.ts";
import {
  findingsFromReview,
  formatOpenFindings,
  markFindingsResolved,
  normalizeReview,
  openBlockingFindings,
  synthesizeReviews,
} from "./review.ts";
import { buildDecisionPrompt, decisionRequestFromReview, parseDecision } from "./decision.ts";
import { hashContract } from "./contract.ts";
import { isStagnant } from "./stagnation.ts";
import { spawnResearchHook } from "./research-hook.ts";
import {
  appendRunEvent,
  atomicWriteJson,
  initializeRunStorage,
  loadRunState,
  persistFinding,
  runRoot,
  writeArtifact,
  writeRunState,
} from "./store.ts";
import { assertValidManifest } from "./validation.ts";
import { DynamicWorkflowBackend } from "./dynamic-backend.ts";
import type {
  AgentBackend,
  AgentRequest,
  AttemptRecord,
  DecisionRecord,
  DecisionRequest,
  Finding,
  NormalizedReview,
  RunState,
  StageRunState,
  TripManifest,
  TripStage,
  ValidationResult,
} from "./types.ts";

export interface RunOptions {
  manifestPath: string;
  humanDecisions?: boolean;
  backend?: AgentBackend;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
}

export interface ResumeOptions {
  repositoryRoot: string;
  runId: string;
  /** Generation token captured from state.lease.generation before the resume call.
   * A stale token returns the current state without side effects. */
  leaseGeneration?: number;
  backend?: AgentBackend;
  onEvent?: RunOptions["onEvent"];
}

interface RunnerContext {
  repositoryRoot: string;
  workingDirectory: string;
  packageRelative: string;
  manifestPath: string;
  manifest: TripManifest;
  backend: AgentBackend;
  state: RunState;
  onEvent?: RunOptions["onEvent"];
  /** Output from prior research/readonly stages, injected into implementation prompts. */
  researchOutput?: string;
}

class PauseRun extends Error {
  kind: NonNullable<RunState["pauseKind"]>;
  stageId: string;

  constructor(kind: NonNullable<RunState["pauseKind"]>, stageId: string, message: string) {
    super(message);
    this.kind = kind;
    this.stageId = stageId;
  }
}

export async function runManifestFile(options: RunOptions): Promise<RunState> {
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = assertValidManifest(JSON.parse(await readFile(manifestPath, "utf8")) as TripManifest);
  await ensureGitRepository(manifest.workingDirectory);
  const repository = await repositoryRoot(manifest.workingDirectory);
  const resolvedWorkingDirectory = await realpath(manifest.workingDirectory);
  const packageRelative = path.relative(repository, resolvedWorkingDirectory);
  if (packageRelative === ".." || packageRelative.startsWith(`..${path.sep}`)) {
    throw new Error(`workingDirectory must be inside its Git repository: ${manifest.workingDirectory}`);
  }
  await assertCleanCheckout(repository);
  const baseRevision = await currentHead(repository);
  const now = new Date().toISOString();
  const id = `trip-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const stageStates = Object.fromEntries(manifest.stages.map((stage) => [stage.id, newStageState(stage.id)]));
  const state: RunState = {
    formatVersion: 1,
    id,
    manifestPath,
    manifest,
    status: "pending",
    baseRevision,
    decisionMode: options.humanDecisions ? "human" : manifest.settings?.decisionPolicy?.mode ?? "agent",
    createdAt: now,
    updatedAt: now,
    abortRequested: false,
    stageStates,
    findings: [],
    decisionRequests: [],
    decisions: [],
    lease: {
      owner: id,
      generation: 1,
      heartbeatAt: now,
      // 120 s — long enough for a slow stage turn, short enough to detect dead runs
      leaseTimeoutMs: 120_000,
    },
  };
  await initializeRunStorage(repository, id);
  await atomicWriteJson(path.join(runRoot(repository, id), "manifest.json"), manifest);
  await writeRunState(repository, state);
  return await execute({
    repositoryRoot: repository,
    workingDirectory: manifest.workingDirectory,
    packageRelative,
    manifestPath,
    manifest,
    backend: options.backend ?? backendForManifest(manifest),
    state,
    onEvent: options.onEvent,
  });
}

export async function resumeRun(options: ResumeOptions): Promise<RunState> {
  const repository = path.resolve(options.repositoryRoot);
  const state = await loadRunState(repository, options.runId);
  const manifest = assertValidManifest(state.manifest);
  if (state.status === "completed" || state.status === "aborted") return state;
  // Stale generation check: a caller with an outdated lease token gets the current
  // state back without any side effects (verbatim from pi-codex-goal pattern).
  if (options.leaseGeneration !== undefined && state.lease && state.lease.generation !== options.leaseGeneration) {
    return state;
  }
  // Bump lease generation on successful resumption
  if (state.lease) {
    state.lease.generation += 1;
    state.lease.heartbeatAt = new Date().toISOString();
  }
  await reconcileInterruptedStages(repository, state);
  state.status = "pending";
  state.pauseKind = undefined;
  state.pauseReason = undefined;
  await writeRunState(repository, state);
  return await execute({
    repositoryRoot: repository,
    workingDirectory: manifest.workingDirectory,
    packageRelative: path.relative(repository, manifest.workingDirectory),
    manifestPath: state.manifestPath,
    manifest,
    backend: options.backend ?? backendForManifest(manifest),
    state,
    onEvent: options.onEvent,
  });
}

export async function requestAbort(repositoryRootInput: string, runId: string): Promise<RunState> {
  const repository = path.resolve(repositoryRootInput);
  const state = await loadRunState(repository, runId);
  state.abortRequested = true;
  await writeRunState(repository, state);
  await appendRunEvent(repository, runId, { type: "run.abort.requested" });
  return state;
}

export async function recordHumanDecision(
  repositoryRootInput: string,
  runId: string,
  choice: string,
  rationale: string,
): Promise<RunState> {
  const repository = path.resolve(repositoryRootInput);
  const state = await loadRunState(repository, runId);
  const request = [...state.decisionRequests].reverse().find((entry) => !state.decisions.some((decision) => decision.requestId === entry.id && decision.actor === "human"));
  if (!request) throw new Error(`run ${runId} has no pending human decision`);
  const decision: DecisionRecord = {
    id: `decision-${randomUUID()}`,
    requestId: request.id,
    runId,
    stageId: request.stageId,
    actor: "human",
    status: "decided",
    choice,
    rationale,
    implementationDirection: choice,
    createdAt: new Date().toISOString(),
  };
  state.decisions.push(decision);
  const stageState = state.stageStates[request.stageId];
  if (stageState) {
    stageState.status = "paused";
    stageState.pauseReason = "Human decision recorded; resume will verify and continue the interrupted workspace.";
  }
  state.status = "pending";
  state.pauseKind = undefined;
  state.pauseReason = undefined;
  await atomicWriteJson(path.join(runRoot(repository, runId), "decisions", `${decision.id}.json`), decision);
  await appendRunEvent(repository, runId, { type: "decision.human.recorded", stageId: request.stageId, decisionId: decision.id });
  await writeRunState(repository, state);
  return state;
}

async function execute(context: RunnerContext): Promise<RunState> {
  const { state } = context;
  state.status = "running";
  state.startedAt ??= new Date().toISOString();
  await emit(context, "run.started", `Run ${state.id} started`);
  await writeRunState(context.repositoryRoot, state);

  try {
    while (true) {
      if (state.abortRequested) {
        state.status = "aborted";
        state.completedAt = new Date().toISOString();
        await emit(context, "run.aborted", `Run ${state.id} aborted at a durable boundary`);
        await writeRunState(context.repositoryRoot, state);
        return state;
      }
      const pending = context.manifest.stages.filter((stage) => state.stageStates[stage.id]?.status === "pending");
      if (!pending.length) {
        const failedRequired = context.manifest.stages.find((stage) => stage.required !== false && state.stageStates[stage.id]?.status === "failed");
        if (failedRequired) state.status = "failed";
        else if (Object.values(state.stageStates).some((entry) => entry.status === "paused")) state.status = "paused";
        else state.status = "completed";
        state.completedAt = new Date().toISOString();
        await emit(context, `run.${state.status}`, `Run ${state.id} ${state.status}`);
        await writeRunState(context.repositoryRoot, state);
        return state;
      }
      const ready = pending.filter((stage) => stage.needs.every((dependency) => state.stageStates[dependency]?.status === "completed"));
      if (!ready.length) {
        // Mark stages whose dependencies have failed or been skipped as skipped with
        // a typed schedulingReason — no plain Error thrown.
        const newlySkipped = pending.filter((stage) =>
          stage.needs.some((dep) => {
            const s = state.stageStates[dep]?.status;
            return s === "failed" || s === "skipped";
          }),
        );
        if (newlySkipped.length > 0) {
          for (const stage of newlySkipped) {
            const failedDeps = stage.needs.filter((dep) => {
              const s = state.stageStates[dep]?.status;
              return s === "failed" || s === "skipped";
            });
            const ss = requiredStageState(state, stage.id);
            ss.status = "skipped";
            ss.schedulingReason = { kind: "waiting_on_failed_dependency", dependencyId: failedDeps[0]! };
            ss.blockedBy = failedDeps;
            await emit(context, "stage.skipped", `Stage ${stage.id} skipped: dependency failed (${failedDeps.join(", ")})`, stage.id);
          }
          await writeRunState(context.repositoryRoot, context.state);
          continue;
        }
        // True deadlock — no stages can be scheduled
        const blockers = pending.map((stage) => `${stage.id} waits for ${stage.needs.filter((dep) => state.stageStates[dep]?.status !== "completed").join(", ")}`);
        state.status = "failed";
        state.pauseKind = "blocked";
        state.pauseReason = `Deadlock: no runnable stage remains:\n${blockers.join("\n")}`;
        await emit(context, "run.failed", state.pauseReason);
        await writeRunState(context.repositoryRoot, state);
        return state;
      }
      const serial = ready.find((stage) => stage.isolation === "same-checkout" || stage.type === "integration");
      if (serial) {
        await executeStage(context, serial);
      } else {
        const limit = context.manifest.settings?.maxParallel ?? 4;
        for (let index = 0; index < ready.length; index += limit) {
          const batch = ready.slice(index, index + limit);
          const outcomes = await Promise.allSettled(batch.map(async (stage) => await executeStage(context, stage)));
          const rejection = outcomes.find((outcome) => outcome.status === "rejected");
          if (rejection?.status === "rejected") throw rejection.reason;
        }
      }
      await writeRunState(context.repositoryRoot, state);
    }
  } catch (error) {
    if (error instanceof PauseRun) {
      state.status = "paused";
      state.pauseKind = error.kind;
      state.pauseReason = error.message;
      const stage = state.stageStates[error.stageId];
      if (stage) {
        stage.status = "paused";
        stage.pauseReason = error.message;
      }
      await emit(context, "run.paused", error.message, error.stageId);
      await writeRunState(context.repositoryRoot, state);
      return state;
    }
    state.status = "failed";
    state.pauseReason = errorMessage(error);
    await emit(context, "run.failed", errorMessage(error));
    await writeRunState(context.repositoryRoot, state);
    return state;
  }
}

async function executeStage(context: RunnerContext, stage: TripStage): Promise<void> {
  const stageState = requiredStageState(context.state, stage.id);
  stageState.status = "running";
  stageState.startedAt ??= new Date().toISOString();
  await emit(context, "stage.started", `Stage ${stage.id} started`, stage.id);
  await writeRunState(context.repositoryRoot, context.state);
  try {
    if (stage.type === "review") await runReadonlyStage(context, stage, stageState);
    else if (stage.type === "implementation") await runWriterStage(context, stage, stageState, false);
    else await runIntegrationStage(context, stage, stageState);
    stageState.status = "completed";
    stageState.completedAt = new Date().toISOString();
    await emit(context, "stage.completed", `Stage ${stage.id} completed`, stage.id);
  } catch (error) {
    if (error instanceof PauseRun) throw error;
    stageState.status = "failed";
    stageState.pauseReason = errorMessage(error);
    await emit(context, "stage.failed", `Stage ${stage.id} failed: ${errorMessage(error)}`, stage.id);
    if (stage.required !== false || context.manifest.settings?.failFast) throw error;
  } finally {
    await writeRunState(context.repositoryRoot, context.state);
  }
}

async function runReadonlyStage(context: RunnerContext, stage: TripStage, stageState: StageRunState): Promise<void> {
  const attemptNum = stageState.attempts.length + 1;
  const artifactDirectory = attemptDirectory(context, stage.id, attemptNum, "research");
  const startedAt = new Date().toISOString();
  const result = await context.backend.run(agentRequest(context, stage, "research", context.workingDirectory, stage.prompt, artifactDirectory));
  if (!result.success) throw new Error(result.error ?? "readonly agent failed");
  stageState.lastAgentOutput = result.text;
  await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/result.md`, result.text);
  // Record a minimal research attempt
  stageState.attempts.push({
    attempt: attemptNum,
    role: "research",
    validationResults: [],
    reviewVerdict: emptyReview(),
    diffHash: "",
    asi: {},
    status: "keep",
    startedAt,
    completedAt: new Date().toISOString(),
  });
  // Capture research output for injection into dependent implementation prompts
  if (!context.researchOutput) context.researchOutput = result.text;
}

async function runWriterStage(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  integration: boolean,
): Promise<void> {
  const attemptHistory = stageState.attempts;
  let attemptNum = attemptHistory.length;

  const location = await writerLocation(context, stage, stageState);
  const gitRoot = location.gitRoot;
  const agentCwd = location.agentCwd;
  const initialHead = await currentHead(gitRoot);
  if (stage.isolation === "worktree" && initialHead !== context.state.baseRevision) {
    throw new Error(`worktree ${stage.id} is not at the immutable run base revision`);
  }
  const stageStart = await snapshotChangedPathStates(gitRoot);

  // Hash the stage contract at start (Slice 7)
  stageState.contractHash = hashContract(stage);

  // Determine initial prompt, injecting research output for first attempt
  let nextPrompt = attemptNum > 0
    ? recoveryPrompt(stage, latestDecisionDirection(context.state, stage.id))
    : injectResearch(stage.prompt, context.researchOutput);

  const maximumRounds = context.manifest.settings?.reviewPolicy?.maxRepairRounds ?? 4;
  const maxConsecutiveFailures = context.manifest.settings?.continuationPolicy?.maxConsecutiveFailures ?? 5;
  // Counts consecutive non-completing attempts (discards + checks_failed).
  // Reset when the stage passes validation (any real progress). Crashes throw
  // immediately and bypass this counter.
  let consecutiveNonProgress = 0;
  // Track whether we've already triggered a research escalation for this stage
  let researchEscalated = false;

  while (stageState.reviewRounds <= maximumRounds) {
    if (consecutiveNonProgress >= maxConsecutiveFailures) {
      throw new PauseRun("review_blocked", stage.id, `Stage ${stage.id} paused after ${maxConsecutiveFailures} consecutive non-completing attempts.`);
    }
    if (context.state.abortRequested) throw new PauseRun("blocked", stage.id, "Abort requested; stopped before the next agent attempt.");

    attemptNum += 1;
    const role: AgentRequest["role"] = integration ? "integration" : attemptNum === 1 ? "implementation" : "repair";
    const beforeAttempt = await snapshotChangedPathStates(gitRoot);
    const headBefore = await currentHead(gitRoot);
    const attemptStartedAt = new Date().toISOString();
    const artifactDirectory = attemptDirectory(context, stage.id, attemptNum, role);
    const result = await context.backend.run(agentRequest(context, stage, role, agentCwd, nextPrompt, artifactDirectory));
    stageState.lastAgentOutput = result.text;
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/agent-response.md`, result.text || result.error || "");

    if (!result.success) {
      // Agent execution failed (infrastructure/crash) — fail immediately.
      // Record a crash attempt for history, then propagate the error so
      // executeStage can handle required vs non-required stage failure.
      const crashRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: [],
        reviewVerdict: emptyReview(),
        diffHash: "",
        asi: { error: result.error },
        status: "crash",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      };
      attemptHistory.push(crashRecord);
      throw new Error(result.error ?? `${role} agent failed`);
    }

    const headAfter = await currentHead(gitRoot);
    if (headAfter !== headBefore) throw new Error(`agent created a direct commit in ${stage.id}; the runtime is the only commit authority`);
    const attemptDelta = await calculateStageDelta(gitRoot, beforeAttempt);
    enforcePathContract(context, stage, attemptDelta.changedDuring);

    const workerReview = normalizeReview(result.text);
    if (workerReview.status !== "complete") {
      const direction = await handleNonCompleteVerdict(context, stage, stageState, workerReview, "worker", agentCwd);
      const diffHash = sha256(await captureBinaryPatch(gitRoot));
      const discardRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: stageState.validationResults,
        reviewVerdict: workerReview,
        diffHash,
        asi: { source: "worker" },
        status: "discard",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      };
      attemptHistory.push(discardRecord);
      consecutiveNonProgress++;
      stageState.reviewRounds += 1;
      if (stageState.reviewRounds > maximumRounds) {
        const escalated = await tryResearchEscalation(context, stage, stageState, agentCwd, attemptHistory, researchEscalated);
        if (escalated) { researchEscalated = true; stageState.reviewRounds = 0; consecutiveNonProgress = 0; nextPrompt = escalated; await writeRunState(context.repositoryRoot, context.state); continue; }
        throw new PauseRun("review_blocked", stage.id, `Stage ${stage.id} exhausted ${maximumRounds} repair rounds with unresolved feedback.`);
      }
      nextPrompt = repairPrompt(stage, context.state, direction);
      await writeRunState(context.repositoryRoot, context.state);
      continue;
    }

    await verifyOutputs(agentCwd, stage.outputs ?? []);
    const validation = await validateStage(context, stage, stageState, agentCwd, integration);
    if (!validationPassed(validation)) {
      const finding = validationFinding(context, stage, stageState, validation);
      await addFinding(context, finding);
      const diffHash = sha256(await captureBinaryPatch(gitRoot));
      const checksFailedRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: validation,
        reviewVerdict: emptyReview(),
        diffHash,
        asi: { source: "deterministic-validation" },
        status: "checks_failed",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      };
      attemptHistory.push(checksFailedRecord);
      consecutiveNonProgress++;
      stageState.reviewRounds += 1;
      if (stageState.reviewRounds > maximumRounds) {
        const escalated = await tryResearchEscalation(context, stage, stageState, agentCwd, attemptHistory, researchEscalated);
        if (escalated) { researchEscalated = true; stageState.reviewRounds = 0; consecutiveNonProgress = 0; nextPrompt = escalated; await writeRunState(context.repositoryRoot, context.state); continue; }
        throw new PauseRun("review_blocked", stage.id, `Stage ${stage.id} validation remained red after ${maximumRounds} repair rounds.`);
      }
      nextPrompt = repairPrompt(stage, context.state, "Fix the deterministic validation failures exactly; do not expand scope.");
      continue;
    }

    const reviews = await runReviewers(context, stage, stageState, agentCwd, validation, integration);
    const synthesis = synthesizeReviews(reviews);
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/review-synthesis.json`, `${JSON.stringify(synthesis, null, 2)}\n`);

    if (synthesis.status === "complete" && !synthesis.findings.some((finding) => finding.blocking)) {
      const finalDelta = await calculateStageDelta(gitRoot, stageStart);
      enforcePathContract(context, stage, finalDelta.changedDuring);
      stageState.changedPaths = finalDelta.changedDuring;
      // Capture the patch once; reuse for diffHash and for the artifact in persistWriterBoundary.
      const verifiedPatch = await captureBinaryPatch(gitRoot);
      const diffHash = sha256(verifiedPatch);
      const keepRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: validation,
        reviewVerdict: synthesis,
        diffHash,
        asi: { source: "ensemble-review" },
        status: "keep",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      };
      attemptHistory.push(keepRecord);
      markFindingsResolved(context.state.findings, stage.id, {
        repairAttempt: attemptNum,
        changedPaths: finalDelta.changedDuring,
        validationArtifact: `stages/${stage.id}/attempt-${attemptNum}/validation.json`,
        reviewArtifact: `stages/${stage.id}/attempt-${attemptNum}/review-synthesis.json`,
        actor: "fresh-reviewer-ensemble",
      });
      for (const finding of context.state.findings.filter((entry) => entry.stageId === stage.id && entry.disposition === "resolved")) {
        await persistFinding(context.repositoryRoot, finding);
      }
      if (openBlockingFindings(context.state.findings, stage.id).length) {
        throw new Error(`stage ${stage.id} cannot complete with unresolved blocking findings`);
      }
      consecutiveNonProgress = 0;
      await persistWriterBoundary(context, stage, stageState, gitRoot, attemptNum, verifiedPatch);
      return;
    }

    const direction = await handleNonCompleteVerdict(context, stage, stageState, synthesis, integration ? "integration-review" : "independent-review", agentCwd);
    const diffHash = sha256(await captureBinaryPatch(gitRoot));
    const reviewDiscardRecord: AttemptRecord = {
      attempt: attemptNum,
      role,
      validationResults: validation,
      reviewVerdict: synthesis,
      diffHash,
      asi: { source: integration ? "integration-review" : "independent-review" },
      status: "discard",
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      contractHash: stageState.contractHash,
    };
    attemptHistory.push(reviewDiscardRecord);
      consecutiveNonProgress++;
      stageState.reviewRounds += 1;
      if (stageState.reviewRounds > maximumRounds) {
        const escalated = await tryResearchEscalation(context, stage, stageState, agentCwd, attemptHistory, researchEscalated);
        if (escalated) { researchEscalated = true; stageState.reviewRounds = 0; consecutiveNonProgress = 0; nextPrompt = escalated; await writeRunState(context.repositoryRoot, context.state); continue; }
        throw new PauseRun("review_blocked", stage.id, `Stage ${stage.id} exhausted ${maximumRounds} repair rounds with unresolved review findings.`);
      }
    nextPrompt = repairPrompt(stage, context.state, direction);
  }
  throw new PauseRun("review_blocked", stage.id, `Stage ${stage.id} did not reach a verified completion boundary.`);
}

async function runIntegrationStage(context: RunnerContext, stage: TripStage, stageState: StageRunState): Promise<void> {
  if (stage.integrationStrategy === "worktree-fan-in") {
    await assertCleanCheckout(context.repositoryRoot);
    for (const writer of context.manifest.stages.filter((entry) => entry.type === "implementation" && entry.isolation === "worktree")) {
      const writerState = requiredStageState(context.state, writer.id);
      if (!writerState.patchPath || !writerState.patchSha256) throw new Error(`writer ${writer.id} has no verified patch artifact`);
      const patch = await readFile(writerState.patchPath);
      if (sha256(patch) !== writerState.patchSha256) throw new Error(`writer patch hash mismatch: ${writer.id}`);
      await applyPatch(context.repositoryRoot, patch);
      await emit(context, "integration.patch.applied", `Applied verified patch from ${writer.id}`, stage.id);
    }
  }

  await runWriterStage(context, stage, stageState, true);
  const finalPaths = (await changedPaths(context.repositoryRoot))
    .filter((value) => !isRuntimePath(value))
    .filter((value) => !isStrayIgnorablePath(context, stage, value));
  enforcePathContract(context, stage, finalPaths);
  const journalPath = path.join(runRoot(context.repositoryRoot, context.state.id), "integration", "journal.json");
  await atomicWriteJson(journalPath, {
    version: 1,
    status: "prepared",
    runId: context.state.id,
    stageId: stage.id,
    baseRevision: context.state.baseRevision,
    changedPaths: finalPaths,
    preparedAt: new Date().toISOString(),
  });
  if (context.manifest.settings?.autoCommit !== false && finalPaths.length) {
    const commit = await stageAndCommitOwnedPaths(
      context.repositoryRoot,
      finalPaths,
      context.manifest.settings?.commitMessage ?? `feat: ${context.manifest.name}`,
      {
        "Durable-Trip-Run": context.state.id,
        "Durable-Trip-Stage": stage.id,
        "Durable-Trip-Base": context.state.baseRevision,
      },
    );
    context.state.resultCommit = commit;
    await atomicWriteJson(journalPath, {
      version: 1,
      status: "complete",
      runId: context.state.id,
      stageId: stage.id,
      baseRevision: context.state.baseRevision,
      changedPaths: finalPaths,
      resultCommit: commit,
      completedAt: new Date().toISOString(),
    });
  }
  for (const writerState of Object.values(context.state.stageStates)) {
    if (writerState.worktreePath) {
      try {
        await removeWorktree(context.repositoryRoot, writerState.worktreePath);
        writerState.worktreePath = undefined;
      } catch (error) {
        await emit(context, "worktree.cleanup.failed", `Preserved worktree ${writerState.worktreePath}: ${errorMessage(error)}`, writerState.id);
      }
    }
  }
}

async function handleNonCompleteVerdict(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  review: NormalizedReview,
  source: Finding["source"],
  agentCwd: string,
): Promise<string> {
  const findings = findingsFromReview(review, {
    runId: context.state.id,
    stageId: stage.id,
    attempt: stageState.attempts.length,
    source,
  });
  for (const finding of findings) await addFinding(context, finding);
  if (review.status === "blocked") {
    throw new PauseRun("blocked", stage.id, `Stage ${stage.id} is blocked: ${review.rationale}`);
  }
  if (review.status === "needs_decision") {
    return await resolveDecision(context, stage, review, agentCwd);
  }
  return review.recommendedFollowupPrompt ?? "Address every open blocking finding, then rerun validation and review.";
}

async function resolveDecision(
  context: RunnerContext,
  stage: TripStage,
  review: NormalizedReview,
  agentCwd: string,
): Promise<string> {
  const pendingHuman = [...context.state.decisions].reverse().find((decision) => decision.stageId === stage.id && decision.actor === "human" && decision.status === "decided");
  if (pendingHuman) return pendingHuman.implementationDirection ?? pendingHuman.choice ?? pendingHuman.rationale;

  const request = decisionRequestFromReview(review, {
    runId: context.state.id,
    stageId: stage.id,
    findings: context.state.findings,
  });
  context.state.decisionRequests.push(request);
  await atomicWriteJson(path.join(runRoot(context.repositoryRoot, context.state.id), "decisions", `${request.id}.json`), request);
  await appendRunEvent(context.repositoryRoot, context.state.id, { type: "decision.requested", stageId: stage.id, requestId: request.id });
  const maximum = context.manifest.settings?.decisionPolicy?.maxDecisionRounds ?? 2;
  let recommendation: DecisionRecord | undefined;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const artifactDirectory = attemptDirectory(context, stage.id, attempt, "decision");
    const prompt = buildDecisionPrompt(request, decisionContext(context, stage));
    const result = await context.backend.run(agentRequest(context, stage, "decision", agentCwd, prompt, artifactDirectory, ["read", "grep", "find", "ls"]));
    if (!result.success) continue;
    recommendation = parseDecision(result.text, request, "agent");
    if (recommendation) break;
  }
  if (!recommendation) throw new PauseRun("blocked", stage.id, `Decision agent could not produce a valid decision after ${maximum} attempts.`);
  context.state.decisions.push(recommendation);
  await atomicWriteJson(path.join(runRoot(context.repositoryRoot, context.state.id), "decisions", `${recommendation.id}.json`), recommendation);
  await appendRunEvent(context.repositoryRoot, context.state.id, { type: "decision.agent.recorded", stageId: stage.id, decisionId: recommendation.id, status: recommendation.status });
  if (recommendation.status === "blocked") throw new PauseRun("blocked", stage.id, recommendation.rationale);
  if (context.state.decisionMode === "human") {
    throw new PauseRun("decision_pending", stage.id, `Human decision required. Agent recommendation: ${recommendation.choice ?? recommendation.implementationDirection ?? recommendation.rationale}`);
  }
  return recommendation.implementationDirection ?? recommendation.choice ?? recommendation.rationale;
}

async function validateStage(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  cwd: string,
  integration: boolean,
): Promise<ValidationResult[]> {
  const commands = unique([
    ...(stage.validationCommands?.length ? stage.validationCommands : context.manifest.settings?.defaultValidationCommands ?? []),
    ...(integration ? context.manifest.settings?.finalValidationCommands ?? [] : []),
  ]);
  const results = await runValidationCommands(cwd, commands, context.manifest.settings?.commandTimeoutMs ?? 15 * 60_000);
  stageState.validationResults = results;
  await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${stageState.attempts}/validation.json`, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

async function runReviewers(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  cwd: string,
  validation: ValidationResult[],
  integration: boolean,
): Promise<NormalizedReview[]> {
  if (context.manifest.settings?.reviewPolicy?.required === false) return [normalizeReview("<status>complete</status><risk>low</risk><rationale>Review disabled by manifest policy.</rationale>")];
  const count = context.manifest.settings?.reviewPolicy?.reviewerCount ?? 2;
  const open = openBlockingFindings(context.state.findings, stage.id);
  const angles = [
    "correctness, plan conformance, and user-visible regressions",
    "tests, failure behavior, edge cases, and unnecessary complexity",
    "security, architecture, resource cleanup, and operational risk",
  ];
  return await Promise.all(Array.from({ length: count }, async (_, index) => {
    const prompt = reviewPrompt(context, stage, validation, open, angles[index % angles.length] ?? "correctness", integration);
    const currentAttemptCount = stageState.attempts.length;
    const artifactDirectory = attemptDirectory(context, stage.id, currentAttemptCount, `reviewer-${index + 1}`);
    const result = await context.backend.run(agentRequest(context, stage, "review", cwd, prompt, artifactDirectory, ["read", "grep", "find", "ls"]));
    const review = result.success
      ? normalizeReview(result.text)
      : normalizeReview(`<status>blocked</status><risk>high</risk><rationale>Reviewer session failed: ${escapeXml(result.error ?? "unknown error")}</rationale>`);
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${currentAttemptCount}/review-${index + 1}.json`, `${JSON.stringify(review, null, 2)}\n`);
    return review;
  }));
}

async function persistWriterBoundary(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  gitRoot: string,
  attemptNum: number,
  /** Pre-captured binary patch buffer from the verified stage — avoids a redundant git-diff call. */
  patch: Buffer,
): Promise<void> {
  const relative = `stages/${stage.id}/${stage.isolation === "worktree" ? "patch.diff" : "cumulative.patch.diff"}`;
  const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, relative, patch);
  const digest = sha256(patch);
  if (stage.isolation === "worktree") {
    stageState.patchPath = patchPath;
    stageState.patchSha256 = digest;
  } else {
    stageState.cumulativePatchPath = patchPath;
    stageState.cumulativePatchSha256 = digest;
  }
  // Create a verified-stage checkpoint commit on a dedicated ref (Slice 6)
  try {
    const checkpointHash = await createCheckpointCommit(gitRoot, context.state.id, stage.id, {
      "Durable-Trip-Run": context.state.id,
      "Durable-Trip-Stage": stage.id,
      "Durable-Trip-Attempt": String(attemptNum),
      "Durable-Trip-Validation": `stages/${stage.id}/attempt-${attemptNum}/validation.json`,
      "Durable-Trip-Review": `stages/${stage.id}/attempt-${attemptNum}/review-synthesis.json`,
      "Durable-Trip-Diff-Hash": digest,
    });
    stageState.verifiedCommit = checkpointHash;
  } catch {
    // Checkpoint creation is best-effort; do not fail the stage boundary
  }
  await appendRunEvent(context.repositoryRoot, context.state.id, {
    type: "stage.boundary.persisted",
    stageId: stage.id,
    patchSha256: digest,
    changedPaths: stageState.changedPaths,
    verifiedCommit: stageState.verifiedCommit,
  });
  await writeRunState(context.repositoryRoot, context.state);
}

async function writerLocation(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
): Promise<{ gitRoot: string; agentCwd: string }> {
  if (stage.isolation !== "worktree") return { gitRoot: context.repositoryRoot, agentCwd: context.workingDirectory };
  if (!stageState.worktreePath) {
    stageState.worktreePath = await createWorktree(context.repositoryRoot, context.state.id, stage.id, context.state.baseRevision);
    await writeRunState(context.repositoryRoot, context.state);
  }
  return {
    gitRoot: stageState.worktreePath,
    agentCwd: context.packageRelative ? path.join(stageState.worktreePath, context.packageRelative) : stageState.worktreePath,
  };
}

function enforcePathContract(context: RunnerContext, stage: TripStage, repositoryRelativePaths: string[]): void {
  const allowed = (stage.allowedPaths ?? []).map((value) => withPackagePrefix(context.packageRelative, value));
  const violations = repositoryRelativePaths.filter((value) =>
    !isRuntimePath(value)
    && !isStrayIgnorablePath(context, stage, value)
    && !allowed.some((pattern) => assertPathCovered(value, [pattern])));
  if (violations.length) throw new Error(`stage ${stage.id} wrote outside its allowed path contract:\n${violations.map((value) => `- ${value}`).join("\n")}`);
}

// A stray plan/manifest artifact (a NON-high-risk .md/.json) that a stage touches
// outside its path contract must not sink the run: an agent jotting a scratch
// `plans/*.md` or emitting a stray `*.json` is off-task, not dangerous, so the
// runtime tolerates it — it is neither enforced against the writer contract nor
// swept into the scoped commit; it just sits ignored in the working tree. Stray
// SOURCE files (a `.ts` outside contract) and high-risk configs (package.json,
// tsconfig.json, lockfiles, migrations, schemas) still trip enforcePathContract,
// so the real guarantees hold. Mirrors the pre-run cleanliness relaxation
// (isIgnorableDirtyPath) at the writer and finalize boundaries.
function isStrayIgnorablePath(context: RunnerContext, stage: TripStage, value: string): boolean {
  if (!isIgnorableDirtyPath(value) || isHighRiskPath(value)) return false;
  const allowed = (stage.allowedPaths ?? []).map((pattern) => withPackagePrefix(context.packageRelative, pattern));
  return !allowed.some((pattern) => assertPathCovered(value, [pattern]));
}

async function verifyOutputs(cwd: string, outputs: string[]): Promise<void> {
  for (const output of outputs) {
    try {
      await access(path.join(cwd, normalizeRepoPath(output)));
    } catch {
      throw new Error(`declared output does not exist: ${output}`);
    }
  }
}

async function addFinding(context: RunnerContext, finding: Finding): Promise<void> {
  const duplicate = context.state.findings.find((entry) => entry.stageId === finding.stageId
    && entry.disposition === "open"
    && entry.summary.toLowerCase() === finding.summary.toLowerCase());
  if (duplicate) {
    duplicate.evidence = `${duplicate.evidence}\n\nRepeated evidence:\n${finding.evidence}`;
    duplicate.updatedAt = new Date().toISOString();
    await persistFinding(context.repositoryRoot, duplicate);
    return;
  }
  context.state.findings.push(finding);
  await persistFinding(context.repositoryRoot, finding);
  await writeRunState(context.repositoryRoot, context.state);
}

function validationFinding(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  results: ValidationResult[],
): Finding {
  const failed = results.find((result) => result.exitCode !== 0);
  const now = new Date().toISOString();
  return {
    id: `finding-${randomUUID()}`,
    runId: context.state.id,
    stageId: stage.id,
    attempt: stageState.attempts.length,
    source: "deterministic-validation",
    severity: "major",
    blocking: true,
    summary: failed ? `Validation failed: ${failed.command}` : "Validation did not pass",
    evidence: failed ? `${failed.stdout}\n${failed.stderr}`.trim() : JSON.stringify(results),
    suggestedRemediation: "Fix the validation failure without expanding the approved scope, then rerun the exact command.",
    affectedPaths: stageState.changedPaths,
    disposition: "open",
    createdAt: now,
    updatedAt: now,
  };
}

function repairPrompt(stage: TripStage, state: RunState, direction: string): string {
  const findings = openBlockingFindings(state.findings, stage.id);
  const decision = latestDecisionDirection(state, stage.id);
  return `Repair the current frozen stage. Do not advance to other work and do not expand scope.

ORIGINAL STAGE
${stage.prompt}

OPEN BLOCKING FINDINGS
${formatOpenFindings(findings)}

DECISION DIRECTION
${decision ?? direction}

REQUIRED ACTION
${direction}

After repairing, run the targeted checks you can run. Do not commit. End with:
<status>complete|continue|blocked|needs_decision</status>
<risk>low|medium|high|critical</risk>
<rationale>what changed and why it addresses every open finding</rationale>
<missingItems>anything still unresolved</missingItems>
<recommendedFollowupPrompt>next action if not complete</recommendedFollowupPrompt>`;
}

function recoveryPrompt(stage: TripStage, decision: string | undefined): string {
  return `Recover and complete an interrupted stage. Partial edits are EXPECTED in the working tree — your own from an earlier attempt, and, in a shared checkout, in-contract changes from prior stages (schema, generated code, fixtures, helpers). Treat all of them as expected and in-contract: inspect them, build on them, and keep them. Do not revert them, do not treat them as foreign or "host-owned", and do not pause or block because they are present. Do not repeat already-completed work blindly.

${stage.prompt}

${decision ? `Previously resolved decision:\n${decision}\n` : ""}
Stay inside your allowed paths — editing any file that matches them is in-contract. Do not commit. Return the required structured status.`;
}

function reviewPrompt(
  context: RunnerContext,
  stage: TripStage,
  validation: ValidationResult[],
  open: Finding[],
  angle: string,
  integration: boolean,
): string {
  return `You are a fresh, read-only reviewer. You did not implement this change.

Review focus: ${angle}.
Review the actual Git diff, the approved stage, VISION.md, ARCHI.md, repository instructions, and deterministic evidence.
${integration ? "This is the aggregate integration review; verify all approved slices work together." : "This is a slice review."}

APPROVED STAGE
${stage.prompt}

OPEN FINDINGS THAT MUST BE EXPLICITLY CLOSED OR RETAINED
${formatOpenFindings(open)}

DETERMINISTIC VALIDATION
${validation.length ? validation.map((result) => `${result.exitCode === 0 ? "PASS" : "FAIL"}: ${result.command}`).join("\n") : "No commands were configured."}

Rules:
- A successful process exit is not proof of correctness.
- Inspect the real diff and cite concrete evidence.
- If any correction is needed, return continue and a blocking finding.
- If a product/architecture choice is needed, return needs_decision with options and a recommendation.
- Return blocked only for a hard policy, structural impossibility, or failed reviewer session.
- Return complete only when all acceptance criteria and every listed open finding are resolved.

Return exactly one status and zero or more findings:
<status>complete|continue|blocked|needs_decision</status>
<risk>low|medium|high|critical</risk>
<rationale>...</rationale>
<finding>
  <severity>critical|major|minor|suggestion</severity>
  <blocking>true|false</blocking>
  <summary>...</summary>
  <evidence>file:line and behavior</evidence>
  <remediation>...</remediation>
  <path>relative/path</path>
</finding>
<decisionQuestion>...</decisionQuestion>
<option><id>...</id>...</option>
<recommendedOption>...</recommendedOption>
<recommendationRationale>...</recommendationRationale>
<recommendedFollowupPrompt>...</recommendedFollowupPrompt>`;
}

function decisionContext(context: RunnerContext, stage: TripStage): string {
  return `Run: ${context.state.id}
Stage: ${stage.id}
Base revision: ${context.state.baseRevision}
Decision mode: ${context.state.decisionMode}
Allowed paths: ${(stage.allowedPaths ?? []).join(", ")}
Claimed paths: ${(stage.claimedPaths ?? []).join(", ")}
Open findings:
${formatOpenFindings(openBlockingFindings(context.state.findings, stage.id))}`;
}

function latestDecisionDirection(state: RunState, stageId: string): string | undefined {
  const decision = [...state.decisions].reverse().find((entry) => entry.stageId === stageId && entry.status === "decided");
  return decision?.implementationDirection ?? decision?.choice ?? decision?.rationale;
}

function agentRequest(
  context: RunnerContext,
  stage: TripStage,
  role: AgentRequest["role"],
  cwd: string,
  prompt: string,
  artifactDirectory: string,
  tools = stage.allowedTools ?? [],
): AgentRequest {
  return {
    runId: context.state.id,
    stageId: stage.id,
    role,
    cwd,
    prompt,
    tools,
    timeoutMs: context.manifest.settings?.sessionTimeoutMs ?? 30 * 60_000,
    artifactDirectory,
  };
}

function attemptDirectory(context: RunnerContext, stageId: string, attempt: number, kind: string): string {
  return path.join(runRoot(context.repositoryRoot, context.state.id), "stages", stageId, `attempt-${attempt}`, kind);
}

function validationPassed(results: ValidationResult[]): boolean {
  return results.every((result) => result.exitCode === 0 && !result.timedOut);
}

function newStageState(id: string): StageRunState {
  return {
    id,
    status: "pending",
    attempts: [],
    reviewRounds: 0,
    changedPaths: [],
    validationResults: [],
  };
}

/** Returns an empty NormalizedReview for crash/pre-review attempt records. */
function emptyReview(): import("./types.ts").NormalizedReview {
  return {
    status: "continue",
    risk: "medium",
    rationale: "",
    missingItems: [],
    findings: [],
    raw: "",
    malformed: false,
  };
}

/**
 * Injects research stage output into an implementation prompt so that dependent
 * stages receive the initial research context (closes the research-injection gap).
 */
function injectResearch(prompt: string, researchOutput: string | undefined): string {
  if (!researchOutput) return prompt;
  return `${prompt}\n\nRESEARCH CONTEXT\nThe following research was gathered by the research stage and should inform your implementation:\n${researchOutput}`;
}

/**
 * Attempts to escalate the repair loop via the configured research hook when the
 * stage is stagnant. Returns a new nextPrompt string with research context injected
 * if escalation succeeds, or undefined if escalation should not be attempted.
 */
async function tryResearchEscalation(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  agentCwd: string,
  attemptHistory: AttemptRecord[],
  alreadyEscalated: boolean,
): Promise<string | undefined> {
  if (alreadyEscalated) return undefined;
  const policy = context.manifest.settings?.researchPolicy;
  if (!policy?.hookCommand) return undefined;
  if (!isStagnant(attemptHistory)) return undefined;
  const hookResult = await spawnResearchHook(
    policy.hookCommand,
    agentCwd,
    policy.timeoutMs ?? 30_000,
  );
  if (!hookResult.success) return undefined;
  const researchContext = [
    hookResult.steerMessage,
    hookResult.adaptationPlan,
    ...(hookResult.citations ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
  const open = openBlockingFindings(context.state.findings, stage.id);
  return `Research-informed repair. Use the research below to break through the current stagnation.\n\nRESEARCH OUTPUT\n${researchContext}\n\n${repairPrompt(stage, context.state, `Apply research insights to address the stagnant findings. Open findings:\n${formatOpenFindings(open)}`)}`;
}

function requiredStageState(state: RunState, id: string): StageRunState {
  const value = state.stageStates[id];
  if (!value) throw new Error(`missing state for stage ${id}`);
  return value;
}

async function reconcileInterruptedStages(repository: string, state: RunState): Promise<void> {
  const current = await currentHead(repository);
  const journalPath = path.join(runRoot(repository, state.id), "integration", "journal.json");
  const journal = await readOptionalJson(journalPath) as {
    status?: string;
    resultCommit?: string;
    stageId?: string;
  } | undefined;

  if (state.resultCommit && current === state.resultCommit) {
    state.status = "completed";
    state.completedAt ??= new Date().toISOString();
    return;
  }

  if (current !== state.baseRevision) {
    const message = await git(repository, ["log", "-1", "--format=%B"]);
    const belongsToRun = message.includes(`Durable-Trip-Run: ${state.id}`);
    const journalCommit = journal?.resultCommit;
    if ((journal?.status === "complete" && journalCommit === current) || (journal?.status === "prepared" && belongsToRun)) {
      state.resultCommit = current;
      const integration = state.manifest.stages.find((stage) => stage.type === "integration");
      if (integration) {
        const integrationState = state.stageStates[integration.id];
        if (integrationState) {
          integrationState.status = "completed";
          integrationState.completedAt ??= new Date().toISOString();
        }
      }
      state.status = "completed";
      state.completedAt ??= new Date().toISOString();
      await atomicWriteJson(journalPath, {
        version: 1,
        status: "complete",
        runId: state.id,
        stageId: integration?.id ?? journal?.stageId,
        baseRevision: state.baseRevision,
        resultCommit: current,
        reconciledAt: new Date().toISOString(),
      });
      await writeRunState(repository, state);
      return;
    }
    throw new Error(`repository HEAD moved from run base ${state.baseRevision} to ${current}; refusing unsafe resume`);
  }

  const interrupted = state.manifest.stages.filter((stage) => {
    const status = state.stageStates[stage.id]?.status;
    return status === "running" || status === "paused";
  });
  const interruptedSameCheckout = interrupted.filter((stage) => stage.isolation === "same-checkout");
  if (interruptedSameCheckout.length) {
    const currentPaths = (await changedPaths(repository)).filter((value) => !isRuntimePath(value) && !isIgnorableDirtyPath(value));
    const authorizedStages = state.manifest.stages.filter((stage) => {
      const status = state.stageStates[stage.id]?.status;
      return stage.isolation === "same-checkout" && (status === "completed" || status === "running" || status === "paused");
    });
    const allowed = authorizedStages.flatMap((stage) => (stage.allowedPaths ?? []).map((pattern) => withPackagePrefix(path.relative(repository, state.manifest.workingDirectory), pattern)));
    const violations = currentPaths.filter((value) => !allowed.some((pattern) => assertPathCovered(value, [pattern])));
    if (violations.length) throw new Error(`interrupted same-checkout workspace contains out-of-scope paths: ${violations.join(", ")}`);
  } else {
    const completed = state.manifest.stages
      .map((stage, index) => ({ stage, index, state: state.stageStates[stage.id] }))
      .filter((entry) => entry.stage.isolation === "same-checkout" && entry.stage.type === "implementation" && entry.state?.status === "completed" && entry.state.cumulativePatchSha256)
      .sort((a, b) => b.index - a.index)[0];
    if (completed?.state?.cumulativePatchSha256) {
      const currentPatch = await captureBinaryPatch(repository);
      if (sha256(currentPatch) !== completed.state.cumulativePatchSha256) {
        throw new Error(`same-checkout workspace drift detected after ${completed.stage.id}`);
      }
    }
  }

  for (const stage of interrupted) {
    const stageState = state.stageStates[stage.id];
    if (!stageState) continue;
    if (stageState.worktreePath) {
      const paths = (await changedPaths(stageState.worktreePath)).filter((value) => !isRuntimePath(value) && !isIgnorableDirtyPath(value));
      const allowed = stage.allowedPaths ?? [];
      const violations = paths.filter((value) => !allowed.some((pattern) => assertPathCovered(value, [withPackagePrefix(path.relative(repository, state.manifest.workingDirectory), pattern)])));
      if (violations.length) throw new Error(`interrupted worktree ${stage.id} contains out-of-scope paths: ${violations.join(", ")}`);
    }
    stageState.status = "pending";
    stageState.pauseReason = undefined;
  }
  await writeRunState(repository, state);
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function emit(context: RunnerContext, type: string, message: string, stageId?: string): Promise<void> {
  // Update lease heartbeat on every event (stage transitions)
  if (context.state.lease) {
    context.state.lease.heartbeatAt = new Date().toISOString();
  }
  await appendRunEvent(context.repositoryRoot, context.state.id, { type, message, stageId });
  await context.onEvent?.({ type, message, stageId });
}

function withPackagePrefix(packageRelative: string, value: string): string {
  const normalized = normalizeRepoPath(value);
  if (!packageRelative || packageRelative === ".") return normalized;
  return path.posix.join(packageRelative.replaceAll("\\", "/"), normalized);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function backendForManifest(manifest: TripManifest): AgentBackend {
  const routing = manifest.settings?.modelRouting;
  return new DynamicWorkflowBackend({
    mainModel: routing?.mainModel,
    persistAgentSessions: routing?.persistAgentSessions ?? true,
    roleTiers: routing?.roleTiers,
    roleModels: routing?.roleModels,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
