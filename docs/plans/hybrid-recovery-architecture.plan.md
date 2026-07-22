# Hybrid Recovery Architecture for Prompt-Chain-Dynamic

## Overview

Replace prompt-chain-dynamic's single flat maxRepairRounds cap and stateless
continuation with a five-capability recovery architecture grounded in working reference
implementations (pi-codex-goal, pi-autoresearch). The plan is organized in three waves
matching the dependency graph established in the research synthesis.

### Problem

Today the runner throws a plain Error when no stage is runnable, repair is capped by
one hard limit with no strategy escalation, only final integration creates a git commit,
and the trip-loop is stateless — no persistent supervisor, no failure classification, no
completion audit. Research confirmed all five planned capabilities have working reference
implementations.

### Solution architecture

Three waves, dependency-ordered:

Wave 1 (Foundation) — Data model, scheduler and leases, supervisor framework, wiring
Wave 2 (Recovery) — Attempt memory, escalation ladder with research hook, verified commits
Wave 3 (Amendment) — Risk-classified contract amendment

The hot path is the runner module — every wave extends the orchestration loop. New modules
(supervisor, failure-classifier, audit, stagnation, research-hook, contract) are
introduced in the wave that first needs them.

### Non-goals

- Changing the manifest schema version (all additions are backward-compatible optional fields)
- Replacing the existing agent backend interface
- Adding a persistence layer (run state is already persisted)
- Porting pi-autoresearch's full experiment loop — only the anti-thrash and ASI primitives

### Risks

- The runner module is the hot file touched by every wave; merge conflicts across waves are
  expected and managed by serial ordering
- Phase 3 (contract amendment) has the weakest external evidence; implemented
  conservatively with a local-first risk classification function
- Lease timeout (120s default) may need tuning for long integration stages; instrumented
  in Wave 1 for later calibration

### Test impact

Existing tests validate the current runner, manifest validation, and review synthesis.
New tests per slice focus on the new modules (unit) and the modified orchestration paths
(integration). See each slice's validation section.

---

### Slice 1 — Data Model Foundation

**Files**: src/types.ts

**Parallel-safe**: no

**Allowed paths**:
- src/types.ts

Add all new types, interfaces, and enums required by subsequent slices. This is a
pure type-definition change with zero runtime impact.

New types to add:

- StageSchedulingReason — discriminated union with five variants replacing bare Error
  throws in the execute loop: waiting_on_active_stage,
  waiting_on_failed_dependency carrying a dependencyId, decision_pending,
  stale_worker_reclaimed, invariant_violation
- RunLease shape: owner, generation, heartbeatAt, leaseTimeoutMs — added as optional
  field on RunState
- schedulingReason and blockedBy fields on StageRunState
- AttemptRecord shape: attempt counter, role string, optional commit hash, validation
  results, review verdict, diff hash, asi free-form object, status as keep discard
  crash or checks_failed, startedAt timestamp, optional completedAt timestamp
- attempts array on StageRunState
- FailureCategory union type: transient, context-overflow, provider-quota, semantic,
  structural
- AmendmentProposal shape: oldContractHash, newContractHash, revalidatedPaths,
  revalidatedDeps, riskClass as auto-approve or human-required, reason string
- contractHash and verifiedCommit optional fields on StageRunState
- checkpointStrategy on manifest settings (keep or squash)
- continuationPolicy and researchPolicy on manifest settings from the reconciled
  configuration

No new runtime behavior — existing code continues to compile and run against these
additions.

**Needs**: (none)

**Acceptance Criteria**:
- All new types are exported from the types module
- TypeScript compilation passes with zero errors
- StageSchedulingReason has at least 5 variants
- AttemptRecord has all 9 fields including asi and status
- RunLease has all 4 fields

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 2 — Scheduler Semantics + Ownership Leases

**Files**: src/runner.ts

**Parallel-safe**: no

**Allowed paths**:
- src/runner.ts

Replace the throw in the execute loop with typed state transitions and add
generation-token leases to resumeRun.

1. Replace throw with typed scheduling in the execute loop at the point where no ready
   stages remain. Set pauseKind to blocked with a structured pauseReason naming the
   failed dependencies. Populate blockedBy on each pending StageRunState. Transition
   downstream stages to skipped status with schedulingReason set to blocked-by the
   failed dependency ID. Trigger completion check where all stages either completed or
   skipped becomes the terminal state.

2. Generation-token lease on resumeRun: accept an optional leaseGeneration parameter.
   On resume, check the stored lease generation against the captured token. A stale
   generation returns the current state as a no-op, verbatim from pi-codex-goal. Bump
   lease generation on successful resumption.

3. Lease initialization in runManifestFile: set state.lease with an owner identifier,
   generation set to 1, heartbeatAt set to current ISO timestamp, and leaseTimeoutMs
   set to 120000.

4. Heartbeat updates: update lease.heartbeatAt on each stage transition in the execute
   loop.

**Needs**:
- implement-data-model-foundation

**Acceptance Criteria**:
- No plain Error thrown for scheduling reasons — all scheduling failures use typed
  state transitions
- resumeRun with a stale generation returns the current state without side effects
- resumeRun with a current generation increments the lease generation
- blockedBy is populated on stages whose dependencies are failed
- Downstream stages of a failed dependency show skipped status with schedulingReason set

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 3 — Supervisor Framework

**Files**: src/supervisor.ts, src/failure-classifier.ts, src/audit.ts

**Parallel-safe**: no

**Allowed paths**:
- src/supervisor.ts
- src/failure-classifier.ts
- src/audit.ts

Create three new modules that form the persistent supervisor layer. These are pure new
files with no edits to existing code.

1. The failure-classifier module: exports classifyFailure which accepts an error or
   agent result and returns a FailureCategory. Categories are transient for network or
   timeout errors, context-overflow for compaction-needed cases, provider-quota for
   rate-limited scenarios, semantic for validation or review failures, and structural
   for broken contracts or invariants. Also exports isInfraFailure which returns true
   for transient, overflow, and quota — these never consume repair rounds.

2. The supervisor module: exports a Supervisor class with start and stop methods. It
   owns the run lease via generation tokens from Slice 2. Polls on a 50ms continuation
   retry interval. Uses classifyFailure to decide retry strategy per failure category.
   Keeps separate counters per category so infra retries do not consume the semantic
   repair budget. Enforces both a total turn limit defaulting to 30 and a consecutive
   failure override limit as hard stops. Persists run state every 60 seconds.

3. The audit module: exports auditCompletion which maps each acceptance criterion from
   the manifest to its validation artifact, review artifact, resolved findings, and
   commit hash. Fails fast if any criterion is unmapped. Returns an AuditResult with
   passed flag, mapped criteria, and unmapped failures.

**Needs**:
- implement-data-model-foundation
- implement-scheduler-semantics-ownership-leases

**Acceptance Criteria**:
- classifyFailure correctly maps at least 5 distinct error patterns to FailureCategory
- isInfraFailure returns true for transient, context-overflow, and provider-quota
- Supervisor class compiles with start and stop methods
- auditCompletion returns passed false when a stage has no validation artifact
- All three modules are importable without runtime errors

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 4 — Controller + CLI Wiring

**Files**: src/controller.ts, src/index.ts

**Parallel-safe**: no

**Allowed paths**:
- src/controller.ts
- src/index.ts

Wire the supervisor into the existing controller and commands.

1. In the controller module: processNextIssue initializes a Supervisor after a
   successful runManifestFile call. resumeIssue initializes a Supervisor after
   resumeRun. The supervisor polls until terminal state (completed, failed, or
   aborted). On supervisor stop, return the final RunState.

2. In the index module: register a prompt-chain-supervise command that starts a
   supervised run and blocks until terminal state. Keep prompt-chain-loop-once as a
   backward-compatible alias for single-turn execution without the supervisor. Add a
   prompt-chain-audit command that takes a run ID and runs auditCompletion, displaying
   the result.

**Needs**:
- implement-scheduler-semantics-ownership-leases
- implement-supervisor-framework

**Acceptance Criteria**:
- processNextIssue returns only after the supervisor reaches terminal state
- prompt-chain-loop-once still works as a single-turn command with no supervisor
- prompt-chain-supervise starts a supervised run
- prompt-chain-audit displays pass or fail with per-criterion detail

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 5 — Attempt Memory + Escalation Ladder

**Files**: src/runner.ts, src/stagnation.ts, src/research-hook.ts

**Parallel-safe**: no

**Allowed paths**:
- src/runner.ts
- src/stagnation.ts
- src/research-hook.ts

Replace the single repair round cap with an attempt-memory system and a strategy-based
escalation ladder.

1. The stagnation module: exports stagnationFingerprint which hashes the open blocking
   findings, validation failures, diff hash, and reviewer recommendation from a list of
   AttemptRecords into a deterministic string. Exports isStagnant which returns true
   when the last N fingerprints are equal. Exports isBetter which does a
   multi-dimensional comparison: fewer blocking findings wins, tiebreak on fewer total
   findings, tiebreak on smaller changed path set. Tie means not better.

2. The research-hook module: exports spawnResearchHook which runs a sandboxed child
   process with a JSON-in stdout-out contract, 30 second timeout, and 8 kilobyte stdout
   cap. Returns structured output with success flag, optional steer message, citations,
   and adaptation plan. Pattern matched from pi-autoresearch before.sh hook.

3. In the runner module, the runWriterStage repair loop: after each attempt, record an
   AttemptRecord on the stage state with ASI populated from validation and review
   results. Replace the flat reviewRounds cap with a strategy-based ladder that flows
   from implementation to validation to review to focused repair with max 3 rounds,
   then on stagnation (2 consecutive equal fingerprints) transitions to research hook
   with max 3 rounds, then to research-informed repair with max 2 rounds, then to
   decision and scope amendment with max 2 rounds, then to final verification. On
   hitting the consecutive failure override limit of consecutive discards or crashes,
   stop all strategies and pause. Re-inject the initial research into dependent
   implementation prompts, closing the existing research-injection gap.

**Needs**:
- implement-scheduler-semantics-ownership-leases
- implement-controller-cli-wiring

**Acceptance Criteria**:
- stagnationFingerprint produces equal hashes for two attempts with equal outcomes
- isStagnant returns true after 2 consecutive equal fingerprints
- isBetter prefers fewer blocking findings over fewer total findings over smaller path set
- Research hook spawns a child process and returns structured output within 30 seconds
- Escalation flows from repair to research to decision on stagnation
- The consecutive failure override limit (default 5) stops the loop
- Dependent implementation prompts include the initial research stage output

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 6 — Verified Commit Checkpoints

**Files**: src/runner.ts, src/git.ts

**Parallel-safe**: no

**Allowed paths**:
- src/runner.ts
- src/git.ts

Create scoped git commits for verified stages instead of only capturing binary patches.

1. In the git module: add a createCheckpointCommit function that creates a commit on a
   prompt-chain ref keyed by run ID (not the user working branch), returning the commit
   hash.

2. In the runner module, the persistWriterBoundary function: after a stage passes
   validation and review with no blocking findings, create a verified-stage commit with
   trailers for the validation artifact path, review artifact path, attempt number, and
   diff hash. Store the commit hash on the stage state verifiedCommit field.

3. In the runner module, terminal interrupt handling: save uncommitted work as a WIP
   patch under the stages directory for the stage ID. Verified-stage checkpoints remain
   intact on their ref.

4. In the runner module, final integration: read the checkpointStrategy from manifest
   settings. The squash strategy (default) produces a single integrated commit at the
   end. The keep strategy preserves all verified-stage commits in history.

**Needs**:
- implement-scheduler-semantics-ownership-leases
- implement-attempt-memory-escalation-ladder

**Acceptance Criteria**:
- A stage that passes validation and review gets a verified-stage commit on the ref
- The commit includes trailers for validation artifact, review artifact, and attempt number
- The stage state verifiedCommit field is populated after checkpoint
- Terminal interrupt saves WIP patches and preserves checkpoints
- checkpointStrategy squash produces a single final commit

**Targeted Validation**:
```sh
npx tsc --noEmit
```

---

### Slice 7 — Risk-Classified Contract Amendment

**Files**: src/contract.ts, src/decision.ts, src/runner.ts

**Parallel-safe**: no

**Allowed paths**:
- src/contract.ts
- src/decision.ts
- src/runner.ts

Add contract hashing and risk-classified amendment proposals. This is the thinnest
phase — implemented conservatively with a local-first approach.

1. The contract module: exports hashContract which computes a SHA-256 of the stage
   allowed paths, claimed paths, outputs, and validation commands. Exports
   classifyAmendmentRisk which compares current and proposed stage contracts against
   all stages. Returns auto-approve when new paths fall within existing allowed paths
   with no semantic boundary crossings and no cross-stage overlap. Returns
   human-required for new claimed paths, cross-stage overlap, or high-risk path
   changes such as migrations, schemas, auth, or API surface changes.

2. In the decision module: add an autoApproveAmendment function that creates a
   DecisionRecord with source set to auto. The existing parseDecision function still
   handles human-required amendments.

3. In the runner module: hash the contract on stage start and store it on the stage
   state. At the stagnation-to-decision step in the escalation ladder from Slice 5,
   build an AmendmentProposal with old and new contract hashes. Auto-approve proposals
   are applied immediately and recorded as a decision, then the stage continues to
   verification. Human-required proposals trigger the existing decision pipeline with
   pauseKind set to decision_pending. The enforcePathContract function accepts the
   updated contract from the proposal. Store the contract hash on each AttemptRecord.

**Needs**:
- implement-attempt-memory-escalation-ladder
- implement-verified-commit-checkpoints

**Acceptance Criteria**:
- hashContract is deterministic for identical stage definitions
- classifyAmendmentRisk returns auto-approve for path-only additions within existing
  allowed paths
- classifyAmendmentRisk returns human-required for new claimed paths or high-risk
  path changes
- autoApproveAmendment produces a valid DecisionRecord with source set to auto
- Human-required amendments trigger decision_pending pause
- contractHash is recorded on each AttemptRecord

**Targeted Validation**:
```sh
npx tsc --noEmit
```
