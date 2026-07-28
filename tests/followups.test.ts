import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFollowUpManifest,
  collectFollowUpItems,
  followUpItemsFromAudit,
} from "../src/followups.ts";
import type { AuditResult } from "../src/audit.ts";
import type { Finding, RunState, StageRunState, TripManifest, TripStage } from "../src/types.ts";

function stageState(id: string, status: StageRunState["status"] = "completed"): StageRunState {
  return { id, status, attempts: [], reviewRounds: 0, changedPaths: [], validationResults: [] };
}

function finding(overrides: Partial<Finding> & Pick<Finding, "id" | "stageId" | "disposition">): Finding {
  return {
    runId: "trip-followups-example",
    attempt: 1,
    source: "operator",
    severity: "minor",
    blocking: false,
    summary: "Best-effort completion requires follow-up",
    evidence: "One acceptance test was deferred after repair exhaustion.",
    affectedPaths: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureState(stages: TripStage[], findings: Finding[]): RunState {
  return {
    formatVersion: 1,
    id: "trip-followups-example",
    manifestPath: "/repo/plan.trip.json",
    manifest: {
      schemaVersion: 1,
      name: "Follow-up fixture",
      workingDirectory: "/repo",
      stages,
    },
    status: "completed",
    baseRevision: "abc123",
    decisionMode: "agent",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T01:00:00.000Z",
    abortRequested: false,
    stageStates: Object.fromEntries(stages.map((stage) => [stage.id, stageState(stage.id)])),
    findings,
    decisionRequests: [],
    decisions: [],
  };
}

const research: TripStage = {
  id: "research",
  type: "review",
  needs: [],
  isolation: "readonly",
  prompt: "Inspect the existing implementation.",
};

const impl: TripStage = {
  id: "impl",
  type: "implementation",
  needs: ["research"],
  isolation: "same-checkout",
  prompt: "Implement the feature end to end.",
  allowedPaths: ["src/**"],
  claimedPaths: ["src/feature.ts"],
  validationCommands: ["npm test"],
};

const integrate: TripStage = {
  id: "integrate",
  type: "integration",
  needs: ["impl"],
  isolation: "same-checkout",
  integrationStrategy: "same-checkout-finalize",
  prompt: "Finalize and validate the combined result.",
};

test("collectFollowUpItems returns only follow-up-created findings", () => {
  const state = fixtureState([research, impl, integrate], [
    finding({ id: "f-1", stageId: "impl", disposition: "follow-up-created", suggestedRemediation: "Add the missing edge-case unit test.", affectedPaths: ["src/feature.ts"] }),
    finding({ id: "f-2", stageId: "impl", disposition: "resolved" }),
    finding({ id: "f-3", stageId: "research", disposition: "follow-up-created", summary: "Deferred documentation gap" }),
  ]);
  const items = collectFollowUpItems(state);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.findingIds).flat(), ["f-1", "f-3"]);
  assert.equal(items[0]?.remediation, "Add the missing edge-case unit test.");
});

test("buildFollowUpManifest synthesizes a valid serial manifest that inherits writer contracts", () => {
  const state = fixtureState([research, impl, integrate], []);
  const items = [
    { stageId: "impl", findingIds: ["f-1"], summary: "Deferred edge case", evidence: "Repair exhaustion left the edge case untested.", remediation: "Add the missing edge-case unit test.", affectedPaths: ["src/feature.ts"] },
    { stageId: "research", findingIds: ["f-3"], summary: "Deferred documentation gap", evidence: "Docs were out of scope for the readonly stage.", affectedPaths: [] },
  ];
  const manifest = buildFollowUpManifest(state, items, 1);
  assert.ok(manifest, "expected a manifest");
  const built = manifest as TripManifest;
  assert.equal(built.name, "Follow-up fixture — follow-up round 1");
  assert.deepEqual(built.stages.map((stage) => stage.id), ["followup-impl", "followup-integration"]);

  const writer = built.stages[0] as TripStage;
  assert.equal(writer.type, "implementation");
  assert.equal(writer.isolation, "same-checkout");
  assert.deepEqual(writer.allowedPaths, ["src/**"]);
  assert.deepEqual(writer.claimedPaths, ["src/feature.ts"]);
  assert.deepEqual(writer.validationCommands, ["npm test"]);
  assert.match(writer.prompt, /Deferred edge case/);
  assert.match(writer.prompt, /Repair exhaustion left the edge case untested\./);
  assert.match(writer.prompt, /\*\*Acceptance Criteria\*\*/);
  assert.match(writer.prompt, /Add the missing edge-case unit test\./);

  const integration = built.stages[1] as TripStage;
  assert.equal(integration.type, "integration");
  assert.equal(integration.integrationStrategy, "same-checkout-finalize");
  assert.deepEqual(integration.needs, ["followup-impl"]);
  assert.match(integration.prompt, /Deferred documentation gap/);
});

test("buildFollowUpManifest returns undefined when no item maps onto a writer stage", () => {
  const state = fixtureState([research], []);
  const items = [
    { stageId: "research", findingIds: ["f-3"], summary: "Readonly-only note", evidence: "No writer stage exists.", affectedPaths: [] },
  ];
  assert.equal(buildFollowUpManifest(state, items, 1), undefined);
  assert.equal(buildFollowUpManifest(state, [], 1), undefined);
});

test("buildFollowUpManifest does not stack followup- prefixes across rounds", () => {
  const followupImpl: TripStage = { ...impl, id: "followup-impl", needs: [] };
  const followupIntegration: TripStage = { ...integrate, id: "followup-integration", needs: ["followup-impl"] };
  const state = fixtureState([followupImpl, followupIntegration], []);
  const items = [
    { stageId: "followup-impl", findingIds: ["f-9"], summary: "Still deferred", evidence: "Round one deferred again.", affectedPaths: [] },
  ];
  const manifest = buildFollowUpManifest(state, items, 2);
  assert.ok(manifest);
  assert.deepEqual((manifest as TripManifest).stages.map((stage) => stage.id), ["followup-impl", "followup-integration"]);
  assert.equal((manifest as TripManifest).name, "Follow-up fixture — follow-up round 2");
});

test("followUpItemsFromAudit converts unverified criteria into remediation items", () => {
  const state = fixtureState([research, impl, integrate], []);
  const audit: AuditResult = {
    passed: false,
    criteria: [
      { criterion: "All feature tests pass", stageId: "impl", passed: false, resolvedFindings: 0, reason: "no validation artifact" },
      { criterion: "Docs updated", stageId: "impl", passed: true, resolvedFindings: 1 },
    ],
    unmapped: ["impl: All feature tests pass"],
  };
  const items = followUpItemsFromAudit(state, audit);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.stageId, "impl");
  assert.equal(items[0]?.remediation, "All feature tests pass");
  assert.match(items[0]?.evidence ?? "", /no validation artifact/);
});
