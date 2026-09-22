# Hybrid Architecture

## Authority boundaries

### Prompt-chain manifest

The JSON manifest is the canonical program and authorization contract. It owns stage IDs, dependencies, prompts, path contracts, validation, outputs, review policy, decision policy and integration topology.

### Stage scheduler and lifecycle

The scheduler finds dependency-ready stages. Each stage is a state machine:

```text
pending → preparing → implementing → validating ──(completion claim)──→ reviewing
                                      ↑    │                              │
                                      │    └─(not a claim: worker direction)   │
                                      └── repairing ←─────────────────────────┘ continue
                                                     needs_decision → deciding
                                                     blocked → paused
                                                     complete → capturing → checkpointed
```

`implementing → validating` is unconditional: deterministic validation runs on every worker return, whatever status the worker reported. `validating → reviewing` requires a *completion claim*, which is an explicit `complete` or a `continue` that lists nothing as missing. A `continue` with missing items goes straight back to repairing with those items as direction, without reviewers. A completion claim that lacks a declared output produces a deterministic finding and repairs, rather than failing the stage. Worker output never creates findings; only validation and reviewers do.

A DAG models macro dependencies. Repair and decision behavior is not represented as additional DAG nodes.

#### Scheduling

Ready stages are dispatched into a bounded pool of `settings.maxParallel` slots and the loop re-evaluates readiness on every completion, so a finished worktree writer is replaced immediately rather than after its whole batch. Same-checkout and integration stages are *exclusive*: one starts only when nothing is in flight, and while it runs nothing else starts, because both mutate the shared checkout. Worktree writers backfill around a waiting exclusive stage. Skipped-dependency marking and deadlock detection run only when the pool is empty; a transiently empty ready set while stages run is not a deadlock (dependency cycles are rejected by manifest validation, so the deadlock branch is defensive). A pause, abort or stage failure stops new dispatch and waits for in-flight siblings to reach their durable boundary before propagating; a superseded lease returns the durable state immediately, since stale writers cannot overwrite it.

### pi-dynamic-workflows

`DynamicWorkflowBackend` calls `WorkflowAgent` with a role-specific TypeBox schema, model tier, tools, working directory, and persisted session name. It supplies reasoning execution, not authorization. Supported history and streaming-usage callbacks report activity to the runtime; final usage reporting is preserved. No wall-clock deadline is passed to the backend. The runtime awaits the original agent or validation result, emitting advisory inactivity warnings (live and durable) without cancellation, failure classification, or replacement. Legacy timeout settings now select warning intervals, and activity resets the warning timer. Lease/control-plane bounds are independent and unchanged.

### Git transaction layer

The transaction layer owns immutable base revisions, worktrees, actual changed-path attribution, direct-commit detection, validation, patch hashing, fan-in, integration journals and final commits.

## Data model

```text
plan.md
manifest.prompt-chain.json
.pi/prompt-chain-hybrid/runs/<run-id>/
  manifest.json
  run.json
  events.jsonl
  findings/
  decisions/
  stages/<stage-id>/attempt-*/
  integration/journal.json
```

## Caching rule

Agent-session persistence may retain transcripts. No cached or replayed LLM result is accepted as evidence that code still exists. Writer completion is always reconciled from Git state and verified artifacts.
