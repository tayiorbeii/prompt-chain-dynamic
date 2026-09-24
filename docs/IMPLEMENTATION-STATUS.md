# Implementation Status — 0.2.0

## Implemented

- Markdown implementation-slice compiler.
- Schema-v1 prompt-chain JSON validator.
- Source, policy and contract hashes.
- Manifest inspection view.
- DAG scheduling and serialized/shared-checkout execution.
- Parallel worktree fan-out and deterministic fan-in, including multi-wave execution: dependency waves compiled by default in auto mode, deterministic `checkpoint-wave-N` stages that fold a wave into a private checkpoint ref, and later waves branching from it.
- `WorkflowAgent` backend from pi-dynamic-workflows (dependency range `^3.3.0`).
- TypeBox structured output for stage and decision agents.
- Role tier/model routing.
- Finding persistence and mandatory repair closure.
- Agent-first and human-intervention decision modes.
- Path enforcement, validation, patch hashes and scoped commit promotion.
- Cooperative abort and durable resume reconciliation.
- Verified-patch checkpoint capture using a temporary Git index, preserving unrelated staged changes.
- Activity-aware warnings for agent and validation operations, without deadline-triggered cancellation or replacement.
- Local append-only issue controller.
- Pi commands, skills, shell CLI, templates and installation scripts.

## Verified locally — 2026-09-22 reconciliation

- TypeScript static check and 171 passing tests; one opt-in real-agent canary skipped (172 total).
- Smoke suite, including example manifest validation and plan compilation/validation.
- Package dry-run inspection; no runtime state, Git metadata, or dependency directories included.
- Temporary Git repositories and real worktree operations.
- Checkpoint/index preservation, literal paths, binary patch round-trips, failure cleanup, stale-base rejection, and cumulative serial-writer checkpoints.
- Silent and active agent/validation operations continue beyond their warning interval without replacement; silent decisions complete without fallback.
- Feedback-closure regression.
- Autonomous and human decision flows using injected test backends.
- Commit-after-interruption reconciliation.

## Installed-copy reconciliation

The installed Git checkout diverged from the project/GitHub checkout after `7362ed6`.

- Integrated `e97acd4` (isolated verified checkpoint capture), retaining the inactivity-warning regressions already on main.
- Retained `a945202` (warn on inactivity without timing out working operations).
- Did not apply `f8d1d06` (cancel/drain timed-out agents before retrying): it fixes overlapping retries under the old deadline policy, but reintroduces deadline-triggered cancellation. The current warning-only policy removes that trigger and waits for the original operation instead. Its deadline-specific regressions are superseded by the no-replacement tests, not silently omitted.
- The original installed commits remain preserved locally on `archive/installed-before-disable-20260922` and in the untouched installed checkout. This reconciliation does not claim production readiness or live-provider validation.

## Not verified in this environment

- Live authenticated `WorkflowAgent` calls.
- Provider rate-limit auto-resume integration.
- Pi task-panel interoperability with simultaneous dynamic-workflows installation.
- Long-duration multi-model runs.

## Deferred

- Dynamic manifest amendment protocol.
- GitHub Issues and Linear adapters.
- A dedicated operator TUI.
- Remote workers and cryptographic artifact signatures.
