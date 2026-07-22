import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("blockedBy is populated on stages whose dependencies are failed", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Scheduler semantics",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false },
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

  // slice-a failed (non-required, so run continues)
  assert.equal(state.stageStates["slice-a"]?.status, "failed");

  // slice-b is downstream of slice-a — should be skipped with schedulingReason
  assert.equal(state.stageStates["slice-b"]?.status, "skipped");
  assert.deepEqual(state.stageStates["slice-b"]?.blockedBy, ["slice-a"]);
  assert.equal(state.stageStates["slice-b"]?.schedulingReason?.kind, "waiting_on_failed_dependency");

  // integrate depends on slice-b (skipped) — should also be skipped
  assert.equal(state.stageStates["integrate"]?.status, "skipped");
  assert.deepEqual(state.stageStates["integrate"]?.blockedBy, ["slice-b"]);
});

test("downstream stages of a failed dependency show skipped status with schedulingReason set", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Skipped downstream",
    workingDirectory: repository,
    settings: { autoCommit: false, reviewPolicy: { required: false } },
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
  assert.equal(state.stageStates["failed-stage"]?.status, "failed");
  assert.equal(state.stageStates["downstream"]?.status, "skipped");
  const sr = state.stageStates["downstream"]?.schedulingReason;
  assert.ok(sr, "schedulingReason should be set");
  assert.equal(sr?.kind, "waiting_on_failed_dependency");
  if (sr?.kind === "waiting_on_failed_dependency") {
    assert.equal(sr.dependencyId, "failed-stage");
  }
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
  const returned = await resumeRun({ repositoryRoot: repository, runId: initial.id, leaseGeneration: 0, backend: new SimpleBackend() });
  // Should return current state with no side effects — generation should still be 1
  assert.equal(returned.lease?.generation, initial.lease?.generation, "stale generation should not bump the lease");
  assert.equal(returned.status, initial.status, "stale generation should not change run status");
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
  const resumed = await resumeRun({ repositoryRoot: repository, runId: initial.id, leaseGeneration: gen, backend: new SimpleBackend() });
  assert.equal(resumed.lease?.generation, gen + 1, "current generation should be incremented on successful resume");
});
