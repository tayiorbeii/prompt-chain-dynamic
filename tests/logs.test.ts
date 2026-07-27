import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatRunEvent, readRunEvents } from "../src/logs.ts";

const runId = "trip-log-test";

test("readRunEvents returns valid durable events while ignoring a partial trailing write", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "prompt-chain-logs-"));
  try {
    const directory = path.join(repository, ".pi", "prompt-chain-hybrid", "runs", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "events.jsonl"), [
      JSON.stringify({ timestamp: "2026-07-27T17:00:00.000Z", runId, type: "stage.started", stageId: "implement", message: "Starting work" }),
      "{partial-json",
      JSON.stringify({ timestamp: "2026-07-27T17:00:01.000Z", runId, type: "stage.completed", attempt: 1 }),
      "",
    ].join("\n"));

    const events = await readRunEvents(repository, runId);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.message, "Starting work");
    assert.equal(events[1]?.type, "stage.completed");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("readRunEvents returns an empty list before the durable event log exists", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "prompt-chain-logs-"));
  try {
    assert.deepEqual(await readRunEvents(repository, runId), []);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("formatRunEvent keeps timestamp, type, stage, message, and durable details visible", () => {
  const output = formatRunEvent({
    timestamp: "2026-07-27T17:00:00.000Z",
    type: "stage.completed",
    stageId: "implement",
    message: "Validation passed",
    attempt: 2,
    changedPaths: ["src/index.ts"],
  });

  assert.equal(output, "17:00:00 stage.completed [implement] — Validation passed · attempt=2 changedPaths=[\"src/index.ts\"]");
});
