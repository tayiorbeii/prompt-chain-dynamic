import assert from "node:assert/strict";
import test from "node:test";
import { stagnationFingerprint, isStagnant, isBetter } from "../src/stagnation.ts";
import { spawnResearchHook } from "../src/research-hook.ts";
import type { AttemptRecord, NormalizedReview } from "../src/types.ts";

function makeReview(overrides: Partial<NormalizedReview> = {}): NormalizedReview {
  return {
    status: "continue",
    risk: "medium",
    rationale: "test",
    missingItems: [],
    findings: [],
    raw: "",
    malformed: false,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attempt: 1,
    role: "repair",
    validationResults: [],
    reviewVerdict: makeReview(),
    diffHash: "abc123",
    asi: {},
    status: "discard",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── stagnationFingerprint ───────────────────────────────────────────────────

test("stagnationFingerprint produces equal hashes for two attempts with equal outcomes", () => {
  const finding = { severity: "major" as const, blocking: true, summary: "Missing test", evidence: "line 42", affectedPaths: [] };
  const a = makeAttempt({ reviewVerdict: makeReview({ findings: [finding], recommendedFollowupPrompt: "add tests" }), diffHash: "deadbeef" });
  const b = makeAttempt({ reviewVerdict: makeReview({ findings: [finding], recommendedFollowupPrompt: "add tests" }), diffHash: "deadbeef" });
  assert.equal(stagnationFingerprint(a), stagnationFingerprint(b));
});

test("stagnationFingerprint produces different hashes for attempts with different outcomes", () => {
  const a = makeAttempt({ diffHash: "hash-a" });
  const b = makeAttempt({ diffHash: "hash-b" });
  assert.notEqual(stagnationFingerprint(a), stagnationFingerprint(b));
});

test("stagnationFingerprint is deterministic regardless of finding order", () => {
  const f1 = { severity: "major" as const, blocking: true, summary: "Alpha", evidence: "", affectedPaths: [] };
  const f2 = { severity: "minor" as const, blocking: false, summary: "Beta", evidence: "", affectedPaths: [] };
  const a = makeAttempt({ reviewVerdict: makeReview({ findings: [f1, f2] }) });
  const b = makeAttempt({ reviewVerdict: makeReview({ findings: [f2, f1] }) });
  // Sorted by summary so order doesn't matter for blocking findings
  const fp1 = stagnationFingerprint(a);
  const fp2 = stagnationFingerprint(b);
  // Both have the same blocking finding (Alpha); order of non-blocking doesn't affect fingerprint
  assert.equal(fp1, fp2);
});

test("stagnationFingerprint reflects validation failures", () => {
  const a = makeAttempt({
    validationResults: [{ command: "npm test", exitCode: 1, stdout: "FAIL", stderr: "", durationMs: 100, timedOut: false }],
  });
  const b = makeAttempt({ validationResults: [] });
  assert.notEqual(stagnationFingerprint(a), stagnationFingerprint(b));
});

// ─── isStagnant ──────────────────────────────────────────────────────────────

test("isStagnant returns false when fewer than windowSize attempts", () => {
  const a = makeAttempt({ diffHash: "same" });
  assert.equal(isStagnant([a], 2), false);
});

test("isStagnant returns true after 2 consecutive equal fingerprints", () => {
  const finding = { severity: "major" as const, blocking: true, summary: "Bug", evidence: "", affectedPaths: [] };
  const a = makeAttempt({ reviewVerdict: makeReview({ findings: [finding] }), diffHash: "same" });
  const b = makeAttempt({ reviewVerdict: makeReview({ findings: [finding] }), diffHash: "same" });
  assert.equal(isStagnant([a, b], 2), true);
});

test("isStagnant returns false when last 2 fingerprints differ", () => {
  const a = makeAttempt({ diffHash: "hash-a" });
  const b = makeAttempt({ diffHash: "hash-b" });
  assert.equal(isStagnant([a, b], 2), false);
});

test("isStagnant checks only the most recent windowSize attempts", () => {
  const stagnant = makeAttempt({ diffHash: "same" });
  const different = makeAttempt({ diffHash: "different" });
  // [different, stagnant, stagnant] — last 2 are equal
  assert.equal(isStagnant([different, stagnant, stagnant], 2), true);
  // [stagnant, stagnant, different] — last 2 differ
  assert.equal(isStagnant([stagnant, stagnant, different], 2), false);
});

// ─── isBetter ────────────────────────────────────────────────────────────────

test("isBetter prefers fewer blocking findings", () => {
  const blocking = { severity: "major" as const, blocking: true, summary: "Bug", evidence: "", affectedPaths: [] };
  const nonBlocking = { severity: "minor" as const, blocking: false, summary: "Style", evidence: "", affectedPaths: [] };
  const better = makeAttempt({ reviewVerdict: makeReview({ findings: [nonBlocking] }) });
  const worse = makeAttempt({ reviewVerdict: makeReview({ findings: [blocking, nonBlocking] }) });
  assert.equal(isBetter(better, worse), true);
  assert.equal(isBetter(worse, better), false);
});

test("isBetter tiebreaks on fewer total findings when blocking count is equal", () => {
  const f = { severity: "minor" as const, blocking: false, summary: "Nit", evidence: "", affectedPaths: [] };
  const fewer = makeAttempt({ reviewVerdict: makeReview({ findings: [f] }) });
  const more = makeAttempt({ reviewVerdict: makeReview({ findings: [f, { ...f, summary: "Another nit" }] }) });
  assert.equal(isBetter(fewer, more), true);
  assert.equal(isBetter(more, fewer), false);
});

test("isBetter returns false on a tie (equal blocking, total, and validation)", () => {
  const a = makeAttempt({ reviewVerdict: makeReview(), diffHash: "x" });
  const b = makeAttempt({ reviewVerdict: makeReview(), diffHash: "y" });
  assert.equal(isBetter(a, b), false);
  assert.equal(isBetter(b, a), false);
});

// ─── spawnResearchHook ───────────────────────────────────────────────────────

test("Research hook spawns a child process and returns structured output within 30 seconds", async () => {
  // Use a simple shell command that outputs valid JSON
  const output = await spawnResearchHook(
    `node -e "process.stdout.write(JSON.stringify({steerMessage:'found pattern',citations:['ref1'],adaptationPlan:'try X'}))"`,
    process.cwd(),
    30_000,
  );
  assert.equal(output.success, true);
  assert.equal(output.steerMessage, "found pattern");
  assert.deepEqual(output.citations, ["ref1"]);
  assert.equal(output.adaptationPlan, "try X");
});

test("research hook with non-JSON stdout returns steer message", async () => {
  const output = await spawnResearchHook(
    `node -e "process.stdout.write('plain text guidance')"`,
    process.cwd(),
    30_000,
  );
  assert.equal(output.success, true);
  assert.equal(output.steerMessage, "plain text guidance");
});

test("research hook timeout produces failure result", async () => {
  const output = await spawnResearchHook(
    "sleep 100",
    process.cwd(),
    200,
  );
  assert.equal(output.success, false);
  assert.ok(output.error?.includes("timed out"), `expected 'timed out' in: ${output.error}`);
});

test("research hook non-zero exit produces failure result", async () => {
  const output = await spawnResearchHook(
    "exit 1",
    process.cwd(),
    5_000,
  );
  assert.equal(output.success, false, `expected failure but got: ${JSON.stringify(output)}`);
  assert.ok(output.error?.includes("exited") || output.error?.includes("1"), `error: ${output.error}`);
});

// ─── Slice 4: worker self-reports are comparable ─────────────────────────────

test("stagnationFingerprint differs when only the missing items differ", () => {
  const a = makeAttempt({ reviewVerdict: makeReview({ missingItems: ["Add tests"] }), diffHash: "same" });
  const b = makeAttempt({ reviewVerdict: makeReview({ missingItems: ["Wire export"] }), diffHash: "same" });
  const c = makeAttempt({ reviewVerdict: makeReview({ missingItems: [" Add tests "] }), diffHash: "same" });
  assert.notEqual(stagnationFingerprint(a), stagnationFingerprint(b));
  assert.equal(stagnationFingerprint(a), stagnationFingerprint(c), "whitespace-only differences are not progress");
});

test("stagnationFingerprint differs when only the review status differs", () => {
  const a = makeAttempt({ reviewVerdict: makeReview({ status: "continue" }), diffHash: "same" });
  const b = makeAttempt({ reviewVerdict: makeReview({ status: "blocked" }), diffHash: "same" });
  assert.notEqual(stagnationFingerprint(a), stagnationFingerprint(b));
  assert.equal(isStagnant([a, b], 2), false);
});
