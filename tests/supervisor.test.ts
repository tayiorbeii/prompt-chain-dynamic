import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, isInfraFailure } from "../src/failure-classifier.ts";
import { auditCompletion } from "../src/audit.ts";
import { Supervisor } from "../src/supervisor.ts";
import type { FailureCategory } from "../src/types.ts";

// ─── Failure Classifier ──────────────────────────────────────────────────────

test("classifyFailure correctly maps at least 5 distinct error patterns to FailureCategory", () => {
  const cases: Array<[string, FailureCategory]> = [
    ["ECONNRESET socket hang up", "transient"],
    ["context window exceeded; context too long", "context-overflow"],
    ["429 Too Many Requests; rate limit exceeded", "provider-quota"],
    ["stage wrote outside its allowed path contract", "structural"],
    ["validation failed: unexpected output format", "semantic"],
  ];
  for (const [message, expected] of cases) {
    const actual = classifyFailure(new Error(message));
    assert.equal(actual, expected, `expected "${message}" → "${expected}", got "${actual}"`);
  }
});

test("classifyFailure maps network/timeout patterns to transient", () => {
  assert.equal(classifyFailure(new Error("network timeout after 30s")), "transient");
  assert.equal(classifyFailure(new Error("fetch failed: ETIMEDOUT")), "transient");
  assert.equal(classifyFailure(new Error("connection refused")), "transient");
  assert.equal(classifyFailure(new Error("service unavailable 503")), "transient");
});

test("classifyFailure maps context overflow patterns to context-overflow", () => {
  assert.equal(classifyFailure(new Error("context window too long")), "context-overflow");
  assert.equal(classifyFailure(new Error("compaction.needed")), "context-overflow");
  assert.equal(classifyFailure(new Error("input too long")), "context-overflow");
});

test("classifyFailure maps quota patterns to provider-quota", () => {
  assert.equal(classifyFailure(new Error("rate limit exceeded")), "provider-quota");
  assert.equal(classifyFailure(new Error("quota exceeded")), "provider-quota");
  assert.equal(classifyFailure(new Error("overloaded")), "provider-quota");
});

test("classifyFailure maps path contract violations to structural", () => {
  assert.equal(classifyFailure(new Error("outside its allowed path contract")), "structural");
  assert.equal(classifyFailure(new Error("path contract violation")), "structural");
  assert.equal(classifyFailure(new Error("invariant breach")), "structural");
});

test("classifyFailure defaults unmatched errors to semantic", () => {
  assert.equal(classifyFailure(new Error("unexpected return value")), "semantic");
  assert.equal(classifyFailure(new Error("review finding: incorrect output")), "semantic");
  assert.equal(classifyFailure(null), "semantic");
});

test("classifyFailure uses agent result text as additional signal", () => {
  const resultWithContext = { success: false, text: "context_overflow detected", error: "", durationMs: 1 };
  assert.equal(classifyFailure(new Error("generic error"), resultWithContext), "context-overflow");
});

// ─── isInfraFailure ──────────────────────────────────────────────────────────

test("isInfraFailure returns true for transient, context-overflow, and provider-quota", () => {
  assert.equal(isInfraFailure("transient"), true);
  assert.equal(isInfraFailure("context-overflow"), true);
  assert.equal(isInfraFailure("provider-quota"), true);
});

test("isInfraFailure returns false for semantic and structural", () => {
  assert.equal(isInfraFailure("semantic"), false);
  assert.equal(isInfraFailure("structural"), false);
});

// ─── Supervisor ──────────────────────────────────────────────────────────────

test("Supervisor class compiles with start and stop methods", () => {
  const supervisor = new Supervisor({
    repositoryRoot: "/tmp",
    runId: "fake-run-id",
  });
  assert.ok(typeof supervisor.start === "function", "start should be a function");
  assert.ok(typeof supervisor.stop === "function", "stop should be a function");
});

// ─── auditCompletion ─────────────────────────────────────────────────────────

test("auditCompletion returns passed false when a stage has no validation artifact", async () => {
  // Build a minimal RunState with no run artifacts on disk
  const state = {
    formatVersion: 1 as const,
    id: "fake-run-id",
    manifestPath: "/tmp/fake.json",
    manifest: {
      schemaVersion: 1 as const,
      name: "Test",
      workingDirectory: "/tmp",
      stages: [
        {
          id: "impl",
          type: "implementation" as const,
          needs: [],
          isolation: "same-checkout" as const,
          prompt: "Implement something.\n\n**Acceptance Criteria**:\n- Feature X works\n- Tests pass",
          allowedPaths: ["src/x.ts"],
        },
      ],
    },
    status: "completed" as const,
    baseRevision: "abc123",
    decisionMode: "agent" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    abortRequested: false,
    stageStates: {
      impl: {
        id: "impl",
        status: "completed" as const,
        attempts: [],
        reviewRounds: 0,
        changedPaths: [],
        validationResults: [],
      },
    },
    findings: [],
    decisionRequests: [],
    decisions: [],
  };

  // Use a non-existent repository root so no artifacts will be found
  const result = await auditCompletion("/tmp/nonexistent-repo-abc123", state as any);
  assert.equal(result.passed, false, "should fail when no validation artifact exists");
  assert.ok(result.unmapped.length > 0, "should have unmapped criteria");
  assert.ok(result.criteria.every((c) => !c.passed), "all criteria should be not passed");
});

test("auditCompletion extracts acceptance criteria from prompt", async () => {
  const state = {
    formatVersion: 1 as const,
    id: "fake-run-2",
    manifestPath: "/tmp/fake2.json",
    manifest: {
      schemaVersion: 1 as const,
      name: "Test",
      workingDirectory: "/tmp",
      stages: [
        {
          id: "stage-a",
          type: "review" as const,
          needs: [],
          isolation: "readonly" as const,
          prompt: "Research only.\n\n(no acceptance criteria here)",
          allowedPaths: [],
        },
        {
          id: "stage-b",
          type: "implementation" as const,
          needs: ["stage-a"],
          isolation: "same-checkout" as const,
          prompt: "Implement B.\n\n**Acceptance Criteria**:\n- Criterion one\n- Criterion two\n- Criterion three",
          allowedPaths: ["src/b.ts"],
        },
      ],
    },
    status: "completed" as const,
    baseRevision: "abc",
    decisionMode: "agent" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    abortRequested: false,
    stageStates: {
      "stage-a": { id: "stage-a", status: "completed" as const, attempts: [], reviewRounds: 0, changedPaths: [], validationResults: [] },
      "stage-b": { id: "stage-b", status: "completed" as const, attempts: [], reviewRounds: 0, changedPaths: [], validationResults: [] },
    },
    findings: [],
    decisionRequests: [],
    decisions: [],
  };

  const result = await auditCompletion("/tmp/nonexistent-repo-xyz789", state as any);
  // stage-a has no criteria, stage-b has 3
  assert.equal(result.criteria.length, 3);
  assert.ok(result.criteria.every((c) => c.stageId === "stage-b"));
  assert.ok(result.criteria.some((c) => c.criterion === "Criterion one"));
  assert.ok(result.criteria.some((c) => c.criterion === "Criterion two"));
  assert.ok(result.criteria.some((c) => c.criterion === "Criterion three"));
});
