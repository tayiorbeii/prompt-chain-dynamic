# Prompt-Chain Dynamic Runtime

A Pi package that keeps **prompt-chain JSON as the canonical implementation contract** while using **pi-dynamic-workflows** to execute implementation, review, repair, research, integration, and decision-agent sessions.

The package combines four layers:

1. Markdown-first implementation planning.
2. A compiled, schema-validated prompt-chain JSON DAG.
3. Per-stage lifecycle state machines with mandatory feedback closure.
4. Git-aware worktree, patch, validation, checkpoint, and scoped-commit transactions.

`pi-dynamic-workflows` supplies typed Pi subagents, model routing, structured output, and agent-session persistence. It does not own the implementation graph or Git promotion.

## Interaction model

```text
implementation guide / plan.md
        ↓ prompt-chain compile
*.prompt-chain.json
        ↓ prompt-chain run
DAG scheduler + stage state machines
        ↓
pi-dynamic-workflows WorkflowAgent sessions
        ↓
Git verification, patch capture, integration and commit
```

Humans normally author Markdown. JSON is the frozen machine contract and may also be authored directly when desired.

## Implemented guarantees

- Acyclic stage dependencies through `needs`.
- Read-only, same-checkout writer, worktree writer, and integration stages.
- Concrete `claimedPaths` and constrained `allowedPaths`.
- Conservative parallel compilation: only an explicitly safe same-base worktree wave.
- Strict worktree creation owned by this runtime; no fallback to parallel shared-checkout writing.
- Direct agent commits rejected.
- Actual Git changes checked against the stage path contract.
- Required outputs and validation commands checked before review completion; known “no tests found” exit-0 output is rejected as a false green.
- Typed structured output through `WorkflowAgent` and TypeBox.
- Free-form corrective feedback defaults to `continue`, never completion.
- Durable blocking finding ledger and same-stage repair loop with bounded recent attempt, validation, and review evidence carried into every repair.
- Fresh independent reviewer ensemble after each repair. With `reviewPolicy.requireFreshClosureReviewer` (default `true`) every reviewer call gets its own persisted session, scoped by attempt and reviewer index, so no reviewer inherits an earlier verdict's transcript; set it to `false` to reuse one review session per stage and trade that isolation for cached context.
- Agent decisions by default; `--human-decisions` records the recommendation for later human review without wedging execution.
- Redundant detached stale-lease reapers with atomic generation claims, so dead workers/reapers are automatically replaced without duplicate resumes.
- Bounded agent, decision, and heartbeat-shutdown waits; by default, exhausted work pauses the run for operator review instead of being silently accepted (`continuationPolicy.bestEffortCompletion: false`). Set `bestEffortCompletion: true` to opt into the legacy behavior of accepting exhausted safe work best-effort with durable follow-up notes instead of pausing.
- Verified binary patch capture and SHA-256 hashing.
- Deterministic fan-in and runtime-owned scoped result commit.
- Run state, findings, decisions, patches and integration journals under `.pi/prompt-chain-hybrid/runs/`.
- Optional append-only JSONL issue controller.

## Requirements

- Node.js 22.19 or newer is recommended by current Pi packages.
- Git.
- Pi coding agent 0.80.8 or newer.
- An authenticated model available to Pi.

## Install for development

```sh
unzip prompt-chain-dynamic-runtime-0.2.0.zip
cd prompt-chain-dynamic-runtime
npm install
npm test
```

Install into one project first:

```sh
cd /path/to/target-repository
pi install -l /absolute/path/to/prompt-chain-dynamic-runtime
```

Restart Pi or run `/reload`.

Initialize project policy files:

```sh
bash /absolute/path/to/prompt-chain-dynamic-runtime/scripts/install.sh "$PWD"
```

Review and commit:

```text
docs/VISION.md
docs/ARCHI.md
docs/QUALITY-GATES.json
docs/REVIEW-CHECKLIST.md
.gitignore
```

## Pi commands

```text
/prompt-chain-compile <plan.md> [--out file.prompt-chain.json] [--mode auto|serial|parallel]
/prompt-chain-inspect <file.prompt-chain.json>
/prompt-chain-validate <file.prompt-chain.json>
/prompt-chain-run <file.prompt-chain.json> [--human-decisions] [--no-follow-ups]
/prompt-chain-supervise <file.prompt-chain.json> [--human-decisions]
/prompt-chain-status [run-id] [--watch]
/prompt-chain-resume [run-id] [--adopt-current-head] [--no-follow-ups]
/prompt-chain-follow-ups [run-id] [--rounds N] [--no-audit]
/prompt-chain-decide <run-id> <choice> :: <rationale>
/prompt-chain-abort [run-id]
/prompt-chain-audit [run-id]
```

### Autonomous completion

`/prompt-chain-run`, `/prompt-chain-supervise`, and `/prompt-chain-resume` do not stop at the end of the DAG. Like the pi-workflows and pi-goal extensions, they drive the run to a *finished result*:

1. The chain executes with its full recovery machinery (repairs, research escalation, lease reaping, best-effort boundaries).
2. A non-terminal run is handed to the supervisor, which reclaims stale leases and resumes until completed or aborted. A run paused on a pending *human* decision is surfaced instead of spun on.
3. After completion, every deferred `follow-up-created` finding and every acceptance criterion the completion audit could not verify is compiled into a fresh, validated follow-up manifest (`.pi/prompt-chain-hybrid/runs/<id>/follow-ups/round-N.trip.json`). Follow-up writer steps inherit the original steps' path contracts and validation commands, so remediation stays inside the reviewed scope.
4. The follow-up run executes with the same recovery machinery. On success the source findings are durably marked resolved with the follow-up run id as evidence, and the parent run records the linkage in `followUpRunIds`. New deferrals feed the next round, up to 3 rounds by default.
5. A final completion audit is reported alongside the run summary.

Use `--no-follow-ups` for the legacy single-chain behavior, or `/prompt-chain-follow-ups [run-id]` to execute deferred work of an already-completed run later.

`/prompt-chain-status` reports when the status was requested; run creation, start, update, completion, and elapsed times; lease freshness, abort state, deferred follow-up items, and linked follow-up runs; plus per-step task, dependency, timing, attempt, validation, blocker, changed-path, worktree, patch, and verified-commit details. Individual steps are collapsed to a one-line summary by default: use `↑`/`↓` (or `j`/`k`) to select a step, Enter/Space/`l` to expand or collapse it, `e`/`c` to expand or collapse all, PgUp/PgDn to scroll, and Escape/`q` to close. A terminally aborted run cannot display a stale running step as active; it is labeled as interrupted. Add `--watch` to open a live, auto-refreshing view of the run's durable `events.jsonl` log. Newest events are shown at the top while following; use `f` to return to them, `r` to refresh, arrows or `j`/`k` to browse older entries, and Enter/Escape to close.

`/prompt-chain-abort` is durable across Pi processes. Active workers observe the request at the next attempt boundary, while an expired worker lease is aborted immediately. An explicit `/prompt-chain-resume` reopens an aborted run, validates and preserves its in-contract checkout changes, clears the abort request, atomically claims the next lease generation, and continues the interrupted stage. A live lease rejects concurrent resume attempts.

If the branch intentionally moved after a run stopped, checkpoint all source changes first and use `/prompt-chain-resume <run-id> --adopt-current-head`. This explicit recovery mode refuses a dirty source workspace, backs up the pre-adoption run state, records the old and new base revisions, and then continues from the clean current `HEAD`. It never silently rebases an ambiguous dirty workspace.

Normal CLI/Pi runs launch two detached `trip-reaper` replicas. They poll durable lease freshness, wait while the current worker is healthy, and atomically reclaim stale generations. One replica remains outside the recovered worker process, so it can recover if that worker/reaper dies too. Cross-process state locks and generation checks ensure that competing reapers have one winner and stale workers cannot overwrite the recovered run.

Optional issue-loop commands:

```text
/prompt-chain-issue-add <issues.jsonl> <title> :: <manifest> :: <priority>
/prompt-chain-issues <issues.jsonl>
/prompt-chain-loop <issues.jsonl> [--max N] [--human-decisions]
/prompt-chain-loop-once <issues.jsonl> [--human-decisions]
/prompt-chain-loop-resume <issues.jsonl> <issue-id>
```

`/prompt-chain-loop` drains the backlog autonomously: it claims the highest-priority ready issue, executes its chain to completion (including supervision and follow-up rounds), records the durable issue events, and moves to the next issue until none remain, an issue fails to complete, or the `--max` bound (default 20) is reached. `/prompt-chain-loop-once` and `/prompt-chain-loop-resume` also complete deferred follow-ups before recording the issue terminal event.

Skills:

```text
/skill:prompt-chain-plan
/skill:prompt-chain-implement
/skill:prompt-chain-release
```

## Shell CLI

```sh
npm link

prompt-chain compile docs/plans/feature.plan.md \
  --out docs/plans/feature.prompt-chain.json \
  --mode auto

prompt-chain inspect docs/plans/feature.prompt-chain.json
prompt-chain validate docs/plans/feature.prompt-chain.json
prompt-chain run docs/plans/feature.prompt-chain.json --human-decisions
prompt-chain status <run-id>
```

## Authoring a plan

```markdown
# Stable cluster ordering

### Slice 1 — Preserve parent order

**File**: `src/features/clusters/parent-order.ts`

**Parallel-safe**: no

Keep the initial parent order stable while displayed counts update.

**Acceptance Criteria**:
- Excluding children does not reorder parents.
- Re-including children does not reorder parents.
- Counts continue to update.

**Targeted Validation**:
```sh
npm test -- src/features/clusters/parent-order.test.ts
npm run typecheck
```
```

The Targeted Validation fence is the validation contract: every non-blank,
non-comment line in it becomes a stage command verbatim, with no allowlist, and
nothing outside the fence contributes. A declared label whose fence yields no
command fails compilation. Slices without a fence fall back to an allowlisted
scan of command-like lines and compile with an author warning.

A `**Needs**:` list names earlier slices. Any of these forms identifies the
same slice: its full title (`Slice 1 — Data Model`), the title without its
ordinal (`Data Model`), the ordinal alone (`Slice 1`), or its compiled stage
id (`implement-slice-1-data-model`). `(none)` declares no dependency. A value
that matches no slice is kept and reported by validation as an unknown
dependency rather than silently dropped.

Compilation freezes:

- Source-plan hash.
- Policy-document hashes when present.
- Fully expanded graph and path contracts.
- Selected topology and warnings.
- Runtime engine declaration.
- Contract hash.

## Agent model routing

A manifest may configure dynamic-workflows model tiers or explicit models:

```json
{
  "settings": {
    "modelRouting": {
      "persistAgentSessions": true,
      "roleTiers": {
        "research": "small",
        "implementation": "medium",
        "repair": "medium",
        "review": "medium",
        "decision": "big",
        "integration": "big"
      }
    }
  }
}
```

The user's `~/.pi/workflows/model-tiers.json` determines which concrete models back these tiers. Inside Pi, the runtime's subagents resolve tiers and explicit models against the host session's model registry, so providers registered by other extensions are available to them; the shell CLI and detached reapers build their own registry from disk.

## Feedback closure

The runtime does not equate a successful session with a successful stage.

```text
agent output
  → structured normalization
  → deterministic validation
  → reviewer ensemble
  → open blocking findings?
       yes: focused repair of the same stage
       no: capture durable artifact and checkpoint
```

Worker output never creates findings. A worker that returns `continue` supplies direction for its next attempt through `missingItems`; only deterministic validation and independent reviewers can open or close a blocking finding. Runs recorded before this rule are migrated on load: worker-sourced findings are relabeled `legacy-worker`, open ones are marked resolved with a migration rationale, already-resolved ones keep their evidence, and the per-finding ledger files are rewritten on the next resume.

A worker that repeats itself is detected, not humored. Two consecutive worker returns with the same diff, status and missing items earn one nudge in the next prompt naming the loop and the exit. After `continuationPolicy.maxWorkerReflections` consecutive worker-only `continue` returns (default 3), the next return is routed through validation and independent review whatever the worker says, and the run log records `stage.worker.reflection_cap`. Any completion claim resets the counter; the status view shows it as worker reflections.

Each repair and resumed-stage prompt includes bounded evidence from its most recent attempts: failed command output, review rationale/findings, and patch identity. The agent must use that evidence to avoid repeating an approach that left the same failure unresolved. `reviewPolicy.maxRepairRounds` is a focused-strategy window, not a terminal cap. By default (`continuationPolicy.bestEffortCompletion: false`), exhausting the repair budget pauses the run for operator review rather than persisting unresolved work as a follow-up — the runtime never silently marks a stage complete with unresolved or exhausted review findings unless you opt in. An explicit resume of such a run opens a fresh bounded repair window: the paused stage's repair-round and worker-reflection counters start over, exactly as they do for an automatic follow-up pass, instead of carrying the values that caused the pause into the first attempt after it. Set `continuationPolicy.bestEffortCompletion: true` to restore the legacy accept-and-continue behavior described below. With that opt-in set, before persisting unresolved work as `follow-ups.md`, the runtime automatically opens one bounded remediation window (five attempts by default) on the same cumulative worktree. Configure `continuationPolicy.automaticFollowUpPasses` or `automaticFollowUpAttemptLimit` to adjust it. When that window closes, the runtime automatically continues from the current worktree: evolving attempts enter another focused repair window, while stagnant attempts request configured research and otherwise receive a root-cause/re-plan prompt. Worker/check failures and reviewer-only churn have separate consecutive-failure rails. At either rail or the total automatic-attempt limit (`continuationPolicy.autoResumeTurnLimit`, default 30), the runtime retains the final cumulative worktree exactly as the last attempt left it, marks unresolved findings `follow-up-created`, writes per-stage and run-level `follow-ups.md`, and continues downstream work instead of pausing.

The run lease is renewed periodically during long agent and reviewer calls. A detached reaper observes expiry and atomically resumes the interrupted stage. Agent calls (including decisions) and validation commands **warn and keep waiting** rather than terminating on a wall-clock deadline. Fresh reviews also reconcile the finding ledger so resolved historical findings do not accumulate in later repair prompts. Safety boundaries—out-of-contract writes, workspace drift, direct agent commits, and corrupt patch hashes—still stop rather than silently ship unsafe work.

### Activity warnings (legacy timeout settings)

`sessionTimeoutMs` (default 30 minutes) and `commandTimeoutMs` (default 15 minutes) now specify **inactivity warning intervals**, not hard deadlines. `continuationPolicy.agentCallTimeoutMs` overrides the agent interval; `decisionTimeoutMs` overrides the decision interval (otherwise the smaller of the session interval and 5 minutes). These semantics also apply to existing compiled manifests with explicit numeric values. Zero disables warnings, not waiting. No implicit hard operation limit remains.

Observed agent history/streaming usage or validation stdout/stderr resets the corresponding inactivity timer. Silence produces periodic `agent.call.idle` or `validation.command.idle` events with elapsed and idle milliseconds, delivered to the live event callback and persisted in `events.jsonl`. Lease heartbeats do not count as agent activity. Sparse or unavailable activity signals may produce advisory warnings; a quiet compiler/test is not assumed hung. Warnings never create failed attempts, replacement workers, or timeout-based decision fallbacks. Genuine operation errors retain their existing handling.

A genuinely hung operation can wait indefinitely. Abort remains cooperative at durable stage boundaries; this change does **not** add immediate interruption of an in-flight agent/tool/validation command. Internal Git, research-hook, telemetry, and heartbeat-shutdown bounds remain unchanged. Tools and providers may have their own independent limits. The runtime does not rewrite or automatically restart previously stopped runs.

### Two lease clocks and the reclaim bound

The run lease carries two timestamps. `heartbeatAt` is renewed on a timer and proves the worker process is alive. `lastActivityAt` moves only when the worker observes agent history, streaming usage, or validation stdout/stderr, and proves the work itself is progressing. The status view shows both ages and labels a run with a fresh heartbeat but stale activity as "alive, idle", so a slow agent is distinguishable from a crashed worker without guessing.

When a lease does go stale and the reaper (or an operator) reclaims a run whose stage was still running, that stage's `reclaims` counter increments. After `continuationPolicy.maxLeaseReclaims` such reclaims (default 3) the run pauses as `reclaim_exhausted` instead of being resumed again: a worker that keeps dying or stalling mid-stage needs a person to look at it. Operator resumes of paused or failed runs never count, and resuming a `reclaim_exhausted` run resets every stage's counter, because that resume is the human intervention the pause asked for. A completed stage's counter also resets.

## Decision policy

Default:

```text
needs_decision → decision agent → implementation direction → repair → validation → review
```

Human-review mode:

```text
needs_decision → decision agent recommendation → continue with safest reversible choice → durable follow-up for human review
```

A decision supplies direction only. It cannot close the associated implementation finding. If decision sessions time out or return malformed output, the runtime records an `auto` decision and continues with the safest reversible in-scope option.

## Parallel writers

Parallel implementation is accepted only when the compiler and validator establish:

- Explicit `Parallel-safe: yes` declarations.
- Non-overlapping concrete claims.
- No dependency between writers.
- No recognized high-risk shared path.
- A common immutable Git base.
- A downstream worktree fan-in integration stage.

The runtime creates the worktrees itself and passes their exact `cwd` to `WorkflowAgent`. It intentionally does not use dynamic-workflows' throwaway worktree option for implementation writers.

### Waves

`--mode auto` groups writers into dependency waves instead of deciding parallelism for the whole plan at once (`--no-waves` restores the legacy all-or-nothing decision). Declared `Needs` never serialize anything; they place a slice in a later wave. A wave fans out into worktrees when every member declares parallel safety, no claims overlap inside the wave, no claim is a high-risk path, and the wave has a checkpoint base to branch from (wave 1 uses the run base; later waves need the previous wave to have checkpointed). Such a wave compiles to worktree writers plus a deterministic `checkpoint-wave-N` stage with strategy `worktree-wave-checkpoint`; other waves compile to same-checkout writers, each carrying `schedulingNotes` that say why. A manifest with any checkpoint stage has topology `mixed`, its final `integrate` stage uses `same-checkout-finalize`, and only that final stage runs the final validation commands. `--mode serial` is unchanged; a serial golden fixture pins that. At run time a checkpoint stage is deterministic: no agent runs. It applies the wave's verified patches to the shared checkout, runs their validation commands, records the cumulative run-owned patch, and creates a checkpoint commit on the runtime's private ref namespace whose parent is the run base; the branch never moves until the final `integrate` stage. Later waves' worktrees branch from that checkpoint. If a checkpoint's validation fails, its patches are reverted and the run pauses as `checkpoint_blocked`; resuming re-applies the wave once. Later checkpoints and the final integrate compare the run-owned tree to the previous checkpoint instead of demanding a clean checkout, and pause as `workspace_drift` on a mismatch.

## Validation

```sh
npm test
npm run smoke
npm pack --dry-run
```

Current automated suite: 172 tests (171 run against mocked agent backends using real temporary Git repositories and worktrees, including one that compiles and validates every plan shipped in the repository; 1 real-agent canary is skipped by default). Run the canary deliberately with `npm run test:canary` — see [docs/CANARY.md](docs/CANARY.md).

## Important limitations

- The mocked test suite is the default signal; a minimal real-agent canary exists (`npm run test:canary`, [docs/CANARY.md](docs/CANARY.md)) but is not run automatically and does not substitute for exercising the package against a real authenticated model session at the scale of an actual project.
- The issue controller is local JSONL, not a GitHub/Linear adapter.
- There is no dedicated combined TUI; Pi commands expose status while dynamic-workflows persists agent sessions.
- This is not an OS sandbox. Installed Pi packages and agents operate with the user's permissions.
- Dynamic-workflows journal replay is not used as proof of code completion; Git evidence remains authoritative.

See [Architecture](docs/ARCHITECTURE.md), [Project creation](docs/PROJECT-CREATION.md), [Acceptance gates](docs/ACCEPTANCE-GATES.md), and [Implementation status](docs/IMPLEMENTATION-STATUS.md).
