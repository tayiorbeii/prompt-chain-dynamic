import assert from "node:assert/strict";
import test from "node:test";
import { hashContract, classifyAmendmentRisk, buildAmendmentProposal } from "../src/contract.ts";
import { autoApproveAmendment } from "../src/decision.ts";
import type { TripManifest, TripStage } from "../src/types.ts";

function makeStage(overrides: Partial<TripStage> = {}): TripStage {
  return {
    id: "test-stage",
    type: "implementation",
    needs: [],
    isolation: "same-checkout",
    prompt: "Implement",
    allowedPaths: ["src/feature.ts"],
    claimedPaths: ["src/feature.ts"],
    outputs: [],
    validationCommands: ["npm test"],
    ...overrides,
  };
}

function makeManifest(stages: TripStage[]): TripManifest {
  return {
    schemaVersion: 1,
    name: "test",
    workingDirectory: ".",
    stages,
  };
}

// ─── hashContract ─────────────────────────────────────────────────────────────

test("hashContract is deterministic for identical stage definitions", () => {
  const stage = makeStage();
  assert.equal(hashContract(stage), hashContract(stage));
  assert.equal(hashContract(makeStage()), hashContract(makeStage()));
});

test("hashContract produces the same hash regardless of allowed-paths insertion order", () => {
  const a = makeStage({ allowedPaths: ["src/a.ts", "src/b.ts"] });
  const b = makeStage({ allowedPaths: ["src/b.ts", "src/a.ts"] });
  assert.equal(hashContract(a), hashContract(b));
});

test("hashContract produces different hashes for different stage contracts", () => {
  const a = makeStage({ allowedPaths: ["src/a.ts"] });
  const b = makeStage({ allowedPaths: ["src/b.ts"] });
  assert.notEqual(hashContract(a), hashContract(b));
});

test("hashContract produces different hashes when validation commands differ", () => {
  const a = makeStage({ validationCommands: ["npm test"] });
  const b = makeStage({ validationCommands: ["npm run lint"] });
  assert.notEqual(hashContract(a), hashContract(b));
});

// ─── classifyAmendmentRisk ────────────────────────────────────────────────────

test("classifyAmendmentRisk returns auto-approve for path-only additions within existing allowed paths", () => {
  const stage = makeStage({ allowedPaths: ["src/**"] });
  const manifest = makeManifest([stage]);
  // Proposed: add src/helper.ts — still within src/**
  const result = classifyAmendmentRisk(stage, ["src/**", "src/helper.ts"], manifest);
  assert.equal(result, "auto-approve");
});

test("classifyAmendmentRisk returns human-required for new claimed paths that are high-risk", () => {
  const stage = makeStage({ allowedPaths: ["src/feature.ts"] });
  const manifest = makeManifest([stage]);
  // Proposing to add package.json (high-risk)
  const result = classifyAmendmentRisk(stage, ["src/feature.ts", "package.json"], manifest);
  assert.equal(result, "human-required");
});

test("classifyAmendmentRisk returns human-required when new paths overlap with another stage", () => {
  const stageA = makeStage({ id: "stage-a", allowedPaths: ["src/a.ts"], claimedPaths: ["src/a.ts"] });
  const stageB = makeStage({ id: "stage-b", allowedPaths: ["src/b.ts"], claimedPaths: ["src/b.ts"] });
  const manifest = makeManifest([stageA, stageB]);
  // stage-a wants to add src/b.ts — overlaps with stage-b
  const result = classifyAmendmentRisk(stageA, ["src/a.ts", "src/b.ts"], manifest);
  assert.equal(result, "human-required");
});

test("classifyAmendmentRisk returns human-required for schema/migration paths", () => {
  const stage = makeStage({ allowedPaths: ["src/feature.ts"] });
  const manifest = makeManifest([stage]);
  const cases = [
    ["src/feature.ts", "db/migrations/001.sql"],
    ["src/feature.ts", "src/schema.ts"],
    ["src/feature.ts", "src/auth.ts"],
  ];
  for (const proposed of cases) {
    const result = classifyAmendmentRisk(stage, proposed, manifest);
    assert.equal(result, "human-required", `expected human-required for paths: ${proposed.join(", ")}`);
  }
});

test("classifyAmendmentRisk returns auto-approve for no new paths", () => {
  const stage = makeStage({ allowedPaths: ["src/a.ts", "src/b.ts"] });
  const manifest = makeManifest([stage]);
  const result = classifyAmendmentRisk(stage, ["src/a.ts", "src/b.ts"], manifest);
  assert.equal(result, "auto-approve");
});

// ─── buildAmendmentProposal ───────────────────────────────────────────────────

test("buildAmendmentProposal populates all required fields", () => {
  const stage = makeStage({ allowedPaths: ["src/a.ts"] });
  const manifest = makeManifest([stage]);
  const proposal = buildAmendmentProposal(stage, ["src/a.ts", "src/b.ts"], manifest, "need helper");
  assert.ok(proposal.oldContractHash, "oldContractHash should be set");
  assert.ok(proposal.newContractHash, "newContractHash should be set");
  assert.notEqual(proposal.oldContractHash, proposal.newContractHash, "hashes should differ");
  assert.deepEqual(proposal.revalidatedPaths.sort(), ["src/a.ts", "src/b.ts"].sort());
  assert.equal(proposal.reason, "need helper");
  assert.ok(["auto-approve", "human-required"].includes(proposal.riskClass));
});

// ─── autoApproveAmendment ─────────────────────────────────────────────────────

test("autoApproveAmendment produces a valid DecisionRecord with source set to auto", () => {
  const stage = makeStage({ allowedPaths: ["src/a.ts"] });
  const manifest = makeManifest([stage]);
  const proposal = buildAmendmentProposal(stage, ["src/a.ts", "src/helper.ts"], manifest, "add helper");
  const record = autoApproveAmendment(proposal, { runId: "run-123", stageId: "test-stage" });

  assert.ok(record.id.startsWith("decision-"));
  assert.equal(record.runId, "run-123");
  assert.equal(record.stageId, "test-stage");
  assert.equal(record.source, "auto");
  assert.equal(record.actor, "agent");
  assert.equal(record.status, "decided");
  assert.equal(record.choice, "auto-approve");
  assert.ok(record.rationale.includes("Auto-approved"));
  assert.ok(record.createdAt);
});

test("autoApproveAmendment includes the reason from the proposal in its rationale", () => {
  const stage = makeStage({ allowedPaths: ["src/a.ts"] });
  const manifest = makeManifest([stage]);
  const proposal = buildAmendmentProposal(stage, ["src/a.ts"], manifest, "alignment with approved plan");
  const record = autoApproveAmendment(proposal, { runId: "run-456", stageId: "test-stage" });
  assert.ok(record.rationale.includes("alignment with approved plan"));
});
