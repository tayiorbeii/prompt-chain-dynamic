import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { IssueEvent, IssueEventType, IssueProjection } from "./types.ts";

export interface AppendIssueEventInput {
  issueId: string;
  type: IssueEventType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

export async function readIssueEvents(fileInput: string): Promise<IssueEvent[]> {
  const file = path.resolve(fileInput);
  try {
    const content = await readFile(file, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as IssueEvent;
      } catch (error) {
        throw new Error(`invalid issue event JSON at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).sort((a, b) => a.sequence - b.sequence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendIssueEvent(fileInput: string, input: AppendIssueEventInput): Promise<IssueEvent> {
  const file = path.resolve(fileInput);
  await mkdir(path.dirname(file), { recursive: true });
  const release = await acquireLock(`${file}.lock`);
  try {
    const events = await readIssueEvents(file);
    const duplicate = events.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (duplicate) return duplicate;
    const event: IssueEvent = {
      version: 1,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      id: `issue-event-${randomUUID()}`,
      issueId: input.issueId,
      type: input.type,
      timestamp: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
    };
    const handle = await open(file, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  } finally {
    await release();
  }
}

export function projectIssues(events: IssueEvent[]): Map<string, IssueProjection> {
  const issues = new Map<string, IssueProjection>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "issue.created") {
      const title = stringPayload(event, "title");
      const manifestPath = stringPayload(event, "manifestPath");
      const priority = numberPayload(event, "priority", 0);
      issues.set(event.issueId, {
        id: event.issueId,
        title,
        manifestPath,
        priority,
        status: "backlog",
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      continue;
    }
    const issue = issues.get(event.issueId);
    if (!issue) continue;
    issue.updatedAt = event.timestamp;
    if (event.type === "issue.ready") {
      issue.status = "ready";
      issue.claimToken = undefined;
      issue.claimExpiresAt = undefined;
      issue.lastMessage = stringPayload(event, "message", issue.lastMessage ?? "Ready");
    } else if (event.type === "issue.claimed") {
      issue.status = "executing";
      issue.claimToken = stringPayload(event, "claimToken");
      issue.claimExpiresAt = stringPayload(event, "expiresAt");
    } else if (event.type === "issue.claim.expired") {
      issue.status = "ready";
      issue.claimToken = undefined;
      issue.claimExpiresAt = undefined;
      issue.lastMessage = "Previous claim expired";
    } else if (event.type === "issue.execution.started") {
      issue.status = "executing";
      issue.lastMessage = stringPayload(event, "message", "Execution started");
    } else if (event.type === "issue.completed") {
      issue.status = "completed";
      issue.runId = stringPayload(event, "runId", issue.runId ?? "");
      issue.lastMessage = stringPayload(event, "message", "Completed");
      issue.claimToken = undefined;
      issue.claimExpiresAt = undefined;
    } else if (event.type === "issue.paused") {
      issue.status = "paused";
      issue.runId = stringPayload(event, "runId", issue.runId ?? "");
      issue.lastMessage = stringPayload(event, "message", "Paused");
    } else if (event.type === "issue.failed") {
      issue.status = "failed";
      issue.runId = stringPayload(event, "runId", issue.runId ?? "");
      issue.lastMessage = stringPayload(event, "message", "Failed");
      issue.claimToken = undefined;
      issue.claimExpiresAt = undefined;
    }
  }
  return issues;
}

export async function expireStaleClaims(file: string, now = new Date()): Promise<IssueProjection[]> {
  const events = await readIssueEvents(file);
  const issues = projectIssues(events);
  const expired = [...issues.values()].filter((issue) => issue.status === "executing"
    && issue.claimExpiresAt
    && new Date(issue.claimExpiresAt).getTime() <= now.getTime());
  for (const issue of expired) {
    await appendIssueEvent(file, {
      issueId: issue.id,
      type: "issue.claim.expired",
      idempotencyKey: `claim-expired:${issue.id}:${issue.claimToken ?? issue.claimExpiresAt}`,
      payload: { previousClaimToken: issue.claimToken, expiredAt: now.toISOString() },
    });
  }
  return expired;
}

export function selectNextReadyIssue(issues: Iterable<IssueProjection>): IssueProjection | undefined {
  return [...issues]
    .filter((issue) => issue.status === "ready")
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
}

async function acquireLock(file: string, timeoutMs = 10_000, staleAfterMs = 60_000): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return async () => { await unlink(file).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > staleAfterMs) {
          await unlink(file).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out acquiring issue event lock: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function stringPayload(event: IssueEvent, key: string, fallback = ""): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : fallback;
}

function numberPayload(event: IssueEvent, key: string, fallback: number): number {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
