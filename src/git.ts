import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ValidationResult } from "./types.ts";

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
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } ,
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
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
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

export async function captureBinaryPatch(cwd: string): Promise<Buffer> {
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = untracked.split("\0").filter(Boolean).filter((value) => !isRuntimePath(value));
  if (files.length) await git(cwd, ["add", "-N", "--", ...files]);
  const result = await runCommand("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`could not capture patch: ${result.stderr}`);
  return Buffer.from(result.stdout, "utf8");
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
  timeoutMs: number,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    const result = await runCommand("/bin/sh", ["-lc", command], { cwd, timeoutMs });
    results.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }
  return results;
}

export async function createWorktree(repository: string, runId: string, stageId: string, baseRevision: string): Promise<string> {
  const repositoryKey = `${path.basename(repository)}-${sha256(repository).slice(0, 12)}`;
  const directory = path.join(path.dirname(repository), ".prompt-chain-worktrees", repositoryKey, runId, stageId);
  await git(repository, ["worktree", "add", "--detach", directory, baseRevision], 120_000);
  return directory;
}

/**
 * Creates a verified-stage checkpoint commit on a prompt-chain ref keyed by run ID.
 * The commit is placed at refs/prompt-chain/runs/<runId>/stages/<stageId> — NOT on
 * the user's working branch — so it preserves verified work without polluting history.
 *
 * Implementation:
 *   1. git add -A  (stage all working-tree changes)
 *   2. git write-tree  (capture the staged tree)
 *   3. git reset HEAD  (unstage — working tree is preserved)
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
): Promise<string> {
  const ref = `refs/prompt-chain/runs/${runId}/stages/${stageId}`;
  // Stage all working-tree changes so write-tree captures them
  await git(cwd, ["add", "-A"]);
  const treeHash = await git(cwd, ["write-tree"]);
  // Unstage — working tree is unchanged
  await git(cwd, ["reset", "HEAD"]);
  const parentHash = await currentHead(cwd);
  const message = `checkpoint(${stageId}): verified stage commit`;
  const commitArgs = ["commit-tree", treeHash, "-p", parentHash, "-m", message];
  for (const [key, value] of Object.entries(trailers)) {
    commitArgs.push("-m", `${key}: ${value}`);
  }
  const commitHash = (await git(cwd, commitArgs)).trim();
  await git(cwd, ["update-ref", ref, commitHash]);
  return commitHash;
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
