import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCleanCheckout, git, isIgnorableDirtyPath, runValidationCommands } from "../src/git.ts";

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

test("silent validation warns and preserves the actual result after the old deadline", async () => {
  const command = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => console.log("finished"), 150)'`;
  let warnings = 0;
  const results = await runValidationCommands(process.cwd(), [command], 20, () => { warnings++; });
  assert.equal(results[0]?.timedOut, false);
  assert.equal(results[0]?.exitCode, 0);
  assert.equal(results[0]?.stdout.trim(), "finished");
  assert.ok(warnings > 0);
});

test("active validation outlives its warning interval and retains stdout and stderr", async () => {
  const command = `${JSON.stringify(process.execPath)} -e 'let n = 0; const timer = setInterval(() => { console.log("out"); console.error("err"); if (++n === 8) clearInterval(timer); }, 20)'`;
  const results = await runValidationCommands(process.cwd(), [command], 60, () => {});
  assert.equal(results[0]?.exitCode, 0);
  assert.equal(results[0]?.timedOut, false);
  assert.equal(results[0]?.stdout.trim().split("\n").length, 8);
  assert.equal(results[0]?.stderr.trim().split("\n").length, 8);
});

test("warning delivery failures do not hide actual validation failures or run later commands", async () => {
  const command = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => { console.error("actual failure"); process.exitCode = 7; }, 100)'`;
  const results = await runValidationCommands(process.cwd(), [command, "echo should-not-run"], 20, async () => {
    throw new Error("warning transport unavailable");
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.timedOut, false);
  assert.equal(results[0]?.exitCode, 7);
  assert.equal(results[0]?.stderr.trim(), "actual failure");
});

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
