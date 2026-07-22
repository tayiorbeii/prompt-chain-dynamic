# Hybrid Architecture

## Authority boundaries

### Prompt-chain manifest

The JSON manifest is the canonical program and authorization contract. It owns stage IDs, dependencies, prompts, path contracts, validation, outputs, review policy, decision policy and integration topology.

### Stage scheduler and lifecycle

The scheduler finds dependency-ready stages. Each stage is a state machine:

```text
pending → preparing → implementing → validating → reviewing
                                      ↑              │
                                      └── repairing ← continue
                                                     needs_decision → deciding
                                                     blocked → paused
                                                     complete → capturing → checkpointed
```

A DAG models macro dependencies. Repair and decision behavior is not represented as additional DAG nodes.

### pi-dynamic-workflows

`DynamicWorkflowBackend` calls `WorkflowAgent` with a role-specific TypeBox schema, model tier, tools, working directory, timeout, and persisted session name. It supplies reasoning execution, not authorization.

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
