# How comparable projects solve the 2026-09-22 review findings

Research date: 2026-09-22. Target: prompt-chain-dynamic at commit 6073c72.

Each section pairs a defect found in the architecture review with the mechanism
one or more mature open-source projects use for the same problem, cited to the
exact file and line read on GitHub during this research, followed by the
concrete change proposed for this repository.

## How this research was produced

The research-orchestrator planning kit was run twice (five CLI goals, then five
library campaigns with structured hints). Artifacts are under
`docs/research/pcd-*` and `docs/research/pcd-v2-*` (gitignored, local only;
regenerate with `bun scripts/research-fix-patterns.ts`). Every kit run ended
`inconclusive`: the goal classifier routed the first pass to documentation-only
probes, and the second pass lost most code-search probes to GitHub code-search
timeouts while five campaigns ran concurrently. The kit did surface the right
reference repositories in one campaign (`pcd-v2-review-loop-convergence`
selected a mirror containing aider and OpenHands). The anchors below were then
read directly with the octocode file-content tools, one repository at a time,
because that path uses the GitHub contents API and does not hit the code-search
rate limit. Treat the kit artifacts as diagnostics; treat this file as the
grounded result.

## 1. A worker that says `continue` never re-enters verification

### Defect

`src/runner.ts:673` routes any non-`complete` worker status away from validation
and review. `src/review.ts:83` turns a `continue` with no findings into a
blocking major finding built from the worker's own rationale. Worker-sourced
findings are never reconciled (`src/runner.ts:929` reconciles reviewer sources
only). The stage loops until the attempt budget is spent.

### What references do

**aider** verifies after every edit and bounds self-driven retries.

- `Aider-AI/aider` `aider/coders/base_coder.py:101` sets `max_reflections = 3`.
- `aider/coders/base_coder.py:933-943`: the outer loop re-sends only while
  `reflected_message` is set; at `num_reflections >= max_reflections` it warns
  "Only N reflections allowed, stopping." and returns. `reflected_message` is
  populated from deterministic signals (lint and test output, malformed edits),
  not from the model saying it is unfinished.

**OpenHands SDK** detects a stuck loop by comparing recent events, then nudges.

- `OpenHands/software-agent-sdk`
  `openhands-sdk/openhands/sdk/conversation/stuck_detector.py:104` `is_stuck`
  evaluates five scenarios over events since the last user message.
- `:156` `_is_stuck_repeating_action_observation` flags N identical
  action/observation pairs using `_event_eq`, which ignores ids and metrics.
- `:208` `_is_stuck_repeating_action_error` flags the same action erroring past a
  threshold; `get_action_error_nudge` (`:~225`) then injects one message telling
  the agent it has repeated the same call N times and must change approach.
- `:250` monologue detection: N consecutive agent messages with no other event.

### Proposed change for prompt-chain-dynamic

1. Run deterministic validation on every worker return regardless of status
   (aider's auto-lint/auto-test shape). Validation is cheap relative to an agent
   turn and produces the evidence reviewers currently never see.
2. Delete the worker branch of `findingsFromReview`. A worker `continue` yields
   direction text, never a `Finding`. Only reviewers and deterministic
   validation may open blocking findings.
3. When a worker returns `continue` with an empty `missingItems` list, or when
   validation passes, treat it as a completion claim and run the reviewer
   ensemble. That closes the gap where reviewer findings can only be
   re-verified after a literal `complete`.
4. Add a stuck detector over `AttemptRecord`s: identical `diffHash` plus
   identical worker status and `missingItems` for two consecutive attempts
   triggers an OpenHands-style nudge in the next prompt ("your last two
   responses were identical and produced no diff; `continue` does not trigger
   review, return `complete` to be reviewed or list concrete `missingItems`").
   `isStagnant` in `src/stagnation.ts:38` already fingerprints attempts; wire it
   into the worker-discard path, not only `advanceRepairStrategy`.
5. Cap consecutive worker-only `continue` returns at three (aider's number).
   On the third, force the validation and review path.
6. Implement `requireFreshClosureReviewer` or remove it from settings; nothing
   in `src` reads it today.

## 2. The compiler silently drops validation commands

### Defect

`src/compiler.ts:444` accepts only `npm|pnpm|yarn|bun run …`, pytest, cargo,
`go test`, and `git diff --check`. `npx tsc --noEmit` in every Targeted
Validation fence was dropped, so reviewers were told "No commands were
configured" and blocked on missing evidence forever.

### What references do

**mask** treats the fence as the contract and the language tag as the executor.

- `jacobdeichert/mask` `mask-parser/src/parser.rs:29-40`: on
  `Tag::CodeBlock(lang_code)` the block's language tag becomes
  `script.executor`; the only filter is excluding Windows shells on non-Windows
  hosts. There is no allowlist of command names.
- `mask-parser/src/parser.rs:69-80`: the fence body is stored verbatim as
  `script.source`.

**xc** applies the same rule and fails loudly on malformed input.

- `joerdav/xc` `parser/parsemd/parsemd.go:222-240` `parseCodeBlock`: every
  non-blank line inside the fence is appended verbatim to the task script; a
  second fence for the same task is an error ("command block already exists"),
  and an unterminated fence is detected via the `ended` flag. No command-name
  allowlist exists.

### Proposed change for prompt-chain-dynamic

1. Inside a `sh|bash|shell|zsh` fence that follows a `Targeted Validation`
   label, take every non-empty, non-comment line verbatim as a validation
   command. The fence is the author's explicit declaration; the language tag
   already says it is runnable.
2. Keep the `isValidationCommand` allowlist only for the loose line scan outside
   fences, which `skills/prompt-chain-plan/SKILL.md:75-81` already documents as a
   false-positive source.
3. Fail compilation, or at minimum emit an `authorWarnings` entry and a non-zero
   `/prompt-chain-compile` status, when a Targeted Validation label yields zero
   commands. Silence is the current failure mode.
4. Add `typescript` as a devDependency so `tsc` resolves inside the checkout
   rather than from a global PATH entry.

## 3. Serial scheduling and chunked batches

### Defect

`src/runner.ts:391` runs exactly one stage per loop iteration whenever any ready
stage is same-checkout. The parallel branch at `:396` is chunked
`Promise.allSettled`, so one slow stage stalls the next chunk.

### What references do

**nx** uses a coordinator loop with a sliding pool and a per-task exclusivity
flag.

- `nrwl/nx` `packages/nx/src/tasks-runner/task-orchestrator.ts:~380-390`:
  `while (this.pendingDiscreteWorkers.size < parallelism)` pulls the next
  schedulable task and dispatches it; completions wake the loop.
- `packages/nx/src/tasks-runner/tasks-schedule.ts:332-361` `canBeScheduled`:
  dependencies must be complete; if nothing is running, anything may start; if
  any running task has `parallelism === false`, nothing else starts; a task with
  `parallelism === false` starts only when nothing is running.
- `task-orchestrator.ts:~2394-2426` `getThreadPoolSize` gives continuous tasks
  their own slots so they never starve discrete work.

**turborepo** bounds the walk with a semaphore and validates special tasks up
front.

- `vercel/turborepo` `crates/turborepo-engine/src/execute.rs:79-81`:
  `Semaphore::new(concurrency)` around a `Walker` over the petgraph task graph;
  `:113` acquires a permit per task unless `--parallel`.
- `crates/turborepo-engine/src/validate_engine.rs:18-32` defines
  `DependencyOnPersistentTask` and `PersistentTasksExceedConcurrency`;
  `:202-205` requires `persistent_count < concurrency` so at least one slot
  remains for ordinary tasks.

**wireit** is the smallest TypeScript reference for the pool itself.

- `google/wireit` `src/util/worker-pool.ts:23-68`: `WorkerPool.run` decrements
  `#availableWorkers`, parks callers on a `Deferred` when zero, and wakes one
  waiter in `finally`.

### Proposed change for prompt-chain-dynamic

1. Replace the `serial`/chunk branch in `executeLoop` with a pool: dispatch
   while in-flight count is below `maxParallel`, and re-evaluate readiness on
   every completion instead of once per chunk.
2. Adopt nx's `canBeScheduled` rule for exclusivity. A same-checkout or
   integration stage is `parallelism: false`: it starts only when nothing is in
   flight, and while it runs nothing else starts. Worktree stages backfill
   around it.
3. Validate like turborepo at run start: if the manifest mixes exclusive and
   parallel stages with `maxParallel < 2`, warn that parallel stages can never
   overlap.

## 4. Parallel topology is unreachable from authored plans

### Defect

`src/compiler.ts:191` never matches the documented `**Parallel-safe**: yes`
form. `src/compiler.ts:327` makes any `Needs` line a whole-plan blocker. The
runtime also ignores the per-stage `parallel` field.

### What references do

**turborepo** turns declared dependencies into edges and reports specific
reasons.

- `crates/turborepo-engine/src/builder.rs:598-603` reads
  `task_dependencies` and `topological_dependencies` from the task definition.
- `:648` and `:700` call `task_graph_mut().add_edge(to, from, ())` per declared
  dependency; `:~712` connects a task to the root only when it has no deps.
  Declaring a dependency never changes the concurrency mode of the run.
- `validate_engine.rs:18-32` produces per-task diagnostics naming the offending
  task and its dependant, rather than a global "serialized" flag.

### Proposed change for prompt-chain-dynamic

1. Fix the detector: allow optional `**` on both sides of the label and an
   optional colon, then test the documented bold form in `tests/compiler.test.ts`
   (the current fixtures use the bold form and pass only because they assert on
   other properties).
2. Remove `needs.length` from `parallelBlockers`. Declared needs are already
   DAG edges after commit d586522; they should shape the graph, not the mode.
3. Make topology per stage instead of per plan. A slice that declares parallel
   safety, has non-overlapping claims, and no high-risk path gets
   `isolation: "worktree"`; everything else stays same-checkout. Emit
   `serializedBecause` on each same-checkout stage so `/prompt-chain-inspect`
   can show the reason per slice, as turborepo does per task.

## 5. Timeouts, leases, and liveness

### Current state

Since commit a945202 agent and validation timeouts are warning-only. The hard
bounds are a 120 second lease renewed every 40 seconds
(`src/runner.ts:183`, `:1686`), two detached reapers, and a 30 second research
hook. `reportIdleWarning` at `src/runner.ts:1784` deliberately does not touch
the lease.

### What references do

**BullMQ** renews at half the lease and reaps on a separate cadence.

- `taskforcesh/bullmq` `src/classes/worker.ts:249`: defaults
  `lockDuration: 30000`, `stalledInterval: 30000`, `maxStalledCount: 1`;
  `:280` `lockRenewTime = lockDuration / 2`.
- `src/classes/lock-manager.ts:98-125`: a timer at `lockRenewTime / 2` extends
  every tracked job whose last renewal is older than `lockRenewTime / 2`;
  failures emit `lockRenewalFailed`.
- `src/classes/worker.ts:1382` `stalledChecker` loops `moveStalledJobsToWait`
  every `stalledInterval`; `maxStalledCount` bounds how often a job may be
  reclaimed before it is failed.

**graphile-worker** claims with `locked_at` and reaps by age.

- `graphile/worker` `src/sql/getJobs.ts:214,248`: claim sets `locked_by` and
  `locked_at` under `for update skip locked`.
- `src/sql/resetLockedAt.ts:21-28`: clears locks older than four hours and
  pushes `run_at` forward, so a lost worker's job re-runs.

**Temporal** separates activity heartbeats from job duration.

- `temporalio/sdk-typescript` `packages/worker/src/activity.ts:42,75,97`: the
  activity `Context` receives a `heartbeatCallback`; the server enforces a
  heartbeat timeout independent of the activity's total runtime, and a heartbeat
  failure surfaces as a distinct cancel reason.

### Proposed change for prompt-chain-dynamic

1. The lease design already matches BullMQ and graphile. Two gaps remain. First,
   forward `onActivity` (streamed tokens, tool calls, validation stdout) into a
   `lastActivityAt` field on the lease, distinct from `heartbeatAt`. The reaper
   can then tell a crashed worker (no heartbeat) from a slow one (heartbeat but
   no activity) and status output can show both.
2. Add BullMQ's `maxStalledCount` analog: bound how many times a stage may be
   reclaimed by the reaper before the run pauses with a clear reason, so a
   worker that is repeatedly killed and resumed does not loop silently.
3. Consider a longer lease for agent turns. A 120 second lease with a 40 second
   heartbeat is tight when large synchronous work (binary patch capture, run
   state writes) can block the event loop; graphile uses hours, BullMQ renews at
   a quarter of the lease. Renewing at one third with a two minute lease leaves
   one missed tick before expiry.

## Evidence table

| Issue | Repo | Path | Lines | Claim |
| --- | --- | --- | --- | --- |
| 1 | Aider-AI/aider | aider/coders/base_coder.py | 101, 933-943 | reflection cap of 3, driven by lint/test signals |
| 1 | OpenHands/software-agent-sdk | openhands-sdk/openhands/sdk/conversation/stuck_detector.py | 104, 156, 208, 250, 277 | five stuck scenarios via event equality; nudge on repeated error |
| 2 | jacobdeichert/mask | mask-parser/src/parser.rs | 29-40, 69-80 | fence language tag selects executor; body taken verbatim |
| 2 | joerdav/xc | parser/parsemd/parsemd.go | 222-240 | fence body verbatim; duplicate or unterminated fence is an error |
| 3 | nrwl/nx | packages/nx/src/tasks-runner/task-orchestrator.ts | ~380-390, ~2394-2426 | sliding dispatch while in-flight < parallelism; separate slots for continuous tasks |
| 3 | nrwl/nx | packages/nx/src/tasks-runner/tasks-schedule.ts | 332-361 | `parallelism === false` exclusivity rule |
| 3 | vercel/turborepo | crates/turborepo-engine/src/execute.rs | 79-81, 113 | semaphore-bounded graph walk |
| 3,4 | vercel/turborepo | crates/turborepo-engine/src/validate_engine.rs | 18-32, 202-205 | per-task persistent diagnostics; persistent count must be below concurrency |
| 3 | google/wireit | src/util/worker-pool.ts | 23-68 | minimal TypeScript worker pool |
| 4 | vercel/turborepo | crates/turborepo-engine/src/builder.rs | 598-603, 648, 700 | declared deps become `add_edge` calls, never a mode switch |
| 5 | taskforcesh/bullmq | src/classes/worker.ts | 249, 280, 1382 | lock defaults, renew at half lease, stalled checker loop |
| 5 | taskforcesh/bullmq | src/classes/lock-manager.ts | 98-125 | renewal timer and `lockRenewalFailed` |
| 5 | graphile/worker | src/sql/getJobs.ts, src/sql/resetLockedAt.ts | 214, 248; 21-28 | claim with locked_at; age-based reset |
| 5 | temporalio/sdk-typescript | packages/worker/src/activity.ts | 42, 75, 97 | activity heartbeat callback separate from runtime |

Line numbers are from files as read on 2026-09-22 on each repository's default
branch and will drift.
