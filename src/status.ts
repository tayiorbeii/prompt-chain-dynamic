import type { Keybinding } from "@earendil-works/pi-tui";
import type { AttemptRecord, Finding, RunState, StageRunState, TripStage, ValidationResult } from "./types.ts";

const STATUS_ICON: Record<StageRunState["status"], string> = {
  pending: "·",
  running: "▶",
  paused: "!",
  completed: "✓",
  failed: "×",
  skipped: "↷",
};

export interface RunSummarySections {
  header: string[];
  stages: Array<{ id: string; title: string; lines: string[] }>;
}

export type StatusInputAction =
  | "close"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "confirm"
  | "space"
  | "left"
  | "right"
  | "next"
  | "previous"
  | "expandAll"
  | "collapseAll"
  | "top"
  | "bottom"
  | "follow"
  | "refresh";

export function resolveStatusInput(
  data: string,
  matches: (data: string, keybinding: Keybinding) => boolean,
): StatusInputAction | undefined {
  if (matches(data, "tui.select.cancel") || data === "q") return "close";
  if (data === "j") return "next";
  if (data === "k") return "previous";
  if (matches(data, "tui.select.up")) return "up";
  if (matches(data, "tui.select.down")) return "down";
  if (matches(data, "tui.select.pageUp")) return "pageUp";
  if (matches(data, "tui.select.pageDown")) return "pageDown";
  if (matches(data, "tui.select.confirm")) return "confirm";
  if (data === " ") return "space";
  if (matches(data, "tui.editor.cursorLeft") || data === "h") return "left";
  if (matches(data, "tui.editor.cursorRight") || data === "l") return "right";
  if (data === "e") return "expandAll";
  if (data === "c") return "collapseAll";
  if (data === "g") return "top";
  if (data === "G") return "bottom";
  if (data === "f") return "follow";
  if (data === "r") return "refresh";
  return undefined;
}

export function buildRunSummarySections(state: RunState, requestedAt = new Date()): RunSummarySections {
  const openBlockers = state.findings.filter((finding) => finding.blocking && finding.disposition === "open");
  const followUps = state.findings.filter((finding) => finding.disposition === "follow-up-created");
  const terminal = state.status === "completed" || state.status === "failed" || state.status === "aborted";
  const runEnd = state.completedAt ?? (terminal ? state.updatedAt : requestedAt.toISOString());
  const header = [
    `Run: ${state.id} — ${state.manifest.name}`,
    `Status: ${state.status}${state.pauseKind ? ` (${state.pauseKind})` : ""}`,
    `Status requested: ${formatTimestamp(requestedAt.toISOString())}`,
    `Run requested: ${formatTimestamp(state.createdAt)}`,
    `Run started: ${formatTimestamp(state.startedAt)}`,
    `Last update: ${formatTimestamp(state.updatedAt)}`,
    `Run finished: ${formatTimestamp(terminal ? runEnd : undefined)}`,
    `Run elapsed since start: ${formatDuration(state.startedAt ?? state.createdAt, runEnd)}`,
    `Abort requested: ${state.abortRequested ? "yes" : "no"}`,
    `Lease: ${formatLease(state, requestedAt)}`,
    `Decision mode: ${state.decisionMode}`,
    `Open blockers: ${openBlockers.length}`,
    `Deferred follow-up items: ${followUps.length}`,
    `Result commit: ${state.resultCommit ?? "none"}`,
  ];
  if (state.followUpRunIds?.length) header.push(`Follow-up runs: ${state.followUpRunIds.join(", ")}`);
  if (state.pauseReason) header.push(`Pause reason: ${state.pauseReason}`);

  const stages = state.manifest.stages.map((stage) => {
    const lines = formatStage(stage, state.stageStates[stage.id], state.findings, requestedAt, state.status, runEnd, state.manifest.settings?.continuationPolicy?.maxWorkerReflections ?? 3);
    return { id: stage.id, title: lines[0] ?? `? ${stage.id}`, lines: lines.slice(1) };
  });
  return { header, stages };
}

export function formatRunSummary(state: RunState, requestedAt = new Date()): string {
  const sections = buildRunSummarySections(state, requestedAt);
  return [
    ...sections.header,
    "",
    `Steps (${sections.stages.length}):`,
    ...sections.stages.flatMap((stage) => [stage.title, ...stage.lines]),
  ].join("\n");
}

function formatStage(
  stage: TripStage,
  value: StageRunState | undefined,
  findings: Finding[],
  requestedAt: Date,
  runStatus: RunState["status"],
  runEnd: string,
  maxWorkerReflections = 3,
): string[] {
  if (!value) {
    return [
      `? ${stage.id} — state unavailable`,
      `  Type: ${stage.type} | Isolation: ${stage.isolation} | Required: ${stage.required === false ? "no" : "yes"}`,
      `  Task: ${summarizePrompt(stage.prompt)}`,
      `  Depends on: ${formatList(stage.needs)}`,
    ];
  }

  const interruptedByAbort = runStatus === "aborted" && value.status === "running";
  const stageEnd = value.completedAt ?? (interruptedByAbort ? runEnd : requestedAt.toISOString());
  const stageFindings = findings.filter((finding) => finding.stageId === stage.id);
  const openBlockers = stageFindings.filter((finding) => finding.blocking && finding.disposition === "open");
  const latestAttempt = value.attempts.at(-1);
  const validation = validationSummary(value.validationResults);
  const attemptsByStatus = countAttempts(value.attempts);
  const lines = [
    `${interruptedByAbort ? "!" : STATUS_ICON[value.status]} ${stage.id} — ${interruptedByAbort ? "interrupted by abort (recorded: running)" : value.status}`,
    `  Type: ${stage.type} | Isolation: ${stage.isolation} | Required: ${stage.required === false ? "no" : "yes"}`,
    `  Task: ${summarizePrompt(stage.prompt)}`,
    `  Depends on: ${formatList(stage.needs)}`,
    `  Started: ${formatTimestamp(value.startedAt)} | Finished: ${formatTimestamp(value.completedAt)} | Elapsed since start: ${formatDuration(value.startedAt, stageEnd)}`,
    `  Attempts: ${value.attempts.length} (accepted ${attemptsByStatus.keep}, repair requested ${attemptsByStatus.discard}, checks failed ${attemptsByStatus.checks_failed}, crashed ${attemptsByStatus.crash}) | Repair rounds: ${value.reviewRounds} | Worker reflections: ${value.workerReflections ?? 0}/${maxWorkerReflections}`,
  ];

  if (latestAttempt) lines.push(`  Latest attempt: ${formatAttempt(latestAttempt, requestedAt)}`);
  lines.push(`  Validation: ${validation}`);
  if (value.schedulingReason) lines.push(`  Scheduling: ${formatSchedulingReason(value.schedulingReason)}`);
  if (value.blockedBy?.length) lines.push(`  Blocked by: ${value.blockedBy.join(", ")}`);
  if (value.pauseReason) lines.push(`  Pause reason: ${value.pauseReason}`);

  lines.push(`  Open blockers: ${openBlockers.length}`);
  for (const finding of openBlockers.slice(0, 3)) {
    lines.push(`    - [${finding.severity}] ${finding.summary} (${finding.source}, attempt ${finding.attempt})`);
  }
  if (openBlockers.length > 3) lines.push(`    - … ${openBlockers.length - 3} more`);

  lines.push(`  Verified changed paths (${value.changedPaths.length}; finalized on acceptance): ${formatList(value.changedPaths, 5)}`);
  if (stage.outputs?.length) lines.push(`  Expected outputs: ${formatList(stage.outputs, 5)}`);
  if (value.verifiedCommit) lines.push(`  Verified commit: ${value.verifiedCommit}`);
  if (value.worktreePath) lines.push(`  Worktree: ${value.worktreePath}`);
  if (value.patchPath) lines.push(`  Patch: ${value.patchPath}`);
  return lines;
}

function formatLease(state: RunState, requestedAt: Date): string {
  if (!state.lease) return "not recorded";
  const heartbeat = Date.parse(state.lease.heartbeatAt);
  const age = requestedAt.getTime() - heartbeat;
  const freshness = !Number.isFinite(age)
    ? "invalid timestamp"
    : state.status !== "running"
      ? `inactive (${state.status}); last heartbeat age ${formatMilliseconds(Math.max(0, age))}`
      : age <= state.lease.leaseTimeoutMs
        ? `live; age ${formatMilliseconds(Math.max(0, age))}`
        : `stale; overdue by ${formatMilliseconds(age - state.lease.leaseTimeoutMs)}`;
  return `generation ${state.lease.generation} | heartbeat ${formatTimestamp(state.lease.heartbeatAt)} | ${freshness}`;
}

function formatAttempt(attempt: AttemptRecord, requestedAt: Date): string {
  const end = attempt.completedAt ?? requestedAt.toISOString();
  return `#${attempt.attempt} ${attempt.role} → ${attemptOutcomeLabel(attempt.status)} | started ${formatTimestamp(attempt.startedAt)} | finished ${formatTimestamp(attempt.completedAt)} | elapsed ${formatDuration(attempt.startedAt, end)}`;
}

function attemptOutcomeLabel(status: AttemptRecord["status"]): string {
  if (status === "keep") return "accepted";
  if (status === "discard") return "repair requested (changes retained)";
  if (status === "checks_failed") return "checks failed (changes retained)";
  return "crashed";
}

function validationSummary(results: ValidationResult[]): string {
  if (!results.length) return "not run";
  const passed = results.filter((result) => result.exitCode === 0 && !result.timedOut).length;
  const failed = results.length - passed;
  const duration = results.reduce((total, result) => total + result.durationMs, 0);
  return `${passed}/${results.length} passed${failed ? `, ${failed} failed` : ""} in ${formatMilliseconds(duration)}`;
}

function countAttempts(attempts: AttemptRecord[]): Record<AttemptRecord["status"], number> {
  const counts: Record<AttemptRecord["status"], number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const attempt of attempts) counts[attempt.status] += 1;
  return counts;
}

function formatSchedulingReason(reason: StageRunState["schedulingReason"]): string {
  if (!reason) return "none";
  if (reason.kind === "waiting_on_failed_dependency") return `waiting on failed dependency ${reason.dependencyId}`;
  return reason.kind.replaceAll("_", " ");
}

function summarizePrompt(prompt: string): string {
  const compact = prompt.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "not provided";
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact;
}

function formatList(values: string[], limit = values.length): string {
  if (!values.length) return "none";
  const visible = values.slice(0, limit);
  return `${visible.join(", ")}${values.length > visible.length ? `, … +${values.length - visible.length}` : ""}`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function formatDuration(start: string | undefined, end: string | undefined): string {
  if (!start || !end) return "not available";
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "not available";
  return formatMilliseconds(endMs - startMs);
}

function formatMilliseconds(milliseconds: number): string {
  if (milliseconds < 1_000) return "<1s";
  let remaining = Math.floor(milliseconds / 1_000);
  const days = Math.floor(remaining / 86_400);
  remaining %= 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining %= 3_600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const parts = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, seconds && `${seconds}s`].filter(Boolean);
  return parts.slice(0, 3).join(" ") || "<1s";
}
