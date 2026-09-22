import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgent } from "@quintinshaw/pi-dynamic-workflows";
import { DynamicWorkflowBackend } from "../src/dynamic-backend.ts";
import type { AgentRequest } from "../src/types.ts";

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.01 };

test("backend forwards supported activity hooks without a deadline and preserves final usage", async (t) => {
  let activity = 0;
  let usageReports = 0;
  t.mock.method(WorkflowAgent.prototype, "run", async (...[_prompt, options]: Parameters<WorkflowAgent["run"]>) => {
    assert.ok(options);
    assert.equal("timeoutMs" in options, false, "WorkflowAgent has no timeout option");
    assert.equal(options.signal, undefined, "no implicit deadline signal");
    options.onHistory?.([]);
    options.onUsageProgress?.(usage);
    options.onUsage?.(usage);
    return { status: "complete", rationale: "Finished", risk: "low" };
  });
  const backend = new DynamicWorkflowBackend({
    onUsage(_request, actual) { assert.deepEqual(actual, usage); usageReports++; },
  });
  const request: AgentRequest = {
    runId: "run", stageId: "stage", role: "implementation", cwd: process.cwd(),
    prompt: "Implement", tools: ["read"], timeoutMs: 20, artifactDirectory: ".",
    onActivity() { activity++; },
  };
  const result = await backend.run(request);
  assert.equal(result.success, true, result.error);
  assert.match(result.text, /<status>complete<\/status>/);
  assert.equal(activity, 2);
  assert.equal(usageReports, 1);
});

test("session scope extends the persisted session name only when present", async (t) => {
  const names: Array<string | undefined> = [];
  t.mock.method(WorkflowAgent.prototype, "run", async (...[_prompt, options]: Parameters<WorkflowAgent["run"]>) => {
    names.push(options?.sessionName);
    return { status: "complete", rationale: "Finished", risk: "low" };
  });
  const backend = new DynamicWorkflowBackend();
  const base: AgentRequest = {
    runId: "run", stageId: "stage", role: "review", cwd: process.cwd(),
    prompt: "Review", tools: ["read"], timeoutMs: 0, artifactDirectory: ".",
  };
  await backend.run(base);
  await backend.run({ ...base, sessionScope: "attempt-2 reviewer-1" });
  assert.deepEqual(names, ["prompt-chain:run stage:review", "prompt-chain:run stage:review attempt-2 reviewer-1"]);
});
