import { readFile } from "node:fs/promises";
import path from "node:path";
import { runRoot } from "./store.ts";

export interface RunLogEvent {
  timestamp?: string;
  runId?: string;
  type?: string;
  stageId?: string;
  message?: string;
  [key: string]: unknown;
}

/** Read the append-only durable event log. A partially written final line is retried on the next poll. */
export async function readRunEvents(repositoryRoot: string, runId: string): Promise<RunLogEvent[]> {
  const file = path.join(runRoot(repositoryRoot, runId), "events.jsonl");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" && !Array.isArray(value) ? [value as RunLogEvent] : [];
      } catch {
        return [];
      }
    });
}

/** Format an append-only event stream for a tailing UI: newest events first. */
export function formatRunEventsNewestFirst(events: RunLogEvent[]): string[] {
  return [...events].reverse().map(formatRunEvent);
}

export function formatRunEvent(event: RunLogEvent): string {
  const timestamp = event.timestamp ? formatTimestamp(event.timestamp) : "--:--:--";
  const type = event.type ?? "event";
  const stage = event.stageId ? ` [${event.stageId}]` : "";
  const details = Object.entries(event)
    .filter(([key, value]) => !["timestamp", "runId", "type", "stageId", "message"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  const message = [event.message, details].filter(Boolean).join(" · ");
  return `${timestamp} ${type}${stage}${message ? ` — ${message}` : ""}`;
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString().slice(11, 19);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
