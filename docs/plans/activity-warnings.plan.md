# Activity-aware warnings instead of operation deadlines

## Overview and approval

The user approved: warn and keep waiting for silent operations; do not kill active work or launch timeout replacements. Implement directly in this runtime, verify, stage, commit, and push. Do not restart the previously stopped workload.

Baseline evidence (before this fix): `src/runner.ts` races backend calls against `withTimeout`; `src/git.ts` kills validation commands on a fixed deadline. `DynamicWorkflowBackend` forwards a timeout option, although the installed WorkflowAgent API has no such option. Its supported `onHistory` and `onUsageProgress` hooks provide activity observations.

## Architecture and compatibility

Reuse existing numeric settings as inactivity-warning intervals, retaining their names for existing compiled manifests: session/agent calls default to 30 minutes, validation commands 15 minutes, decisions retain their existing interval selection. Explicit legacy timeout values are warning intervals too, not opt-in termination. Zero disables warnings. Document this intentional behavioral change. Do not add a second timeout-policy system or dependency.

Add a small reusable activity monitor: monotonic elapsed/idle durations, reset on observed activity, periodic warnings while silent, cleanup when settled. Warnings are best-effort and must neither reject the operation nor wait for a broken observer. Keep the process alive while waiting. Emit durable and live warning events without fabricating stage transitions, failed attempts, or progress. Runtime lease heartbeats do not count as agent activity.

The internal `AgentBackend` / `AgentRequest` boundary receives `timeoutMs: 0` and an optional activity callback; the unsupported timeout option is removed from the `WorkflowAgent` call. History/streaming usage observations invoke the activity callback, preserving the separate final `onUsage` accounting. Await the original call without a deadline. Validation uses stdout/stderr activity and no process timeout. Keep existing fixed bounds for internal Git operations, research hooks, lease shutdown, and telemetry: those are not worker/validation deadlines.

## Non-goals

No productive-progress heuristic, automatic retries on silence, new hard-limit/cancellation feature, changes to reaper ownership, dependency updates, or paid live runs. Manual abort remains the existing cooperative-at-boundaries behavior; this change does not claim immediate interruption of an in-flight tool.

## Risks / rollback

A genuinely hung operation can remain waiting indefinitely; warnings explicitly state that silence is not proof of a hang. Host tools/providers may enforce their own independent limits. Sparse backend activity produces advisory warnings only. Reverting restores the previous deadline behavior. Existing manifest hashes and stored run state are not rewritten.

## Test impact

Replace the historical decision-timeout/fallback test with a delayed real decision that succeeds after warnings. Add deterministic activity-monitor tests, backend hook wiring tests, silent/active runner regressions, and validation command completion/failure tests. Retain independent internal timeout/heartbeat tests.

### Slice 1 — Warning-only operations

**Files**: `src/liveness.ts`, `src/types.ts`, `src/runner.ts`, `src/dynamic-backend.ts`, `src/git.ts`, `src/validation.ts`, `tests/liveness.test.ts`, `tests/git.test.ts`, `tests/dynamic-backend.test.ts`, `tests/validation.test.ts`, `README.md`, `docs/ARCHITECTURE.md`

**Parallel-safe**: no

**Allowed paths**:
- src/**
- tests/**
- README.md
- docs/**

Implement the architecture above in a single coherent slice. No dependency or runtime-artifact changes.

**Needs**:
- none

**Acceptance Criteria**:
- Active agents and commands can exceed the old fixed duration; activity postpones warnings.
- Silent agents, decisions, and validation commands emit warnings and remain pending until their actual result; no timeout replacement or fallback is launched.
- Legacy compiled numeric limits select warning intervals; backend hard deadline is disabled.
- Warnings expose elapsed and idle time, survive observer failure without failing work, and stop after completion/error.
- Validation still reports actual output and exit status and stops on a real nonzero exit.
- Internal Git/control-plane bounds, stage safety checks, and manual cooperative abort are unchanged.

**Targeted Validation**:
```sh
npm run check
node --experimental-strip-types --test tests/liveness.test.ts tests/git.test.ts tests/dynamic-backend.test.ts tests/validation.test.ts
```

## Review and validation

Independent plan review: APPROVED after source-backed clarification of the internal AgentRequest versus WorkflowAgent boundary and the existing runner regressions in `tests/liveness.test.ts`. No additional scope or redundant test files required.

Regression reproduction: both new silent-operation tests failed before implementation (validation killed; backend called four times instead of once). After implementation, typechecking and all 120 tests passed on the original baseline. After rebasing onto upstream `7362ed6`, an additional regression proved warning-disabled operations could exit early with no other active handles; retaining the monitor handle fixed it. Final validation: typechecking passed; 123 tests passed, 0 failed, 1 opt-in paid-agent canary skipped; example manifest validation passed. The staged diff was inspected. No paid agent canary or previously stopped workload was run.
