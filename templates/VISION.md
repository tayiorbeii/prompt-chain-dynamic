# Project Vision

## Product goal

Describe what this project exists to accomplish and who it serves.

## Current priorities

1. Replace with the highest-value current objective.
2. Keep this list short and ordered.

## Agent authority

Agents may autonomously:

- Research the repository and relevant documentation.
- Implement approved, path-constrained plan slices.
- Add or update behavioral tests inside approved paths.
- Choose among safe, reversible, in-scope options when a decision is required.
- Run configured validation commands.

Agents may not autonomously:

- Expand approved scope or path ownership.
- Access or expose secrets not required by the task.
- Perform destructive production actions.
- Bypass failed validation or unresolved blocking findings.
- Commit, merge, tag, or push except through the Prompt-chain hybrid runtime/release gate.

## Decision policy

The default is agent decision-making. A dedicated decision agent should choose the smallest reversible option consistent with this vision, ARCHI.md, the approved plan, and existing repository patterns.

Start a run with `--human-decisions` when a human must approve every explicit `needs_decision` event. Even in human mode, the decision agent prepares a recommendation and alternatives before the runtime pauses.

## Risk and escalation

Human approval is normally required before release for authentication, authorization, billing, deletion, migrations, secrets, dependency additions, public API breaks, infrastructure changes, or irreversible external effects.

## Definition of done

Work is done only when deterministic validation passes, independent review resolves, all blocking findings are closed or explicitly dispositioned, the Git path contract passes, and the runtime persists a durable completion boundary.
