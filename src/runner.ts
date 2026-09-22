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
  reconcileOpenFindings,
  isCompletionClaim,
  synthesizeReviews,
  workerDirection,
} from "./review.ts";
import { buildDecisionPrompt, decisionRequestFromReview, parseDecision } from "./decision.ts";
import { hashContract } from "./contract.ts";
import { isStagnant } from "./stagnation.ts";
import { spawnResearchHook } from "./research-hook.ts";
import { monitorActivity, waitForHeartbeatStop, withTimeout, type ActivityWarning } from "./liveness.ts";
import { spawnRunReapers } from "./reaper-launcher.ts";
import {
  appendRunEvent,
  atomicWriteJson,
  claimRunLease,
  heartbeatRunLease,
  initializeRunStorage,
  LeaseGenerationMismatchError,
  leaseIsFresh,
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
  AgentResult,
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
  /** Disable when a separate service already provides stale-lease recovery. */
  externalReaper?: boolean;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
}

export interface ResumeOptions {
  repositoryRoot: string;
  runId: string;
  /** Generation token captured from state.lease.generation before the resume call.
   * A stale token returns the current state without side effects. */
  leaseGeneration?: number;
  backend?: AgentBackend;
  /** Disable only inside an already-running detached reaper or test harness. */
  externalReaper?: boolean;
  /** Explicitly adopt the current clean HEAD as a new recovery base after intentional branch movement. */
  adoptCurrentHead?: boolean;
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

class AbortRun extends Error {
  stageId?: string;

  constructor(message: string, stageId?: string) {
    super(message);
    this.stageId = stageId;
  }
}

class LeaseSuperseded extends Error {}

export async function runManifestFile(options: RunOptions): Promise<RunState> {
  const manifestPath = path.resolve(options.manifestPath);
  const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8")) as TripManifest;
  const manifest = assertValidManifest({
    ...sourceManifest,
    workingDirectory: path.isAbsolute(sourceManifest.workingDirectory)
      ? sourceManifest.workingDirectory
      : path.resolve(path.dirname(manifestPath), sourceManifest.workingDirectory),
  });
  await ensureGitRepository(manifest.workingDirectory);
  const repository = await repositoryRoot(manifest.workingDirectory);
  const resolvedWorkingDirectory = await realpath(manifest.workingDirectory);
  const packageRelative = path.relative(repository, resolvedWorkingDirectory);
  if (packageRelative === ".." || packageRelative.startsWith(`..${path.sep}`)) {
    throw new Error(`workingDirectory must be inside its Git repository: ${manifest.workingDirectory}`);
  }
  const workspaceBaseline = await snapshotChangedPathStates(repository);
  const writerAllowed = manifest.stages
    .filter((stage) => stage.type !== "review")
    .flatMap((stage) => (stage.allowedPaths ?? []).map((value) => withPackagePrefix(packageRelative, value)));
  const ambiguousDirtyPaths = Object.keys(workspaceBaseline).filter((value) =>
    !isIgnorableDirtyPath(value)
    && writerAllowed.some((pattern) => assertPathCovered(value, [pattern])));
  if (ambiguousDirtyPaths.length) {
    throw new Error(`writer execution cannot safely attribute pre-existing changes inside a writer path contract; commit, stash, or move these paths before starting:\n${ambiguousDirtyPaths.map((value) => `- ${value}`).join("\n")}`);
  }
  const baseRevision = await currentHead(repository);
  const now = new Date().toISOString();
  const id = `trip-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const stageStates = Object.fromEntries(manifest.stages.map((stage) => [stage.id, newStageState(stage.id)]));
  const state: RunState = {
    formatVersion: 1,
    id,
    manifestPath,
    manifest,
    // Persist as running before the detached reaper starts so it cannot race the
    // initial worker for a merely-pending run.
    status: "running",
    baseRevision,
    workspaceBaseline,
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
      // Renewed periodically while an agent or reviewer is running.
      leaseTimeoutMs: manifest.settings?.continuationPolicy?.leaseTimeoutMs ?? 120_000,
    },
  };
  await initializeRunStorage(repository, id);
  await atomicWriteJson(path.join(runRoot(repository, id), "manifest.json"), manifest);
  await writeRunState(repository, state);
  if (options.externalReaper !== false
    && !options.backend
    && manifest.settings?.continuationPolicy?.reaperEnabled !== false) {
    const reaperPids = spawnRunReapers(repository, id);
    await appendRunEvent(repository, id, { type: "reaper.started", pids: reaperPids });
  }
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
  const observed = await loadRunState(repository, options.runId);
  if (observed.status === "completed") return observed;

  // Cross-process compare-and-swap: only one manual resume, supervisor, or
  // detached reaper can advance a stale lease generation.
  const claim = await claimRunLease(repository, options.runId, {
    expectedGeneration: options.leaseGeneration,
    reopenAborted: true,
  });
  if (!claim.claimed) {
    if (claim.reason === "live") {
      throw new Error(`run ${claim.state.id} is already running with a live lease; refusing a concurrent resume`);
    }
    return claim.state;
  }

  const state = claim.state;
  if (options.externalReaper !== false && state.manifest.settings?.continuationPolicy?.reaperEnabled !== false) {
    const reaperPids = spawnRunReapers(repository, state.id);
    await appendRunEvent(repository, state.id, { type: "run.reaper.launched", pids: reaperPids, source: "resume" });
  }
  const manifest = assertValidManifest(state.manifest);
  try {
    await reconcileInterruptedStages(repository, state, claim.previousStatus === "failed", options.adoptCurrentHead === true);
  } catch (error) {
    if (!isSafetyBoundaryError(error)) throw error;
    state.pauseKind = "workspace_drift";
    state.pauseReason = errorMessage(error);
    if (isRecoverableWorkspaceDriftError(error)) {
      state.status = "paused";
      state.completedAt = undefined;
      await writeRunState(repository, state);
      await appendRunEvent(repository, state.id, { type: "run.paused", message: state.pauseReason });
      return state;
    }
    state.status = "failed";
    state.completedAt = new Date().toISOString();
    await writeRunState(repository, state);
    await appendRunEvent(repository, state.id, { type: "run.failed", message: state.pauseReason });
    return state;
  }
  state.status = "running";
  state.abortRequested = false;
  state.completedAt = undefined;
  state.pauseKind = undefined;
  state.pauseReason = undefined;
  await writeRunState(repository, state);
  if (claim.previousStatus === "aborted") {
    await appendRunEvent(repository, state.id, { type: "run.reopened", message: `Aborted run ${state.id} explicitly reopened for resume` });
  }
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
  if (state.status === "completed" || state.status === "aborted") return state;
  state.abortRequested = true;
  await appendRunEvent(repository, runId, { type: "run.abort.requested" });
  if (state.status !== "running" || !leaseIsFresh(state)) {
    const reason = state.status === "running"
      ? "Abort finalized immediately because the worker lease had expired."
      : `Abort finalized immediately because the run was ${state.status}.`;
    finalizeAbortedState(state, reason);
    await appendRunEvent(repository, runId, { type: "run.aborted", message: state.pauseReason });
  }
  await writeRunState(repository, state);
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
  const stopHeartbeat = startLeaseHeartbeat(context);
  try {
    return await executeLoop(context);
  } finally {
    await stopHeartbeat();
  }
}

async function executeLoop(context: RunnerContext): Promise<RunState> {
  const { state } = context;
  state.status = "running";
  state.startedAt ??= new Date().toISOString();
  await emit(context, "run.started", `Run ${state.id} started`);
  await writeRunState(context.repositoryRoot, state);

  try {
    while (true) {
      await refreshRunControl(context);
      if (state.abortRequested) throw new AbortRun(`Run ${state.id} aborted at a durable boundary`);
      const pending = context.manifest.stages.filter((stage) => state.stageStates[stage.id]?.status === "pending");
      if (!pending.length) {
        const failedRequired = context.manifest.stages.find((stage) => stage.required !== false && state.stageStates[stage.id]?.status === "failed");
        if (failedRequired) state.status = "failed";
        else if (Object.values(state.stageStates).some((entry) => entry.status === "paused")) state.status = "paused";
        else state.status = "completed";
        state.completedAt = new Date().toISOString();
        if (state.status === "completed") await writeRunFollowUpSummary(context);
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
    if (error instanceof LeaseSuperseded || error instanceof LeaseGenerationMismatchError) {
      return await loadRunState(context.repositoryRoot, state.id);
    }
    if (error instanceof AbortRun) {
      finalizeAbortedState(state, error.message);
      await emit(context, "run.aborted", error.message, error.stageId);
      await writeRunState(context.repositoryRoot, state);
      return state;
    }
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
    if (isSafetyBoundaryError(error)) state.pauseKind = "workspace_drift";
    state.pauseReason = errorMessage(error);
    await emit(context, "run.failed", errorMessage(error));
    await writeRunState(context.repositoryRoot, state);
    return state;
  }
}

async function executeStage(context: RunnerContext, stage: TripStage): Promise<void> {
  const stageState = requiredStageState(context.state, stage.id);
  let shouldPersist = true;
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
    if (error instanceof LeaseSuperseded || error instanceof LeaseGenerationMismatchError) {
      shouldPersist = false;
      throw error;
    }
    if (error instanceof PauseRun || error instanceof AbortRun) throw error;
    if (isSafetyBoundaryError(error) || context.manifest.settings?.failFast) {
      stageState.status = "failed";
      stageState.pauseReason = errorMessage(error);
      await emit(context, "stage.failed", `Stage ${stage.id} failed at a safety boundary: ${errorMessage(error)}`, stage.id);
      if (stage.required !== false || context.manifest.settings?.failFast) throw error;
      return;
    }
    if (context.manifest.settings?.continuationPolicy?.bestEffortCompletion === false) {
      stageState.status = "failed";
      stageState.pauseReason = errorMessage(error);
      throw error;
    }
    await recordStageFollowUp(context, stage, stageState, `Stage execution error: ${errorMessage(error)}`);
    stageState.status = "completed";
    stageState.completionMode = "best-effort";
    stageState.completedAt = new Date().toISOString();
    await emit(context, "stage.completed.best_effort", `Stage ${stage.id} completed best-effort; remaining work was recorded for follow-up`, stage.id);
  } finally {
    if (shouldPersist) await writeRunState(context.repositoryRoot, context.state);
  }
}

async function runReadonlyStage(context: RunnerContext, stage: TripStage, stageState: StageRunState): Promise<void> {
  const retries = context.manifest.settings?.continuationPolicy?.transientRetries ?? 3;
  let lastError = "readonly agent failed";
  for (let round = 0; round <= retries; round += 1) {
    const attemptNum = stageState.attempts.length + 1;
    const artifactDirectory = attemptDirectory(context, stage.id, attemptNum, "research");
    const startedAt = new Date().toISOString();
    const request = agentRequest(context, stage, "research", context.workingDirectory, stage.prompt, artifactDirectory);
    const result = await runAgent(context, request, `research agent for ${stage.id}`);
    stageState.lastAgentOutput = result.text;
    if (result.success) {
      await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/result.md`, result.text);
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
      stageState.completionMode = "verified";
      if (!context.researchOutput) context.researchOutput = result.text;
      return;
    }
    lastError = result.error ?? lastError;
    stageState.attempts.push({
      attempt: attemptNum,
      role: "research",
      validationResults: [],
      reviewVerdict: emptyReview(),
      diffHash: "",
      asi: { error: lastError },
      status: "crash",
      startedAt,
      completedAt: new Date().toISOString(),
    });
    await writeRunState(context.repositoryRoot, context.state);
  }
  if (context.manifest.settings?.continuationPolicy?.bestEffortCompletion === false) {
    throw new Error(`Research could not be completed after ${retries + 1} attempts: ${lastError}`);
  }
  stageState.completionMode = "best-effort";
  await recordStageFollowUp(context, stage, stageState, `Research could not be completed after ${retries + 1} attempts: ${lastError}`);
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
    ? recoveryPrompt(stage, context.state, latestDecisionDirection(context.state, stage.id))
    : injectResearch(stage.prompt, context.researchOutput);

  const maximumRounds = context.manifest.settings?.reviewPolicy?.maxRepairRounds ?? 4;
  const continuationPolicy = context.manifest.settings?.continuationPolicy;
  const maxConsecutiveFailures = continuationPolicy?.consecutiveFailureOverride
    ?? continuationPolicy?.maxConsecutiveFailures
    ?? 5;
  const configuredAttemptLimit = continuationPolicy?.autoResumeTurnLimit
    ?? continuationPolicy?.maxTurns
    ?? 30;
  const automaticFollowUpPasses = continuationPolicy?.automaticFollowUpPasses ?? 1;
  const automaticFollowUpAttemptLimit = continuationPolicy?.automaticFollowUpAttemptLimit ?? 5;
  // A manually resumed paused stage receives a fresh bounded repair window rather
  // than immediately re-hitting its historical lifetime attempt count.
  let maximumTotalAttempts = Math.max(
    configuredAttemptLimit,
    attemptNum > 0 ? attemptNum + automaticFollowUpAttemptLimit : configuredAttemptLimit,
  );
  let automaticFollowUpPass = 0;
  // maxRepairRounds is a focused-strategy window, not a terminal attempt cap.
  // Semantic work continues automatically while validation/review keeps making
  // progress, bounded by the total-attempt and consecutive-failure safety rails.
  let consecutiveNonProgress = 0;
  let consecutiveReviewChurn = 0;
  let researchEscalations = 0;
  // Worker-only `continue` returns are bounded separately (aider's reflection
  // cap): after maxWorkerReflections in a row the next return is forced through
  // validation and review whatever the worker says.
  const maxWorkerReflections = continuationPolicy?.maxWorkerReflections ?? 3;
  let consecutiveWorkerContinues = stageState.workerReflections ?? 0;
  let stuckNudged = false;
  let reflectionCapAnnounced = false;

  while (true) {
    const kind = consecutiveReviewChurn >= maxConsecutiveFailures ? "review-only churn" : "non-progressing worker or validation attempts";
    const exhausted = attemptNum >= maximumTotalAttempts;
    const hitFailureRail = consecutiveNonProgress >= maxConsecutiveFailures || consecutiveReviewChurn >= maxConsecutiveFailures;
    if (exhausted || hitFailureRail) {
      const reason = exhausted
        ? `Exhausted the automatic ${maximumTotalAttempts}-attempt repair budget.`
        : `Reached ${maxConsecutiveFailures} consecutive ${kind}.`;
      if (continuationPolicy?.bestEffortCompletion !== false
        && automaticFollowUpPass < automaticFollowUpPasses
        && automaticFollowUpAttemptLimit > 0) {
        automaticFollowUpPass += 1;
        maximumTotalAttempts = attemptNum + automaticFollowUpAttemptLimit;
        consecutiveNonProgress = 0;
        consecutiveReviewChurn = 0;
        stageState.reviewRounds = 0;
        nextPrompt = repairPrompt(
          stage,
          context.state,
          `AUTOMATIC FOLLOW-UP REMEDIATION PASS ${automaticFollowUpPass}/${automaticFollowUpPasses}\n${reason} Build on the complete current worktree and the prior attempt evidence; do not restart or discard cumulative in-contract work. Resolve the remaining findings with a materially different, evidence-based approach.`,
        );
        await emit(context, "stage.follow_up.automatic_started", `Stage ${stage.id} started automatic follow-up remediation pass ${automaticFollowUpPass}/${automaticFollowUpPasses}`, stage.id);
        await writeRunState(context.repositoryRoot, context.state);
        continue;
      }
      if (integration && stage.required !== false) {
        throw new PauseRun(
          "review_blocked",
          stage.id,
          `${reason} Required integration remains unverified. The run is paused without committing so the blocking evidence can be fixed, then resumed for another bounded repair window.`,
        );
      }
      if (continuationPolicy?.bestEffortCompletion === false) {
        throw new PauseRun("review_blocked", stage.id, `${reason} Automatic remediation is disabled by bestEffortCompletion=false.`);
      }
      await completeWriterBestEffort(
        context,
        stage,
        stageState,
        gitRoot,
        stageStart,
        attemptNum,
        `${reason} Accepted the safest available cumulative work after automatic follow-up remediation.`,
      );
      return;
    }
    await refreshRunControl(context);
    if (context.state.abortRequested) throw new AbortRun("Abort requested; stopped before the next agent attempt.", stage.id);

    attemptNum += 1;
    const role: AgentRequest["role"] = integration ? "integration" : attemptNum === 1 ? "implementation" : "repair";
    const beforeAttempt = await snapshotChangedPathStates(gitRoot);
    const headBefore = await currentHead(gitRoot);
    const attemptStartedAt = new Date().toISOString();
    const artifactDirectory = attemptDirectory(context, stage.id, attemptNum, role);
    const request = agentRequest(context, stage, role, agentCwd, nextPrompt, artifactDirectory);
    const result = await runAgent(context, request, `${role} agent for ${stage.id}`);
    stageState.lastAgentOutput = result.text;
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/agent-response.md`, result.text || result.error || "");
    await refreshRunControl(context);
    if (context.state.abortRequested) throw new AbortRun("Abort requested after the agent attempt completed.", stage.id);

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
      consecutiveNonProgress += 1;
      nextPrompt = repairPrompt(
        stage,
        context.state,
        `The prior ${role} session failed (${result.error ?? "unknown backend failure"}). Inspect the durable worktree, preserve valid work, and continue from the current state.`,
      );
      await writeRunState(context.repositoryRoot, context.state);
      continue;
    }

    const headAfter = await currentHead(gitRoot);
    if (headAfter !== headBefore) throw new Error(`agent created a direct commit in ${stage.id}; the runtime is the only commit authority`);
    const attemptDelta = await calculateStageDelta(gitRoot, beforeAttempt);
    enforcePathContract(context, stage, attemptDelta.changedDuring);
    const cumulativeAttemptDelta = await calculateStageDelta(gitRoot, stageStart);
    const candidatePatchPaths = patchPathsForStage(context, stage, cumulativeAttemptDelta.changedDuring);

    const workerReview = normalizeReview(result.text);
    const forcedClaim = workerReview.status === "continue"
      && !isCompletionClaim(workerReview)
      && consecutiveWorkerContinues >= maxWorkerReflections;
    if (forcedClaim && !reflectionCapAnnounced) {
      reflectionCapAnnounced = true;
      await emit(context, "stage.worker.reflection_cap", `Stage ${stage.id}: ${consecutiveWorkerContinues} consecutive worker continue returns reached the reflection cap (${maxWorkerReflections}); routing this return through validation and review`, stage.id);
    }
    const completionClaim = isCompletionClaim(workerReview) || forcedClaim;
    if (completionClaim) {
      consecutiveWorkerContinues = 0;
      stageState.workerReflections = 0;
    }
    // Deterministic validation runs on every attempt regardless of the worker's
    // status, so repair prompts and reviewers always see real evidence.
    const validation = await validateStage(context, stage, stageState, agentCwd, integration, attemptNum);
    if (!completionClaim && validationPassed(validation)) {
      // The worker's self-report never enters the finding pipeline: a
      // `continue` becomes direction for the next attempt, and `blocked` or
      // `needs_decision` escalate without minting findings from worker prose.
      let direction = workerReview.status === "continue"
        ? workerDirection(workerReview)
        : await resolveWorkerEscalation(context, stage, workerReview, agentCwd);
      const candidatePatch = await captureBinaryPatch(gitRoot, candidatePatchPaths);
      const diffHash = sha256(candidatePatch);
      const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/candidate.patch.diff`, candidatePatch);
      const discardRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: validation,
        // Findings a worker embeds in its own verdict are not evidence; drop them
        // so they never echo back into later prompts as attempt evidence.
        reviewVerdict: { ...workerReview, findings: [] },
        diffHash,
        patchPath,
        patchSha256: diffHash,
        asi: { source: "worker", completionClaim: false },
        status: "discard",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      };
      attemptHistory.push(discardRecord);
      consecutiveNonProgress++;
      if (workerReview.status === "continue") {
        consecutiveWorkerContinues += 1;
        stageState.workerReflections = consecutiveWorkerContinues;
        // OpenHands-style stuck detection: two identical worker returns over
        // the same diff earn one nudge that names the loop and the exit.
        const workerAttempts = attemptHistory.filter((entry) => entry.asi.source === "worker");
        if (!stuckNudged && isStagnant(workerAttempts, 2)) {
          stuckNudged = true;
          await emit(context, "stage.worker.stuck", `Stage ${stage.id}: the last two worker returns were identical (same diff, status and missing items)`, stage.id);
          direction = `${STUCK_WORKER_NUDGE}\n\n${direction}`;
        }
      }
      stageState.reviewRounds += 1;
      if (stageState.reviewRounds > maximumRounds) {
        const next = await advanceRepairStrategy(context, stage, stageState, agentCwd, attemptHistory, direction, researchEscalations);
        researchEscalations = next.researchEscalations;
        stageState.reviewRounds = 0;
        nextPrompt = next.prompt;
        await writeRunState(context.repositoryRoot, context.state);
        continue;
      }
      nextPrompt = repairPrompt(stage, context.state, direction);
      await writeRunState(context.repositoryRoot, context.state);
      continue;
    }

    if (!validationPassed(validation)) {
      // Validation failure outranks the worker's own status, but its reported
      // missing items still travel with the deterministic direction.
      const validationDirection = workerReview.missingItems.some((item) => item.trim())
        ? `Fix the deterministic validation failures exactly; do not expand scope.\n\nAlso complete the items you reported as missing:\n${workerReview.missingItems.filter((item) => item.trim()).map((item) => `- ${item.trim()}`).join("\n")}`
        : "Fix the deterministic validation failures exactly; do not expand scope.";
      const finding = validationFinding(context, stage, stageState, validation);
      await addFinding(context, finding);
      const candidatePatch = await captureBinaryPatch(gitRoot, candidatePatchPaths);
      const diffHash = sha256(candidatePatch);
      const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/candidate.patch.diff`, candidatePatch);
      const checksFailedRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: validation,
        reviewVerdict: emptyReview(),
        diffHash,
        patchPath,
        patchSha256: diffHash,
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
        const next = await advanceRepairStrategy(
          context,
          stage,
          stageState,
          agentCwd,
          attemptHistory,
          validationDirection,
          researchEscalations,
        );
        researchEscalations = next.researchEscalations;
        stageState.reviewRounds = 0;
        nextPrompt = next.prompt;
        await writeRunState(context.repositoryRoot, context.state);
        continue;
      }
      nextPrompt = repairPrompt(stage, context.state, validationDirection);
      continue;
    }

    // A completion claim must also have produced every declared output. A miss
    // is deterministic evidence routed into the repair loop, not a thrown error
    // that would fail the stage.
    const missingOutput = await missingOutputs(agentCwd, stage.outputs ?? []);
    if (missingOutput.length) {
      const finding = outputFinding(context, stage, stageState, missingOutput);
      await addFinding(context, finding);
      const candidatePatch = await captureBinaryPatch(gitRoot, candidatePatchPaths);
      const diffHash = sha256(candidatePatch);
      const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/candidate.patch.diff`, candidatePatch);
      attemptHistory.push({
        attempt: attemptNum,
        role,
        validationResults: validation,
        reviewVerdict: emptyReview(),
        diffHash,
        patchPath,
        patchSha256: diffHash,
        asi: { source: "deterministic-validation", completionClaim: true, missingOutputs: missingOutput },
        status: "checks_failed",
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
        contractHash: stageState.contractHash,
      });
      consecutiveNonProgress++;
      stageState.reviewRounds += 1;
      nextPrompt = repairPrompt(stage, context.state, `Create the declared outputs that are still missing, inside your allowed paths: ${missingOutput.join(", ")}`);
      await writeRunState(context.repositoryRoot, context.state);
      continue;
    }

    // Passing deterministic validation is concrete progress. Reviewer-requested
    // repairs must not be counted as consecutive failed worker/check attempts.
    consecutiveNonProgress = 0;

    const reviews = await runReviewers(context, stage, agentCwd, validation, integration, attemptNum);
    const synthesis = synthesizeReviews(reviews);
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/review-synthesis.json`, `${JSON.stringify(synthesis, null, 2)}\n`);

    if (synthesis.status === "complete" && !synthesis.findings.some((finding) => finding.blocking)) {
      const finalDelta = await calculateStageDelta(gitRoot, stageStart);
      enforcePathContract(context, stage, finalDelta.changedDuring);
      stageState.changedPaths = unique([...stageState.changedPaths, ...finalDelta.changedDuring]);
      // Capture the patch once; reuse for diffHash and for the artifact in persistWriterBoundary.
      const verifiedPatch = await captureBinaryPatch(gitRoot, patchPathsForStage(context, stage, finalDelta.changedDuring));
      const diffHash = sha256(verifiedPatch);
      const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/candidate.patch.diff`, verifiedPatch);
      const keepRecord: AttemptRecord = {
        attempt: attemptNum,
        role,
        validationResults: validation,
        reviewVerdict: synthesis,
        diffHash,
        patchPath,
        patchSha256: diffHash,
        asi: { source: "ensemble-review", completionClaim: true, freshReviewers: context.manifest.settings?.reviewPolicy?.requireFreshClosureReviewer !== false },
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
      consecutiveReviewChurn = 0;
      stageState.completionMode = "verified";
      stageState.bestAttempt = attemptNum;
      await persistWriterBoundary(context, stage, stageState, gitRoot, attemptNum, verifiedPatch);
      return;
    }

    const direction = await handleNonCompleteVerdict(context, stage, stageState, synthesis, integration ? "integration-review" : "independent-review", agentCwd);
    const candidatePatch = await captureBinaryPatch(gitRoot, candidatePatchPaths);
    const diffHash = sha256(candidatePatch);
    const patchPath = await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/candidate.patch.diff`, candidatePatch);
    const reviewDiscardRecord: AttemptRecord = {
      attempt: attemptNum,
      role,
      validationResults: validation,
      reviewVerdict: synthesis,
      diffHash,
      patchPath,
      patchSha256: diffHash,
      asi: { source: integration ? "integration-review" : "independent-review", completionClaim: true, freshReviewers: context.manifest.settings?.reviewPolicy?.requireFreshClosureReviewer !== false },
      status: "discard",
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      contractHash: stageState.contractHash,
    };
    attemptHistory.push(reviewDiscardRecord);
    // Deterministic validation passed, but reviewer-only churn still needs its
    // own bounded rail; validation success must not reset this counter.
    consecutiveReviewChurn += 1;
    stageState.reviewRounds += 1;
    if (stageState.reviewRounds > maximumRounds) {
      const next = await advanceRepairStrategy(context, stage, stageState, agentCwd, attemptHistory, direction, researchEscalations);
      researchEscalations = next.researchEscalations;
      stageState.reviewRounds = 0;
      nextPrompt = next.prompt;
      await writeRunState(context.repositoryRoot, context.state);
      continue;
    }
    nextPrompt = repairPrompt(stage, context.state, direction);
  }
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
  const workspaceDelta = await currentWorkspaceDeltaPaths(context.repositoryRoot, context.state);
  const runOwned = new Set(runOwnedPaths(context.state));
  const unowned = workspaceDelta.filter((value) =>
    !runOwned.has(value) && !isStrayIgnorablePath(context, stage, value));
  if (unowned.length) {
    throw new PauseRun(
      "workspace_drift",
      stage.id,
      `Integration found workspace changes that no stage owns. Preserve or move them outside the checkout, then resume:\n${unowned.map((value) => `- ${value}`).join("\n")}`,
    );
  }
  const finalPaths = workspaceDelta
    .filter((value) => runOwned.has(value))
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

/**
 * Worker `blocked` and `needs_decision` verdicts still need a resolution path,
 * but any findings the worker embedded in its own response are ignored; a
 * reviewer must raise them independently.
 */
async function resolveWorkerEscalation(
  context: RunnerContext,
  stage: TripStage,
  review: NormalizedReview,
  agentCwd: string,
): Promise<string> {
  if (review.status === "needs_decision") return await resolveDecision(context, stage, review, agentCwd);
  return review.recommendedFollowupPrompt
    ?? `Use best judgement to resolve or safely work around this blocker without expanding scope: ${review.rationale}`;
}

async function handleNonCompleteVerdict(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  review: NormalizedReview,
  source: "independent-review" | "integration-review",
  agentCwd: string,
): Promise<string> {
  let findings = findingsFromReview(review, {
    runId: context.state.id,
    stageId: stage.id,
    attempt: stageState.attempts.length,
    source,
  });
  if ((source === "independent-review" || source === "integration-review") && !review.malformed) {
    const reconciled = reconcileOpenFindings(context.state.findings, stage.id, findings, {
      repairAttempt: stageState.attempts.length,
      changedPaths: stageState.changedPaths,
      reviewArtifact: `stages/${stage.id}/attempt-${stageState.attempts.length}/review-synthesis.json`,
      actor: "fresh-reviewer-ensemble",
      rationale: "A fresh review verified prior open findings and returned the current blocking set.",
    });
    findings = reconciled.additions;
    for (const finding of reconciled.updated) await persistFinding(context.repositoryRoot, finding);
    if (reconciled.updated.length) await writeRunState(context.repositoryRoot, context.state);
  }
  for (const finding of findings) await addFinding(context, finding);
  if (review.status === "blocked") {
    return review.recommendedFollowupPrompt
      ?? `Use best judgement to resolve or safely work around this blocker without expanding scope: ${review.rationale}`;
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
  const sessionTimeoutMs = context.manifest.settings?.sessionTimeoutMs ?? 30 * 60_000;
  const decisionTimeoutMs = context.manifest.settings?.continuationPolicy?.decisionTimeoutMs
    ?? Math.min(sessionTimeoutMs, 5 * 60_000);
  let recommendation: DecisionRecord | undefined;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const artifactDirectory = attemptDirectory(context, stage.id, attempt, "decision");
    const prompt = buildDecisionPrompt(request, decisionContext(context, stage));
    const agentCall = agentRequest(context, stage, "decision", agentCwd, prompt, artifactDirectory, ["read", "grep", "find", "ls"]);
    const result = await runAgent(context, agentCall, `decision agent for ${stage.id}`, decisionTimeoutMs);
    if (!result.success) continue;
    recommendation = parseDecision(result.text, request, "agent");
    if (recommendation) break;
  }
  if (!recommendation) {
    const choice = request.recommendation ?? request.options[0]?.id ?? "safest-reversible-in-scope-option";
    const selected = request.options.find((option) => option.id === choice);
    recommendation = {
      id: `decision-${randomUUID()}`,
      requestId: request.id,
      runId: context.state.id,
      stageId: stage.id,
      actor: "agent",
      source: "auto",
      status: "decided",
      choice,
      rationale: `Decision sessions did not return a valid answer after ${maximum} attempts. The runtime selected the safest reversible in-scope option and recorded this fallback for follow-up.`,
      implementationDirection: selected?.description
        ?? review.recommendedFollowupPrompt
        ?? "Choose the safest reversible implementation that satisfies the existing path contract and validation commands.",
      assumptions: ["No human response was required to keep the prompt chain live."],
      createdAt: new Date().toISOString(),
    };
    await addFinding(context, {
      id: `finding-${randomUUID()}`,
      runId: context.state.id,
      stageId: stage.id,
      attempt: context.state.stageStates[stage.id]?.attempts.length ?? 0,
      source: "operator",
      severity: "minor",
      blocking: false,
      summary: "Autonomous fallback decision was used",
      evidence: recommendation.rationale,
      suggestedRemediation: "Review the recorded decision after the run and override it in a follow-up if better product context is available.",
      affectedPaths: context.state.stageStates[stage.id]?.changedPaths ?? [],
      disposition: "follow-up-created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  if (recommendation.status === "blocked") {
    recommendation.status = "decided";
    recommendation.source = "auto";
    recommendation.choice ??= request.recommendation ?? request.options[0]?.id ?? "safest-reversible-in-scope-option";
    recommendation.implementationDirection ??= review.recommendedFollowupPrompt
      ?? "Use the safest reversible in-scope implementation and record unresolved trade-offs for follow-up.";
  }
  context.state.decisions.push(recommendation);
  await atomicWriteJson(path.join(runRoot(context.repositoryRoot, context.state.id), "decisions", `${recommendation.id}.json`), recommendation);
  await appendRunEvent(context.repositoryRoot, context.state.id, { type: "decision.agent.recorded", stageId: stage.id, decisionId: recommendation.id, status: recommendation.status });
  // Human mode still records the recommendation, but no longer wedges the run.
  // A human can review/override the durable decision after completion.
  return recommendation.implementationDirection ?? recommendation.choice ?? recommendation.rationale;
}

async function validateStage(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  cwd: string,
  integration: boolean,
  attemptNum: number,
): Promise<ValidationResult[]> {
  const commands = unique([
    ...(stage.validationCommands?.length ? stage.validationCommands : context.manifest.settings?.defaultValidationCommands ?? []),
    ...(integration ? context.manifest.settings?.finalValidationCommands ?? [] : []),
  ]);
  if (!commands.length && !integration && attemptNum === 1) {
    await emit(context, "stage.validation.none", `Stage ${stage.id} declares no validation commands; reviewers will see no deterministic evidence`, stage.id);
  }
  const results = await runValidationCommands(
    cwd, commands, context.manifest.settings?.commandTimeoutMs ?? 15 * 60_000,
    (command, warning) => reportIdleWarning(context, stage.id, "validation.command.idle", `Validation ${command}`, warning, { command }),
  );
  stageState.validationResults = results;
  await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/validation.json`, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

async function runReviewers(
  context: RunnerContext,
  stage: TripStage,
  cwd: string,
  validation: ValidationResult[],
  integration: boolean,
  attemptNum: number,
): Promise<NormalizedReview[]> {
  if (context.manifest.settings?.reviewPolicy?.required === false) return [normalizeReview("<status>complete</status><risk>low</risk><rationale>Review disabled by manifest policy.</rationale>")];
  const count = context.manifest.settings?.reviewPolicy?.reviewerCount ?? 2;
  // Fresh closure reviewers never share a persisted transcript: reviewers in
  // one attempt already shared a session name, and so did the same reviewer
  // across repairs, which let an earlier verdict leak into a later one.
  const freshReviewers = context.manifest.settings?.reviewPolicy?.requireFreshClosureReviewer !== false;
  const open = openBlockingFindings(context.state.findings, stage.id);
  const angles = [
    "correctness, plan conformance, and user-visible regressions",
    "tests, failure behavior, edge cases, and unnecessary complexity",
    "security, architecture, resource cleanup, and operational risk",
  ];
  return await Promise.all(Array.from({ length: count }, async (_, index) => {
    const prompt = reviewPrompt(context, stage, validation, open, angles[index % angles.length] ?? "correctness", integration);
    const artifactDirectory = attemptDirectory(context, stage.id, attemptNum, `reviewer-${index + 1}`);
    const request = agentRequest(context, stage, "review", cwd, prompt, artifactDirectory, ["read", "grep", "find", "ls"]);
    if (freshReviewers) request.sessionScope = `attempt-${attemptNum} reviewer-${index + 1}`;
    const result = await runAgent(context, request, `reviewer ${index + 1} for ${stage.id}`);
    const review = result.success
      ? normalizeReview(result.text)
      : normalizeReview(`<status>blocked</status><risk>high</risk><rationale>Reviewer session failed: ${escapeXml(result.error ?? "unknown error")}</rationale>`);
    await writeArtifact(context.repositoryRoot, context.state.id, `stages/${stage.id}/attempt-${attemptNum}/review-${index + 1}.json`, `${JSON.stringify(review, null, 2)}\n`);
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
      "Durable-Trip-Base": context.state.baseRevision,
    }, patch, context.state.baseRevision);
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
  if (violations.length) {
    throw new PauseRun(
      "workspace_drift",
      stage.id,
      `Stage ${stage.id} changed paths outside its allowed path contract. The run is paused without committing; preserve or move these paths, then resume:\n${violations.map((value) => `- ${value}`).join("\n")}`,
    );
  }
}

async function currentWorkspaceDeltaPaths(repository: string, state: RunState): Promise<string[]> {
  const current = await snapshotChangedPathStates(repository);
  if (!state.workspaceBaseline) {
    return Object.keys(current).filter((value) => !isIgnorableDirtyPath(value)).sort();
  }
  return Object.entries(current)
    .filter(([value, currentState]) => state.workspaceBaseline?.[value] !== currentState)
    .map(([value]) => value)
    .sort();
}

function runOwnedPaths(state: RunState): string[] {
  return unique(Object.values(state.stageStates).flatMap((value) => value.changedPaths));
}

function patchPathsForStage(context: RunnerContext, stage: TripStage, stageDelta: string[]): string[] {
  const allowed = (stage.allowedPaths ?? []).map((value) => withPackagePrefix(context.packageRelative, value));
  const currentStagePaths = stageDelta.filter((value) =>
    allowed.some((pattern) => assertPathCovered(value, [pattern])));
  return stage.isolation === "worktree"
    ? unique(currentStagePaths)
    : unique([...runOwnedPaths(context.state), ...currentStagePaths]);
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

async function missingOutputs(cwd: string, outputs: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const output of outputs) {
    try {
      await access(path.join(cwd, normalizeRepoPath(output)));
    } catch {
      missing.push(output);
    }
  }
  return missing;
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

const STUCK_WORKER_NUDGE = [
  "STUCK LOOP DETECTED",
  "Your last two responses were identical: same diff, same status, same missing items. Repeating them will not work.",
  "The runtime acts only on what you return: a `continue` with an empty missingItems list is treated as a completion claim and goes to validation and independent review; a `continue` with missing items comes straight back to you without review.",
  "Either finish the listed items and return complete, or list the concrete, different items that still block you and change your approach to them.",
].join("\n");

function outputFinding(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  missing: string[],
): Finding {
  const now = new Date().toISOString();
  return {
    id: `finding-${randomUUID()}`,
    runId: context.state.id,
    stageId: stage.id,
    attempt: stageState.attempts.length,
    source: "deterministic-validation",
    severity: "major",
    blocking: true,
    summary: `Declared outputs are missing: ${missing.join(", ")}`,
    evidence: missing.map((output) => `${output}: not found in the stage checkout after a completion claim`).join("\n"),
    suggestedRemediation: "Create every declared output inside the allowed paths, then return complete.",
    affectedPaths: missing,
    disposition: "open",
    createdAt: now,
    updatedAt: now,
  };
}

function repairPrompt(stage: TripStage, state: RunState, direction: string): string {
  const findings = openBlockingFindings(state.findings, stage.id);
  const decision = latestDecisionDirection(state, stage.id);
  const priorAttempts = formatRepairAttemptEvidence(state.stageStates[stage.id]?.attempts ?? []);
  return `Repair the current frozen stage. Do not advance to other work and do not expand scope. All in-contract edits from prior attempts remain in the working tree: inspect them, build on them, and preserve correct work rather than restarting from scratch.

ORIGINAL STAGE
${stage.prompt}

OPEN BLOCKING FINDINGS
${formatOpenFindings(findings)}

RECENT ATTEMPT EVIDENCE
${priorAttempts}

DECISION DIRECTION
${decision ?? direction}

REQUIRED ACTION
${direction}

Use the prior attempt evidence before editing. The current diff and the failing command output are authoritative. Do not repeat an approach that left the same failure unresolved: identify why it did not work, then take a materially different, evidence-based repair path.

After repairing, run the targeted checks you can run. Do not commit. The runtime acts on missingItems, not on prose: list every concrete item that still blocks completion there, and return complete when nothing remains. End with:
<status>complete|continue|blocked|needs_decision</status>
<risk>low|medium|high|critical</risk>
<rationale>what changed and why it addresses every open finding</rationale>
<missingItems>anything still unresolved, one concrete item per line</missingItems>
<recommendedFollowupPrompt>next action if not complete</recommendedFollowupPrompt>`;
}

function recoveryPrompt(stage: TripStage, state: RunState, decision: string | undefined): string {
  const open = openBlockingFindings(state.findings, stage.id);
  const priorAttempts = formatRepairAttemptEvidence(state.stageStates[stage.id]?.attempts ?? []);
  return `Recover and complete an interrupted stage. Partial edits are EXPECTED in the working tree — your own from an earlier attempt, and, in a shared checkout, in-contract changes from prior stages (schema, generated code, fixtures, helpers). Treat all of them as expected and in-contract: inspect them, build on them, and keep them. Do not revert them, do not treat them as foreign or "host-owned", and do not pause or block because they are present. Do not repeat already-completed work blindly.

${stage.prompt}

OPEN BLOCKING FINDINGS
${formatOpenFindings(open)}

RECENT ATTEMPT EVIDENCE
${priorAttempts}

${decision ? `Previously resolved decision:\n${decision}\n` : ""}
Stay inside your allowed paths — editing any file that matches them is in-contract. Do not commit. Return the required structured status.`;
}

function formatRepairAttemptEvidence(attempts: AttemptRecord[]): string {
  if (!attempts.length) return "No prior attempts were recorded.";
  const recent = attempts.slice(-4).map((attempt) => {
    const validation = attempt.validationResults.length
      ? attempt.validationResults.map((result) => {
        const status = result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL";
        const output = status === "FAIL" ? truncateRepairEvidence(result.stderr || result.stdout, 700) : "";
        return `${status} ${result.command}${result.timedOut ? " (timed out)" : ""}${output ? `\n${output}` : ""}`;
      }).join("\n")
      : "No deterministic validation recorded.";
    const review = attempt.reviewVerdict;
    const reviewEvidence = [
      `Review: ${review.status}; ${truncateRepairEvidence(review.rationale, 400)}`,
      review.missingItems.length ? `Missing: ${truncateRepairEvidence(review.missingItems.join("; "), 400)}` : "",
      review.findings.length ? `Findings: ${truncateRepairEvidence(review.findings.map((finding) => `${finding.summary}: ${finding.remediation ?? finding.evidence}`).join("; "), 700)}` : "",
    ].filter(Boolean).join("\n");
    return `Attempt ${attempt.attempt} (${attempt.role}, ${attempt.status}, diff ${attempt.diffHash || "none"})\n${validation}\n${reviewEvidence}`;
  });
  return truncateRepairEvidence(recent.join("\n\n"), 6_000);
}

function truncateRepairEvidence(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}\n…[truncated]`;
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
Review the actual Git diff, the approved stage, docs/VISION.md, docs/ARCHI.md, repository instructions, and deterministic evidence.
${integration ? "This is the aggregate integration review; verify all approved slices work together." : "This is a slice review."}

APPROVED STAGE
${stage.prompt}

OPEN FINDINGS THAT MUST BE EXPLICITLY CLOSED OR RETAINED
${formatOpenFindings(open)}

DETERMINISTIC VALIDATION
${validation.length
    ? validation.map((result) => `${result.exitCode === 0 ? "PASS" : "FAIL"}: ${result.command}`).join("\n")
    : stage.validationCommands?.length
      ? "Declared validation commands produced no results."
      : "This stage declares no validation commands. That is a plan defect (missing Targeted Validation fence), not evidence against the implementation; review the diff on its merits and note the gap as non-blocking."}

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
    timeoutMs: 0,
    artifactDirectory,
  };
}

function attemptDirectory(context: RunnerContext, stageId: string, attempt: number, kind: string): string {
  return path.join(runRoot(context.repositoryRoot, context.state.id), "stages", stageId, `attempt-${attempt}`, kind);
}

function validationPassed(results: ValidationResult[]): boolean {
  return results.every((result) => result.exitCode === 0 && !result.timedOut && !isEmptyTestSuccess(result));
}

function isEmptyTestSuccess(result: ValidationResult): boolean {
  if (!/\b(?:test|tests|jest|vitest|mocha|playwright|ava)\b/i.test(result.command)) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /no test files found|no tests found|no test files|ran 0 tests|0 tests? (?:run|executed|collected)/i.test(output);
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

async function advanceRepairStrategy(
  context: RunnerContext,
  stage: TripStage,
  _stageState: StageRunState,
  agentCwd: string,
  attemptHistory: AttemptRecord[],
  direction: string,
  researchEscalations: number,
): Promise<{ prompt: string; researchEscalations: number }> {
  const continuation = context.manifest.settings?.continuationPolicy;
  const stagnationRounds = continuation?.stagnationRounds ?? 2;
  const maxResearchEscalations = continuation?.maxResearchEscalations
    ?? context.manifest.settings?.researchPolicy?.maxRounds
    ?? 3;
  const stagnant = isStagnant(attemptHistory, stagnationRounds);

  if (stagnant && researchEscalations < maxResearchEscalations) {
    const escalated = await tryResearchEscalation(context, stage, agentCwd, attemptHistory, stagnationRounds);
    if (escalated) {
      return { prompt: escalated, researchEscalations: researchEscalations + 1 };
    }
  }

  const strategy = stagnant
    ? "The previous attempts are stagnant. Re-inspect the actual diff and tests, challenge the prior approach, identify the root cause, and try a materially different repair."
    : "The focused repair window ended while the diff, validation, or reviewer findings were still evolving. Continue automatically from the current worktree and close the remaining findings.";
  return {
    prompt: repairPrompt(stage, context.state, `${direction}\n\nAUTOMATIC STRATEGY TRANSITION\n${strategy}`),
    researchEscalations,
  };
}

/**
 * Attempts to escalate a stagnant repair loop via the configured research hook.
 */
async function tryResearchEscalation(
  context: RunnerContext,
  stage: TripStage,
  agentCwd: string,
  attemptHistory: AttemptRecord[],
  stagnationRounds: number,
): Promise<string | undefined> {
  const policy = context.manifest.settings?.researchPolicy;
  if (!policy?.hookCommand) return undefined;
  if (!isStagnant(attemptHistory, stagnationRounds)) return undefined;
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

async function reconcileInterruptedStages(
  repository: string,
  state: RunState,
  recoverFailed = false,
  adoptCurrentHead = false,
): Promise<void> {
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

  if (current !== state.baseRevision && adoptCurrentHead) {
    // Explicit recovery only: force the operator to checkpoint all source changes
    // first, so adopting HEAD cannot silently absorb an ambiguous dirty workspace.
    try {
      await assertCleanCheckout(repository);
    } catch (error) {
      throw new Error(`workspace drift: --adopt-current-head requires source changes to be committed or stashed first. ${errorMessage(error)}`);
    }
    const previousBaseRevision = state.baseRevision;
    const adoptedAt = new Date().toISOString();
    await atomicWriteJson(
      path.join(runRoot(repository, state.id), "recovery", `pre-head-adoption-${adoptedAt.replaceAll(":", "-")}.json`),
      state,
    );
    state.baseRevision = current;
    await appendRunEvent(repository, state.id, {
      type: "run.head.adopted",
      previousBaseRevision,
      baseRevision: current,
      adoptedAt,
    });
    await writeRunState(repository, state);
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
    return status === "running" || status === "paused" || (recoverFailed && (status === "failed" || status === "skipped"));
  });
  const interruptedSameCheckout = interrupted.filter((stage) => stage.isolation === "same-checkout");
  let sameCheckoutDelta: string[] = [];
  if (interruptedSameCheckout.length) {
    const currentPaths = (await currentWorkspaceDeltaPaths(repository, state))
      .filter((value) => !isIgnorableDirtyPath(value));
    sameCheckoutDelta = currentPaths;
    const authorizedStages = state.manifest.stages.filter((stage) => {
      const status = state.stageStates[stage.id]?.status;
      return stage.isolation === "same-checkout"
        && (status === "completed" || status === "running" || status === "paused" || (recoverFailed && status === "failed"));
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
      const currentPatch = await captureBinaryPatch(repository, runOwnedPaths(state));
      if (sha256(currentPatch) !== completed.state.cumulativePatchSha256) {
        throw new Error(`same-checkout workspace drift detected after ${completed.stage.id}`);
      }
    }
  }

  for (const stage of interrupted) {
    const stageState = state.stageStates[stage.id];
    if (!stageState) continue;
    if (stage.isolation === "same-checkout" && sameCheckoutDelta.length) {
      const allowed = (stage.allowedPaths ?? []).map((pattern) => withPackagePrefix(path.relative(repository, state.manifest.workingDirectory), pattern));
      stageState.changedPaths = unique([
        ...stageState.changedPaths,
        ...sameCheckoutDelta.filter((value) => allowed.some((pattern) => assertPathCovered(value, [pattern]))),
      ]);
    }
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

function finalizeAbortedState(state: RunState, reason: string): void {
  state.status = "aborted";
  state.abortRequested = true;
  state.completedAt = new Date().toISOString();
  state.pauseKind = "blocked";
  state.pauseReason = reason;
  for (const stageState of Object.values(state.stageStates)) {
    if (stageState.status !== "running") continue;
    stageState.status = "paused";
    stageState.pauseReason = reason;
  }
}

async function refreshRunControl(context: RunnerContext): Promise<void> {
  const durable = await loadRunState(context.repositoryRoot, context.state.id);
  if (context.state.lease && durable.lease?.generation !== context.state.lease.generation) {
    throw new LeaseSuperseded(`run ${context.state.id} lease was superseded by a newer worker`);
  }
  if (durable.abortRequested) context.state.abortRequested = true;
}

function startLeaseHeartbeat(context: RunnerContext): () => Promise<void> {
  const lease = context.state.lease;
  if (!lease) return async () => {};
  const intervalMs = Math.max(1_000, Math.floor(lease.leaseTimeoutMs / 3));
  const stopTimeoutMs = context.manifest.settings?.continuationPolicy?.heartbeatStopTimeoutMs ?? 5_000;
  let pending: Promise<void> | undefined;
  let lastFailure: string | undefined;
  const timer = setInterval(() => {
    // Never queue unbounded writes behind a wedged filesystem operation. A stale
    // lease lets the detached reaper reclaim this generation instead.
    if (pending) return;
    pending = heartbeatRunLease(context.repositoryRoot, context.state.id, lease.generation)
      .then(async (renewed) => {
        if (!renewed) throw new LeaseSuperseded();
        if (lastFailure) {
          lastFailure = undefined;
          await withTimeout(
            Promise.resolve(context.onEvent?.({ type: "lease.heartbeat.recovered", message: `Lease heartbeat recovered for ${context.state.id}` })),
            1_000,
            "heartbeat recovery notification",
          );
        }
      })
      .catch(async (error) => {
        lastFailure = errorMessage(error);
        if (error instanceof LeaseSuperseded) clearInterval(timer);
        try {
          await withTimeout(
            Promise.all([
              Promise.resolve(context.onEvent?.({ type: "lease.heartbeat.failed", message: `Lease heartbeat failed: ${lastFailure}` })),
              appendRunEvent(context.repositoryRoot, context.state.id, {
                type: "lease.heartbeat.failed",
                generation: lease.generation,
                error: lastFailure,
              }),
            ]),
            1_000,
            "heartbeat failure telemetry",
          );
        } catch {
          // The external reaper observes durable expiry even if telemetry fails.
        }
      })
      .finally(() => {
        pending = undefined;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    const stopped = await waitForHeartbeatStop(pending ?? Promise.resolve(), stopTimeoutMs);
    if (!stopped) {
      try {
        await withTimeout(
          appendRunEvent(context.repositoryRoot, context.state.id, {
            type: "lease.heartbeat.stop_timeout",
            timeoutMs: stopTimeoutMs,
            lastFailure,
          }),
          1_000,
          "heartbeat stop-timeout event write",
        );
      } catch {
        // Never let telemetry wedge run shutdown.
      }
    }
  };
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

async function reportIdleWarning(
  context: RunnerContext,
  stageId: string,
  type: "agent.call.idle" | "validation.command.idle",
  label: string,
  warning: ActivityWarning,
  details: Record<string, unknown>,
): Promise<void> {
  const message = `${label}: no observed activity for ${Math.round(warning.idleMs)}ms (${Math.round(warning.elapsedMs)}ms elapsed); continuing to wait. Silence does not prove a hang.`;
  // Do not mutate run state or treat the lease heartbeat as operation activity.
  await withTimeout(Promise.allSettled([
    appendRunEvent(context.repositoryRoot, context.state.id, { type, stageId, message, ...warning, ...details }),
    Promise.resolve().then(() => context.onEvent?.({ type, stageId, message })),
  ]), 1_000, "idle warning delivery");
}

async function runAgent(
  context: RunnerContext,
  request: AgentRequest,
  label: string,
  warningOverrideMs?: number,
): Promise<AgentResult> {
  const warningAfterMs = warningOverrideMs
    ?? context.manifest.settings?.continuationPolicy?.agentCallTimeoutMs
    ?? context.manifest.settings?.sessionTimeoutMs
    ?? 30 * 60_000;
  const startedAt = Date.now();
  const monitor = monitorActivity(warningAfterMs, (warning) =>
    reportIdleWarning(context, request.stageId, "agent.call.idle", label, warning, { role: request.role }));
  try {
    return await context.backend.run({ ...request, timeoutMs: 0, onActivity: monitor.activity });
  } catch (error) {
    const message = errorMessage(error);
    try {
      await withTimeout(
        appendRunEvent(context.repositoryRoot, context.state.id, {
          type: "agent.call.failed",
          stageId: request.stageId,
          role: request.role,
          error: message,
          warningAfterMs,
        }),
        1_000,
        "agent failure event write",
      );
    } catch {
      // The durable lease/reaper is the fallback when the event filesystem is unavailable.
    }
    return { success: false, text: "", error: message, durationMs: Date.now() - startedAt };
  } finally {
    monitor.stop();
  }
}

async function completeWriterBestEffort(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  gitRoot: string,
  stageStart: Record<string, string>,
  attemptNum: number,
  reason: string,
): Promise<void> {
  // Each repair works on the same worktree. Preserve its final cumulative state
  // at exhaustion rather than resetting it to a previously ranked candidate.
  const retainedAttempt = stageState.attempts.at(-1);
  const finalDelta = await calculateStageDelta(gitRoot, stageStart);
  enforcePathContract(context, stage, finalDelta.changedDuring);
  stageState.changedPaths = unique([...stageState.changedPaths, ...finalDelta.changedDuring]);
  const retainedPatch = await captureBinaryPatch(gitRoot, patchPathsForStage(context, stage, finalDelta.changedDuring));
  stageState.completionMode = "best-effort";
  stageState.bestAttempt = retainedAttempt?.attempt;
  await appendRunEvent(context.repositoryRoot, context.state.id, {
    type: "stage.cumulative_attempt.retained",
    stageId: stage.id,
    attempt: retainedAttempt?.attempt ?? attemptNum,
    patchSha256: sha256(retainedPatch),
    changedPaths: finalDelta.changedDuring,
  });

  const now = new Date().toISOString();
  for (const finding of context.state.findings.filter((entry) => entry.stageId === stage.id && entry.disposition === "open")) {
    finding.disposition = "follow-up-created";
    finding.updatedAt = now;
    finding.resolutionEvidence = {
      repairAttempt: attemptNum,
      changedPaths: finalDelta.changedDuring,
      actor: "best-effort-runtime",
      rationale: reason,
    };
    await persistFinding(context.repositoryRoot, finding);
  }
  await recordStageFollowUp(
    context,
    stage,
    stageState,
    `${reason}${retainedAttempt ? ` Retained the cumulative worktree through attempt ${retainedAttempt.attempt} (${retainedAttempt.status}); no earlier attempt was restored.` : " No usable agent attempt completed."}`,
  );
  await persistBestEffortBoundary(context, stage, stageState, attemptNum, retainedPatch);
}

async function persistBestEffortBoundary(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  attemptNum: number,
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
  await appendRunEvent(context.repositoryRoot, context.state.id, {
    type: "stage.boundary.best_effort",
    stageId: stage.id,
    attempt: attemptNum,
    patchSha256: digest,
    changedPaths: stageState.changedPaths,
    followUpArtifact: stageState.followUpArtifact,
  });
  await writeRunState(context.repositoryRoot, context.state);
}

async function recordStageFollowUp(
  context: RunnerContext,
  stage: TripStage,
  stageState: StageRunState,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = context.state.findings.find((finding) => finding.stageId === stage.id
    && finding.source === "operator"
    && finding.summary === "Best-effort completion requires follow-up");
  if (existing) {
    existing.evidence = `${existing.evidence}\n\n${reason}`;
    existing.updatedAt = now;
    await persistFinding(context.repositoryRoot, existing);
  } else {
    await addFinding(context, {
      id: `finding-${randomUUID()}`,
      runId: context.state.id,
      stageId: stage.id,
      attempt: stageState.attempts.length,
      source: "operator",
      severity: "minor",
      blocking: false,
      summary: "Best-effort completion requires follow-up",
      evidence: reason,
      suggestedRemediation: "Review this note after the full chain completes; preserve completed work and address only the remaining gap.",
      affectedPaths: stageState.changedPaths,
      disposition: "follow-up-created",
      createdAt: now,
      updatedAt: now,
    });
  }
  const notes = context.state.findings.filter((finding) => finding.stageId === stage.id && finding.disposition === "follow-up-created");
  const markdown = [
    `# Follow-ups for ${stage.id}`,
    "",
    `Completion mode: best-effort`,
    stageState.bestAttempt ? `Retained cumulative attempt: ${stageState.bestAttempt}` : "Retained cumulative attempt: none",
    "",
    ...notes.flatMap((finding) => [
      `## ${finding.summary}`,
      "",
      finding.evidence || "No additional evidence was captured.",
      finding.suggestedRemediation ? `\nNext: ${finding.suggestedRemediation}` : "",
      "",
    ]),
  ].join("\n");
  stageState.followUpArtifact = await writeArtifact(
    context.repositoryRoot,
    context.state.id,
    `stages/${stage.id}/follow-ups.md`,
    `${markdown.trim()}\n`,
  );
  await writeRunState(context.repositoryRoot, context.state);
}

async function writeRunFollowUpSummary(context: RunnerContext): Promise<void> {
  const notes = context.state.findings.filter((finding) => finding.disposition === "follow-up-created" || finding.disposition === "accepted-risk");
  if (!notes.length) return;
  const markdown = [
    `# Follow-ups for ${context.state.id}`,
    "",
    "The prompt chain completed all safe work. These items were deliberately deferred instead of wedging the run.",
    "",
    ...notes.flatMap((finding) => [
      `## ${finding.stageId}: ${finding.summary}`,
      "",
      finding.evidence || "No additional evidence was captured.",
      finding.suggestedRemediation ? `\nNext: ${finding.suggestedRemediation}` : "",
      "",
    ]),
  ].join("\n");
  await writeArtifact(context.repositoryRoot, context.state.id, "follow-ups.md", `${markdown.trim()}\n`);
}

function isRecoverableWorkspaceDriftError(error: unknown): boolean {
  return /out-of-scope paths|workspace drift detected|workspace changes that no stage owns/i.test(errorMessage(error));
}

function isSafetyBoundaryError(error: unknown): boolean {
  return /outside (?:its )?allowed path contract|out-of-scope paths|HEAD moved|patch hash mismatch|workspace drift|direct commit|immutable run base revision/i.test(errorMessage(error));
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
