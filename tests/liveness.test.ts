import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, runCommand } from "../src/git.ts";
import { monitorActivity, waitForHeartbeatStop } from "../src/liveness.ts";
import { RunReaper } from "../src/reaper.ts";
import { runManifestFile } from "../src/runner.ts";
import { claimRunLease, loadRunState, runRoot, writeRunState } from "../src/store.ts";
import type { AgentBackend, AgentRequest, AgentResult, TripManifest } from "../src/types.ts";

test("activity resets warnings; silence warns periodically without ending the operation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const warnings: Array<{ elapsedMs: number; idleMs: number }> = [];
  const monitor = monitorActivity(100, (warning) => { warnings.push(warning); });
  t.after(() => monitor.stop());
  async function advance(ms: number) {
    now += ms;
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (let i = 0; i < 5; i++) {
    await advance(90);
    monitor.activity();
  }
  assert.equal(warnings.length, 0, "activity outlives the original wall-clock limit");
  await advance(100);
  assert.deepEqual(warnings, [{ elapsedMs: 550, idleMs: 100 }]);
  await advance(100);
  assert.deepEqual(warnings[1], { elapsedMs: 650, idleMs: 200 });
  monitor.activity();
  await advance(90);
  assert.equal(warnings.length, 2);
  now += 10;
  t.mock.timers.tick(10);
  monitor.activity();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 2, "activity also suppresses a queued, not-yet-delivered warning");
  monitor.stop();
  monitor.activity();
  await advance(1_000);
  assert.equal(warnings.length, 2, "no warning or rearming after stop");
});

test("warning observer failure or a pending observer cannot terminate work or pile up callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let calls = 0;
  const monitor = monitorActivity(100, () => {
    calls++;
    if (calls === 1) throw new Error("observer failed");
    return new Promise<void>(() => {});
  });
  t.after(() => monitor.stop());
  for (let i = 0; i < 4; i++) {
    now += 100;
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(calls, 2);
});

test("zero disables warnings while waiting for completion", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const monitor = monitorActivity(0, () => assert.fail("warnings are disabled"));
  monitor.activity();
  t.mock.timers.tick(1_000_000);
  monitor.stop();
});

test("waiting retains the process even with warnings disabled and no other active handles", async () => {
  for (const interval of [0, 60_000]) {
    const script = `
      import { monitorActivity } from ${JSON.stringify(new URL("../src/liveness.ts", import.meta.url).href)};
      const monitor = monitorActivity(${interval}, () => {});
      setTimeout(() => { monitor.stop(); console.log("settled"); }, 20).unref();
    `;
    const result = await runCommand(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: process.cwd() });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "settled", `warning interval ${interval} must retain the waiting process`);
  }
});

function success(text: string): AgentResult {
  return { success: true, text, durationMs: 1 };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-chain-liveness-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

function readonlyManifest(repository: string): TripManifest {
  return {
    schemaVersion: 1,
    name: "Liveness fixture",
    workingDirectory: repository,
    settings: { autoCommit: false, continuationPolicy: { leaseTimeoutMs: 5, reaperPollIntervalMs: 1 } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
}

class ReadonlyBackend implements AgentBackend {
  calls = 0;
  async run(): Promise<AgentResult> {
    this.calls += 1;
    return success("Research complete.");
  }
}

test("a silent backend warns and returns its real result without a replacement", async () => {
  const repository = await createRepository();
  const manifest = readonlyManifest(repository);
  manifest.settings!.sessionTimeoutMs = 20;
  const manifestPath = path.join(repository, "warning.trip.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  let warnings = 0;
  const state = await runManifestFile({
    manifestPath,
    externalReaper: false,
    backend: {
      async run(request) {
        calls++;
        assert.equal(request.timeoutMs, 0, "the backend must not inherit a hard deadline");
        await new Promise((resolve) => setTimeout(resolve, 80));
        return success("Research complete.");
      },
    },
    onEvent(event) {
      if (event.type === "agent.call.idle") {
        warnings++;
        assert.match(event.message, /continuing to wait/i);
      }
    },
  });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(calls, 1);
  assert.ok(warnings > 0);
  const events = await readFile(path.join(runRoot(repository, state.id), "events.jsonl"), "utf8");
  assert.match(events, /agent\.call\.idle/);
  assert.doesNotMatch(events, /agent\.call\.failed/);
});

test("an active backend can exceed its interval and warning observers cannot fail it", async () => {
  const repository = await createRepository();
  const manifest = readonlyManifest(repository);
  manifest.settings!.continuationPolicy!.agentCallTimeoutMs = 20;
  const manifestPath = path.join(repository, "active.trip.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  let ticks = 0;
  let warnings = 0;
  const state = await runManifestFile({
    manifestPath, externalReaper: false,
    backend: {
      async run(request) {
        calls++;
        assert.equal(request.timeoutMs, 0);
        assert.ok(request.onActivity);
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          request.onActivity();
          ticks++;
        }
        // A subsequent silent spell and broken warning sink still aren't failures.
        await new Promise((resolve) => setTimeout(resolve, 80));
        return success("Research complete.");
      },
    },
    onEvent(event) {
      if (event.type === "agent.call.idle") {
        warnings++;
        throw new Error("notification sink failed");
      }
    },
  });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(calls, 1);
  assert.equal(ticks, 10);
  assert.ok(warnings > 0);
});

test("heartbeat shutdown is bounded when a renewal never settles", async () => {
  const never = new Promise<void>(() => {});
  const startedAt = Date.now();
  assert.equal(await waitForHeartbeatStop(never, 20), false);
  assert.ok(Date.now() - startedAt < 500, "shutdown should not wait forever");
});

test("duplicate stale-lease reapers have a single atomic winner", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `lease-race-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(readonlyManifest(repository)));
  const completed = await runManifestFile({ manifestPath, backend: new ReadonlyBackend(), externalReaper: false });

  completed.status = "running";
  completed.completedAt = undefined;
  completed.stageStates.research!.status = "running";
  completed.lease!.leaseTimeoutMs = 1;
  await writeRunState(repository, completed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const generation = completed.lease!.generation;

  const claims = await Promise.all([
    claimRunLease(repository, completed.id, { expectedGeneration: generation }),
    claimRunLease(repository, completed.id, { expectedGeneration: generation }),
  ]);
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal((await loadRunState(repository, completed.id)).lease?.generation, generation + 1);
});

test("reaper notices an expired running lease and completes the interrupted stage", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `lease-recovery-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(readonlyManifest(repository)));
  const backend = new ReadonlyBackend();
  const completed = await runManifestFile({ manifestPath, backend, externalReaper: false });
  const generation = completed.lease!.generation;

  completed.status = "running";
  completed.completedAt = undefined;
  completed.stageStates.research!.status = "running";
  completed.stageStates.research!.completedAt = undefined;
  completed.lease!.leaseTimeoutMs = 1;
  await writeRunState(repository, completed);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const recovered = await new RunReaper({ repositoryRoot: repository, runId: completed.id, backend, pollIntervalMs: 1 }).start();
  assert.equal(recovered.status, "completed", recovered.pauseReason);
  assert.equal(recovered.stageStates.research?.status, "completed");
  assert.equal(recovered.lease?.generation, generation + 1);
  assert.ok(backend.calls >= 2, "the interrupted stage should run again");
});

class BestAttemptBackend implements AgentBackend {
  implementationAttempt = 0;
  reviewCalls = 0;

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "implementation" || request.role === "repair") {
      this.implementationAttempt += 1;
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      const value = this.implementationAttempt === 1 ? "best" : "worse";
      await writeFile(path.join(request.cwd, "src", "best.ts"), `export const value = '${value}';\n`);
      return success("<status>complete</status><risk>low</risk><rationale>Candidate complete.</rationale>");
    }
    if (request.role === "integration") {
      return success("<status>complete</status><risk>low</risk><rationale>Integration complete.</rationale>");
    }
    if (request.role === "review") {
      this.reviewCalls += 1;
      if (request.stageId === "integrate") {
        return success("<status>complete</status><risk>low</risk><rationale>Integration accepted.</rationale>");
      }
      if (this.reviewCalls === 1) {
        return success("<status>continue</status><risk>low</risk><rationale>Minor follow-up.</rationale><finding><severity>minor</severity><blocking>false</blocking><summary>Minor issue</summary><evidence>Small polish item.</evidence></finding>");
      }
      return success("<status>continue</status><risk>high</risk><rationale>Regressed.</rationale><finding><severity>major</severity><blocking>true</blocking><summary>Regression</summary><evidence>The second candidate is worse.</evidence></finding>");
    }
    return success("Research complete.");
  }
}

test("best-effort exhaustion retains the final cumulative candidate patch", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Best candidate restore",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 10, malformedVerdict: "continue", requireFreshClosureReviewer: true },
      // This test exercises the opt-in best-effort acceptance path.
      continuationPolicy: { consecutiveFailureOverride: 2, bestEffortCompletion: true },
    },
    stages: [
      {
        id: "implement",
        type: "implementation",
        needs: [],
        isolation: "same-checkout",
        prompt: "Implement the best candidate.",
        allowedPaths: ["src/**"],
        claimedPaths: ["src/best.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["implement"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `best-candidate-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend: new BestAttemptBackend(), externalReaper: false });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.stageStates.implement?.completionMode, "best-effort");
  assert.equal(state.stageStates.implement?.bestAttempt, 4);
  assert.equal(await readFile(path.join(repository, "src", "best.ts"), "utf8"), "export const value = 'worse';\n");
  assert.match(await readFile(path.join(runRoot(repository, state.id), "events.jsonl"), "utf8"), /stage\.cumulative_attempt\.retained/);
});

class DelayedDecisionBackend implements AgentBackend {
  reviewCalls = 0;
  decisionCalls = 0;

  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "decision") {
      this.decisionCalls++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return success("<decision><status>decided</status><choice>safe</choice><rationale>Examined the options.</rationale><implementationDirection>Use the safe option.</implementationDirection></decision>");
    }
    if (request.role === "implementation" || request.role === "repair" || request.role === "integration") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "choice.ts"), "export const choice = 'safe';\n");
      return success("<status>complete</status><risk>low</risk><rationale>Implemented safely.</rationale>");
    }
    if (request.role === "review") {
      this.reviewCalls += 1;
      if (this.reviewCalls === 1) {
        return success("<status>needs_decision</status><risk>medium</risk><rationale>Choose a safe option.</rationale><decisionQuestion>Which option?</decisionQuestion><option><id>safe</id><description>Use the reversible safe option.</description></option><recommendedOption>safe</recommendedOption>");
      }
      return success("<status>complete</status><risk>low</risk><rationale>The fallback choice is safe.</rationale>");
    }
    return success("Research complete.");
  }
}

test("an empty test-suite success is treated as non-validation and recorded for follow-up", async () => {
  const repository = await createRepository();
  const backend: AgentBackend = {
    async run(request: AgentRequest): Promise<AgentResult> {
      if (request.role === "implementation" || request.role === "integration") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "empty-suite.ts"), "export const implemented = true;\n");
      }
      return success("<status>complete</status><risk>low</risk><rationale>Work complete.</rationale>");
    },
  };
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Empty suite",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false },
      // This test exercises the opt-in best-effort acceptance path.
      continuationPolicy: { consecutiveFailureOverride: 1, bestEffortCompletion: true },
    },
    stages: [
      {
        id: "implement",
        type: "implementation",
        needs: [],
        isolation: "same-checkout",
        prompt: "Implement.",
        allowedPaths: ["src/**"],
        claimedPaths: ["src/empty-suite.ts"],
        validationCommands: ["node -e \"console.log('No test files found, exiting with code 0')\""],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["implement"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `empty-suite-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend, externalReaper: false });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.stageStates.implement?.completionMode, "best-effort");
  assert.ok(state.findings.some((finding) => finding.stageId === "implement"
    && finding.summary === "Validation did not pass"
    && finding.disposition === "follow-up-created"));
  assert.match(await readFile(path.join(runRoot(repository, state.id), "follow-ups.md"), "utf8"), /Validation did not pass/);
});

test("automatic follow-up remediation builds on the current worktree before recording terminal follow-ups", async () => {
  const repository = await createRepository();
  let repairs = 0;
  const backend: AgentBackend = {
    async run(request: AgentRequest): Promise<AgentResult> {
      if (request.stageId === "implement" && request.role === "implementation") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "repair.ts"), "export const repaired = false;\n");
      } else if (request.stageId === "implement" && request.role === "repair") {
        repairs += 1;
        assert.match(request.prompt, /AUTOMATIC FOLLOW-UP REMEDIATION PASS 1\/1/);
        assert.match(request.prompt, /Build on the complete current worktree/);
        await writeFile(path.join(request.cwd, "src", "repair.ts"), "export const repaired = true;\n");
      }
      return success("<status>complete</status><risk>low</risk><rationale>Work complete.</rationale>");
    },
  };
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Automatic follow-up remediation",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false },
      // The automatic follow-up remediation window is itself gated behind
      // best-effort acceptance (see runner.ts): opt in explicitly so this
      // test can exercise the bounded auto-repair-retry mechanism.
      continuationPolicy: { consecutiveFailureOverride: 1, autoResumeTurnLimit: 1, automaticFollowUpPasses: 1, automaticFollowUpAttemptLimit: 1, bestEffortCompletion: true },
    },
    stages: [
      {
        id: "implement",
        type: "implementation",
        needs: [],
        isolation: "same-checkout",
        prompt: "Implement.",
        allowedPaths: ["src/**"],
        claimedPaths: ["src/repair.ts"],
        validationCommands: ["node -e \"const fs = require('fs'); process.exit(fs.readFileSync('src/repair.ts', 'utf8').includes('true') ? 0 : 1)\""],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["implement"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `automatic-follow-up-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));

  const state = await runManifestFile({ manifestPath, backend, externalReaper: false });

  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(repairs, 1);
  assert.equal(state.stageStates.implement?.completionMode, "verified");
  assert.equal(state.findings.some((finding) => finding.disposition === "follow-up-created"), false);
  assert.match(await readFile(path.join(repository, "src", "repair.ts"), "utf8"), /true/);
  assert.match(await readFile(path.join(runRoot(repository, state.id), "events.jsonl"), "utf8"), /stage\.follow_up\.automatic_started/);
});

test("a silent decision warns and completes without fallback or replacement", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Decision inactivity warning",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      decisionPolicy: { mode: "agent", maxDecisionRounds: 1 },
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: true },
      continuationPolicy: { decisionTimeoutMs: 20, agentCallTimeoutMs: 1_000 },
    },
    stages: [
      {
        id: "implement",
        type: "implementation",
        needs: [],
        isolation: "same-checkout",
        prompt: "Implement the safest choice.",
        allowedPaths: ["src/**"],
        claimedPaths: ["src/choice.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["implement"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Finalize the safe choice.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `decision-timeout-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));

  const backend = new DelayedDecisionBackend();
  let warnings = 0;
  const state = await runManifestFile({
    manifestPath, backend, externalReaper: false,
    onEvent(event) {
      if (event.type === "agent.call.idle" && event.message.includes("decision agent")) warnings++;
    },
  });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(backend.decisionCalls, 1);
  assert.ok(warnings > 0);
  assert.ok(state.decisions.some((decision) => decision.actor === "agent" && decision.status === "decided"));
  assert.ok(!state.findings.some((finding) => finding.summary === "Autonomous fallback decision was used"));
});

// --- Slice 9: activity clock and bounded reclaim ---

import { formatRunSummary } from "../src/status.ts";
import { resumeRun } from "../src/runner.ts";

function slice9Manifest(repository: string): TripManifest {
  return {
    schemaVersion: 1,
    name: "Two clocks",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false, reviewerCount: 1, maxRepairRounds: 1, malformedVerdict: "continue", requireFreshClosureReviewer: false },
      continuationPolicy: { leaseTimeoutMs: 3_000, reaperEnabled: false },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "impl", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement", allowedPaths: ["src/**"], claimedPaths: ["src/x.ts"] },
      { id: "integrate", type: "integration", needs: ["impl"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
}

async function slice9Repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "two-clocks-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

class ActiveBackend implements AgentBackend {
  calls = 0;
  async run(request: AgentRequest): Promise<AgentResult> {
    this.calls += 1;
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "research") return { success: true, text: "Context.", durationMs: 1 };
    if (request.stageId === "impl") {
      // Streamed activity while the agent works, then a quiet stretch longer than the heartbeat interval.
      for (let tick = 0; tick < 3; tick += 1) { request.onActivity?.(); await new Promise((resolve) => setTimeout(resolve, 100)); }
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "x.ts"), "export const x = 1;\n");
    }
    return { success: true, text: "<status>complete</status><risk>low</risk><rationale>Done.</rationale>", durationMs: 1 };
  }
}

test("observed activity updates the lease's activity clock independently of the heartbeat", async () => {
  const repository = await slice9Repository();
  const manifestPath = path.join(os.tmpdir(), `two-clocks-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(slice9Manifest(repository)));
  const state = await runManifestFile({ manifestPath, backend: new ActiveBackend(), externalReaper: false });
  assert.equal(state.status, "completed", state.pauseReason);
  const durable = await loadRunState(repository, state.id);
  assert.ok(durable.lease?.lastActivityAt, "activity was persisted");
  assert.ok(Date.parse(durable.lease!.heartbeatAt) > Date.parse(durable.lease!.lastActivityAt!), "the heartbeat kept advancing after the last observed activity");
  assert.match(formatRunSummary(durable), /activity age/);
});

test("a stage reclaimed from a stale lease too many times pauses the run as reclaim_exhausted, while operator resumes do not count", async () => {
  const repository = await slice9Repository();
  const manifestPath = path.join(os.tmpdir(), `reclaims-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(slice9Manifest(repository)));
  const backend = new ActiveBackend();
  const completed = await runManifestFile({ manifestPath, backend, externalReaper: false });
  assert.equal(completed.status, "completed", completed.pauseReason);

  // Forge a stale-lease crash mid-stage after three earlier reclaims. Write the
  // file directly: writeRunState would refresh the heartbeat and make it live.
  const statePath = path.join(runRoot(repository, completed.id), "run.json");
  const forged = JSON.parse(await readFile(statePath, "utf8")) as typeof completed;
  forged.status = "running";
  forged.completedAt = undefined;
  forged.resultCommit = undefined;
  forged.stageStates.impl!.status = "running";
  forged.stageStates.impl!.reclaims = 3;
  forged.stageStates.integrate!.status = "pending";
  forged.lease = { owner: "dead-worker", generation: forged.lease!.generation, heartbeatAt: "2026-01-01T00:00:00.000Z", leaseTimeoutMs: 3_000 };
  await writeFile(statePath, JSON.stringify(forged));
  const callsBefore = backend.calls;
  const paused = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend, externalReaper: false });
  assert.equal(paused.status, "paused", paused.pauseReason);
  assert.equal(paused.pauseKind, "reclaim_exhausted");
  assert.match(paused.pauseReason ?? "", /Stage impl was reclaimed from a stale lease 4 times \(limit 3\)/);
  assert.equal(backend.calls, callsBefore, "no agent ran once the reclaim bound was hit");
  assert.equal(paused.stageStates.impl?.reclaims, 4);

  // An operator resume of the paused run is not a reclaim: the counter holds.
  const operator = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend, externalReaper: false });
  assert.equal(operator.stageStates.impl?.reclaims, 4, "operator resumes never increment the counter");
  assert.notEqual(operator.pauseKind, "reclaim_exhausted");
});
