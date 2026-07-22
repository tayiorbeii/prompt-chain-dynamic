import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIssue, processNextIssue } from "../src/controller.ts";
import { appendIssueEvent, projectIssues, readIssueEvents, selectNextReadyIssue } from "../src/issues.ts";
import { git } from "../src/git.ts";
import type { AgentBackend, AgentRequest, AgentResult, TripManifest } from "../src/types.ts";

class IssueBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return ok("Research complete.");
    if (request.role === "implementation") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "issue.ts"), "export const done = true;\n");
      return ok("<status>complete</status><risk>low</risk><rationale>Implemented.</rationale>");
    }
    if (request.role === "review") return ok("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
    if (request.role === "integration") return ok("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    throw new Error(`unexpected role ${request.role}`);
  }
}

function ok(text: string): AgentResult {
  return { success: true, text, durationMs: 1 };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-issues-repo-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

function manifest(root: string): TripManifest {
  return {
    schemaVersion: 1,
    name: "Issue implementation",
    workingDirectory: root,
    settings: { autoCommit: false, reviewPolicy: { reviewerCount: 1, maxRepairRounds: 2 } },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "implement", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement", allowedPaths: ["src/issue.ts"], claimedPaths: ["src/issue.ts"] },
      { id: "integrate", type: "integration", needs: ["implement"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/issue.ts"] },
    ],
  };
}

test("issue event append is idempotent and projection selects highest priority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-events-"));
  const file = path.join(root, "issues.jsonl");
  const first = await appendIssueEvent(file, { issueId: "low", type: "issue.created", idempotencyKey: "create-low", payload: { title: "Low", manifestPath: "low.json", priority: 1 } });
  const duplicate = await appendIssueEvent(file, { issueId: "low", type: "issue.created", idempotencyKey: "create-low", payload: { title: "Changed", manifestPath: "changed.json", priority: 99 } });
  assert.equal(duplicate.id, first.id);
  await appendIssueEvent(file, { issueId: "low", type: "issue.ready", idempotencyKey: "ready-low" });
  await appendIssueEvent(file, { issueId: "high", type: "issue.created", idempotencyKey: "create-high", payload: { title: "High", manifestPath: "high.json", priority: 10 } });
  await appendIssueEvent(file, { issueId: "high", type: "issue.ready", idempotencyKey: "ready-high" });
  const issues = projectIssues(await readIssueEvents(file));
  assert.equal(issues.get("low")?.title, "Low");
  assert.equal(selectNextReadyIssue(issues.values())?.id, "high");
});

test("controller claims one issue, runs its DAG, and does not reprocess completion", async () => {
  const repo = await repository();
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-controller-"));
  const eventFile = path.join(root, "issues.jsonl");
  const manifestPath = path.join(root, "issue.trip.json");
  await writeFile(manifestPath, JSON.stringify(manifest(repo)));
  await createIssue(eventFile, { title: "Implement issue", manifestPath, priority: 5, issueId: "issue-1" });
  const first = await processNextIssue({ eventFile, backend: new IssueBackend() });
  assert.equal(first.run?.status, "completed", first.run?.pauseReason);
  const projected = projectIssues(await readIssueEvents(eventFile));
  assert.equal(projected.get("issue-1")?.status, "completed");
  assert.equal(projected.get("issue-1")?.runId, first.run?.id);
  const second = await processNextIssue({ eventFile, backend: new IssueBackend() });
  assert.equal(second.run, undefined);
  assert.match(second.message, /No ready issue/);
});
