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
- Fresh independent reviewer ensemble after each repair.
- Agent decisions by default; `--human-decisions` records the recommendation for later human review without wedging execution.
- Redundant detached stale-lease reapers with atomic generation claims, so dead workers/reapers are automatically replaced without duplicate resumes.
- Bounded agent, decision, and heartbeat-shutdown waits; exhausted safe work is accepted best-effort with durable follow-up notes.
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
/prompt-chain-run <file.prompt-chain.json> [--human-decisions]
/prompt-chain-status [run-id] [--watch]
/prompt-chain-resume [run-id]
/prompt-chain-decide <run-id> <choice> :: <rationale>
/prompt-chain-abort [run-id]
```

`/prompt-chain-status` reports when the status was requested; run creation, start, update, completion, and elapsed times; lease freshness and abort state; plus per-step task, dependency, timing, attempt, validation, blocker, changed-path, worktree, patch, and verified-commit details. A terminally aborted run cannot display a stale running step as active; it is labeled as interrupted. Add `--watch` to open a live, auto-refreshing view of the run's durable `events.jsonl` log. Newest events are shown at the top while following; use `f` to return to them, `r` to refresh, arrows or `j`/`k` to browse older entries, and Enter/Escape to close.

`/prompt-chain-abort` is durable across Pi processes. Active workers observe the request at the next attempt boundary, while an expired worker lease is aborted immediately. An explicit `/prompt-chain-resume` reopens an aborted run, validates and preserves its in-contract checkout changes, clears the abort request, atomically claims the next lease generation, and continues the interrupted stage. A live lease rejects concurrent resume attempts.

If the branch intentionally moved after a run stopped, checkpoint all source changes first and use `/prompt-chain-resume <run-id> --adopt-current-head`. This explicit recovery mode refuses a dirty source workspace, backs up the pre-adoption run state, records the old and new base revisions, and then continues from the clean current `HEAD`. It never silently rebases an ambiguous dirty workspace.

Normal CLI/Pi runs launch two detached `trip-reaper` replicas. They poll durable lease freshness, wait while the current worker is healthy, and atomically reclaim stale generations. One replica remains outside the recovered worker process, so it can recover if that worker/reaper dies too. Cross-process state locks and generation checks ensure that competing reapers have one winner and stale workers cannot overwrite the recovered run.

Optional issue-loop commands:

```text
/prompt-chain-issue-add <issues.jsonl> <title> :: <manifest> :: <priority>
/prompt-chain-issues <issues.jsonl>
/prompt-chain-loop-once <issues.jsonl> [--human-decisions]
/prompt-chain-loop-resume <issues.jsonl> <issue-id>
```

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

The user's `~/.pi/workflows/model-tiers.json` determines which concrete models back these tiers.

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

Each repair and resumed-stage prompt includes bounded evidence from its most recent attempts: failed command output, review rationale/findings, and patch identity. The agent must use that evidence to avoid repeating an approach that left the same failure unresolved. `reviewPolicy.maxRepairRounds` is a focused-strategy window, not a terminal cap. Before persisting unresolved work as `follow-ups.md`, the runtime automatically opens one bounded remediation window (five attempts by default) on the same cumulative worktree. Configure `continuationPolicy.automaticFollowUpPasses` or `automaticFollowUpAttemptLimit` to adjust it; set `bestEffortCompletion: false` to pause instead. When that window closes, the runtime automatically continues from the current worktree: evolving attempts enter another focused repair window, while stagnant attempts request configured research and otherwise receive a root-cause/re-plan prompt. Worker/check failures and reviewer-only churn have separate consecutive-failure rails. At either rail or the total automatic-attempt limit (`continuationPolicy.autoResumeTurnLimit`, default 30), the runtime ranks durable candidate patches, restores the strongest safe attempt, marks unresolved findings `follow-up-created`, writes per-stage and run-level `follow-ups.md`, and continues downstream work instead of pausing.

The run lease is renewed periodically during long agent and reviewer calls. A detached reaper observes expiry and atomically resumes the interrupted stage. Every backend call has a runtime-owned wall-clock timeout, decision calls have a separate bounded timeout with an autonomous safest-option fallback, and heartbeat shutdown is bounded so a wedged lease write cannot wedge `finally`. Fresh reviews also reconcile the finding ledger so resolved historical findings do not accumulate in later repair prompts. Safety boundaries—out-of-contract writes, workspace drift, direct agent commits, and corrupt patch hashes—still stop rather than silently ship unsafe work.

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

## Validation

```sh
npm test
npm run smoke
npm pack --dry-run
```

Current automated suite: 21 tests, including real temporary Git repositories and worktrees.

## Important limitations

- The package has not been exercised here against a real authenticated model session.
- Only one same-base parallel writer wave is supported.
- The issue controller is local JSONL, not a GitHub/Linear adapter.
- There is no dedicated combined TUI; Pi commands expose status while dynamic-workflows persists agent sessions.
- This is not an OS sandbox. Installed Pi packages and agents operate with the user's permissions.
- Dynamic-workflows journal replay is not used as proof of code completion; Git evidence remains authoritative.

See [Architecture](docs/ARCHITECTURE.md), [Project creation](docs/PROJECT-CREATION.md), [Acceptance gates](docs/ACCEPTANCE-GATES.md), and [Implementation status](docs/IMPLEMENTATION-STATUS.md).
