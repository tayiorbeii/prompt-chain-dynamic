import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ValidationResult } from "./types.ts";
import { monitorActivity, type ActivityWarning } from "./liveness.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; onActivity?: () => void },
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 0;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; options.onActivity?.(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; options.onActivity?.(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);
      timer.unref();
    }
  });
}

export async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trimEnd();
}

export async function ensureGitRepository(cwd: string): Promise<void> {
  const value = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (value !== "true") throw new Error(`${cwd} is not a Git worktree`);
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentHead(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "HEAD"]);
}

export async function changedPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!output) return [];
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const status = entry.slice(0, 2);
    const name = entry.slice(3);
    if (name) paths.push(name.replaceAll("\\", "/"));
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      paths.push((entries[index + 1] ?? "").replaceAll("\\", "/"));
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export async function assertCleanCheckout(cwd: string): Promise<void> {
  const paths = (await changedPaths(cwd))
    .filter((value) => !isRuntimePath(value) && !isIgnorableDirtyPath(value));
  if (paths.length) {
    throw new Error(`writer execution requires a clean checkout; dirty paths:\n${paths.map((value) => `- ${value}`).join("\n")}`);
  }
}

export function isRuntimePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized === ".pi/prompt-chain-hybrid" || normalized.startsWith(".pi/prompt-chain-hybrid/") || normalized.includes("/.pi/prompt-chain-hybrid/");
}

// Plan and manifest artifacts — Markdown plans and compiled *.json manifests — commonly
// live in the working tree alongside the code they describe and are not part of any
// writer's path contract. Worktrees are branched from HEAD (a committed revision), never
// from the dirty tree, so pre-existing dirty .md/.json files cannot leak into a run;
// letting them block startup is pure friction. This relaxes ONLY the pre-run cleanliness
// gate. Change-detection (snapshotChangedPathStates/changedPaths) and scoped-commit logic
// still use isRuntimePath alone, so any .md/.json a stage legitimately produces is tracked
// and committed as usual.
const IGNORABLE_DIRTY_FILE = /\.(?:md|json)$/i;

export function isIgnorableDirtyPath(value: string): boolean {
  return IGNORABLE_DIRTY_FILE.test(value.replaceAll("\\", "/"));
}

export async function pathState(cwd: string, relativePath: string): Promise<string> {
  const absolute = path.join(cwd, relativePath);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return `symlink:${await readlink(absolute)}`;
    if (stat.isDirectory()) return "directory";
    const content = await readFile(absolute);
    return `file:${stat.mode}:${sha256(content)}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    throw error;
  }
}

export async function snapshotChangedPathStates(cwd: string): Promise<Record<string, string>> {
  const paths = (await changedPaths(cwd)).filter((value) => !isRuntimePath(value));
  const pairs = await Promise.all(paths.map(async (value) => [value, await pathState(cwd, value)] as const));
  return Object.fromEntries(pairs);
}

export async function calculateStageDelta(
  cwd: string,
  before: Record<string, string>,
): Promise<{ changedDuring: string[]; after: Record<string, string> }> {
  const after = await snapshotChangedPathStates(cwd);
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedDuring: string[] = [];
  for (const value of all) {
    const current = after[value] ?? await pathState(cwd, value);
    const previous = before[value] ?? "missing";
    if (current !== previous) changedDuring.push(value);
  }
  return { changedDuring: changedDuring.sort(), after };
}

function literalPathspec(value: string): string {
  return `:(literal)${value}`;
}

async function temporaryIndex(cwd: string): Promise<{ directory: string; index: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-chain-index-"));
  const index = path.join(directory, "index");
  try {
    const realIndexValue = await git(cwd, ["rev-parse", "--git-path", "index"]);
    const realIndex = path.isAbsolute(realIndexValue) ? realIndexValue : path.resolve(cwd, realIndexValue);
    await copyFile(realIndex, index);
    return { directory, index };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function runGitWithEnv(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
  input?: string,
): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs, env, input });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trimEnd();
}

export async function captureBinaryPatch(cwd: string, includedPaths?: string[]): Promise<Buffer> {
  const selected = includedPaths ? new Set(includedPaths) : undefined;
  if (selected?.size === 0) return Buffer.alloc(0);
  const temporary = await temporaryIndex(cwd);
  try {
    const env = { GIT_INDEX_FILE: temporary.index };
    const untracked = await runGitWithEnv(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], env);
    const untrackedFiles = untracked.split("\0")
      .filter(Boolean)
      .filter((value) => !isRuntimePath(value) && (!selected || selected.has(value)));
    if (untrackedFiles.length) {
      await runGitWithEnv(cwd, ["add", "-N", "--", ...untrackedFiles.map(literalPathspec)], env);
    }

    let files: string[];
    if (selected) {
      files = [...selected].filter((value) => !isRuntimePath(value)).sort();
    } else {
      const tracked = await runGitWithEnv(cwd, ["diff", "--name-only", "-z", "HEAD"], env);
      files = [...new Set([
        ...tracked.split("\0").filter(Boolean),
        ...untrackedFiles,
      ])].filter((value) => !isRuntimePath(value)).sort();
    }
    if (!files.length) return Buffer.alloc(0);
    const result = await runCommand("git", [
      "diff", "--binary", "--no-ext-diff", "HEAD", "--", ...files.map(literalPathspec),
    ], { cwd, timeoutMs: 120_000, env });
    if (result.exitCode !== 0) throw new Error(`could not capture patch: ${result.stderr}`);
    return Buffer.from(result.stdout, "utf8");
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
}

/** Undo a patch previously applied with applyPatch; new files it created are removed. */
export async function reverseApplyPatch(cwd: string, patch: Buffer): Promise<void> {
  if (!patch.length) return;
  // applyPatch uses --3way, which also stages the change, so the reversal must
  // cover the index too or the staged postimage survives as dirty paths.
  const result = await runCommand("git", ["apply", "-R", "--index", "--whitespace=nowarn", "-"], {
    cwd,
    timeoutMs: 120_000,
    input: patch.toString("utf8"),
  });
  if (result.exitCode !== 0) throw new Error(`patch reversal failed: ${result.stderr || result.stdout}`);
}

export async function applyPatch(cwd: string, patch: Buffer): Promise<void> {
  if (!patch.length) return;
  const result = await runCommand("git", ["apply", "--3way", "--whitespace=nowarn", "-"], {
    cwd,
    timeoutMs: 120_000,
    input: patch.toString("utf8"),
  });
  if (result.exitCode !== 0) throw new Error(`patch application failed: ${result.stderr || result.stdout}`);
}

export async function runValidationCommands(
  cwd: string,
  commands: string[],
  warningAfterMs: number,
  onWarning: (command: string, warning: ActivityWarning) => void | Promise<void> = (command, warning) => {
    console.warn(`Validation ${command}: no output for ${Math.round(warning.idleMs)}ms; continuing to wait.`);
  },
  onActivity?: () => void,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    const monitor = monitorActivity(warningAfterMs, (warning) => onWarning(command, warning));
    try {
      const result = await runCommand("/bin/sh", ["-lc", command], { cwd, onActivity: () => { monitor.activity(); onActivity?.(); } });
      results.push({ command, ...result });
      if (result.exitCode !== 0) break;
    } finally {
      monitor.stop();
    }
  }
  return results;
}

export async function createWorktree(repository: string, runId: string, stageId: string, baseRevision: string): Promise<string> {
  const repositoryKey = `${path.basename(repository)}-${sha256(repository).slice(0, 12)}`;
  const directory = path.join(path.dirname(repository), ".prompt-chain-worktrees", repositoryKey, runId, stageId);
  // A directory left behind by an interrupted creation would make `worktree add`
  // fail on every resume. The run state never recorded it, so no verified work
  // lives there: clear it and any dangling registration before adding.
  if (await pathExists(directory)) {
    await rm(directory, { recursive: true, force: true });
    await git(repository, ["worktree", "prune"]);
  }
  await git(repository, ["worktree", "add", "--detach", directory, baseRevision], 120_000);
  return directory;
}

/**
 * Creates a verified-stage checkpoint commit on a prompt-chain ref keyed by run ID.
 * The commit is placed at refs/prompt-chain/runs/<runId>/stages/<stageId> — NOT on
 * the user's working branch — so it preserves verified work without polluting history.
 *
 * Implementation:
 *   1. initialize a temporary index from the requested base revision
 *   2. git apply --cached  (apply only the verified patch to the temporary index)
 *   3. git write-tree  (capture the patched tree)
 *   4. git commit-tree  (create a detached commit object with trailers)
 *   5. git update-ref  (point the special ref at the new commit)
 *
 * Returns the commit hash.
 */
export async function createCheckpointCommit(
  cwd: string,
  runId: string,
  stageId: string,
  trailers: Record<string, string>,
  patch: Buffer,
  baseRevision: string,
): Promise<string> {
  const ref = `refs/prompt-chain/runs/${runId}/stages/${stageId}`;
  const actualBase = await currentHead(cwd);
  if (actualBase !== baseRevision) {
    throw new Error(`checkpoint base mismatch: expected ${baseRevision}, found ${actualBase}`);
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "prompt-chain-checkpoint-"));
  const index = path.join(temporary, "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    await runGitWithEnv(cwd, ["read-tree", baseRevision], env);
    if (patch.length) {
      await runGitWithEnv(cwd, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], env, 120_000, patch.toString("utf8"));
    }
    const treeHash = await runGitWithEnv(cwd, ["write-tree"], env);
    const message = `checkpoint(${stageId}): verified stage commit`;
    const commitArgs = ["commit-tree", treeHash, "-p", baseRevision, "-m", message];
    for (const [key, value] of Object.entries(trailers)) {
      commitArgs.push("-m", `${key}: ${value}`);
    }
    const commitHash = await git(cwd, commitArgs);
    const current = await currentHead(cwd);
    if (current !== baseRevision) {
      throw new Error(`checkpoint base changed: expected ${baseRevision}, found ${current}`);
    }
    await git(cwd, ["update-ref", ref, commitHash]);
    return commitHash;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeWorktree(repository: string, worktree: string): Promise<void> {
  await git(repository, ["worktree", "remove", "--force", worktree], 120_000);
}

export async function stageAndCommitOwnedPaths(
  cwd: string,
  paths: string[],
  message: string,
  trailers: Record<string, string>,
): Promise<string | undefined> {
  if (!paths.length) return undefined;
  await git(cwd, ["add", "-A", "--", ...paths]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only", "-z"]);
  const stagedPaths = staged.split("\0").filter(Boolean).sort();
  const unexpected = stagedPaths.filter((value) => !paths.includes(value));
  if (unexpected.length) throw new Error(`unexpected staged paths: ${unexpected.join(", ")}`);
  const args = ["commit", "-m", message];
  for (const [key, value] of Object.entries(trailers)) args.push("-m", `${key}: ${value}`);
  await git(cwd, args, 120_000);
  return await currentHead(cwd);
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
