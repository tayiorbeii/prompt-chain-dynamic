---
name: prompt-chain-implement
description: Execute an approved Prompt-chain hybrid implementation DAG with path contracts, validation, feedback-closure review loops, decisions, worktrees, checkpoints, and deterministic integration.
---

# Prompt-chain hybrid Implementation

Do not manually walk plan prompts. Start the runtime so stage advancement is controlled by durable evidence rather than conversation state.

## Preconditions

- The plan is approved.
- The `.trip.json` manifest passes `prompt-chain validate`.
- The Git checkout is clean.
- `docs/VISION.md`, `docs/ARCHI.md`, and repository instructions are current.
- Pi is authenticated and its default model can use the required tools.

## Start

Default autonomous decisions:

```text
/prompt-chain-run docs/plans/<feature>.trip.json
```

Require a human choice for every explicit `needs_decision` event:

```text
/prompt-chain-run docs/plans/<feature>.trip.json --human-decisions
```

The default is intentionally agent decisions. A fresh decision agent chooses the smallest reversible in-scope option, records its rationale, and sends the direction back through implementation, validation, and closure review.

Human mode still runs the decision agent first, then pauses with its recommendation. Respond with:

```text
/prompt-chain-decide <run-id> <choice> :: <rationale>
/prompt-chain-resume <run-id>
```

## Runtime invariants

- A successful child exit or non-empty answer is not completion.
- Free-form corrective feedback is normalized to `continue` and persisted as a blocking finding.
- The current stage repeats until deterministic validation passes, fresh review returns `complete`, and no blocking finding remains open.
- Repair-loop exhaustion pauses as `review_blocked`; it never accepts the latest result.
- Agents edit freely within their allowed paths (a directory-glob boundary by default), including sibling fixtures, generated code, and related tests their change ripples into; they cannot write outside those allowed paths. In a same-checkout serial chain, uncommitted changes carried in from prior stages are expected and in-contract, not a scope violation.
- Agents do not commit. The runtime owns the final commit.
- Parallel writers use isolated worktrees and one same-base fan-out wave.
- Fan-in waits for every required worker artifact and clear finding ledger.
- Abort is cooperative at durable boundaries.

## Observe

```text
/prompt-chain-status <run-id>
```

Resume an interrupted or paused run:

```text
/prompt-chain-resume <run-id>
```

Request abort:

```text
/prompt-chain-abort <run-id>
```

## The goal is always full completion — triage every pause instead of stalling

A paused or `review_blocked` run is not a stopping point. Before resuming, deciding, or reporting
back, always diagnose **why** the stage cannot close, and pick the fix that gets the run moving
again toward `completed`. There are two distinct failure classes; do not treat them the same way.

### 1. Genuine implementation defect

The code, tests, or behavior are actually wrong or incomplete relative to the frozen plan section.

- Read the finding(s) in `.pi/prompt-chain-hybrid/runs/<run-id>/findings/*.json` and the stage's
  latest diff.
- If the fix is in-contract (touches only the stage's `allowedPaths`), let the repair loop continue
  (`/prompt-chain-resume <run-id>`) — the implementer will see the same finding again and can
  correct it.
- If a real product/architecture choice is blocking progress, resolve it as a decision
  (`/prompt-chain-decide` + `/prompt-chain-resume`) rather than guessing silently.

### 2. Manifest or plan-authoring defect (the run can never pass as compiled)

Some pauses are caused by the **frozen manifest itself**, not the agent's work — the implementer
produced correct, in-contract code, but the stage still cannot close. Recognize this pattern:

- `review_blocked` after exhausting repair rounds, and re-reading the diff shows the change is
  actually correct and matches the plan's acceptance criteria.
- A `deterministic-validation` finding whose `evidence` shows a shell syntax error, an unbalanced
  backtick, a duplicated/garbled command, or a command that could not possibly correspond to
  anything in the plan's `Targeted Validation` fence.
- A finding that says the change is "outside its allowed path contract" for a file the plan's
  narrative clearly required (e.g. a test file the plan's prose implied but which was never listed
  under a slice's `**File**:`). With the permissive default path policy this is now rare — a slice
  claiming a file under `convex/` is granted `convex/**` — so when it does happen the slice's
  `**Allowed paths**` were pinned too narrow (or `--path-policy strict` was used). The fix is to
  widen that boundary (see below), not to spend repair rounds.
- A stage that pauses with the implementer reporting its work is correct and tested but "blocked by
  pre-existing changes outside the frozen path contract" (e.g. a prior serial stage's schema or
  generated files it will not touch). The code is fine; the manifest's contract is too narrow for
  the ripple the plan actually requires.
- Repeated repair rounds converge on the same correct diff and the same failure, with no material
  change in the finding across rounds.

When this pattern is recognized, do **not** keep spending repair rounds or ask the agent to
"try again" — the manifest is the actual defect. Instead:

1. `/prompt-chain-abort <run-id>` to close the stuck run cleanly (never leave it ambiguous).
2. Inspect the compiled manifest (`/prompt-chain-inspect <manifest>` and, if needed, read the raw
   JSON) to confirm the exact defect — a malformed `validationCommands` entry, a missing path in
   `allowedPaths`/`claimedPaths`, or a contradiction between prose and the file contract.
3. Fix the root cause at the source: edit the Markdown plan (preferred — e.g. add the missing
   `### Slice N` for a file the narrative required, widen an over-narrow `**Allowed paths**` to the
   directory glob the ripple needs, or rewrite prose that the compiler mis-extracted as a command
   per `prompt-chain-plan`'s command-extraction guidance) and recompile with `/prompt-chain-compile`.
   Only hand-edit the compiled JSON directly when the plan wording is already correct and the defect
   is purely in how the compiler rendered it, and note the hand-edit in the final report.
   - **Widening a path contract by hand-editing a live run's `run.json` is a two-part edit.** The
     runtime enforces from each stage's `allowedPaths` field, but the *writer agent* obeys the path
     contract embedded in its frozen `stage.prompt` text. Widening only the field leaves the agent
     reading the old narrow list, so it keeps treating rippled/pre-existing files as foreign and
     blocks. Patch both the `allowedPaths` field **and** the `PATH CONTRACT` block inside
     `stage.prompt` (and reset the stage's `reviewRounds` if repair rounds were exhausted). Prefer a
     recompile over hand-editing whenever the run has not made expensive progress.
4. Re-validate (`/prompt-chain-validate`) and re-inspect the corrected manifest before restarting.
5. Start a fresh run against the corrected manifest (`/prompt-chain-run <corrected-manifest>
   --human-decisions`, or without the flag once trust is established) rather than resuming the
   run whose manifest was defective — a frozen manifest's stage contracts do not change once a run
   has started against it.
6. Carry forward any already-correct, in-contract code changes from the aborted run's working tree
   when they satisfy the corrected plan, instead of discarding verified-good work.

The objective across both classes is the same: never report a paused, blocked, or failed run as a
final answer. Diagnose, fix at the right layer (code vs. plan/manifest), and keep driving the run
— or a corrected replacement run — to a `completed` status.

## Completion

Implementation is complete only when the run status is `completed`, the final review gate passed, open blockers are zero, and the result commit is recorded when auto-commit is enabled.
