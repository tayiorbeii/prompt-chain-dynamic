# Implementation Status — 0.2.0

## Implemented

- Markdown implementation-slice compiler.
- Schema-v1 prompt-chain JSON validator.
- Source, policy and contract hashes.
- Manifest inspection view.
- DAG scheduling and serialized/shared-checkout execution.
- One-wave parallel worktree fan-out and deterministic fan-in.
- `WorkflowAgent` backend from pi-dynamic-workflows 3.0.0.
- TypeBox structured output for stage and decision agents.
- Role tier/model routing.
- Finding persistence and mandatory repair closure.
- Agent-first and human-intervention decision modes.
- Path enforcement, validation, patch hashes and scoped commit promotion.
- Cooperative abort and durable resume reconciliation.
- Local append-only issue controller.
- Pi commands, skills, shell CLI, templates and installation scripts.

## Verified locally

- TypeScript static check.
- 21 tests.
- Temporary Git repositories and real worktree operations.
- Feedback-closure regression.
- Autonomous and human decision flows using injected test backends.
- Commit-after-interruption reconciliation.

## Not verified in this environment

- Live authenticated `WorkflowAgent` calls.
- Provider rate-limit auto-resume integration.
- Pi task-panel interoperability with simultaneous dynamic-workflows installation.
- Long-duration multi-model runs.

## Deferred

- Multiple parallel implementation epochs.
- Dynamic manifest amendment protocol.
- GitHub Issues and Linear adapters.
- A dedicated operator TUI.
- Remote workers and cryptographic artifact signatures.
