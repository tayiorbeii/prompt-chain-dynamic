import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.ts";
import { waitForHeartbeatStop } from "../src/liveness.ts";
import { RunReaper } from "../src/reaper.ts";
import { runManifestFile } from "../src/runner.ts";
import { claimRunLease, loadRunState, runRoot, writeRunState } from "../src/store.ts";
import type { AgentBackend, AgentRequest, AgentResult, TripManifest } from "../src/types.ts";

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
      continuationPolicy: { consecutiveFailureOverride: 2 },
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

class HangingDecisionBackend implements AgentBackend {
  reviewCalls = 0;

  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "decision") return await new Promise<AgentResult>(() => {});
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
      continuationPolicy: { consecutiveFailureOverride: 1 },
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
      continuationPolicy: { consecutiveFailureOverride: 1, autoResumeTurnLimit: 1, automaticFollowUpPasses: 1, automaticFollowUpAttemptLimit: 1 },
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

test("a hanging decision call times out, uses best judgement, and does not pause the chain", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Decision timeout",
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

  const state = await runManifestFile({ manifestPath, backend: new HangingDecisionBackend(), externalReaper: false });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.ok(state.decisions.some((decision) => decision.source === "auto" && decision.status === "decided"));
  assert.ok(state.findings.some((finding) => finding.summary === "Autonomous fallback decision was used" && finding.disposition === "follow-up-created"));
});
