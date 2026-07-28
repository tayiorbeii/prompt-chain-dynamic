import assert from "node:assert/strict";
import test from "node:test";
import { buildRunSummarySections, formatRunSummary } from "../src/status.ts";
import type { NormalizedReview, RunState } from "../src/types.ts";

const completeReview: NormalizedReview = {
  status: "complete",
  risk: "low",
  rationale: "Verified.",
  missingItems: [],
  findings: [],
  raw: "<status>complete</status>",
  malformed: false,
};

test("status summary includes request, run, step, attempt, validation, and blocker details", () => {
  const state: RunState = {
    formatVersion: 1,
    id: "trip-20260724-example",
    manifestPath: "/repo/plan.json",
    manifest: {
      schemaVersion: 1,
      name: "Detailed status example",
      workingDirectory: "/repo",
      stages: [
        {
          id: "research",
          type: "review",
          needs: [],
          isolation: "readonly",
          prompt: "Inspect the existing implementation.",
        },
        {
          id: "implementation-slice-2",
          type: "implementation",
          needs: ["research"],
          isolation: "same-checkout",
          prompt: "Implement the full review workflow with behavioral acceptance coverage.",
          outputs: ["src/controller.ts", "src/panel.test.tsx"],
        },
      ],
    },
    status: "paused",
    baseRevision: "abc123",
    decisionMode: "agent",
    createdAt: "2026-07-24T00:00:00.000Z",
    startedAt: "2026-07-24T00:01:00.000Z",
    updatedAt: "2026-07-24T00:10:00.000Z",
    pauseKind: "review_blocked",
    pauseReason: "Waiting for another verified repair.",
    abortRequested: false,
    stageStates: {
      research: {
        id: "research",
        status: "completed",
        attempts: [],
        reviewRounds: 0,
        startedAt: "2026-07-24T00:01:00.000Z",
        completedAt: "2026-07-24T00:02:00.000Z",
        changedPaths: [],
        validationResults: [],
      },
      "implementation-slice-2": {
        id: "implementation-slice-2",
        status: "paused",
        attempts: [
          {
            attempt: 5,
            role: "repair",
            validationResults: [],
            reviewVerdict: completeReview,
            diffHash: "diff123",
            asi: { source: "ensemble-review" },
            status: "discard",
            startedAt: "2026-07-24T00:07:00.000Z",
            completedAt: "2026-07-24T00:09:00.000Z",
          },
        ],
        reviewRounds: 5,
        startedAt: "2026-07-24T00:02:00.000Z",
        pauseReason: "Reviewer requested acceptance coverage.",
        changedPaths: ["src/controller.ts", "src/panel.test.tsx"],
        validationResults: [
          {
            command: "npm test",
            exitCode: 1,
            stdout: "",
            stderr: "one test failed",
            durationMs: 1_500,
            timedOut: false,
          },
        ],
      },
    },
    findings: [
      {
        id: "finding-1",
        runId: "trip-20260724-example",
        stageId: "implementation-slice-2",
        attempt: 5,
        source: "independent-review",
        severity: "major",
        blocking: true,
        summary: "Exercise the real panel controller",
        evidence: "src/panel.test.tsx:1",
        affectedPaths: ["src/panel.test.tsx"],
        disposition: "open",
        createdAt: "2026-07-24T00:09:00.000Z",
        updatedAt: "2026-07-24T00:09:00.000Z",
      },
    ],
    decisionRequests: [],
    decisions: [],
  };

  const output = formatRunSummary(state, new Date("2026-07-24T00:12:00.000Z"));

  assert.match(output, /Run: trip-20260724-example — Detailed status example/);
  assert.match(output, /Status requested: 2026-07-24T00:12:00.000Z/);
  assert.match(output, /Run requested: 2026-07-24T00:00:00.000Z/);
  assert.match(output, /Run started: 2026-07-24T00:01:00.000Z/);
  assert.match(output, /Run elapsed since start: 11m/);
  assert.match(output, /✓ research — completed/);
  assert.match(output, /! implementation-slice-2 — paused/);
  assert.match(output, /Type: implementation \| Isolation: same-checkout \| Required: yes/);
  assert.match(output, /Task: Implement the full review workflow with behavioral acceptance coverage\./);
  assert.match(output, /Depends on: research/);
  assert.match(output, /Started: 2026-07-24T00:02:00.000Z \| Finished: not recorded \| Elapsed since start: 10m/);
  assert.match(output, /Attempts: 1 \(accepted 0, repair requested 1, checks failed 0, crashed 0\) \| Repair rounds: 5/);
  assert.match(output, /Latest attempt: #5 repair → repair requested \(changes retained\) .* elapsed 2m/);
  assert.match(output, /Validation: 0\/1 passed, 1 failed in 1s/);
  assert.match(output, /\[major\] Exercise the real panel controller \(independent-review, attempt 5\)/);
  assert.match(output, /Verified changed paths \(2; finalized on acceptance\): src\/controller\.ts, src\/panel\.test\.tsx/);
  assert.match(output, /Expected outputs: src\/controller\.ts, src\/panel\.test\.tsx/);
});

test("status summary remains useful for legacy or missing stage state", () => {
  const state: RunState = {
    formatVersion: 1,
    id: "legacy-run",
    manifestPath: "/repo/plan.json",
    manifest: {
      schemaVersion: 1,
      name: "Legacy run",
      workingDirectory: "/repo",
      stages: [{ id: "missing", type: "implementation", needs: [], isolation: "same-checkout", prompt: "Do the work." }],
    },
    status: "pending",
    baseRevision: "abc123",
    decisionMode: "agent",
    createdAt: "legacy timestamp",
    updatedAt: "legacy timestamp",
    abortRequested: false,
    stageStates: {},
    findings: [],
    decisionRequests: [],
    decisions: [],
  };

  const output = formatRunSummary(state, new Date("2026-07-24T00:12:00.000Z"));
  assert.match(output, /Run requested: legacy timestamp/);
  assert.match(output, /Run started: not recorded/);
  assert.match(output, /Run elapsed since start: not available/);
  assert.match(output, /\? missing — state unavailable/);
  assert.match(output, /Task: Do the work\./);
});

test("aborted runs render a stale running stage as interrupted and stop elapsed time", () => {
  const state: RunState = {
    formatVersion: 1,
    id: "aborted-run",
    manifestPath: "/repo/plan.json",
    manifest: {
      schemaVersion: 1,
      name: "Aborted run",
      workingDirectory: "/repo",
      stages: [{ id: "writer", type: "implementation", needs: [], isolation: "same-checkout", prompt: "Write." }],
    },
    status: "aborted",
    baseRevision: "abc123",
    decisionMode: "agent",
    createdAt: "2026-07-24T20:00:00.000Z",
    updatedAt: "2026-07-24T20:10:00.000Z",
    startedAt: "2026-07-24T20:01:00.000Z",
    abortRequested: true,
    lease: { owner: "aborted-run", generation: 2, heartbeatAt: "2026-07-24T20:02:00.000Z", leaseTimeoutMs: 120_000 },
    stageStates: {
      writer: {
        id: "writer",
        status: "running",
        attempts: [],
        reviewRounds: 0,
        changedPaths: [],
        validationResults: [],
        startedAt: "2026-07-24T20:01:00.000Z",
      },
    },
    findings: [],
    decisionRequests: [],
    decisions: [],
  };

  const output = formatRunSummary(state, new Date("2026-07-25T05:00:00.000Z"));
  assert.match(output, /Status: aborted/);
  assert.match(output, /Abort requested: yes/);
  assert.match(output, /Run finished: 2026-07-24T20:10:00.000Z/);
  assert.match(output, /Run elapsed since start: 9m/);
  assert.match(output, /! writer — interrupted by abort \(recorded: running\)/);
  assert.match(output, /Elapsed since start: 9m/);
  assert.match(output, /Lease: generation 2 .* inactive \(aborted\)/);
});

test("buildRunSummarySections produces collapsible per-step sections consistent with the flat summary", () => {
  const state: RunState = {
    formatVersion: 1,
    id: "trip-20260726-sections",
    manifestPath: "/repo/plan.json",
    manifest: {
      schemaVersion: 1,
      name: "Sections example",
      workingDirectory: "/repo",
      stages: [
        { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Inspect." },
        { id: "impl", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement." },
      ],
    },
    status: "completed",
    baseRevision: "abc123",
    decisionMode: "agent",
    createdAt: "2026-07-26T00:00:00.000Z",
    startedAt: "2026-07-26T00:01:00.000Z",
    updatedAt: "2026-07-26T00:20:00.000Z",
    completedAt: "2026-07-26T00:20:00.000Z",
    abortRequested: false,
    followUpRunIds: ["trip-20260726-followup"],
    stageStates: {
      research: { id: "research", status: "completed", attempts: [], reviewRounds: 0, changedPaths: [], validationResults: [] },
      impl: { id: "impl", status: "completed", attempts: [], reviewRounds: 0, changedPaths: [], validationResults: [] },
    },
    findings: [
      {
        id: "finding-1",
        runId: "trip-20260726-sections",
        stageId: "impl",
        attempt: 1,
        source: "operator",
        severity: "minor",
        blocking: false,
        summary: "Best-effort completion requires follow-up",
        evidence: "Deferred work",
        affectedPaths: [],
        disposition: "follow-up-created",
        createdAt: "2026-07-26T00:10:00.000Z",
        updatedAt: "2026-07-26T00:10:00.000Z",
      },
    ],
    decisionRequests: [],
    decisions: [],
  };

  const requestedAt = new Date("2026-07-26T01:00:00.000Z");
  const sections = buildRunSummarySections(state, requestedAt);
  assert.equal(sections.stages.length, 2);
  assert.match(sections.stages[0]?.title ?? "", /^✓ research — completed$/);
  assert.match(sections.stages[1]?.title ?? "", /^✓ impl — completed$/);
  assert.ok(sections.stages.every((stage) => stage.lines.length > 0), "each collapsed step keeps its detail lines");
  assert.ok(sections.header.some((line) => line === "Deferred follow-up items: 1"));
  assert.ok(sections.header.some((line) => line === "Follow-up runs: trip-20260726-followup"));

  const flat = formatRunSummary(state, requestedAt);
  const recomposed = [
    ...sections.header,
    "",
    `Steps (${sections.stages.length}):`,
    ...sections.stages.flatMap((stage) => [stage.title, ...stage.lines]),
  ].join("\n");
  assert.equal(flat, recomposed);
});
