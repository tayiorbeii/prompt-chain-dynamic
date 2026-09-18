# Real-agent canary

## What it proves

The 112 tests in `tests/*.test.ts` (excluding this one) all run against
mocked `AgentBackend` implementations that return scripted, deterministic
responses. They prove the scheduler, compiler, validation, reaper, and
runner logic is correct — but none of them prove that a *real* coding agent,
talking through `DynamicWorkflowBackend` (`src/dynamic-backend.ts`) and
`@quintinshaw/pi-dynamic-workflows`' `WorkflowAgent`, can actually:

- Return the `structured_output` shape this runtime's XML/JSON adapters
  (`toLegacyCompatibleReview`, `toDecisionXml`) expect.
- Respect an `allowedPaths`/`claimedPaths` contract while editing real files.
- Produce a patch that satisfies a stage's `validationCommands`.
- Complete a full `research -> implementation -> review -> integration`
  loop end to end, including at least one reviewer pass.

`tests/canary.real-agent.test.ts` is that missing evidence: one minimal,
cheap, deterministic task run through the real production code path
(`runManifestFile` with no backend override, so it resolves the same
`DynamicWorkflowBackend` a real `prompt-chain` invocation would use).

## Why it is not part of the default test run

It is a real, metered call to a real model. Silently running it in `npm
test` or CI would mean every contributor's test run costs money, depends on
network/auth availability, and can flake on ordinary model latency/variance
— none of which is true of the rest of the suite. So:

- It lives in `tests/canary.real-agent.test.ts`, matched by `npm test`'s
  `tests/*.test.ts` glob, but is registered with node's test runner as
  **skipped by default**. It always shows up in a normal `npm test` run as
  `skip`, never as a silent omission, and never spends a real API call.
- A dedicated `npm run test:canary` script sets
  `PROMPT_CHAIN_REAL_AGENT_CANARY=1` and runs only this file.

## Running it

```bash
npm run test:canary
```

This requires whatever model auth `pi-dynamic-workflows`' `WorkflowAgent`
needs in your environment (an authenticated `pi` model registry, or
provider API keys) — exactly the same auth a real `prompt-chain` run would
need. There is no separate credential setup specific to the canary.

By default every role is pinned to the runtime's `"small"` tier
(`src/dynamic-backend.ts`'s `defaultTier` otherwise upgrades `review` to
`"medium"` and `decision`/`integration` to `"big"`) to keep the run as
cheap as the runtime's own tiering allows. Override the model explicitly
with:

```bash
PROMPT_CHAIN_CANARY_MODEL="provider/model-id" npm run test:canary
```

## What a failure means

The canary manifest sets `continuationPolicy.bestEffortCompletion: false`
deliberately — the same fail-closed default this runtime now ships with
(see the Tier 1 fix that flipped `bestEffortCompletion`'s default). A
canary that silently accepted an unresolved implementation as best-effort
"complete" would prove nothing. If the canary fails, treat it as a real
signal that the implement-review-integrate loop is broken against a live
backend, not as pre-existing flakiness to route around.

## Extending it

This canary is intentionally minimal (write one file with fixed content).
If you need higher-confidence evidence before a release — e.g. exercising
a real repair round, a `worktree-fanout` topology, or a decision pause —
add further `test("real-agent canary: ...", { skip: ... }, ...)` cases in
the same file, gated behind the same `PROMPT_CHAIN_REAL_AGENT_CANARY` flag,
rather than turning any of them on by default.
