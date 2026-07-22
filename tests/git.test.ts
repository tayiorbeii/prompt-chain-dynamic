import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCleanCheckout, git, isIgnorableDirtyPath } from "../src/git.ts";

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-git-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

test("isIgnorableDirtyPath matches .md and .json but not source files", () => {
  assert.equal(isIgnorableDirtyPath("plans/feature.plan.md"), true);
  assert.equal(isIgnorableDirtyPath("plans/feature.prompt-chain.json"), true);
  assert.equal(isIgnorableDirtyPath("apps/web/convex/schema.ts"), false);
  assert.equal(isIgnorableDirtyPath("README.MD"), true);
});

test("assertCleanCheckout ignores dirty plan/manifest artifacts before a run", async () => {
  const repository = await createRepository();
  await writeFile(path.join(repository, "plans-a.md"), "# untracked plan\n");
  await writeFile(path.join(repository, "feature.prompt-chain.json"), "{}\n");
  // Should not throw despite the dirty .md/.json artifacts.
  await assertCleanCheckout(repository);
});

test("assertCleanCheckout still blocks on a dirty source file", async () => {
  const repository = await createRepository();
  await writeFile(path.join(repository, "leaked.ts"), "export const x = 1;\n");
  await assert.rejects(
    assertCleanCheckout(repository),
    /requires a clean checkout[\s\S]*leaked\.ts/,
  );
});
