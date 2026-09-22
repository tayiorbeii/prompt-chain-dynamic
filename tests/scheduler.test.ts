import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.ts";
import { runManifestFile } from "../src/runner.ts";
import type { AgentBackend, AgentRequest, AgentResult, TripManifest } from "../src/types.ts";

function result(text: string): AgentResult {
  return { success: true, text, durationMs: 1 };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

// Backend that makes slice-a fail so downstream stages get skipped
class FailFirstBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "research") return result("Research complete.");
    if (request.stageId === "slice-a") {
      return { success: false, text: "", durationMs: 1, error: "slice-a intentionally failed" };
    }
    if (request.stageId === "integrate") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
  }
}

test("a failed optional worker is completed best-effort so downstream work still runs", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Scheduler semantics",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false },
      // This test exercises the opt-in best-effort acceptance path.
      continuationPolicy: { bestEffortCompletion: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "slice-a",
        type: "implementation",
        needs: ["research"],
        isolation: "same-checkout",
        prompt: "Implement A",
        allowedPaths: ["src/a.ts"],
        claimedPaths: ["src/a.ts"],
        required: false, // non-required so run can continue
      },
      {
        id: "slice-b",
        type: "implementation",
        needs: ["slice-a"],
        isolation: "same-checkout",
        prompt: "Implement B (depends on A)",
        allowedPaths: ["src/b.ts"],
        claimedPaths: ["src/b.ts"],
        required: false,
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["slice-b"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate",
        allowedPaths: ["src/**"],
        required: false,
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `scheduler-manifest-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend: new FailFirstBackend() });

  assert.equal(state.status, "completed");
  assert.equal(state.stageStates["slice-a"]?.status, "completed");
  assert.equal(state.stageStates["slice-a"]?.completionMode, "best-effort");
  assert.ok(state.stageStates["slice-a"]?.followUpArtifact);
  assert.equal(state.stageStates["slice-b"]?.status, "completed");
  assert.equal(state.stageStates["integrate"]?.status, "completed");
});

test("persistent worker failure is noted and does not skip downstream stages", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Skipped downstream",
    workingDirectory: repository,
    // This test exercises the opt-in best-effort acceptance path.
    settings: { autoCommit: false, reviewPolicy: { required: false }, continuationPolicy: { bestEffortCompletion: true } },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "failed-stage",
        type: "implementation",
        needs: ["research"],
        isolation: "same-checkout",
        prompt: "Fail intentionally",
        allowedPaths: ["src/x.ts"],
        claimedPaths: ["src/x.ts"],
        required: false,
      },
      {
        id: "downstream",
        type: "implementation",
        needs: ["failed-stage"],
        isolation: "same-checkout",
        prompt: "Should be skipped",
        allowedPaths: ["src/y.ts"],
        claimedPaths: ["src/y.ts"],
        required: false,
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["downstream"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate",
        allowedPaths: ["src/**"],
        required: false,
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `downstream-manifest-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));

  class TargetedFailBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Research complete.");
      if (request.stageId === "failed-stage") return { success: false, text: "", durationMs: 1, error: "forced failure" };
      if (request.role === "integration" || request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
      return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
    }
  }

  const state = await runManifestFile({ manifestPath, backend: new TargetedFailBackend() });
  assert.equal(state.status, "completed");
  assert.equal(state.stageStates["failed-stage"]?.status, "completed");
  assert.equal(state.stageStates["failed-stage"]?.completionMode, "best-effort");
  assert.equal(state.stageStates["downstream"]?.status, "completed");
  assert.equal(state.stageStates["integrate"]?.status, "completed");
});

test("run lease is initialized on runManifestFile", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Lease init",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `lease-manifest-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const state = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  assert.ok(state.lease, "lease should be set");
  assert.equal(state.lease?.generation, 1);
  assert.equal(state.lease?.owner, state.id);
  assert.ok(state.lease?.heartbeatAt);
  assert.ok(state.lease?.leaseTimeoutMs > 0);
});

test("resumeRun with a stale generation returns current state without side effects", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Stale generation",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `stale-gen-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  const { resumeRun } = await import("../src/runner.ts");
  // Pass a stale generation (0 != 1)
  const returned = await resumeRun({ repositoryRoot: repository, runId: initial.id, leaseGeneration: 0, backend: new SimpleBackend(), externalReaper: false });
  // Should return current state with no side effects — generation should still be 1
  assert.equal(returned.lease?.generation, initial.lease?.generation, "stale generation should not bump the lease");
  assert.equal(returned.status, initial.status, "stale generation should not change run status");
});

test("consecutive non-progress records follow-up after its automatic remediation window", async () => {
  // A backend that always returns "continue" — every attempt is a discard.
  // With maxConsecutiveFailures: 3, the stage opens its bounded automatic
  // remediation window before it records terminal best-effort follow-up notes.
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Consecutive limit",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 10, malformedVerdict: "continue", requireFreshClosureReviewer: false },
      // This test exercises the opt-in best-effort acceptance path.
      continuationPolicy: { maxConsecutiveFailures: 3, bestEffortCompletion: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "impl",
        type: "implementation",
        needs: ["research"],
        isolation: "same-checkout",
        prompt: "Implement",
        allowedPaths: ["src/x.ts"],
        claimedPaths: ["src/x.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["impl"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `limit-manifest-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  let implementationAttempts = 0;
  class AlwaysContinueBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Research complete.");
      if (request.stageId === "impl") {
        implementationAttempts++;
        // Never complete — always return continue with a concrete missing item, so
        // it is non-progress rather than a completion claim that would route to review.
        return result("<status>continue</status><risk>low</risk><rationale>Still working.</rationale><missingItems>Finish the implementation</missingItems>");
      }
      return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
    }
  }
  const state = await runManifestFile({ manifestPath, backend: new AlwaysContinueBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.stageStates.impl?.completionMode, "best-effort");
  assert.ok(state.stageStates.impl?.followUpArtifact);
  assert.ok(state.findings.some((finding) => finding.stageId === "impl" && finding.disposition === "follow-up-created"));
  assert.ok(implementationAttempts <= 8, `expected at most 8 attempts (configured rail plus default remediation window), got ${implementationAttempts}`);
});

test("resumeRun with current generation increments the lease generation", async () => {
  const { writeRunState } = await import("../src/store.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Generation bump",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `gen-bump-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  // Artificially pause the run so resume has something to do
  initial.status = "paused";
  initial.pauseKind = "blocked";
  await writeRunState(repository, initial);
  const { resumeRun } = await import("../src/runner.ts");
  const gen = initial.lease?.generation ?? 1;
  const resumed = await resumeRun({ repositoryRoot: repository, runId: initial.id, leaseGeneration: gen, backend: new SimpleBackend(), externalReaper: false });
  assert.equal(resumed.lease?.generation, gen + 1, "current generation should be incremented on successful resume");
});

test("an explicit resume reopens an aborted run and clears its abort request", async () => {
  const { writeRunState } = await import("../src/store.ts");
  const { resumeRun } = await import("../src/runner.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Reopen aborted",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
  const manifestPath = path.join(os.tmpdir(), `reopen-aborted-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  initial.status = "aborted";
  initial.abortRequested = true;
  initial.completedAt = new Date().toISOString();
  initial.stageStates.research!.status = "paused";
  initial.stageStates.research!.completedAt = undefined;
  await writeRunState(repository, initial);

  const generation = initial.lease?.generation ?? 1;
  const resumed = await resumeRun({ repositoryRoot: repository, runId: initial.id, backend: new SimpleBackend(), externalReaper: false });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.abortRequested, false);
  assert.equal(resumed.stageStates.research?.status, "completed");
  assert.equal(resumed.lease?.generation, generation + 1);
});

test("explicit HEAD adoption resumes from a clean intentional branch move and preserves a recovery backup", async () => {
  const { writeRunState, runRoot } = await import("../src/store.ts");
  const { resumeRun } = await import("../src/runner.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Adopt moved HEAD",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
  const manifestPath = path.join(os.tmpdir(), `adopt-head-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend(), externalReaper: false });
  initial.status = "paused";
  initial.pauseKind = "workspace_drift";
  initial.stageStates.research!.status = "paused";
  initial.stageStates.research!.completedAt = undefined;
  await writeRunState(repository, initial);
  await writeFile(path.join(repository, "README.md"), "intentional new base\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "intentional branch move"]);
  const adoptedHead = await git(repository, ["rev-parse", "HEAD"]);

  const resumed = await resumeRun({
    repositoryRoot: repository,
    runId: initial.id,
    backend: new SimpleBackend(),
    externalReaper: false,
    adoptCurrentHead: true,
  });
  assert.equal(resumed.status, "completed", resumed.pauseReason);
  assert.equal(resumed.baseRevision, adoptedHead);
  const backups = await readdir(path.join(runRoot(repository, initial.id), "recovery"));
  assert.ok(backups.some((name) => name.startsWith("pre-head-adoption-")));
});

test("explicit HEAD adoption refuses uncommitted source changes", async () => {
  const { writeRunState } = await import("../src/store.ts");
  const { resumeRun } = await import("../src/runner.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Reject dirty adoption",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
  const manifestPath = path.join(os.tmpdir(), `reject-dirty-adopt-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend(), externalReaper: false });
  initial.status = "paused";
  initial.stageStates.research!.status = "paused";
  await writeRunState(repository, initial);
  await writeFile(path.join(repository, "README.md"), "intentional new base\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "intentional branch move"]);
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "src", "dirty.ts"), "export const dirty = true;\n");

  const resumed = await resumeRun({
    repositoryRoot: repository,
    runId: initial.id,
    backend: new SimpleBackend(),
    externalReaper: false,
    adoptCurrentHead: true,
  });
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.pauseKind, "workspace_drift");
  assert.match(resumed.pauseReason ?? "", /requires source changes to be committed or stashed/i);
  assert.equal(resumed.baseRevision, initial.baseRevision);
});

test("resume refuses a concurrent worker while the run lease is live", async () => {
  const { writeRunState } = await import("../src/store.ts");
  const { resumeRun } = await import("../src/runner.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Live lease",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
  const manifestPath = path.join(os.tmpdir(), `live-lease-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  initial.status = "running";
  initial.completedAt = undefined;
  initial.stageStates.research!.status = "running";
  await writeRunState(repository, initial);

  await assert.rejects(
    resumeRun({ repositoryRoot: repository, runId: initial.id, backend: new SimpleBackend(), externalReaper: false }),
    /already running with a live lease/,
  );
});

test("abort immediately finalizes a running state whose worker lease expired", async () => {
  const { requestAbort } = await import("../src/runner.ts");
  const { writeRunState } = await import("../src/store.ts");
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Abort stale worker",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
    stages: [{ id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" }],
  };
  const manifestPath = path.join(os.tmpdir(), `abort-stale-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  class SimpleBackend implements AgentBackend {
    async run(): Promise<AgentResult> { return result("done"); }
  }
  const initial = await runManifestFile({ manifestPath, backend: new SimpleBackend() });
  initial.status = "running";
  initial.completedAt = undefined;
  initial.stageStates.research!.status = "running";
  initial.lease!.leaseTimeoutMs = 1;
  await writeRunState(repository, initial);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const aborted = await requestAbort(repository, initial.id);
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.abortRequested, true);
  assert.equal(aborted.stageStates.research?.status, "paused");
  assert.match(aborted.pauseReason ?? "", /worker lease had expired/);
});

// --- Slice 7: pool scheduler with exclusive stages ---

import { isExclusiveStage, selectDispatchable } from "../src/runner.ts";
import { loadRunState } from "../src/store.ts";
import { readFile } from "node:fs/promises";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function poolStage(id: string, isolation: "worktree" | "same-checkout" | "readonly", type: "implementation" | "integration" | "review" = "implementation"): TripManifest["stages"][number] {
  return { id, type, needs: [], isolation, prompt: id };
}

test("selectDispatchable fills free slots, lets exclusive stages run only alone, and backfills around a waiting exclusive stage", () => {
  const a = poolStage("a", "worktree");
  const b = poolStage("b", "worktree");
  const c = poolStage("c", "worktree");
  const s = poolStage("s", "same-checkout");
  const i = poolStage("i", "same-checkout", "integration");
  assert.equal(isExclusiveStage(s), true);
  assert.equal(isExclusiveStage(i), true);
  assert.equal(isExclusiveStage(a), false);
  assert.deepEqual(selectDispatchable([a, b, c], [], 2).map((stage) => stage.id), ["a", "b"], "bounded by the limit");
  assert.deepEqual(selectDispatchable([c], [a], 2).map((stage) => stage.id), ["c"], "backfills one freed slot");
  assert.deepEqual(selectDispatchable([s], [], 2).map((stage) => stage.id), ["s"], "an exclusive stage starts on an empty pool");
  assert.deepEqual(selectDispatchable([s, b], [a], 2).map((stage) => stage.id), ["b"], "a waiting exclusive stage does not block backfill");
  assert.deepEqual(selectDispatchable([a, b], [s], 2), [], "nothing starts while an exclusive stage runs");
  assert.deepEqual(selectDispatchable([s, i], [], 4).map((stage) => stage.id), ["s"], "only one exclusive stage at a time");
});

async function poolManifest(repository: string, writers: Array<{ id: string; needs?: string[]; required?: boolean }>, maxParallel: number, options: { extraStages?: TripManifest["stages"]; reviewRequired?: boolean; consecutiveFailureOverride?: number } = {}): Promise<string> {
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Pool",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      maxParallel,
      reviewPolicy: { required: options.reviewRequired ?? false, reviewerCount: 1, maxRepairRounds: 1, malformedVerdict: "continue", requireFreshClosureReviewer: false },
      ...(options.consecutiveFailureOverride ? { continuationPolicy: { consecutiveFailureOverride: options.consecutiveFailureOverride } } : {}),
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      ...writers.map((writer) => ({ id: writer.id, type: "implementation" as const, needs: writer.needs ?? ["research"], isolation: "worktree" as const, prompt: writer.id, allowedPaths: [`src/${writer.id}.ts`], claimedPaths: [`src/${writer.id}.ts`], ...(writer.required === false ? { required: false } : {}) })),
      ...(options.extraStages ?? []),
      { id: "integrate", type: "integration", needs: writers.map((writer) => writer.id), isolation: "same-checkout", integrationStrategy: "worktree-fan-in", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `pool-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test("the pool caps in-flight writers and backfills as soon as one finishes", async () => {
  const repository = await createRepository();
  const durations: Record<string, number> = { a: 50, b: 2500, c: 50 };
  const started: Record<string, number> = {};
  const finished: Record<string, number> = {};
  let inFlight = 0;
  let maxInFlight = 0;
  class TimedBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Research complete.");
      if (request.role === "implementation") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started[request.stageId] = Date.now();
        await sleep(durations[request.stageId] ?? 50);
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${request.stageId}.ts`), `export const ${request.stageId} = 1;\n`);
        finished[request.stageId] = Date.now();
        inFlight -= 1;
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
    }
  }
  const manifestPath = await poolManifest(repository, [{ id: "a" }, { id: "b" }, { id: "c" }], 2);
  const state = await runManifestFile({ manifestPath, backend: new TimedBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(maxInFlight, 2, "never more than maxParallel writers in flight");
  assert.ok(started.c !== undefined && finished.a !== undefined && finished.b !== undefined);
  assert.ok(started.c! >= finished.a! - 5, "c starts after a finishes");
  assert.ok(started.c! < finished.b!, "c starts before b finishes: the pool backfills instead of waiting for the batch");
  for (const id of ["a", "b", "c"]) assert.equal(state.stageStates[id]?.attempts.length, 1, `${id} persisted its attempt record`);
});

test("a pause raised by one writer waits for its in-flight sibling and persists the sibling's attempt", async () => {
  const repository = await createRepository();
  class PausingBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Research complete.");
      if (request.stageId === "a" && (request.role === "implementation" || request.role === "repair")) {
        await sleep(1500);
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "a.ts"), "export const a = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.stageId === "a" && request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
      if (request.stageId === "b" && (request.role === "implementation" || request.role === "repair")) {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "b.ts"), "export const b = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.stageId === "b" && request.role === "review") {
        // Reviewer churn on b exhausts its rail while a is still running, which pauses the run.
        return result("<status>continue</status><risk>medium</risk><rationale>Not yet.</rationale><finding><severity>major</severity><blocking>true</blocking><summary>b is wrong</summary><evidence>src/b.ts</evidence></finding>");
      }
      return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
    }
  }
  const manifestPath = await poolManifest(repository, [{ id: "a" }, { id: "b" }], 2, { reviewRequired: true, consecutiveFailureOverride: 2 });
  const state = await runManifestFile({ manifestPath, backend: new PausingBackend() });
  assert.equal(state.status, "paused", state.pauseReason);
  assert.equal(state.pauseKind, "review_blocked");
  const durable = await loadRunState(repository, state.id);
  assert.equal(durable.stageStates.a?.status, "completed", "the sibling reached its durable boundary before the pause propagated");
  assert.equal(durable.stageStates.a?.attempts.length, 1);
  assert.equal(durable.stageStates.a?.attempts[0]?.status, "keep");
});

test("a dependent of a failed optional writer is skipped only after in-flight siblings finish", async () => {
  const repository = await createRepository();
  class FailingBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Research complete.");
      if (request.stageId === "a" && request.role === "implementation") {
        // A direct agent commit is a safety-boundary failure; on an optional stage it fails the stage without pausing the run.
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "a.ts"), "export const a = 1;\n");
        await git(request.cwd, ["add", "src/a.ts"]);
        await git(request.cwd, ["-c", "user.email=agent@example.com", "-c", "user.name=Agent", "commit", "-m", "agent commit"]);
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.stageId === "b" && request.role === "implementation") {
        await sleep(250);
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "b.ts"), "export const b = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      return result("<status>complete</status><risk>low</risk><rationale>OK.</rationale>");
    }
  }
  const manifestPath = await poolManifest(repository, [{ id: "a", required: false }, { id: "b" }], 2, { extraStages: [{ id: "d", type: "review", needs: ["a"], isolation: "readonly", prompt: "Review a" }] });
  const state = await runManifestFile({ manifestPath, backend: new FailingBackend() });
  assert.equal(state.stageStates.a?.status, "failed");
  assert.equal(state.stageStates.d?.status, "skipped");
  assert.equal(state.stageStates.b?.status, "completed");
  const events = (await readFile(path.join(repository, ".pi", "prompt-chain-hybrid", "runs", state.id, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; stageId?: string });
  const bCompleted = events.findIndex((event) => event.type === "stage.completed" && event.stageId === "b");
  const dSkipped = events.findIndex((event) => event.type === "stage.skipped" && event.stageId === "d");
  assert.ok(bCompleted >= 0 && dSkipped >= 0);
  assert.ok(dSkipped > bCompleted, "skip marking waited for the pool to drain");
});
