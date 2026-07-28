# Further Autonomy Opportunities — Prompt-Chain Dynamic Runtime v0.2.0

> **Status**: Planning document. Nothing here is implemented. All designs are proposals subject to review.
>
> **Pre-merge audit gate**: Every opportunity below must include a security/risk review and pass the existing
> acceptance gates (`docs/ACCEPTANCE-GATES.md`) before any merge.

---

## Table of Contents

1. [Background Execution with Result Delivery](#1-background-execution-with-result-delivery)
2. [Agent Tool Surface via `pi.registerTool`](#2-agent-tool-surface-via-piregistertool)
3. [Notification / Intercom Hooks](#3-notification--intercom-hooks)
4. [Further Autonomy & Utility Gaps](#4-further-autonomy--utility-gaps)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Implementation Sequencing](#6-implementation-sequencing)

---

## 1. Background Execution with Result Delivery

### Motivation & User Story

**Parity target**: `pi-workflows` and `pi-goal` both support `background: true` — a run launches detached from
the chat turn, the slash command returns immediately, and the agent is free to continue working. When the
background run completes (or pauses for a human decision), the final report or pause notice is delivered back
into the active conversation.

**User story**: "I want to `/prompt-chain-run manifest.json --background` and get back to reviewing code.
When the chain finishes, push its autonomous completion report into my chat. If it paused on a decision,
surface that decision prompt."

**Current state**: `/prompt-chain-run` and `/prompt-chain-supervise` block the chat turn. They supervise
to terminal and run follow-up rounds synchronously inside the handler. The `RunReaper` already supports
out-of-process recovery (stale-lease reclaim), so a detached supervisor process is architecturally viable.

### Design

#### 1a. Background spawn via a daemon supervisor

Add `src/daemon.ts` — a lightweight process that:

1. `claimRunLease` on the run (same mechanics as `RunReaper`)
2. Enters a polling loop (respecting `ContinuationPolicy.reaperPollIntervalMs`)
3. Calls `superviseToTerminal` from `src/followups.ts` when it wins the lease
4. On terminal: runs `completeChainAutonomously`, writes the `AutonomousCompletionReport` to a well-known
   result file under `.pi/prompt-chain-hybrid/runs/<id>/background-result.json`, then exits 0
5. On pause with `pauseKind === "decision_pending"` and `decisionMode === "human"`: writes a
   `background-decision-request.json`, sets run status to `paused`, and exits 2

**Key invariant**: The daemon is just another lease-consumer. `claimRunLease`'s single-owner guarantee
means at most one supervisor (chat-turned or daemon) ever owns a run. If the daemon dies, `RunReaper`
reclaims the stale lease after `ContinuationPolicy.leaseTimeoutMs` — no different from a crashed chat-turn
supervisor.

#### 1b. `--background` flag on existing commands

Add to `src/index.ts` handlers:

- `/prompt-chain-run <manifest.json> [--background] [--no-follow-ups]`
- `/prompt-chain-supervise <run-id> [--background]`

When `--background` is present:
1. If the run is already leased (running), warn and refuse.
2. Spawn `daemon.ts` via `child_process.fork` or `worker_threads` with the run id and `--daemon` flag.
3. Return immediately: `"Run X started in background (pid Y). Check /prompt-chain-status ${runId} later, or wait with /prompt-chain-supervise ${runId}"`.

The existing `/prompt-chain-run` handler already calls `runManifestFile` then `completeChainAutonomously`.
When `--background` is provided, it should instead:
1. Call `runManifestFile` in-process to initialize storage and start the run.
2. Fork the daemon with the initialized run id.
3. Not block for completion.

#### 1c. Result delivery mechanism

When the daemon exits and a result file exists:

**Approach A (poll on next turn — simpler)**: Extend `/prompt-chain-status` to detect and render
`background-result.json`. When the agent checks status, it sees the result. This is the minimum viable
approach — the agent must remember to check.

**Approach B (push via intercom — more sophisticated)**: The daemon writes the result file *and* calls
`pi-intercom` to deliver the report as a message to the originating session. This requires the daemon to
have intercom credentials (cloning the session socket). See Opportunity #3 for the intercom hook design
that enables this.

**Approach C (push via supervisor handoff)**: Keep the main command blocked but fork supervision to the
daemon. The main handler polls the `background-result.json` with a periodic heartbeat, forwarding progress
via `setStatus`. This gives real-time feedback without blocking indefinitely (the daemon handles lease
renewal). When the result file appears, render it and return.

**Recommendation**: Combine A (baseline) + C (for interactive users). The handler accepts `--background`,
returns a run id immediately, and provides an optional `--wait` flag that enables Approach C's poll-and-forward.

#### 1d. Types & events

```typescript
// src/types.ts additions

export interface BackgroundRunOptions {
  repositoryRoot: string;
  runId: string;
  manifestPath?: string;
  noFollowUps?: boolean;
  maxFollowUpRounds?: number;
}

export interface BackgroundResultFile {
  runId: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  status: RunState["status"];
  pauseKind?: RunState["pauseKind"];
  pauseReason?: string;
  decisionRequest?: DecisionRequest;
  report?: AutonomousCompletionReport;
  error?: string;
}
```

New event types: `"run.background_started"`, `"run.background_completed"`, `"run.background_paused"`.

#### Files touched

| File | Change |
|------|--------|
| `src/daemon.ts` | **NEW** — fork entry point, lease-based supervision loop, result-file writer |
| `src/index.ts` | Add `--background` flag parsing to run/supervise command handlers; fork daemon |
| `src/types.ts` | Add `BackgroundRunOptions`, `BackgroundResultFile` |
| `src/store.ts` | Export `backgroundResultPath(repositoryRoot, runId)` — deterministic result file path |
| `src/runner.ts` | No change needed (already handles everything a supervisor needs) |
| `src/followups.ts` | No change needed (`completeChainAutonomously`, `superviseToTerminal` are the daemon's targets) |
| `src/reaper.ts` | No change needed (daemon is just another lease client) |
| `bin/trip-headless.ts` | Add `--background` / `--daemon` subcommand |
| `.pi/prompt-chain-hybrid/runs/<id>/background-result.json` | Durable result landing path |

### Interaction with Existing Invariants

- **Lease generations**: The daemon claims the lease identically to an in-process supervisor. `claimRunLease`
  ensures generation monotonicity (`LeaseGenerationMismatchError`). If the daemon crashes, `RunReaper`
  reclaims after `leaseTimeoutMs`.
- **Single-supervisor**: Guaranteed by lease. A `--background` + simultaneous chat-turn `--supervise`
  on the same run — the second caller sees the lease is fresh and refuses.
- **Human-decision pause guard**: If `ContinuationPolicy.bestEffortCompletion === false` and the run pauses,
  the daemon writes the decision-request file and exits 2. The agent discovers it on next status check.
  No automatic follow-ups proceed.
- **`--no-follow-ups` opt-out**: Passed transparently through to `completeChainAutonomously`.
- **Path contracts and validation**: Unchanged — the daemon runs `superviseToTerminal` which uses
  `buildFollowUpManifest` with identical stage contract inheritance.

### Testing Strategy

| Test | What it validates |
|------|-------------------|
| `tests/daemon.test.ts` — `daemon claims lease and supervises` | Fork `daemon.ts` with a completed manifest, verify `background-result.json` written with `status: "completed"` |
| `tests/daemon.test.ts` — `--no-follow-ups suppresses follow-up rounds` | Same setup but `noFollowUps: true`, verify report has no follow-up runs |
| `tests/daemon.test.ts` — `daemon exits on human decision pause` | Manifest with best-effort = false, pause kind = decision_pending, verify exit 2 and decision-request artifact |
| `tests/daemon.test.ts` — `stale lease reclaimed` | Start daemon, kill it, verify `RunReaper` reclaims after timeout |
| `tests/index.test.ts` — `--background handler forks process` | Mock `child_process.fork`, verify handler returns immediately with run id |

Use the existing `fixture-state` pattern: pre-seeded `.pi/prompt-chain-hybrid/runs/<id>/` directories with
known `run.json` and `manifest.json`.

### Risks & Open Questions

1. **Environment inheritance**: `child_process.fork` inherits `process.env` by default. The `PI_DURABLE_TRIP_WORKER`
   guard must be set to `"1"` in the forked process. Ensure all env vars the runtime needs (API keys, provider
   config) are inherited. Risk: An env var that the main process loaded asynchronously may not be available
   at fork time.
2. **Intercom push (Approach B) requires session credentials**. The daemon cannot directly call `ctx.ui.notify`
   because there is no live `ExtensionContext` in a forked background process. Intercom messages require an
   active broker connection. Viable path: serialize the session's intercom credentials (session id, broker
   address) at fork time and reconnect in the daemon.
3. **Resource cleanup**: If the agent shuts down while background daemons are alive, they become orphaned
   but continue running. The lease heartbeat keeps them alive. On next agent start, `RunReaper` may or may
   not reclaim them depending on `leaseIsFresh`. This is correct but surprising — document the behavior.
4. **Concurrent daemons**: Multiple `--background` runs can coexist because each has its own run id and
   lease. `trip-headless.ts` already supports concurrent runs.

### Effort Estimate

| Component | Estimated effort | Dependencies |
|-----------|-----------------|--------------|
| `src/daemon.ts` — core loop + result file | 3-4 days | None |
| `src/index.ts` — `--background` flag + fork | 1-2 days | daemon.ts |
| `bin/trip-headless.ts` — `--daemon` entry | 0.5 day | daemon.ts |
| Tests | 2-3 days | daemon.ts |
| **Total** | **6.5-9.5 days** | |

---

## 2. Agent Tool Surface via `pi.registerTool`

### Motivation & User Story

**Parity target**: `pi-intercom` registers the `intercom` tool via `pi.registerTool`, making intercom
operations directly callable by the agent without slash-command syntax. The prompt-chain hybrid should
do the same — let the agent programmatically launch, monitor, resume, decide, and drain chains.

**User story**: "As an agent orchestrating a refactor, I want to call `prompt-chain-run({ manifest, background: true })`
from my own tool-use and get back a structured report, not parse a `/prompt-chain-run` response string."

**Current state**: All operations are exposed via `pi.registerCommand` only. The agent must use slash-command
syntax, which produces human-readable text the agent then re-parses. Structured tool results (JSON with typed
fields) are more reliable and consume fewer tokens.

### Design

#### 2a. Tool registration schema

Add `registerTool` calls in `src/index.ts` following the `pi-intercom` pattern (TypeBox schemas from `typebox`):

```typescript
import { Type } from "typebox";

pi.registerTool({
  name: "prompt-chain-run",
  label: "Run Prompt Chain",
  description: "Execute a prompt-chain DAG manifest with full supervision, recovery, and follow-up rounds.",
  promptSnippet: "Use to run a prompt-chain manifest file when you need multi-stage implementation with review, repair, and autonomous follow-up.",
  parameters: Type.Object({
    manifest: Type.String({ description: "Path to the .trip.json manifest file (relative to cwd or absolute)" }),
    background: Type.Optional(Type.Boolean({ description: "Run detached from the chat turn (default: false)" })),
    noFollowUps: Type.Optional(Type.Boolean({ description: "Skip autonomous follow-up rounds on completion (default: false)" })),
    humanDecisions: Type.Optional(Type.Boolean({ description: "Pause for human input on decisions (default: false)" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    // Same logic as the registerCommand handler, but returns structured JSON
    // Uses ctx.cwd for repositoryRoot resolution
    // Calls runManifestFile → completeChainAutonomously
    // Returns { status, runId, reportUrl, summary, findings[], decisionRequests[] }
  },
  renderCall(args, theme) { /* KISS: "prompt-chain-run manifest.json" */ },
  renderResult(result, { isPartial }, theme, context) { /* Success/error indicators */ },
});
```

#### 2b. Tool surface — all operations

| Tool name | Parameters | Returns | Replaces command |
|-----------|-----------|---------|-----------------|
| `prompt-chain-run` | `{ manifest, background?, noFollowUps?, humanDecisions? }` | `{ status, runId, report?, findings[], decisionRequests[] }` | `/prompt-chain-run` |
| `prompt-chain-status` | `{ runId, watch?: boolean }` | `{ status, stageStates, findings, followUpRunCount, paused, decision }` | `/prompt-chain-status` |
| `prompt-chain-resume` | `{ runId, adoptCurrentHead?: boolean, noFollowUps?: boolean }` | `{ status, runId, report?, pauseKind? }` | `/prompt-chain-resume` |
| `prompt-chain-decide` | `{ runId, choice, rationale? }` | `{ status, runId, decisionRecord }` | `/prompt-chain-decide` |
| `prompt-chain-abort` | `{ runId }` | `{ status, abortRequested }` | `/prompt-chain-abort` |
| `prompt-chain-follow-ups` | `{ runId, rounds?: number, noAudit?: boolean }` | `{ runs, remainingItems, notes }` | `/prompt-chain-follow-ups` |
| `prompt-chain-loop` | `{ issuesFile, max?: number, humanDecisions?: boolean }` | `{ processed, completed, failed, remaining }` | `/prompt-chain-loop` |

#### 2c. Structured result types

```typescript
// src/types.ts additions (or new src/tool-types.ts)

export interface ToolRunResult {
  status: "started" | "completed" | "paused" | "failed";
  runId: string;
  runUrl?: string; // .pi/prompt-chain-hybrid/runs/<id>/
  summary?: string;  // formatted autonomous report text
  autonomousReport?: AutonomousCompletionReport;
  pauseKind?: RunState["pauseKind"];
  decisionRequest?: {
    id: string;
    question: string;
    options: string[];
  };
  findings: Array<{ severity: string; summary: string; stageId: string }>;
}

export interface ToolStatusResult {
  status: RunState["status"];
  stages: Array<{ id: string; title: string; status: StageStatus; changedPaths: string[] }>;
  findings: Array<{ severity: string; summary: string; disposition: FindingDisposition }>;
  followUpRunCount: number;
  paused?: { kind: string; reason: string; decisionRequestId?: string };
}
```

#### 2d. Safety rails

- **Human-decision gating**: When `decisionMode === "human"`, `prompt-chain-run` without `humanDecisions: true`
  will refuse to start, returning `{ status: "error", message: "This manifest requires human decisions. Pass humanDecisions: true or use /prompt-chain-run --human-decisions" }`.
- **Abort safety**: `prompt-chain-abort` sets `abortRequested = true` on the run state. The supervisor reads
  this flag at the next durable boundary. Tool returns immediately; abort is async.
- **Tool call timeout**: Agent tool calls have their own timeout (configurable). For long-running
  synchronous runs, the tool should set a long internal timeout or use `background: true`.

#### Files touched

| File | Change |
|------|--------|
| `src/index.ts` | 7 new `registerTool` calls with TypeBox schemas + execute handlers |
| `src/tool-types.ts` | **NEW** — structured result types (`ToolRunResult`, `ToolStatusResult`, etc.) |
| `src/runner.ts` | Export a lightweight `runAsTool` wrapper that structures the result |
| `src/followups.ts` | Export `formatReportForTool` — structured version of `formatAutonomousReport` |
| `src/controller.ts` | Export `formatIssueResultForTool` |
| `src/store.ts` | Minor: add `findingsSummary(repositoryRoot, runId)` helper |
| `package.json` | Add `typebox` to dependencies (needed for Type.* schema helpers, unless already present) |

### Interaction with Existing Invariants

- **Same execution path**: Tool handlers delegate to the same `runManifestFile`, `resumeRun`,
  `completeChainAutonomously`, `processNextIssue` functions as slash-command handlers. Behavior is identical.
- **Lease management**: No change — tool handlers are synchronous and hold the lease for the duration,
  same as slash-command handlers.
- **Human-decision guard**: The tool checks `decisionMode` before starting; if `human` and no `humanDecisions`,
  it fails fast rather than silently pausing.
- **Path contracts and validation**: No change — the underlying `runManifestFile` validates before starting.

### Testing Strategy

| Test | What it validates |
|------|-------------------|
| `tests/tools.test.ts` — `prompt-chain-run tool starts and completes` | Execute tool programmatically against a valid fixture manifest, verify structured result |
| `tests/tools.test.ts` — `prompt-chain-run with background returns immediately` | Verify returned `status: "started"` with runId |
| `tests/tools.test.ts` — `prompt-chain-status tool returns stage info` | Pre-seeded run, verify stages are enumerated |
| `tests/tools.test.ts` — `prompt-chain-decide tool records decision` | Tool call records a decision, verify durable state |
| `tests/tools.test.ts` — `human-decision gating rejects without flag` | Tool call with `humanDecisions: false` on human manifest → returns error |

Each test should construct `ToolRunParams` and invoke the handler function directly (not via
`registerTool`), following the same test pattern as `tests/followups.test.ts`.

### Risks & Open Questions

1. **TypeBox import**: The `typebox` package must be in `dependencies` (not just `devDependencies`).
   Currently it is in `devDependencies` via pi-codex-goal's peer dep. Add it explicitly.
2. **Tool result size**: Full `AutonomousCompletionReport` can be large. Limit to summary + link to
   durable result file. The agent can call `prompt-chain-status` for details.
3. **Backward compatibility**: Existing slash commands continue working. Tools are additive. No migration needed.
4. **`execute` function signature**: The `_signal` parameter for cancellation. Tool handlers should
   check `_signal?.aborted` at yield points.

### Effort Estimate

| Component | Estimated effort | Dependencies |
|-----------|-----------------|--------------|
| `src/tool-types.ts` — result types | 0.5 day | None |
| Tool handlers (7) in `src/index.ts` | 2-3 days | tool-types.ts |
| `typebox` dependency | 0.1 day | None |
| Tests | 1-2 days | Handlers |
| **Total** | **3.5-5.5 days** | |

---

## 3. Notification / Intercom Hooks

### Motivation & User Story

**Parity target**: Background runs and the issue backlog are autonomous by default — they happen without
the agent watching. The agent needs a way to be *pushed* notifications when significant events occur:
"your background run paused on a decision", "follow-up round failed", "issue backlog drained".

**User story**: "When a background run completes or pauses for a human decision, I want a notification
delivered to my active chat. I don't want to poll status."

**Current state**: `src/followups.ts` has an `onEvent` callback parameter in `runFollowUpRounds`, and
`src/controller.ts` has a similar callback for progress messages. These fire events during execution
but nothing pushes across session boundaries.

### Design

#### 3a. Event hook system

Define a hook registry in `src/hooks.ts` that allows external code to subscribe to lifecycle events:

```typescript
// src/hooks.ts — NEW

export type PromptChainEvent =
  | { type: "run.started"; runId: string; manifestPath: string; background: boolean }
  | { type: "run.completed"; runId: string; result: AutonomousCompletionReport }
  | { type: "run.paused"; runId: string; pauseKind: string; pauseReason: string; decisionRequestId?: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.aborted"; runId: string }
  | { type: "follow_up.round.started"; parentRunId: string; round: number; manifestPath: string }
  | { type: "follow_up.round.completed"; parentRunId: string; round: number; status: string; itemCount: number }
  | { type: "follow_up.round.failed"; parentRunId: string; round: number; error: string }
  | { type: "issue.started"; issueId: string; runId?: string }
  | { type: "issue.completed"; issueId: string; runId?: string }
  | { type: "issue.failed"; issueId: string; error: string }
  | { type: "issue.backlog_drained"; issuesFile: string; processed: number; remaining: number };

export type EventHook = (event: PromptChainEvent) => Promise<void> | void;

export function registerEventHook(hook: EventHook): () => void {
  hooks.push(hook);
  return () => { hooks = hooks.filter(h => h !== hook); };
}

export async function emitEvent(event: PromptChainEvent): Promise<void> {
  await Promise.allSettled(hooks.map(h => h(event)));
}
```

#### 3b. Intercom hook integration

Add a built-in hook that bridges to pi-intercom:

```typescript
// src/intercom-hook.ts — NEW

import type { IntercomClient } from "pi-intercom"; // or use dynamic import

export function createIntercomHook(options: {
  targetSession: string;
  minSeverity?: "info" | "warning" | "error"; // default "warning"
}): EventHook {
  return async (event) => {
    const message = formatEventForIntercom(event);
    if (!message) return; // filtered by severity
    // Use pi-intercom's client to send structured message
    try {
      const { IntercomClient } = await import("pi-intercom");
      const client = await IntercomClient.connect();
      await client.send(options.targetSession, { text: message });
    } catch {
      // Silently degrade — logging is non-critical
    }
  };
}

function formatEventForIntercom(event: PromptChainEvent): string | null {
  switch (event.type) {
    case "run.completed":
      return `🧵 Prompt chain \`${event.runId.slice(0, 8)}\` completed — ${event.result.runs.length} follow-up run(s), ${event.result.remainingItems} remaining items.`;
    case "run.paused":
      return `⏸️ Prompt chain \`${event.runId.slice(0, 8)}\` paused: ${event.pauseReason}. Use \`/prompt-chain-decide ${event.runId}\`.`;
    case "follow_up.round.failed":
      return `⚠️ Follow-up round ${event.round} for run \`${event.parentRunId.slice(0, 8)}\` failed: ${event.error}`;
    case "issue.backlog_drained":
      return `✅ Issue backlog drained: ${event.processed} processed, ${event.remaining} remaining.`;
    default:
      return null; // not significant enough
  }
}
```

#### 3c. Hook injection points

In `src/followups.ts`:

- `runFollowUpRounds`: emit `follow_up.round.*` events
- `completeChainAutonomously`: emit `run.completed` or `run.failed` after final audit

In `src/controller.ts` (or a wrapper):

- `processNextIssue`: emit `issue.started`, `issue.completed`, `issue.failed`
- The drain loop: emit `issue.backlog_drained`

In `src/daemon.ts` (from Opportunity #1):

- After claiming lease: emit `run.started`
- On pause: emit `run.paused`
- On completion: emit `run.completed`

The `RunReaper` in `src/reaper.ts`:

- After reclaiming and completing a stale run: emit `run.completed`

#### 3d. Configuration

Add to `TripSettings`:

```typescript
export interface NotificationConfig {
  /** Target session(s) for intercom notifications. Empty = no intercom push. */
  intercomSession?: string | string[];
  /** Minimum event severity for push: "info" | "warning" | "error" */
  minSeverity?: "info" | "warning" | "error";
  /** File-based log path for structured JSON events (e.g., for external monitoring) */
  eventLogPath?: string;
}
```

Stored in `Settings` under `notifications` key. Read on extension activation to register hooks.

#### 3e. Local notification (same-session)

For non-background runs, the existing `ctx.ui.notify` and `ctx.ui.setStatus` calls already provide
same-session feedback. The hook system augments this — event hooks are fire-and-forget and do not
replace existing UI calls.

#### Files touched

| File | Change |
|------|--------|
| `src/hooks.ts` | **NEW** — `PromptChainEvent` union, `registerEventHook`, `emitEvent` |
| `src/intercom-hook.ts` | **NEW** — `createIntercomHook`, event formatting for intercom |
| `src/followups.ts` | Call `emitEvent` at round/run terminal points |
| `src/controller.ts` | Call `emitEvent` at issue lifecycle points |
| `src/daemon.ts` | Call `emitEvent` at event points |
| `src/reaper.ts` | Call `emitEvent` on reaper-completed runs |
| `src/types.ts` | Add `NotificationConfig` to `TripSettings` |
| `src/index.ts` | Load `NotificationConfig` on activation, register hooks |

### Interaction with Existing Invariants

- **Fire-and-forget**: Event hooks never block execution. The `Promise.allSettled` guarantees that a
  slow/dying hook cannot delay the run loop.
- **No new lease dependency**: Hooks operate outside the lease cycle. A hook failure does not affect
  supervision.
- **Intercom optional**: The `pi-intercom` import is dynamic (try/catch). If the package is not installed,
  the hook creation gracefully returns no-op.

### Testing Strategy

| Test | What it validates |
|------|-------------------|
| `tests/hooks.test.ts` — `emitEvent calls registered hooks` | Register a spy hook, emit event, verify called with correct event shape |
| `tests/hooks.test.ts` — `unsubscribe removes hook` | Verify returned cleanup function works |
| `tests/hooks.test.ts` — `hook failure does not crash emitter` | Hook that throws, verify other hooks still fire |
| `tests/intercom-hook.test.ts` — `intercom hook formats events` | Feed events through formatter, verify expected text output |
| `tests/followups.test.ts` — `follow_up events emitted` | Mock `emitEvent`, verify `runFollowUpRounds` emits expected events |

### Risks & Open Questions

1. **pi-intercom dynamic import reliability**: The `import("pi-intercom")` dynamic import depends on the
   package being in `node_modules`. If it's a peer dependency, this is fine. If not installed, the catch
   silently degrades. Consider making it an optional dependency.
2. **Event volume**: The `run.started`/`run.completed` events are single-fire per run. `follow_up.round.*`
   fires at most 3 times per run. `issue.*` events fire per issue. This is low-volume and safe.
3. **Intercom session targeting**: The daemon process needs to know the originating session id. Pass it
   in the fork's `process.env` (e.g., `PI_INTERCOM_TARGET_SESSION`).
4. **Security**: Unauthenticated intercom messages from a daemon could be spoofed. Mitigation: the daemon
   should only send, never listen. Inbound handling is the main session's responsibility.

### Effort Estimate

| Component | Estimated effort | Dependencies |
|-----------|-----------------|--------------|
| `src/hooks.ts` — event types + registry | 0.5 day | None |
| `src/intercom-hook.ts` — intercom bridge | 1 day | hooks.ts, pi-intercom (optional) |
| Injection into followups/controller/daemon | 1-2 days | hooks.ts |
| `NotificationConfig` + activation | 0.5 day | hooks.ts, types.ts |
| Tests | 1-2 days | hooks.ts |
| **Total** | **4-6 days** | |

---

## 4. Further Autonomy & Utility Gaps

### 4a. Scheduled Reaper / Artifact Cleanup

**Current state**: `RunReaper` polls and reclaims stale leases, but old run artifacts
(`.pi/prompt-chain-hybrid/runs/<id>/`) accumulate indefinitely. There is no TTL-based cleanup.

**Design**:

```typescript
// src/cleanup.ts — NEW

export interface CleanupOptions {
  repositoryRoot: string;
  /** Runs older than this are candidates for full archival. Default 30 days. */
  runTTLMs?: number;
  /** Max retained finding records per run. Default 500. */
  maxFindingsPerRun?: number;
  /** Max retained event log entries. Default 1000. */
  maxEventsPerRun?: number;
  /** If true, archives to .pi/prompt-chain-hybrid/archive/ before deleting stage artifacts. */
  archiveBeforeClean?: boolean;
}

export async function cleanStaleArtifacts(options: CleanupOptions): Promise<CleanupReport> {
  // 1. Enumerate runs/
  // 2. For each run past TTL with status "completed" | "aborted" | "failed":
  //    a. Archive run.json + events.jsonl to archive/ (if archiveBeforeClean)
  //    b. Delete stages/ subdirectory (preserve run.json + events.jsonl)
  //    c. Delete follow-ups/ subdirectory
  // 3. For retained runs, trim events.jsonl to maxEventsPerRun
  // 4. For retained runs, trim findings to maxFindingsPerRun
}
```

**Hook integration**: Register a periodic cleanup hook triggered by `RunReaper`'s poll interval
(via `reaperPollIntervalMs`), or run explicitly via `/prompt-chain-cleanup`.

**Effort**: 2-3 days. Low risk — purely additive, no invariants affected.

### 4b. Goal Integration (Persistent Objectives Spanning Multiple Manifests)

**Current state**: Each manifest is independent. Goal tracking (as in `pi-codex-goal`) is separate.
There is no way to say "these 3 manifests are all part of achieving objective X".

**Design**:

Create a lightweight goal-to-trip mapping:

```typescript
// src/goal-tracker.ts — NEW

export interface GoalMapping {
  goalId: string;
  goalDescription: string;
  manifestPaths: string[];
  runIds: string[];
  status: "in_progress" | "completed" | "failed";
  completedAt?: string;
}
```

Store under `.pi/prompt-chain-hybrid/goals.json`. When a run completes, update the goal's runIds.
The `/prompt-chain-run` command gains an optional `--goal <description>` flag that creates or appends
to a goal entry. `/prompt-chain-goal-status` lists goals and their run results.

**Deeper integration (future)**: When all manifests in a goal are completed successfully, emit a
`goal.completed` event. When a manifest fails, the goal status changes to reflect it. This allows
the agent to programmatically verify multi-manifest objectives.

**Effort**: 2-3 days. Medium priority — useful but not blocking.

### 4c. Cross-Run Follow-Up Deduplication

**Current state**: If two runs produce similar follow-up items (e.g., same `affectedPaths` and similar
`summary`), each gets its own follow-up manifest and round. No cross-run dedup exists.

**Design**:

Add a content-hash key to `FollowUpItem`:

```typescript
// In src/followups.ts

export interface FollowUpItem {
  // ... existing fields ...
  /** Content hash of (stageId, affectedPaths sort, summary) for dedup. */
  contentHash?: string;
}
```

When `buildFollowUpManifest` encounters items with identical `contentHash`, merge them: keep the
first finding's evidence, concatenate `findingIds`. The follow-up prompt mentions all merged origins.

Store seen content hashes in `.pi/prompt-chain-hybrid/followup-seen.jsonl` (append-only). On new
item collection, skip any item whose contentHash already exists with disposition "resolved" | "obsolete".

**Effort**: 2-3 days. Low risk, independent of other features.

### 4d. Backlog Prioritization Heuristics

**Current state**: Issues are drained in FIFO order (`selectNextReadyIssue` picks the first `ready` issue).

**Design**: Add optional priority scoring:

```typescript
// src/backlog-prioritizer.ts — NEW

export interface PrioritizationConfig {
  strategy: "fifo" | "priority-first" | "recent-failures-first";
}

export function selectNextIssue(
  issues: Iterable<IssueProjection>,
  config: PrioritizationConfig
): IssueProjection | undefined {
  switch (config.strategy) {
    case "fifo": return selectNextReadyIssue(issues); // existing
    case "priority-first": {
      // Sort by priority desc, then by createdAt asc
      return [...issues]
        .filter(i => i.status === "ready")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
        [0];
    }
    case "recent-failures-first": {
      // Re-try the most recently failed issue first
      return [...issues]
        .filter(i => i.status === "ready")
        .sort((a, b) => (b.lastMessage?.includes("failed") ? 1 : 0) - (a.lastMessage?.includes("failed") ? 1 : 0))
        [0];
    }
  }
}
```

Expose via `/prompt-chain-loop --strategy priority-first` or the tool equivalent.

**Effort**: 1 day. Simple local change to `src/issues.ts` and `src/controller.ts`.

### 4e. Watch-Mode Status Improvements

**Current state**: `/prompt-chain-status --watch` polls and re-renders the summary. The TUI popup
collapses stages.

**Enhancements**:

1. **Change highlighting**: Highlight stages whose status changed since last render (e.g., recently
   completed stages in green, recently failed stages in red).
2. **Elapsed time per stage**: Show wall-clock time since the stage started running.
3. **Follow-up preview**: When follow-ups are pending, show a preview count and estimated rounds.
4. **Background run indicator**: Add `[bg]` tag for runs running in a daemon.

**Effort**: 1-2 days. Purely UI, no invariant changes.

### 4f. Richer Audit → Remediation Coupling

**Current state**: `followUpItemsFromAudit` maps unverified acceptance criteria to follow-up items.
The coupling is one-directional: audit → follow-up. No feedback loop from follow-up → re-audit.

**Enhancement**: After a follow-up run completes, re-run `auditCompletion` on the source run state and
compare the new audit result. If the follow-up resolved previously unverifiable criteria, update the
source run's finding dispositions. This creates a closure loop.

**Design**:

```typescript
// In src/followups.ts (or new src/re-audit.ts)

export async function reAuditAfterFollowUp(
  state: RunState,
  followUpReport: FollowUpReport,
  repositoryRoot: string
): Promise<AuditResultDiff> {
  const freshAudit = await auditCompletion(state, repositoryRoot);
  // Compare with previous audit
  // Map newly-verifiable criteria → update finding dispositions
  // Emit re-audit events
}
```

**Effort**: 1-2 days. Low risk, additive.

---

## 5. Cross-Cutting Concerns

### 5a. TypeScript (`typebox`) Dependency

Opportunity #2 requires `typebox` at runtime (for `Type.Object`, `Type.String`, etc. used by
`registerTool`). Currently `typebox` is a devDependency. Move it to `dependencies`.

Alternatively, define tool schemas as plain JSON Schema objects (the `registerTool` API likely accepts
both TypeBox `TObject` and raw JSON Schema). Investigate before adding the dependency.

### 5b. Documentation

Each opportunity should update:

- `README.md` — new commands, tools, and flags
- `docs/ARCHITECTURE.md` — daemon lifecycle, hook architecture, tool surface
- `docs/SECURITY.md` — daemon process isolation, intercom message trust

A new `docs/TOOLS.md` may be warranted for the tool surface (Opportunity #2).

### 5c. Backward Compatibility

All designs are additive:

- New commands (`/prompt-chain-cleanup`) and flags (`--background`) slot in alongside existing ones
- `registerTool` calls coexist with `registerCommand` calls
- Event hooks are opt-in; existing code paths that don't call `emitEvent` continue working
- The `FormatVersion` (currently `1`) is bumped to `2` only if `RunState` gains new required fields
  (unlikely — all additions are optional)

### 5d. Testing Infrastructure

The existing test pattern (`node --test` + fixture-state directories) works for all opportunities.
No new test infrastructure needed.

Potential addition: A `tests/fixtures/background/` directory containing pre-seeded run states for
daemon tests.

---

## 6. Implementation Sequencing

### Recommended Order

```
Phase 1: Agent Tool Surface ─────────────── Opportunity #2
  Why: Highest leverage. Makes all other autonomy programmatic.
  Depends on: typebox dependency.
  Risk: Low. Purely additive, same code paths as commands.

Phase 2: Background Execution ────────────── Opportunity #1
  Why: Next highest impact. Enables async operation.
  Depends on: Tool surface makes daemon control programmatic.
  Risk: Medium. Fork process, environment inheritance, intercom push.

Phase 3: Event Hooks + Intercom ───────────── Opportunity #3
  Why: Makes background runs useful by delivering results.
  Depends on: Background execution creates the need for notifications.
  Risk: Low. Fire-and-forget, no blocking.

Phase 4: Utility Gaps ─────────────────────── Opportunity #4
  Sub-order: Cleanup → Dedup → Audit coupling → Prioritization → Goal → Watch-mode
  Why: Polish layer. Each is independently shippable.
  Risk: Low. All additive with narrow scope.
```

### Dependency Graph

```
Opportunity #2 (Tools)
     │
     ▼
Opportunity #1 (Background) ──► Opportunity #3 (Hooks)
     │
     ▼
Opportunity #4 (Utility Gaps) ◄── all independent of each other
```

### Rough Timeline

| Phase | Description | Effort | Cumulative |
|-------|-------------|--------|------------|
| 0 | `typebox` dependency move | 0.1 day | 0.1 day |
| 1 | Tool surface (7 tools) | 4 days | 4.1 days |
| 2 | Background daemon | 7 days | 11.1 days |
| 3 | Event hooks + intercom | 5 days | 16.1 days |
| 4a | Artifact cleanup | 2 days | 18.1 days |
| 4b | Cross-run dedup | 2 days | 20.1 days |
| 4c | Audit coupling loop | 1.5 days | 21.6 days |
| 4d | Backlog prioritization | 1 day | 22.6 days |
| 4e | Goal integration | 2.5 days | 25.1 days |
| 4f | Watch-mode improvements | 1.5 days | 26.6 days |

**Total estimated effort**: ~27 days for full feature set across 6-10 focused work sessions.

### Immediate Next Steps (if greenlit)

1. **Audit**: Verify `typebox` import path and `registerTool` parameter schema requirements.
2. **Prototype**: Implement one tool (`prompt-chain-status`) to validate the schema approach.
3. **Test**: Run the prototype against the existing test suite (105 tests).
4. **Review**: Present structured tool output format for feedback before scaling to all 7 tools.
