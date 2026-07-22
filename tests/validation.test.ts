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
