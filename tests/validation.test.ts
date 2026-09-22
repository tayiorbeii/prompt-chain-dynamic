import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "../src/validation.ts";
import type { TripManifest } from "../src/types.ts";

function baseManifest(): TripManifest {
  return {
    schemaVersion: 1,
    name: "Example",
    workingDirectory: process.cwd(),
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "a",
        type: "implementation",
        needs: ["research"],
        isolation: "worktree",
        prompt: "A",
        allowedPaths: ["app/api/items/[id]/route.ts"],
        claimedPaths: ["app/api/items/[id]/route.ts"],
      },
      {
        id: "b",
        type: "implementation",
        needs: ["research"],
        isolation: "worktree",
        prompt: "B",
        allowedPaths: ["src/b.ts"],
        claimedPaths: ["src/b.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["a", "b"],
        isolation: "same-checkout",
        integrationStrategy: "worktree-fan-in",
        prompt: "Integrate",
        allowedPaths: ["app/api/items/[id]/route.ts", "src/b.ts"],
      },
    ],
  };
}

test("accepts a one-wave worktree fanout and literal Next.js route", () => {
  const result = validateManifest(baseManifest());
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.topology, "worktree-fanout");
  assert.equal(result.normalized?.stages[1]?.claimedPaths?.[0], "app/api/items/[id]/route.ts");
});

test("retains legacy warning intervals, including explicit zero, in normalized manifests", () => {
  const defaults = validateManifest(baseManifest()).normalized!.settings!;
  assert.equal(defaults.sessionTimeoutMs, 30 * 60_000);
  assert.equal(defaults.commandTimeoutMs, 15 * 60_000);
  const manifest = baseManifest();
  manifest.settings = {
    sessionTimeoutMs: 0, commandTimeoutMs: 123,
    continuationPolicy: { agentCallTimeoutMs: 456, decisionTimeoutMs: 789 },
  };
  const result = validateManifest(manifest);
  assert.equal(result.valid, true);
  assert.equal(result.normalized?.settings?.sessionTimeoutMs, 0);
  assert.equal(result.normalized?.settings?.commandTimeoutMs, 123);
  assert.equal(result.normalized?.settings?.continuationPolicy?.agentCallTimeoutMs, 456);
  assert.equal(result.normalized?.settings?.continuationPolicy?.decisionTimeoutMs, 789);
});

test("rejects overlapping worktree claims", () => {
  const manifest = baseManifest();
  manifest.stages[2] = { ...manifest.stages[2]!, allowedPaths: ["app/api/items/[id]/route.ts"], claimedPaths: ["app/api/items/[id]/route.ts"] };
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("overlap")));
});

test("rejects mixed writer isolation", () => {
  const manifest = baseManifest();
  manifest.stages[2] = { ...manifest.stages[2]!, isolation: "same-checkout" };
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("mixed")));
});

test("rejects claims without allowed paths", () => {
  const manifest = baseManifest();
  manifest.stages[1] = { ...manifest.stages[1]!, allowedPaths: [] };
  const result = validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.includes("allowedPaths")));
});

// --- Slice 6: mixed manifests with wave checkpoints ---

function mixedManifest(): TripManifest {
  return {
    schemaVersion: 1,
    name: "Mixed",
    workingDirectory: process.cwd(),
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "a", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "A", allowedPaths: ["src/**"], claimedPaths: ["src/a.ts"] },
      { id: "b", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "B", allowedPaths: ["src/**"], claimedPaths: ["src/b.ts"] },
      { id: "checkpoint-wave-1", type: "integration", needs: ["a", "b"], isolation: "same-checkout", integrationStrategy: "worktree-wave-checkpoint", prompt: "Checkpoint", allowedPaths: ["src/**"], validationCommands: ["true"] },
      { id: "c", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "same-checkout", prompt: "C", allowedPaths: ["src/**"], claimedPaths: ["src/c.ts"] },
      { id: "integrate", type: "integration", needs: ["c"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
}

test("accepts a mixed manifest with a wave checkpoint and a later same-checkout wave", () => {
  const result = validateManifest(mixedManifest());
  assert.deepEqual(result.issues.filter((entry) => entry.severity === "error"), []);
  assert.equal(result.topology, "mixed");
});

test("accepts a later-wave worktree writer whose claims overlap an earlier wave", () => {
  const manifest = mixedManifest();
  manifest.stages.splice(4, 1,
    { id: "c", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "worktree", baseFrom: "checkpoint-wave-1", prompt: "C", allowedPaths: ["src/**"], claimedPaths: ["src/a.ts"] },
    { id: "d", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "worktree", baseFrom: "checkpoint-wave-1", prompt: "D", allowedPaths: ["src/**"], claimedPaths: ["src/d.ts"] },
    { id: "checkpoint-wave-2", type: "integration", needs: ["c", "d"], isolation: "same-checkout", integrationStrategy: "worktree-wave-checkpoint", baseFrom: "checkpoint-wave-1", prompt: "Checkpoint 2", allowedPaths: ["src/**"] },
  );
  manifest.stages[manifest.stages.length - 1]!.needs = ["checkpoint-wave-2"];
  const result = validateManifest(manifest);
  assert.deepEqual(result.issues.filter((entry) => entry.severity === "error"), []);
});

test("rejects a worktree writer whose base is not an earlier wave checkpoint", () => {
  const manifest = mixedManifest();
  manifest.stages.splice(4, 1, { id: "c", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "worktree", baseFrom: "research", prompt: "C", allowedPaths: ["src/**"], claimedPaths: ["src/c.ts"] });
  const result = validateManifest(manifest);
  assert.ok(result.issues.some((entry) => /baseFrom must name an earlier wave checkpoint stage: research/.test(entry.message)), JSON.stringify(result.issues));
});

test("rejects two worktree writers in one wave with different bases", () => {
  const manifest = mixedManifest();
  manifest.stages.splice(4, 1,
    { id: "c", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "worktree", baseFrom: "checkpoint-wave-1", prompt: "C", allowedPaths: ["src/**"], claimedPaths: ["src/c.ts"] },
    { id: "d", type: "implementation", needs: ["checkpoint-wave-1"], isolation: "worktree", prompt: "D", allowedPaths: ["src/**"], claimedPaths: ["src/d.ts"] },
    { id: "checkpoint-wave-2", type: "integration", needs: ["c", "d"], isolation: "same-checkout", integrationStrategy: "worktree-wave-checkpoint", baseFrom: "checkpoint-wave-1", prompt: "Checkpoint 2", allowedPaths: ["src/**"] },
  );
  manifest.stages[manifest.stages.length - 1]!.needs = ["checkpoint-wave-2"];
  const result = validateManifest(manifest);
  assert.ok(result.issues.some((entry) => /worktree writers in one wave must share the checkpoint's base; d has the run base/.test(entry.message)), JSON.stringify(result.issues));
  assert.ok(result.issues.some((entry) => /depends on earlier writers but names no wave checkpoint base/.test(entry.message)));
});
