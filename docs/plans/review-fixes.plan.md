# Review Fixes: Convergent Repair Loop, Honest Compiler, Real Parallelism

> Source requirements: the 2026-09-22 architecture review (five findings) and
> `docs/REVIEW-FIX-PATTERNS.md`, which grounds each fix in how aider, the
> OpenHands SDK, mask, xc, nx, turborepo, wireit, BullMQ, graphile-worker and
> Temporal solve the same problem. Evidence anchors live there; this plan does
> not repeat them. Revision 2 incorporates the independent plan review
> (checkpoint-ref wave model, validation-rule inventory, flag-gated waves,
> pool-aware deadlock detection, reclaim attribution, reordered slices).

## Overview

### Problem

Real runs stall or crawl for reasons the runtime cannot see itself:

1. A worker that returns `continue` never re-enters validation or review. Its
   own rationale is minted into blocking findings, so the stage loops until the
   attempt budget is spent.
2. The compiler drops any Targeted Validation command that is not an
   `npm run`-style script, silently. Reviewers then block on "no evidence"
   that the runtime can never produce. The compiler also keeps backticks on
   claims parsed from a Files label, so the documented plan format fails
   validation.
3. Every plan compiles to a fully serial chain because the parallel-safety
   detector never matches the documented bold label, any dependency between
   writers disables fan-out for the whole plan, and only one parallel wave is
   supported.
4. The scheduler runs one stage per loop iteration whenever a same-checkout
   stage is ready, and uses chunked batches instead of a pool.
5. The lease cannot distinguish a crashed worker from a slow one, and a stage
   can be reclaimed by the reaper indefinitely.

### Solution architecture

Durable decisions that hold across every slice:

- **Evidence authority.** A worker's self-report is direction, never evidence.
  Only deterministic validation and fresh independent reviewers may open or
  close a `Finding`. The `Finding.source` value `worker` is removed and the
  worker path never enters the finding pipeline.
- **Every worker return is validated.** Deterministic validation commands run
  on each attempt regardless of the worker's status. A *completion claim* is
  either `complete`, or `continue` with an empty `missingItems` list.
  Completion claims go to output verification and the reviewer ensemble; other
  `continue` returns carry their `missingItems` forward as the next REQUIRED
  ACTION. A missing declared output on a completion claim is a deterministic
  finding, not a thrown error.
- **Stuck detection is event equality.** Two consecutive attempts with the same
  diff hash, status and missing items are stagnant; the runtime nudges once,
  then forces the completion-claim path after `maxWorkerReflections` (default 3).
- **The fence is the contract.** When a slice has a Targeted Validation fence,
  every non-blank, non-comment line in it is a validation command, verbatim,
  and nothing outside the fence contributes. Without a fence the loose
  allowlist scan remains the fallback. A label with an empty fence fails
  compilation.
- **Waves use checkpoint refs, never branch commits.** The compiler groups
  writers into dependency waves. A qualifying wave compiles to worktree writers
  followed by a wave checkpoint stage. That stage creates a checkpoint commit
  on the runtime's private ref namespace from the cumulative run-owned patch,
  records it as `verifiedCommit`, and never moves the branch, never sets
  `resultCommit`, and never writes the integration journal. Later-wave
  worktrees are created from that checkpoint hash. Only the final `integrate`
  stage commits to the branch. Multi-wave compilation ships behind a flag and
  becomes the default only once the runtime executes it.
- **Scheduling is a pool with exclusivity.** Ready stages dispatch while the
  in-flight count is below `maxParallel`. A same-checkout or integration stage
  is exclusive: it starts only when nothing is in flight, and nothing starts
  while it runs. Skip and deadlock decisions are made only when nothing is in
  flight.
- **Lease liveness has two clocks.** `heartbeatAt` proves the worker process is
  alive; `lastActivityAt` proves the agent or validation command is producing
  output. The reaper bounds how many stale-lease reclaims one stage may absorb.
- **Serial chain, low risk first.** All slices touch `src/runner.ts`,
  `src/compiler.ts` or `src/types.ts`, so the plan is a same-checkout serial
  chain. Compiler-only work leads, the pool lands before waves need it, and
  each slice is a vertical cut: types, behavior, CLI or status surface, tests
  and docs, verifiable on its own.

### Non-goals

- No change to branch commit authority: only the final integration stage
  commits to the working branch, as today.
- The runtime may create local commits. It never pushes, never opens a pull
  request, and never merges one, in any slice now or later. Agents keep the
  same prohibition in their prompts.
- No new agent roles or prompts beyond the stuck nudge and clarified status
  instructions.
- No GitHub or Linear issue adapters.
- No change to decision-policy behavior.

### Risks

- Slices 6 and 8 introduce multi-wave execution, listed as deferred in the
  status document. Slice 6 is flag-gated so the compiler never emits a
  topology the runtime cannot execute; Slice 8 flips the default. Rollback is
  compiling with `--mode serial`, which must keep producing today's topology,
  pinned by a golden fixture.
- Slice 7 changes the scheduler loop. Existing scheduler and runner tests pin
  skipped-dependency handling and lease semantics and must stay green; a
  deadlock test is added because none exists today.
- Removing `worker` from `Finding.source` is a persisted-data change. Old run
  state files may contain worker-sourced findings; loading must tolerate the
  value and treat those findings as resolved-by-migration.
- The test suite runs real temporary Git repositories, so each slice's full
  test run takes one to two minutes. Targeted validation still runs the whole
  suite to catch cross-slice regressions in the shared runner.

### Test impact

Every slice adds behavior tests against mocked agent backends in the existing
style (`FeedbackBackend`, `ProgressiveRepairBackend`). New backends record the
sequence of roles and statuses they were asked for, so tests assert on what the
runtime chose to run, not only on the final state. Compiler tests gain fixtures
for bold labels, backticked Files entries, fence-only commands, multi-wave
plans and a serial golden manifest. Documentation updates are part of each
slice's acceptance criteria.

### Slice 1 — The fence is the validation contract

**Files**: src/compiler.ts, bin/trip-compile.ts, package.json, package-lock.json, tests/compiler.test.ts, skills/prompt-chain-plan/SKILL.md, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- bin/**
- tests/**
- skills/**
- package.json
- package-lock.json
- README.md

Stop dropping declared validation commands, fix claim parsing, and fail loudly
when a declaration is empty. Compiler-only; no runtime change.

- Split `extractCommands` into `extractFenceCommands(body)` and
  `extractLooseCommands(body)`. The fence extractor finds each
  `Targeted Validation` label and the `sh|bash|shell|zsh` fence that follows
  it, strips a leading `$ ` or `> `, skips blank lines and lines starting with
  `#`, and returns the remaining lines verbatim and in order. The loose
  extractor keeps today's allowlist for command-like lines.
- Precedence: when a slice body contains at least one Targeted Validation
  fence, its commands are the fence commands only. When it contains none, the
  loose extractor is the fallback and the slice compiles with an author
  warning naming it. A slice with a Targeted Validation label whose fence
  yields zero commands is a compile error naming the slice, downgraded to an
  author warning under `--allow-unresolved`.
- `discoverFinalValidationCommands` returns the deduped union of every
  Targeted Validation fence in the document. Only when the document has no
  fence at all does it fall back to the loose scan, and only then to package
  scripts, preserving today's fallback order after the fence step.
- Fix claim extraction so Files entries wrapped in backticks yield bare paths.
  Today the label parser keeps the backticks, producing a second claim no
  allowed path can cover, which is why this plan writes Files without them.
- Add `typescript` as a devDependency at the major version the checkout
  resolves globally, so the check script runs inside the package.
- Plan skill: rewrite the command-extraction section to state the fence rule,
  keep the loose-scan trap advice for slices without a fence, and restore the
  backticked Files form in the template.

**Acceptance Criteria**:
- A plan fence containing a TypeScript compiler invocation and a Node script invocation compiles to a stage whose validation commands equal those two lines in order, and a backticked command-like phrase in that slice's acceptance criteria does not appear in the stage's commands.
- A slice with a Targeted Validation label and an empty fence fails compilation with a message naming the slice, and compiles with a warning when unresolved slices are allowed.
- A slice with no Targeted Validation label still yields the loose-scan command the existing fixture expects, plus an author warning.
- A Files label whose entries are wrapped in backticks produces claims without backticks and validates against directory-glob allowed paths.
- The package declares the TypeScript compiler as a development dependency and the check script resolves it from the local install.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 2 — Worker verdicts stop minting findings

**Files**: src/review.ts, src/runner.ts, src/types.ts, src/store.ts, tests/review.test.ts, tests/runner.test.ts, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- README.md

Take the worker's return out of the finding pipeline entirely.

- Add `workerDirection(review)` to `src/review.ts`: returns the joined
  `missingItems` when present, else the worker's `recommendedFollowupPrompt`,
  else a fixed instruction to address open blocking findings. It never
  produces a `Finding`.
- In `runWriterStage`, the non-complete worker branch calls `workerDirection`
  and no longer calls `handleNonCompleteVerdict` or `findingsFromReview`.
  Findings a worker emits inside its own response are ignored; a reviewer must
  raise them.
- Narrow `Finding.source` to
  `deterministic-validation | independent-review | integration-review | operator`
  and narrow the `source` parameter of `handleNonCompleteVerdict` to match.
- In `loadRunState`, accept a legacy `worker` value and mark that finding
  `resolved` with a `resolutionEvidence.rationale` of "legacy worker
  self-report; not evidence".
- Update the repair prompt's FINAL RESPONSE guidance: `missingItems` is what the
  runtime acts on; `continue` with no missing items is treated as a request for
  review.
- README "Feedback closure": state that worker output never creates findings.

**Needs**:
- Slice 1 — The fence is the validation contract

**Acceptance Criteria**:
- A backend whose worker returns continue three times with prose rationale and embedded finding tags, then complete, leaves zero findings on the stage and the stage completes.
- Loading a run state file that contains a legacy worker-sourced finding succeeds and reports that finding as resolved.
- The next repair prompt after a worker continue contains the worker's missing items under REQUIRED ACTION and contains no OPEN BLOCKING FINDINGS entry derived from worker prose.
- The type checker rejects code that constructs a finding with the worker source.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 3 — Validate every attempt and review completion claims

**Files**: src/runner.ts, src/review.ts, tests/runner.test.ts, docs/ARCHITECTURE.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- docs/ARCHITECTURE.md

Move deterministic validation ahead of the status branch and define the
completion claim.

- Add `isCompletionClaim(review)` to `src/review.ts`: true for `complete`, and
  for `continue` when `missingItems` is empty after trimming. `blocked` and
  `needs_decision` are never claims.
- In `runWriterStage`, after the direct-commit and path-contract checks, run
  `validateStage` for every successful agent return before inspecting the
  worker status. Branch order becomes: validation failed → deterministic
  finding and repair, with the worker's `missingItems` appended to the fixed
  repair direction when present; not a completion claim → worker direction
  and repair, no reviewers; completion claim → output verification, then the
  reviewer ensemble.
- `verifyOutputs` runs only for completion claims, and a missing declared
  output becomes a deterministic-validation finding routed into the repair
  path instead of a thrown error that fails the stage.
- Attempt records keep their current shapes and add
  `asi.completionClaim: boolean`.
- Reviewer prompt: replace "No commands were configured." with a line that
  names whether the stage declares commands, and the runner emits one
  stage-level warning event when a writer stage declares none.
- Architecture doc: the stage state machine text shows `implementing →
  validating` as unconditional and `validating → reviewing` as requiring a
  completion claim.

**Needs**:
- Slice 2 — Worker verdicts stop minting findings

**Acceptance Criteria**:
- A backend whose worker returns continue with an empty missing-items list while validation passes and reviewers approve completes the stage without the worker ever returning complete.
- A backend whose worker returns continue with two missing items triggers no reviewer call for that attempt and the following repair prompt lists both items.
- A completion claim that omits a declared output produces a deterministic finding and a repair attempt rather than a failed stage.
- Validation artifacts exist for every attempt directory, including attempts where the worker returned continue.
- When a writer stage declares no validation commands the reviewer prompt says so explicitly and the run event log contains exactly one warning event for that stage.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 4 — Stuck detection and the worker reflection cap

**Files**: src/stagnation.ts, src/runner.ts, src/types.ts, src/validation.ts, src/status.ts, tests/stagnation.test.ts, tests/runner.test.ts, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- README.md

Detect a worker repeating itself and force verification.

- Extend `stagnationFingerprint` to include the attempt's review status and the
  sorted `missingItems`. This also sharpens `advanceRepairStrategy` for
  reviewer-derived attempts; add a test showing two reviewer attempts that
  differ only in status are no longer treated as stagnant.
- Add `ContinuationPolicy.maxWorkerReflections` (default 3) with the default
  applied in `normalizeManifest`.
- In `runWriterStage`, track consecutive non-claim `continue` returns. When
  `isStagnant` is true over the last two worker attempts, prepend a one-time
  nudge to the next prompt modeled on the OpenHands action-error nudge: the
  last two responses were identical and produced no diff; `continue` without
  missing items is treated as a request for review; list concrete missing
  items or return complete.
- When the consecutive count reaches `maxWorkerReflections`, treat the next
  return as a completion claim regardless of status: it still passes through
  validation first, then reviewers. Emit `stage.worker.reflection_cap` once.
- Status output: show "worker reflections N/M" for the running stage.

**Needs**:
- Slice 3 — Validate every attempt and review completion claims

**Acceptance Criteria**:
- Two consecutive worker attempts with the same diff hash, status and missing items produce a fingerprint match and the third prompt contains the nudge text exactly once.
- A worker that returns continue with missing items four times in a row, with validation passing, is routed to reviewers on the fourth return and the run event log contains one reflection-cap event for that stage.
- The status view for a running stage shows the reflection counter.
- Existing stagnation tests remain green and new tests cover fingerprints that differ only in missing items or only in status.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 5 — Fresh closure reviewers

**Files**: src/types.ts, src/dynamic-backend.ts, src/runner.ts, tests/dynamic-backend.test.ts, tests/runner.test.ts, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- README.md

Make `requireFreshClosureReviewer` mean something, or nothing reads it.

- Add `AgentRequest.sessionScope?: string`. The dynamic backend appends it to
  the session name, so distinct scopes never share a persisted transcript.
- In `runReviewers`, the scope is the attempt number joined with the reviewer
  index, because reviewers within one attempt already share a session name
  today. When the policy is true (the default) every reviewer call carries the
  scope; when false, the scope is omitted and the per-stage session is reused.
- Record `asi.freshReviewers: boolean` on review-derived attempt records so
  the audit can tell which closures were fresh.
- README: document the setting's real behavior and its cost (no cached review
  context across repairs).

**Needs**:
- Slice 4 — Stuck detection and the worker reflection cap

**Acceptance Criteria**:
- With the default policy, two reviewers in the same attempt and the same reviewer across two attempts all carry distinct session scopes; with the policy off they carry none.
- The dynamic backend test shows the session name includes the scope when present and is unchanged when absent.
- Review-derived attempt records record whether reviewers were fresh.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 6 — Wave-aware compilation behind a flag

**Files**: src/compiler.ts, src/types.ts, src/validation.ts, src/inspect.ts, src/runner.ts, bin/trip-compile.ts, tests/compiler.test.ts, tests/validation.test.ts, tests/fixtures/serial-golden.plan.md, tests/fixtures/serial-golden.trip.json, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- bin/**
- tests/**
- README.md

Detect parallel safety as documented and compile dependency waves, without
changing what `--mode auto` emits until the runtime can execute waves.

- Fix `parallelDeclared` to accept optional `**` on both sides of the label
  and an optional colon, and add fixtures for the bold form.
- Add a compile option `waves` (CLI `--waves`), default off. With it off,
  every mode compiles exactly as today. With it on, the compiler assigns each
  writer slice a wave index equal to its longest dependency path among writer
  slices. A wave qualifies for fan-out when every slice in it declares
  parallel safety, no two claims overlap, and no claim is a high-risk path.
  A qualifying wave, including the last one, compiles to worktree writers plus
  a stage `checkpoint-wave-N` of type `integration` with the new strategy
  `worktree-wave-checkpoint`, whose `validationCommands` are the deduped union
  of its writers' commands; other waves compile to same-checkout writers in
  source order. The final `integrate` stage is unchanged and remains the only
  branch-committing stage.
- In waves mode, parallel blockers are evaluated per wave and the
  "declares dependencies" blocker is dropped, because dependencies are edges
  that place a slice in a later wave rather than reasons to serialize. The
  sites that key the `parallel` flag, integration `needs` and the integration
  `integrationStrategy` off a two-valued topology handle `mixed`. Any manifest
  that contains a checkpoint stage has `selectedTopology: mixed`, even when
  every writer sits in one qualifying wave, so the old fan-out label never
  coexists with a checkpoint. Its final `integrate` stage uses
  `same-checkout-finalize`, and the validator's expected-strategy check, which
  targets the final non-checkpoint integration stage, accepts that pairing.
- Add `TripStage.baseFrom?: string`, the id of the checkpoint stage whose
  verified commit is the worktree base. Wave 1 worktree stages leave it unset.
  A checkpoint stage carries `baseFrom` naming the previous wave's checkpoint
  stage (unset for wave 1) and is subject to the same base rule, and its
  `allowedPaths` are the union of its writers' allowed paths so the path
  contract and resume scope checks cover the patches it applies.
  Add `TripStage.schedulingNotes?: string[]` holding the per-slice reasons a
  slice was serialized. `metadata.selectedTopology` and the validation result
  topology gain the value `mixed`.
- Relax manifest validation for mixed manifests, each rule behind the
  presence of a checkpoint stage: mixed writer isolations allowed; more than
  one integration stage allowed when all but the last use the checkpoint
  strategy; strategy no longer inferred from writer isolations alone; writers
  may follow a checkpoint stage; dependent worktree waves allowed when the
  dependency is the checkpoint stage named by `baseFrom`; same-checkout writer
  linear ordering enforced per wave; worktree claim overlap checked only among
  writers that share the same `baseFrom`, since a later wave legitimately
  touches files an earlier wave changed. Add: every `baseFrom` must name an
  earlier checkpoint stage, and worktree writers in one wave must share the
  same `baseFrom`.
- `validateStage` skips `finalValidationCommands` only for stages whose
  strategy is `worktree-wave-checkpoint`, so checkpoint stages run just their
  own commands while every existing manifest's `integrate` stage keeps
  receiving the final commands. This is the single runtime touch in this slice.
- `describeManifest` prints, per stage, its isolation, wave, base and notes.
- Commit a dedicated fixture plan with three slices and its manifest compiled
  in serial mode. The test recompiles the fixture plan and compares only
  `stages`, `metadata.selectedTopology` and `settings`, ignoring the
  generated timestamp, source and policy hashes, contract hash and working
  directory, which legitimately vary.

**Needs**:
- Slice 5 — Fresh closure reviewers

**Acceptance Criteria**:
- A plan whose slices use the bold parallel-safe label with the value yes is detected as declaring parallel safety.
- With the waves option on, a plan with two independent parallel-safe slices followed by one slice that needs both compiles to two worktree writers, one checkpoint stage, and one same-checkout writer whose needs include the checkpoint stage; with the option off, the same plan compiles exactly as before this slice.
- Every same-checkout writer in a mixed manifest carries at least one scheduling note explaining its serialization.
- Manifest validation rejects a worktree stage whose base stage is not an earlier checkpoint stage, rejects two worktree writers in one wave with different bases, accepts a later-wave writer whose claims overlap an earlier wave's, and accepts the mixed fixture.
- The serial golden fixture plan recompiles to the same stages, topology and settings as its committed manifest.
- The checkpoint stage in the mixed fixture does not receive the final validation commands, while the integrate stage of an existing manifest without checkpoint stages still does.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 7 — Pool scheduler with exclusive stages

**Files**: src/runner.ts, src/types.ts, tests/scheduler.test.ts, tests/runner.test.ts, docs/ARCHITECTURE.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- docs/ARCHITECTURE.md

Replace one-stage-per-iteration and chunked batches with a bounded pool.

- Add a small pool in `src/runner.ts` in the shape of wireit's worker pool: a
  count of available slots and a queue of waiters, sized by `maxParallel`.
- `executeLoop` dispatches while slots remain and a schedulable stage exists,
  then awaits the first completion and re-evaluates readiness. Readiness stays
  as today (all needs completed); schedulability adds the exclusivity rule: a
  stage whose isolation is same-checkout, or whose type is integration, may
  start only when nothing is in flight, and while it runs nothing else starts.
- Skipped-dependency marking and deadlock detection run only when the
  in-flight count is zero, so a transiently empty ready set while stages run
  is never mistaken for a deadlock.
- A `PauseRun` or `AbortRun` from any in-flight stage stops further dispatch,
  waits for the other in-flight stages to reach their durable boundary, then
  propagates as today. A `LeaseSuperseded` or lease generation mismatch stops
  dispatch and returns the durable state immediately without persisting
  sibling results, because another worker owns the run.
- Run state writes from concurrent stages are already serialized by the state
  lock; add a test that two concurrent writers both persist their attempt
  records.
- Architecture doc: describe the pool, the exclusivity rule and the
  in-flight guard on deadlock detection.

**Needs**:
- Slice 6 — Wave-aware compilation behind a flag

**Acceptance Criteria**:
- With three ready worktree writers and a maximum concurrency of two, a backend that records overlapping calls observes at most two writers in flight, and the third starts as soon as the first finishes rather than after both.
- A same-checkout stage that becomes ready while worktree writers are in flight starts only after they finish, and no worktree writer starts while it runs.
- A pause raised by one in-flight writer leaves a sibling writer's attempt record persisted before the run pauses, and a superseded lease observed by one writer ends the loop without persisting the sibling's later writes.
- A stage whose dependency failed is marked skipped only after the in-flight siblings have finished (dependency cycles are rejected by manifest validation, so the deadlock branch stays defensive and untested), and existing scheduler tests for skipped dependencies and lease reclaim remain green.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 8 — Multi-wave execution in the runtime

**Files**: src/runner.ts, src/git.ts, src/compiler.ts, src/types.ts, src/reaper.ts, tests/runner.test.ts, tests/git.test.ts, tests/compiler.test.ts, tests/liveness.test.ts, docs/ARCHITECTURE.md, docs/IMPLEMENTATION-STATUS.md, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- docs/ARCHITECTURE.md
- docs/IMPLEMENTATION-STATUS.md
- README.md

Execute checkpoint waves and make wave-aware compilation the default.

- `writerLocation` resolves a worktree stage's base: the `verifiedCommit` of
  the checkpoint stage named by `baseFrom`, else the run base revision. The
  worktree is created from that base, and the immutable-base assertion at the
  start of `runWriterStage` compares against it rather than the run base.
- `persistWriterBoundary` passes the same resolved base to
  `createCheckpointCommit`, so wave-N worktree checkpoints are computed
  against their real base instead of failing silently inside the existing
  try/catch.
- A `worktree-wave-checkpoint` stage is deterministic: `runIntegrationStage`
  branches on the strategy before any agent call, and no integration agent
  runs for it. It applies the verified patches of exactly the writers whose
  `baseFrom` matches its own base (unset for wave 1), runs its own validation
  commands, captures the cumulative run-owned patch and records
  `cumulativePatchPath` and `cumulativePatchSha256` on its stage state, then
  calls `createCheckpointCommit` with that patch. The checkpoint commit's
  parent is the run base revision, which is the main checkout's HEAD and what
  the helper's base check requires; only its base trailer carries the resolved
  wave base. The stage stores the hash in `verifiedCommit` and appends a
  `wave.checkpointed` event. It does not call the branch-commit path, does not
  set `resultCommit`, and does not write the integration journal.
- Checkpoint validation failure first reverse-applies the writer patches the
  checkpoint stage applied through a new `reverseApplyPatch` helper in
  `src/git.ts` with its own test, restoring the run-owned paths to the previous
  checkpoint's tree (or to the run base for wave 1), then pauses the run with a
  new pause kind `checkpoint_blocked` whose reason names the failing command.
  No checkpoint ref is written, and the reaper's stop list includes the new
  kind. On resume the stage re-applies its wave's patches once and proceeds, so
  the wave-1 clean-checkout assertion and the later-wave drift check both hold
  on re-entry.
- Resume reconciliation, which today compares the working tree only against
  the latest completed same-checkout writer's cumulative patch hash, takes the
  latest completed stage among same-checkout writers and checkpoint stages, so
  a resume after a checkpoint in a mixed manifest does not report drift against
  a stale writer hash.
- Clean-checkout handling: the wave-1 checkpoint keeps today's clean-checkout
  assertion. Because checkpoint commits use a temporary index and leave the
  working tree carrying the wave's changes uncommitted, every later checkpoint
  stage and the final `integrate` stage in a manifest that contains checkpoint
  stages replace the clean-checkout assertion with a drift check: the SHA-256
  of the current run-owned patch must equal the previous checkpoint stage's
  recorded cumulative patch hash, following the existing reconciliation
  pattern. A mismatch pauses with `workspace_drift` and applies no patches.
- In a wave-aware manifest every qualifying wave, including the last, has a
  checkpoint stage, so the final `integrate` stage applies no worktree patches
  itself; it keeps today's behavior for branch commit, result commit and
  journal. Manifests without checkpoint stages run exactly as before.
- The compiler's `--mode auto` becomes wave-aware by default; `--waves` stays
  as an explicit override and `--mode serial` is unchanged.
- Docs: architecture describes waves; the status document removes the deferred
  item for multiple parallel implementation epochs; the README limitation that
  only one same-base parallel writer wave is supported is deleted.

**Needs**:
- Slice 7 — Pool scheduler with exclusive stages

**Acceptance Criteria**:
- A two-wave manifest runs the second wave's worktree writers from the first wave's checkpoint commit, the checkpoint stage leaves the branch head unchanged, and the final commit contains changes from all writers.
- A second-wave fan-in whose run-owned patch hash differs from the first checkpoint's recorded hash pauses with the workspace-drift kind and applies no patches, and a checkpoint whose validation command fails pauses with the checkpoint-blocked kind without writing a checkpoint ref and with the wave's patches reverted from the tree.
- A run paused with the checkpoint-blocked kind resumes, re-applies the wave's patches exactly once, and completes when validation passes; a resume after a completed checkpoint in a mixed manifest does not report workspace drift.
- No integration agent request is made for a checkpoint stage; the backend sees only writer, reviewer and final-integration roles.
- Manifests compiled before this slice, with no checkpoint stages, run unchanged and the existing worktree fan-in test stays green; in a wave-aware manifest the final integrate stage applies zero worktree patches.
- Compiling this plan in auto mode now yields the wave-aware result, and the serial golden fixture still matches in serial mode.
- The status document no longer lists multiple parallel implementation epochs as deferred and the README no longer states the one-wave limitation.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 9 — Activity clock and bounded reclaim

**Files**: src/types.ts, src/store.ts, src/runner.ts, src/reaper.ts, src/status.ts, src/validation.ts, tests/liveness.test.ts, tests/scheduler.test.ts, tests/status.test.ts, README.md

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- README.md

Give the lease a second clock and stop infinite reclaim loops.

- Add `RunLease.lastActivityAt?: string`. The activity callbacks in `runAgent`
  and validation command execution update it in memory; `heartbeatRunLease`
  gains a parameter to persist it, and `writeRunState` carries it alongside
  `heartbeatAt`.
- Add `StageRunState.reclaims` (initialized to zero in `newStageState`,
  undefined read as zero for old state files) and
  `ContinuationPolicy.maxLeaseReclaims` (default 3, applied in
  `normalizeManifest`). `reconcileInterruptedStages` increments the counter
  only when the claim's previous status was running, which is the stale-lease
  reclaim case; operator resumes of paused or failed runs do not count.
- When the counter exceeds the maximum, the run pauses with a new pause kind
  `reclaim_exhausted` and a reason naming the stage and count. The reaper's
  stop list includes the new kind so it does not resume again.
- Status output: the lease line shows heartbeat age and activity age
  separately, and a running stage with a fresh heartbeat but stale activity is
  labeled "alive, idle".
- README activity-warnings section: describe the two clocks and the reclaim
  bound.

**Needs**:
- Slice 8 — Multi-wave execution in the runtime

**Acceptance Criteria**:
- Streaming activity from a mocked backend updates the persisted last-activity timestamp while the heartbeat timestamp advances independently.
- A stage whose stale lease is reclaimed four times pauses the run with the new pause kind and a reason naming the stage and count, the reaper returns without resuming again, and three operator resumes of a paused run do not change the counter.
- The status view distinguishes a live-and-active run from a live-but-idle run.
- Existing liveness tests for warnings, heartbeat shutdown and reaper recovery remain green.

**Targeted Validation**:
```sh
npm run check
npm test
```
