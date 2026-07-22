import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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

const writeQueues = new Map<string, Promise<void>>();

export async function writeRunState(repositoryRoot: string, state: RunState): Promise<void> {
  const file = runStatePath(repositoryRoot, state.id);
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(file, state);
  });
  writeQueues.set(file, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }
}

export async function loadRunState(repositoryRoot: string, runId: string): Promise<RunState> {
  const content = await readFile(runStatePath(repositoryRoot, runId), "utf8");
  return JSON.parse(content) as RunState;
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
