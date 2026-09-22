import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPatch,
  assertCleanCheckout,
  captureBinaryPatch,
  createCheckpointCommit,
  git,
  isIgnorableDirtyPath,
  runValidationCommands,
} from "../src/git.ts";

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

test("capture and checkpoint preserve the real index and only include the verified literal patch", async () => {
  const repository = await createRepository();
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  const literalPath = "owned[one]$.txt";
  await writeFile(path.join(repository, literalPath), "before\n");
  await writeFile(path.join(repository, "foreign.txt"), "foreign\n");
  await git(repository, ["add", "foreign.txt"]);
  const indexPath = await git(repository, ["rev-parse", "--git-path", "index"]);
  const absoluteIndexPath = path.isAbsolute(indexPath) ? indexPath : path.join(repository, indexPath);
  const indexBefore = await readFile(absoluteIndexPath);

  const patch = await captureBinaryPatch(repository, [literalPath]);
  assert.match(patch.toString("utf8"), /owned\[one\]\$\.txt/);
  assert.doesNotMatch(patch.toString("utf8"), /foreign\.txt/);
  assert.deepEqual(await readFile(absoluteIndexPath), indexBefore);
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "foreign.txt");

  await writeFile(path.join(repository, literalPath), "after\n");
  const checkpoint = await createCheckpointCommit(
    repository,
    "run-index-safety",
    "stage-one",
    { "Durable-Trip-Diff-Hash": "test" },
    patch,
    baseRevision,
  );
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), baseRevision);
  assert.equal(await git(repository, ["show", `${checkpoint}:${literalPath}`]), "before");
  assert.equal(await git(repository, ["cat-file", "-e", `${checkpoint}:foreign.txt`]).catch(() => "missing"), "missing");
  assert.equal(await git(repository, ["rev-parse", "refs/prompt-chain/runs/run-index-safety/stages/stage-one"]), checkpoint);
  assert.deepEqual(await readFile(absoluteIndexPath), indexBefore);
});

test("binary modification and deletion round-trip through a supplied patch", async () => {
  const repository = await createRepository();
  await writeFile(path.join(repository, "image.bin"), Buffer.from([0, 1, 2, 255, 0]));
  await writeFile(path.join(repository, "deleted.bin"), Buffer.from([9, 8, 7]));
  await git(repository, ["add", "image.bin", "deleted.bin"]);
  await git(repository, ["commit", "-m", "binary fixture"]);
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repository, "image.bin"), Buffer.from([255, 0, 3, 4, 5, 6]));
  await rm(path.join(repository, "deleted.bin"));
  const patch = await captureBinaryPatch(repository, ["image.bin", "deleted.bin"]);
  assert.match(patch.toString("utf8"), /GIT binary patch/);

  await git(repository, ["reset", "--hard", baseRevision]);
  await applyPatch(repository, patch);
  assert.deepEqual(await readFile(path.join(repository, "image.bin")), Buffer.from([255, 0, 3, 4, 5, 6]));
  await assert.rejects(readFile(path.join(repository, "deleted.bin")));
});

test("malformed patches and invalid refs preserve checkout state and clean checkpoint temp files", async () => {
  const repository = await createRepository();
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repository, "foreign.json"), "staged foreign\n");
  await git(repository, ["add", "foreign.json"]);
  const indexPath = await git(repository, ["rev-parse", "--git-path", "index"]);
  const absoluteIndexPath = path.isAbsolute(indexPath) ? indexPath : path.join(repository, indexPath);
  const indexBefore = await readFile(absoluteIndexPath);
  const previous = await createCheckpointCommit(repository, "run-failure", "stage", {}, Buffer.alloc(0), baseRevision);
  const headBefore = await git(repository, ["rev-parse", "HEAD"]);
  const isolatedTemp = await mkdtemp(path.join(os.tmpdir(), "trip-checkpoint-temp-"));
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTemp;
  try {
    await assert.rejects(
      createCheckpointCommit(repository, "run-failure", "stage", {}, Buffer.from("not a patch\\n"), baseRevision),
      /git apply .* failed/,
    );
    await assert.rejects(
      createCheckpointCommit(repository, "run-failure", "stage~invalid", {}, Buffer.alloc(0), baseRevision),
      /update-ref .* failed/,
    );
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await git(repository, ["rev-parse", "refs/prompt-chain/runs/run-failure/stages/stage"]), previous);
  assert.deepEqual(await readFile(absoluteIndexPath), indexBefore);
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "foreign.json");
  assert.deepEqual(await readdir(isolatedTemp), []);
  await rm(isolatedTemp, { recursive: true, force: true });
});

test("empty checkpoint uses the requested base and rejects a stale base before ref creation", async () => {
  const repository = await createRepository();
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  const checkpoint = await createCheckpointCommit(repository, "run-empty", "stage", {}, Buffer.alloc(0), baseRevision);
  assert.equal(await git(repository, ["rev-parse", `${checkpoint}^`]), baseRevision);
  assert.equal(await git(repository, ["rev-parse", `${checkpoint}^{tree}`]), await git(repository, ["rev-parse", `${baseRevision}^{tree}`]));
  await assert.rejects(
    createCheckpointCommit(repository, "run-stale", "stage", {}, Buffer.alloc(0), `${baseRevision}^`),
    /checkpoint base mismatch/,
  );
  await assert.rejects(
    git(repository, ["show-ref", "--verify", "refs/prompt-chain/runs/run-stale/stages/stage"]),
  );
});
