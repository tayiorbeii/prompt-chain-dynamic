import path from "node:path";
import { auditCompletion, type AuditResult } from "./audit.ts";
import { runManifestFile } from "./runner.ts";
import { Supervisor } from "./supervisor.ts";
import {
  appendRunEvent,
  atomicWriteJson,
  loadRunState,
  persistFinding,
  runRoot,
  writeRunState,
} from "./store.ts";
import { assertValidManifest } from "./validation.ts";
import type { AgentBackend, RunState, TripManifest, TripStage } from "./types.ts";

/** A unit of deferred work extracted from a completed run. */
export interface FollowUpItem {
  /** Stage in the source run that deferred this work. */
  stageId: string;
  /** Finding ids that this item resolves when its follow-up run completes. */
  findingIds: string[];
  summary: string;
  evidence: string;
  remediation?: string;
  affectedPaths: string[];
}

export interface FollowUpRunRecord {
  round: number;
  runId: string;
  status: RunState["status"];
  manifestPath: string;
  stageCount: number;
  itemCount: number;
}

export interface FollowUpReport {
  runs: FollowUpRunRecord[];
  /** Deferred items still unaddressed after the final round. */
  remainingItems: number;
  notes: string[];
}

export interface AutonomousCompletionReport extends FollowUpReport {
  /** Final durable state of the original run. */
  state: RunState;
  audit?: AuditResult;
}

export interface FollowUpOptions {
  repositoryRoot: string;
  /** Completed source run whose deferred work should be executed. */
  state: RunState;
  backend?: AgentBackend;
  humanDecisions?: boolean;
  /** Maximum autonomous remediation rounds. Defaults to 3. */
  maxRounds?: number;
  /** Feed unverified acceptance criteria from the completion audit into round 1. Defaults to true. */
  auditCriteria?: boolean;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
}

export interface AutonomousOptions extends Omit<FollowUpOptions, "state"> {
  state: RunState;
  /** Disable the autonomous follow-up phase entirely. */
  followUps?: boolean;
}

const TERMINAL: ReadonlySet<RunState["status"]> = new Set(["completed", "failed", "aborted"]);

/** Extract every deferred finding from a run as executable follow-up items. */
export function collectFollowUpItems(state: RunState): FollowUpItem[] {
  return state.findings
    .filter((finding) => finding.disposition === "follow-up-created")
    .map((finding) => ({
      stageId: finding.stageId,
      findingIds: [finding.id],
      summary: finding.summary,
      evidence: finding.evidence,
      remediation: finding.suggestedRemediation,
      affectedPaths: finding.affectedPaths ?? [],
    }));
}

/** Convert unverified acceptance criteria from a completion audit into follow-up items. */
export function followUpItemsFromAudit(state: RunState, audit: AuditResult): FollowUpItem[] {
  return audit.criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => ({
      stageId: criterion.stageId,
      findingIds: [],
      summary: `Unverified acceptance criterion: ${criterion.criterion}`,
      evidence: `The completion audit could not verify this criterion for run ${state.id}${criterion.reason ? ` (${criterion.reason})` : ""}.`,
      remediation: criterion.criterion,
      affectedPaths: [],
    }));
}

/**
 * Build a validated same-checkout-serial manifest that executes deferred items.
 * Writer stages are derived from the source run's implementation stages so the
 * original path contracts and validation commands carry over. Items that
 * originate from readonly or unknown stages are folded into the integration
 * stage as verification context. Returns undefined when no item maps onto an
 * executable writer stage.
 */
export function buildFollowUpManifest(state: RunState, items: FollowUpItem[], round: number): TripManifest | undefined {
  if (!items.length) return undefined;
  const byStage = new Map<string, FollowUpItem[]>();
  for (const item of items) {
    const bucket = byStage.get(item.stageId) ?? [];
    bucket.push(item);
    byStage.set(item.stageId, bucket);
  }

  const orderedStages = state.manifest.stages.filter((stage) => byStage.has(stage.id));
  const writerOrigins = orderedStages.filter((stage) => stage.type === "implementation" && stage.allowedPaths?.length && stage.claimedPaths?.length);
  if (!writerOrigins.length) return undefined;

  const writerStageIds = new Set(writerOrigins.map((stage) => stage.id));
  const extras = items.filter((item) => !writerStageIds.has(item.stageId));

  let previous: string | undefined;
  const stages: TripStage[] = [];
  for (const origin of writerOrigins) {
    const id = `followup-${origin.id.replace(/^followup-/, "")}`;
    stages.push({
      id,
      type: "implementation",
      needs: previous ? [previous] : [],
      isolation: "same-checkout",
      prompt: followUpStagePrompt(state, origin, byStage.get(origin.id) ?? []),
      allowedPaths: origin.allowedPaths,
      claimedPaths: origin.claimedPaths,
      validationCommands: origin.validationCommands,
    });
    previous = id;
  }
  stages.push({
    id: "followup-integration",
    type: "integration",
    needs: previous ? [previous] : [],
    isolation: "same-checkout",
    integrationStrategy: "same-checkout-finalize",
    prompt: followUpIntegrationPrompt(state, extras),
  });

  const baseName = state.manifest.name.replace(/ — follow-up round \d+$/, "");
  return assertValidManifest({
    schemaVersion: 1,
    name: `${baseName} — follow-up round ${round}`,
    workingDirectory: state.manifest.workingDirectory,
    metadata: {
      ...state.manifest.metadata,
      sourceGuide: `autonomous follow-ups of run ${state.id}`,
      generatedAt: new Date().toISOString(),
    },
    settings: state.manifest.settings,
    stages,
  });
}

/**
 * Execute deferred follow-up work from a completed run until nothing remains,
 * a round fails to complete, or the round budget is exhausted. Each round
 * compiles the deferred findings (and, in round 1, unverified acceptance
 * criteria) into a fresh manifest, runs it with the same recovery machinery as
 * the original chain, and durably resolves the source findings on success.
 */
export async function runFollowUpRounds(options: FollowUpOptions): Promise<FollowUpReport> {
  const repository = path.resolve(options.repositoryRoot);
  const maxRounds = options.maxRounds ?? 3;
  const rootId = options.state.id;
  const runs: FollowUpRunRecord[] = [];
  const notes: string[] = [];
  let current = options.state;

  for (let round = 1; round <= maxRounds; round += 1) {
    let items = collectFollowUpItems(current);
    if (round === 1 && options.auditCriteria !== false) {
      try {
        const audit = await auditCompletion(repository, current);
        items = dedupeItems([...items, ...followUpItemsFromAudit(current, audit)]);
      } catch (error) {
        notes.push(`Completion audit was skipped: ${errorMessage(error)}`);
      }
    }
    if (!items.length) break;

    const manifest = buildFollowUpManifest(current, items, round);
    if (!manifest) {
      notes.push(`${items.length} deferred item(s) had no executable writer stage and remain recorded in follow-ups.md.`);
      break;
    }

    const manifestPath = path.join(runRoot(repository, rootId), "follow-ups", `round-${round}.trip.json`);
    await atomicWriteJson(manifestPath, manifest);
    await appendRunEvent(repository, rootId, {
      type: "follow_up.round.started",
      round,
      manifestPath,
      sourceRunId: current.id,
      stageCount: manifest.stages.length,
      itemCount: items.length,
    });
    await options.onEvent?.({
      type: "follow_up.round.started",
      message: `Follow-up round ${round}: executing ${items.length} deferred item(s) across ${manifest.stages.length} step(s)`,
    });

    let run: RunState;
    try {
      run = await runManifestFile({
        manifestPath,
        humanDecisions: options.humanDecisions,
        backend: options.backend,
        onEvent: options.onEvent,
      });
      run = await superviseToTerminal(repository, run, options.backend, options.onEvent);
    } catch (error) {
      notes.push(`Follow-up round ${round} failed to launch: ${errorMessage(error)}`);
      await appendRunEvent(repository, rootId, { type: "follow_up.round.failed", round, error: errorMessage(error) });
      break;
    }

    runs.push({
      round,
      runId: run.id,
      status: run.status,
      manifestPath,
      stageCount: manifest.stages.length,
      itemCount: items.length,
    });
    await appendRunEvent(repository, rootId, {
      type: `follow_up.round.${run.status}`,
      round,
      runId: run.id,
      resultCommit: run.resultCommit,
    });

    // Durably link the follow-up run and, on success, resolve its source findings.
    const source = await loadRunState(repository, current.id);
    source.followUpRunIds = [...new Set([...(source.followUpRunIds ?? []), run.id])];
    if (run.status === "completed") {
      const resolved = new Set(items.flatMap((item) => item.findingIds));
      const now = new Date().toISOString();
      for (const finding of source.findings) {
        if (!resolved.has(finding.id)) continue;
        finding.disposition = "resolved";
        finding.updatedAt = now;
        finding.resolutionEvidence = {
          actor: "follow-up-runtime",
          rationale: `Addressed by autonomous follow-up run ${run.id} (round ${round}).`,
          changedPaths: Object.values(run.stageStates).flatMap((stage) => stage.changedPaths),
        };
        await persistFinding(repository, finding);
      }
    }
    await writeRunState(repository, source);

    if (run.status !== "completed") {
      notes.push(`Follow-up round ${round} (${run.id}) ended ${run.status}${run.pauseReason ? `: ${run.pauseReason}` : ""}.`);
      current = run;
      break;
    }
    current = run;
  }

  return { runs, remainingItems: collectFollowUpItems(current).length, notes };
}

/**
 * Drive a run to a truly finished result: supervise it through recoveries to a
 * terminal state, then autonomously execute its deferred follow-ups and next
 * steps, and finally audit completion. Mirrors the pi-goal contract — the run
 * is not "done" while safe, in-scope work remains.
 */
export async function completeChainAutonomously(options: AutonomousOptions): Promise<AutonomousCompletionReport> {
  const repository = path.resolve(options.repositoryRoot);
  let state = await superviseToTerminal(repository, options.state, options.backend, options.onEvent);

  if (state.status !== "completed") {
    const operatorNote = state.status === "paused" && state.pauseKind === "decision_pending" && state.decisionMode === "human"
      ? `Run ${state.id} is waiting for a human decision. Record it with /prompt-chain-decide, then /prompt-chain-resume.`
      : state.status === "paused" && state.pauseKind === "workspace_drift"
        ? `Run ${state.id} paused before commit because the workspace needs cleanup. Preserve or move the paths named in the pause reason, then run /prompt-chain-resume ${state.id}.`
        : state.status === "paused" && state.pauseKind === "review_blocked"
          ? `Run ${state.id} paused without committing because required integration evidence is still blocked. Supply or fix that evidence, then run /prompt-chain-resume ${state.id} for another bounded repair window.`
          : `Run ${state.id} ended ${state.status}; follow-ups were not started.`;
    return {
      state,
      runs: [],
      remainingItems: collectFollowUpItems(state).length,
      notes: [operatorNote],
    };
  }

  let followUps: FollowUpReport = { runs: [], remainingItems: 0, notes: [] };
  if (options.followUps !== false) {
    followUps = await runFollowUpRounds({
      repositoryRoot: repository,
      state,
      backend: options.backend,
      humanDecisions: options.humanDecisions,
      maxRounds: options.maxRounds,
      auditCriteria: options.auditCriteria,
      onEvent: options.onEvent,
    });
    state = await loadRunState(repository, state.id);
  }

  let audit: AuditResult | undefined;
  try {
    audit = await auditCompletion(repository, state);
  } catch (error) {
    followUps.notes.push(`Final completion audit failed: ${errorMessage(error)}`);
  }
  return { state, ...followUps, audit };
}

export function formatAutonomousReport(report: AutonomousCompletionReport): string {
  const lines: string[] = ["Autonomous completion:"];
  if (!report.runs.length) lines.push("  Follow-up rounds: none needed");
  for (const run of report.runs) {
    lines.push(`  Round ${run.round}: ${run.runId} — ${run.status} (${run.itemCount} item(s), ${run.stageCount} step(s))`);
  }
  lines.push(`  Remaining deferred items: ${report.remainingItems}`);
  if (report.audit) {
    const passed = report.audit.criteria.filter((criterion) => criterion.passed).length;
    lines.push(`  Completion audit: ${report.audit.passed ? "PASS" : "FAIL"} (${passed}/${report.audit.criteria.length} criteria verified)`);
  }
  for (const note of report.notes) lines.push(`  Note: ${note}`);
  return lines.join("\n");
}

/** Supervise a non-terminal run until completed/aborted or a non-recoverable stop. */
export async function superviseToTerminal(
  repository: string,
  state: RunState,
  backend?: AgentBackend,
  onEvent?: FollowUpOptions["onEvent"],
): Promise<RunState> {
  if (TERMINAL.has(state.status)) return state;
  if (state.status === "paused" && state.pauseKind === "decision_pending" && state.decisionMode === "human") return state;
  const supervisor = new Supervisor({ repositoryRoot: repository, runId: state.id, backend, onEvent });
  return await supervisor.start();
}

function followUpStagePrompt(state: RunState, origin: TripStage, items: FollowUpItem[]): string {
  const numbered = items.map((item, index) => [
    `${index + 1}. ${item.summary}`,
    `   Evidence: ${truncate(item.evidence, 500)}`,
    item.remediation ? `   Required remediation: ${item.remediation}` : undefined,
    item.affectedPaths.length ? `   Affected paths: ${item.affectedPaths.join(", ")}` : undefined,
  ].filter(Boolean).join("\n"));
  return [
    `You are completing deferred follow-up work from prompt-chain run ${state.id}, step "${origin.id}".`,
    "",
    "Original step objective (context only — most of it is already done):",
    truncate(origin.prompt, 700),
    "",
    "Deferred items to complete now:",
    ...numbered,
    "",
    "Rules:",
    "- Complete only the remaining gap; do not regress or rewrite work that already passed review.",
    "- Stay strictly within this step's allowed paths.",
    "- Run this step's validation commands before finishing.",
    "",
    "**Acceptance Criteria**:",
    ...items.map((item) => `- ${item.remediation ?? item.summary}`),
  ].join("\n");
}

function followUpIntegrationPrompt(state: RunState, extras: FollowUpItem[]): string {
  const extraLines = extras.length
    ? [
        "",
        "Additional deferred notes from non-writer steps — verify each is addressed or explicitly record why it is out of scope:",
        ...extras.map((item) => `- [${item.stageId}] ${item.summary}${item.remediation ? ` — ${item.remediation}` : ""}`),
      ]
    : [];
  return [
    `Integrate the follow-up work for prompt-chain run ${state.id}.`,
    "Verify the combined result builds and passes the final validation commands, then finalize the checkout.",
    ...extraLines,
  ].join("\n");
}

function dedupeItems(items: FollowUpItem[]): FollowUpItem[] {
  const seen = new Set<string>();
  const output: FollowUpItem[] = [];
  for (const item of items) {
    const key = `${item.stageId}::${(item.remediation ?? item.summary).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function truncate(value: string, limit: number): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
