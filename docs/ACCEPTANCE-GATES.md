# Acceptance Gates Before Unattended Use

The included unit/integration tests are a development baseline, not production certification.

## Required automated gates

- Free-form corrective feedback cannot advance a stage.
- Generic agent failure plus partial text cannot become success.
- Repair-loop exhaustion pauses rather than approves.
- Default `needs_decision` invokes a decision agent.
- `--human-decisions` pauses after producing an agent recommendation.
- A decision cannot close its finding without implementation and review.
- Out-of-scope writes fail.
- Direct agent commits fail.
- Worktree claims do not overlap.
- Fan-in waits for every required worker artifact.
- Final staging contains only verified owned paths.
- Next.js bracket paths remain literal.
- Missing plan paths are never invented.

## Required live canaries

1. Two dependent same-checkout slices.
2. Three independent worktree slices, including one deliberately slow worker.
3. Free-form review feedback followed by repair and closure.
4. Explicit `needs_decision` in autonomous mode.
5. Explicit `needs_decision` in human mode.
6. Out-of-scope new file.
7. Direct worker commit.
8. Patch conflict during fan-in.
9. Main branch moves before final commit.
10. Process termination after:
    - worker patch persistence
    - all worker patches
    - integration journal preparation
    - result commit but before final state write
    - same-checkout cumulative patch persistence
11. Resume after every termination point without duplicate commit or lost work.
12. Run under the exact Pi version, model provider, project extensions, and operating system intended for production.

## Release threshold

Do not call the system production-ready until raw evidence for each gate is retained and independently reviewed. Any skipped crash or security canary remains a blocker.
