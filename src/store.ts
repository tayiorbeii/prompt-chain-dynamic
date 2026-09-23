import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, RunState } from "./types.ts";

export function runRoot(repositoryRoot: string, runId: string): string {
  return path.join(repositoryRoot, ".pi", "prompt-chain-hybrid", "runs", runId);
}

export function runStatePath(repositoryRoot: string, runId: string): string {
  return path.join(runRoot(repositoryRoot, runId), "run.json");
}

export async function initializeRunStorage(repositoryRoot: string, runId: string): Promise<string> {
  const root = runRoot(repositoryRoot, runId);
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "findings"), { recursive: true });
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await mkdir(path.join(root, "integration"), { recursive: true });
  return root;
}

export class LeaseGenerationMismatchError extends Error {
  constructor(runId: string, expected: number, actual: number) {
    super(`run ${runId} lease generation ${expected} was superseded by generation ${actual}`);
    this.name = "LeaseGenerationMismatchError";
  }
}

export interface LeaseClaimResult {
  claimed: boolean;
  state: RunState;
  reason: "claimed" | "completed" | "aborted" | "live" | "generation-mismatch";
  previousStatus: RunState["status"];
  /** The pause kind the run carried before the claim cleared it. */
  previousPauseKind?: RunState["pauseKind"];
}

const writeQueues = new Map<string, Promise<unknown>>();
const LOCK_WAIT_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 30_000;

/**
 * Serialize a state operation both within this process and across detached
 * reaper/worker processes. The directory create is the cross-process CAS.
 */
async function withStateLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const release = await acquireFileLock(`${file}.lock`);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  writeQueues.set(file, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }
}

async function acquireFileLock(lockDirectory: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  await mkdir(path.dirname(lockDirectory), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      return async () => {
        await rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      try {
        const info = await stat(lockDirectory);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockDirectory, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isCode(statError, "ENOENT")) throw statError;
        continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`timed out waiting for durable run-state lock ${lockDirectory}`);
      }
      await sleep(25);
    }
  }
}

export async function writeRunState(repositoryRoot: string, state: RunState): Promise<void> {
  const file = runStatePath(repositoryRoot, state.id);
  await withStateLock(file, async () => {
    const durable = await readOptionalRunState(file);
    const incomingGeneration = state.lease?.generation;
    const durableGeneration = durable?.lease?.generation;
    if (incomingGeneration !== undefined && durableGeneration !== undefined && incomingGeneration < durableGeneration) {
      throw new LeaseGenerationMismatchError(state.id, incomingGeneration, durableGeneration);
    }
    const now = new Date().toISOString();
    state.updatedAt = now;
    if (state.status === "running" && state.lease) state.lease.heartbeatAt = now;
    await atomicWriteJson(file, state);
  });
}

/** Renew only the durable lease. The generation check prevents an old worker
 * from overwriting a run after a newer resume has reclaimed it. */
export async function heartbeatRunLease(repositoryRoot: string, runId: string, generation: number, lastActivityAt?: string): Promise<boolean> {
  const file = runStatePath(repositoryRoot, runId);
  return await withStateLock(file, async () => {
    const state = await loadRunState(repositoryRoot, runId);
    if (!state.lease || state.lease.generation !== generation || state.status !== "running") return false;
    const now = new Date().toISOString();
    state.lease.heartbeatAt = now;
    // The activity clock is independent of the heartbeat: it only moves when the
    // worker observed agent or validation output.
    if (lastActivityAt) state.lease.lastActivityAt = lastActivityAt;
    state.updatedAt = now;
    await atomicWriteJson(file, state);
    return true;
  });
}

/**
 * Atomically claim a stale/non-running run. Only one competing supervisor can
 * advance the generation, so duplicate reapers cannot start duplicate workers.
 */
export async function claimRunLease(
  repositoryRoot: string,
  runId: string,
  options: { expectedGeneration?: number; reopenAborted?: boolean; now?: number } = {},
): Promise<LeaseClaimResult> {
  const file = runStatePath(repositoryRoot, runId);
  return await withStateLock(file, async () => {
    const state = await loadRunState(repositoryRoot, runId);
    const previousStatus = state.status;
    const previousPauseKind = state.pauseKind;
    if (state.status === "completed") return { claimed: false, state, reason: "completed", previousStatus };
    if (state.status === "aborted" && !options.reopenAborted) return { claimed: false, state, reason: "aborted", previousStatus };
    if (options.expectedGeneration !== undefined && state.lease?.generation !== options.expectedGeneration) {
      return { claimed: false, state, reason: "generation-mismatch", previousStatus };
    }
    if (state.status === "running" && leaseIsFresh(state, options.now)) {
      return { claimed: false, state, reason: "live", previousStatus };
    }

    const now = new Date(options.now ?? Date.now()).toISOString();
    state.lease ??= { owner: runId, generation: 0, heartbeatAt: now, leaseTimeoutMs: 120_000 };
    state.lease.owner = `${runId}:${process.pid}`;
    state.lease.generation += 1;
    state.lease.heartbeatAt = now;
    state.status = "running";
    state.abortRequested = false;
    state.completedAt = undefined;
    state.pauseKind = undefined;
    state.pauseReason = undefined;
    state.updatedAt = now;
    await atomicWriteJson(file, state);
    return { claimed: true, state, reason: "claimed", previousStatus, previousPauseKind };
  });
}

export function leaseIsFresh(state: RunState, now = Date.now()): boolean {
  if (!state.lease) return false;
  const heartbeat = Date.parse(state.lease.heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat <= state.lease.leaseTimeoutMs;
}

export async function loadRunState(repositoryRoot: string, runId: string): Promise<RunState> {
  const content = await readFile(runStatePath(repositoryRoot, runId), "utf8");
  const state = JSON.parse(content) as RunState;
  migrateLegacyWorkerFindings(state);
  return state;
}

/**
 * Runs recorded before worker self-reports left the finding pipeline may hold
 * findings with source "worker". They were never evidence; resolve them so they
 * stop appearing in repair prompts, and keep the ledger type-valid.
 */
export function migrateLegacyWorkerFindings(state: RunState): number {
  let migrated = 0;
  for (const finding of state.findings ?? []) {
    if ((finding as { source: string }).source !== "worker") continue;
    // Keep the provenance honest: this was a worker self-report, not an
    // operator note. Findings that were already resolved keep their evidence.
    finding.source = "legacy-worker";
    if (finding.disposition === "open") {
      finding.disposition = "resolved";
      finding.resolutionEvidence = {
        ...finding.resolutionEvidence,
        actor: "migration",
        rationale: "legacy worker self-report; not evidence",
      };
    }
    migrated += 1;
  }
  return migrated;
}

export async function appendRunEvent(
  repositoryRoot: string,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const file = path.join(runRoot(repositoryRoot, runId), "events.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.writeFile(`${JSON.stringify({ timestamp: new Date().toISOString(), runId, ...event })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function persistFinding(repositoryRoot: string, finding: Finding): Promise<void> {
  const file = path.join(runRoot(repositoryRoot, finding.runId), "findings", `${finding.id}.json`);
  await atomicWriteJson(file, finding);
  await appendRunEvent(repositoryRoot, finding.runId, {
    type: `finding.${finding.disposition}`,
    stageId: finding.stageId,
    findingId: finding.id,
    severity: finding.severity,
    blocking: finding.blocking,
  });
}

export async function writeArtifact(
  repositoryRoot: string,
  runId: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<string> {
  const target = path.join(runRoot(repositoryRoot, runId), relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function readOptionalRunState(file: string): Promise<RunState | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as RunState;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
