import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.ts";
import { runManifestFile } from "../src/runner.ts";
import { loadRunState } from "../src/store.ts";
import type { AgentBackend, AgentRequest, AgentResult, TripManifest } from "../src/types.ts";

class FeedbackBackend implements AgentBackend {
  reviewCalls = 0;

  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "research") return result("Architecture context gathered.");
    if (request.stageId === "implement-clusters" && request.role === "implementation") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "clusters.ts"), "export const sortMode = 'live-count';\n");
      return result("<status>complete</status><risk>medium</risk><rationale>Implemented the requested cluster list.</rationale>");
    }
    if (request.stageId === "implement-clusters" && request.role === "review") {
      this.reviewCalls += 1;
      if (this.reviewCalls === 1) {
        return result("Stop the parent cluster list from reshuffling on exclude/include. Clusters are sorted descending by raw topic count, so excluding items re-sorts the list mid-task and you lose your place. Fix: lock the initial order, or sort by the original count instead of the live count.");
      }
      return result("<status>complete</status><risk>low</risk><rationale>The initial order is now stable and the regression test covers exclude/include.</rationale>");
    }
    if (request.stageId === "implement-clusters" && request.role === "repair") {
      await writeFile(path.join(request.cwd, "src", "clusters.ts"), "export const sortMode = 'initial-order';\n");
      await writeFile(path.join(request.cwd, "src", "clusters.test.ts"), "// regression: exclude/include preserves initial parent order\n");
      return result("<status>complete</status><risk>low</risk><rationale>Preserved the initial order and added a regression test.</rationale>");
    }
    if (request.stageId === "integrate" && request.role === "integration") {
      return result("<status>complete</status><risk>low</risk><rationale>Verified the accumulated implementation.</rationale>");
    }
    if (request.stageId === "integrate" && request.role === "review") {
      return result("<status>complete</status><risk>low</risk><rationale>Aggregate implementation satisfies the plan.</rationale>");
    }
    if (request.role === "decision") {
      return result("<decision><status>decided</status><choice>preserve-initial-order</choice><rationale>It is the smallest reversible user-stability fix.</rationale><implementationDirection>Preserve the initial parent-cluster order while live counts update.</implementationDirection><requiredVerification>Add an exclude/include regression test.</requiredVerification></decision>");
    }
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

function result(text: string): AgentResult {
  return { success: true, text, durationMs: 1 };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-runner-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

test("same-checkout checkpoints retain cumulative owned changes across serial writers", async () => {
  const repository = await createRepository();
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repository, "foreign.json"), "foreign staged content\\n");
  await git(repository, ["add", "foreign.json"]);
  const indexPath = await git(repository, ["rev-parse", "--git-path", "index"]);
  const absoluteIndexPath = path.isAbsolute(indexPath) ? indexPath : path.join(repository, indexPath);
  const indexBefore = await readFile(absoluteIndexPath);

  class SerialCheckpointBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      if (request.stageId === "writer-one" && request.role === "implementation") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "one.ts"), "export const one = 1;\\n");
        return result("<status>complete</status><risk>low</risk><rationale>First writer complete.</rationale>");
      }
      if (request.stageId === "writer-two" && request.role === "implementation") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "two.ts"), "export const two = 2;\\n");
        return result("<status>complete</status><risk>low</risk><rationale>Second writer complete.</rationale>");
      }
      if (request.stageId === "integrate" && request.role === "integration") {
        return result("<status>complete</status><risk>low</risk><rationale>Integrated without additional changes.</rationale>");
      }
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }

  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Serial checkpoint safety",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: false, reviewerCount: 1, maxRepairRounds: 1, malformedVerdict: "continue", requireFreshClosureReviewer: false },
    },
    stages: [
      { id: "writer-one", type: "implementation", needs: [], isolation: "same-checkout", prompt: "Write one.", allowedPaths: ["src/**"], claimedPaths: ["src/one.ts"] },
      { id: "writer-two", type: "implementation", needs: ["writer-one"], isolation: "same-checkout", prompt: "Write two.", allowedPaths: ["src/**"], claimedPaths: ["src/two.ts"] },
      { id: "integrate", type: "integration", needs: ["writer-two"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate.", allowedPaths: ["src/**"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-serial-checkpoint-${Date.now()}-${Math.random()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend: new SerialCheckpointBackend() });

  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.baseRevision, baseRevision);
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), baseRevision);
  assert.deepEqual(await readFile(absoluteIndexPath), indexBefore);
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "foreign.json");

  const firstCheckpoint = state.stageStates["writer-one"]?.verifiedCommit;
  const secondCheckpoint = state.stageStates["writer-two"]?.verifiedCommit;
  assert.ok(firstCheckpoint);
  assert.ok(secondCheckpoint);
  assert.equal(await git(repository, ["rev-parse", `refs/prompt-chain/runs/${state.id}/stages/writer-one`]), firstCheckpoint);
  assert.equal(await git(repository, ["rev-parse", `refs/prompt-chain/runs/${state.id}/stages/writer-two`]), secondCheckpoint);
  assert.equal(await git(repository, ["rev-parse", `${secondCheckpoint}^`]), baseRevision);
  assert.equal(await git(repository, ["show", `${secondCheckpoint}:src/one.ts`]), "export const one = 1;\\n");
  assert.equal(await git(repository, ["show", `${secondCheckpoint}:src/two.ts`]), "export const two = 2;\\n");
  assert.equal(await git(repository, ["cat-file", "-e", `${secondCheckpoint}:foreign.json`]).catch(() => "missing"), "missing");

  const patchPath = state.stageStates["writer-two"]?.cumulativePatchPath;
  const patchDigest = state.stageStates["writer-two"]?.cumulativePatchSha256;
  assert.ok(patchPath);
  assert.ok(patchDigest);
  const patch = await readFile(patchPath);
  assert.equal(createHash("sha256").update(patch).digest("hex"), patchDigest);
  assert.ok(patch.toString("utf8").includes("src/one.ts"));
  assert.ok(patch.toString("utf8").includes("src/two.ts"));
  assert.ok(!patch.toString("utf8").includes("foreign.json"));
  const checkpointMessage = await git(repository, ["show", "--format=%B", "--no-patch", secondCheckpoint]);
  assert.match(checkpointMessage, new RegExp(`Durable-Trip-Diff-Hash: ${patchDigest}`));
  assert.match(checkpointMessage, new RegExp(`Durable-Trip-Base: ${baseRevision}`));
});

test("runtime closes free-form feedback before advancing", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Stable cluster order",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 3, malformedVerdict: "continue", requireFreshClosureReviewer: true },
      decisionPolicy: { mode: "agent", maxDecisionRounds: 2, requireBestEffortDecision: true, prepareHumanRecommendation: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "implement-clusters",
        type: "implementation",
        needs: ["research"],
        isolation: "same-checkout",
        prompt: "Implement stable cluster ordering.",
        allowedPaths: ["src/**"],
        claimedPaths: ["src/clusters.ts", "src/clusters.test.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["implement-clusters"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Finalize.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-manifest-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const backend = new FeedbackBackend();
  const state = await runManifestFile({ manifestPath, backend });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(backend.reviewCalls, 2);
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0]?.disposition, "resolved");
  assert.equal(await readFile(path.join(repository, "src", "clusters.ts"), "utf8"), "export const sortMode = 'initial-order';\n");
  assert.equal(state.stageStates["implement-clusters"]?.status, "completed");
  const latestAttempt = state.stageStates["implement-clusters"]?.attempts.at(-1)?.attempt;
  assert.ok(latestAttempt);
  const validationArtifact = path.join(
    repository,
    ".pi",
    "prompt-chain-hybrid",
    "runs",
    state.id,
    "stages",
    "implement-clusters",
    `attempt-${latestAttempt}`,
    "validation.json",
  );
  assert.deepEqual(JSON.parse(await readFile(validationArtifact, "utf8")), []);
  const reviewArtifact = path.join(path.dirname(validationArtifact), "review-1.json");
  assert.equal(JSON.parse(await readFile(reviewArtifact, "utf8")).status, "complete");
});

class ProgressiveRepairBackend implements AgentBackend {
  reviewCalls = 0;
  repairCalls = 0;
  repairPrompts: string[] = [];

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return result("Research complete.");
    if (request.stageId === "impl" && request.role === "implementation") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "x.ts"), "export const version = 1;\n");
      return result("<status>complete</status><risk>low</risk><rationale>Initial implementation.</rationale>");
    }
    if (request.stageId === "impl" && request.role === "repair") {
      this.repairCalls += 1;
      this.repairPrompts.push(request.prompt);
      await writeFile(path.join(request.cwd, "src", "x.ts"), `export const version = ${this.repairCalls + 1};\n`);
      return result("<status>complete</status><risk>low</risk><rationale>Applied the current review feedback.</rationale>");
    }
    if (request.stageId === "impl" && request.role === "review") {
      this.reviewCalls += 1;
      if (this.reviewCalls === 1) {
        return result("<status>continue</status><risk>medium</risk><rationale>First repair needed.</rationale><finding><severity>major</severity><blocking>true</blocking><summary>Fix the first behavior</summary><evidence>src/x.ts:1</evidence><remediation>Update version two.</remediation><path>src/x.ts</path></finding>");
      }
      if (this.reviewCalls === 2) {
        return result("<status>continue</status><risk>medium</risk><rationale>The first behavior is fixed; a second repair is needed.</rationale><finding><severity>major</severity><blocking>true</blocking><summary>Cover the second behavior</summary><evidence>src/x.ts:1</evidence><remediation>Update version three.</remediation><path>src/x.ts</path></finding>");
      }
      return result("<status>complete</status><risk>low</risk><rationale>All evolving findings are now closed.</rationale>");
    }
    if (request.stageId === "integrate" && request.role === "integration") {
      return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    }
    if (request.stageId === "integrate" && request.role === "review") {
      return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
    }
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

test("runtime continues automatically when progressive repairs exceed the focused round window", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Automatic progressive repair",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 1, malformedVerdict: "continue", requireFreshClosureReviewer: true },
      continuationPolicy: { autoResumeTurnLimit: 10, consecutiveFailureOverride: 3 },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      {
        id: "impl",
        type: "implementation",
        needs: ["research"],
        isolation: "same-checkout",
        prompt: "Implement and repair until verified.",
        allowedPaths: ["src/x.ts"],
        claimedPaths: ["src/x.ts"],
      },
      {
        id: "integrate",
        type: "integration",
        needs: ["impl"],
        isolation: "same-checkout",
        integrationStrategy: "same-checkout-finalize",
        prompt: "Integrate.",
        allowedPaths: ["src/**"],
      },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `progressive-repair-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const backend = new ProgressiveRepairBackend();

  const state = await runManifestFile({ manifestPath, backend });

  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(backend.repairCalls, 2, "the second repair must run beyond maxRepairRounds");
  assert.match(backend.repairPrompts[1] ?? "", /Cover the second behavior/);
  assert.match(backend.repairPrompts[1] ?? "", /RECENT ATTEMPT EVIDENCE/);
  assert.match(backend.repairPrompts[1] ?? "", /Attempt 1/);
  assert.match(backend.repairPrompts[1] ?? "", /Fix the first behavior/);
  assert.match(backend.repairPrompts[1] ?? "", /Do not repeat an approach that left the same failure unresolved/);
  assert.equal(state.findings.length, 2);
  assert.ok(state.findings.every((finding) => finding.disposition === "resolved"));
  assert.equal(await readFile(path.join(repository, "src", "x.ts"), "utf8"), "export const version = 3;\n");
});

class ParallelBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return result("Research complete.");
    if (request.role === "implementation") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      if (request.stageId === "slice-a") await writeFile(path.join(request.cwd, "src", "a.ts"), "export const a = 1;\n");
      else if (request.stageId === "slice-b") await writeFile(path.join(request.cwd, "src", "b.ts"), "export const b = 2;\n");
      return result("<status>complete</status><risk>low</risk><rationale>Slice implemented.</rationale>");
    }
    if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
    if (request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

test("runtime executes independent writers in worktrees and fans patches in", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Parallel slices",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      maxParallel: 2,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "slice-a", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "A", allowedPaths: ["src/a.ts"], claimedPaths: ["src/a.ts"] },
      { id: "slice-b", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "B", allowedPaths: ["src/b.ts"], claimedPaths: ["src/b.ts"] },
      { id: "integrate", type: "integration", needs: ["slice-a", "slice-b"], isolation: "same-checkout", integrationStrategy: "worktree-fan-in", prompt: "Integrate", allowedPaths: ["src/a.ts", "src/b.ts"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-parallel-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend: new ParallelBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(await readFile(path.join(repository, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  assert.equal(await readFile(path.join(repository, "src", "b.ts"), "utf8"), "export const b = 2;\n");
  assert.ok(state.stageStates["slice-a"]?.patchSha256);
  assert.ok(state.stageStates["slice-b"]?.patchSha256);
});

class DecisionBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return result("Research complete.");
    if (request.stageId === "choose-order" && request.role === "implementation") {
      return result(`<status>needs_decision</status><risk>low</risk><rationale>Two safe ordering strategies exist.</rationale><decisionQuestion>Which ordering strategy should be used?</decisionQuestion><option><id>initial</id>Preserve initial order</option><option><id>original-count</id>Sort by immutable original count</option><recommendedOption>initial</recommendedOption><recommendationRationale>It is the smallest reversible fix.</recommendationRationale>`);
    }
    if (request.role === "decision") {
      return result("<decision><status>decided</status><choice>initial</choice><rationale>Preserving initial order best protects navigation stability.</rationale><implementationDirection>Store and reuse the initial parent order.</implementationDirection><requiredVerification>Verify exclude/include never reorders parents.</requiredVerification></decision>");
    }
    if (request.stageId === "choose-order" && request.role === "repair") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "decision.ts"), "export const order = 'initial';\n");
      return result("<status>complete</status><risk>low</risk><rationale>Applied the recorded decision.</rationale>");
    }
    if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Decision was applied and verified.</rationale>");
    if (request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

function decisionManifest(repository: string): TripManifest {
  return {
    schemaVersion: 1,
    name: "Decision flow",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 3, malformedVerdict: "continue", requireFreshClosureReviewer: true },
      decisionPolicy: { mode: "agent", maxDecisionRounds: 2, requireBestEffortDecision: true, prepareHumanRecommendation: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "choose-order", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Choose and implement ordering.", allowedPaths: ["src/decision.ts"], claimedPaths: ["src/decision.ts"] },
      { id: "integrate", type: "integration", needs: ["choose-order"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/decision.ts"] },
    ],
  };
}

test("needs_decision defaults to an autonomous decision agent", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `trip-decision-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(decisionManifest(repository)));
  const state = await runManifestFile({ manifestPath, backend: new DecisionBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.decisionMode, "agent");
  assert.ok(state.decisions.some((decision) => decision.actor === "agent" && decision.status === "decided"));
  assert.equal(await readFile(path.join(repository, "src", "decision.ts"), "utf8"), "export const order = 'initial';\n");
});

test("human decision flag records an agent recommendation without wedging autonomous completion", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `trip-human-decision-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(decisionManifest(repository)));
  const completed = await runManifestFile({ manifestPath, backend: new DecisionBackend(), humanDecisions: true });
  assert.equal(completed.status, "completed", completed.pauseReason);
  assert.equal(completed.decisionMode, "human");
  assert.ok(completed.decisions.some((decision) => decision.actor === "agent" && decision.status === "decided"));
});

test("resume reconciles a result commit from the integration journal", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Journal reconciliation",
    workingDirectory: repository,
    settings: {
      autoCommit: true,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "slice-a", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "A", allowedPaths: ["src/a.ts"], claimedPaths: ["src/a.ts"] },
      { id: "slice-b", type: "implementation", needs: ["research"], isolation: "worktree", prompt: "B", allowedPaths: ["src/b.ts"], claimedPaths: ["src/b.ts"] },
      { id: "integrate", type: "integration", needs: ["slice-a", "slice-b"], isolation: "same-checkout", integrationStrategy: "worktree-fan-in", prompt: "Integrate", allowedPaths: ["src/a.ts", "src/b.ts"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-journal-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const backend = new ParallelBackend();
  const completed = await runManifestFile({ manifestPath, backend });
  assert.equal(completed.status, "completed", completed.pauseReason);
  assert.ok(completed.resultCommit);
  const resultCommit = completed.resultCommit;
  completed.resultCommit = undefined;
  completed.status = "running";
  completed.completedAt = undefined;
  completed.stageStates.integrate!.status = "running";
  completed.stageStates.integrate!.completedAt = undefined;
  completed.lease!.leaseTimeoutMs = 1;
  const { writeRunState } = await import("../src/store.ts");
  await writeRunState(repository, completed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { resumeRun } = await import("../src/runner.ts");
  const reconciled = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend, externalReaper: false });
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.resultCommit, resultCommit);
  const names = await git(repository, ["show", "--pretty=format:", "--name-only", resultCommit!]);
  assert.match(names, /src\/a\.ts/);
  assert.match(names, /src\/b\.ts/);
  assert.doesNotMatch(names, /\.pi\/prompt-chain-hybrid/);
});

class SimpleCheckoutBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "research") return result("Context gathered.");
    if (request.stageId === "implement") {
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const feature = true;\n");
      return result("<status>complete</status><risk>low</risk><rationale>Implemented.</rationale>");
    }
    if (request.stageId === "integrate") return result("<status>complete</status><risk>low</risk><rationale>Finalized.</rationale>");
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

// A resumed same-checkout run must not be blocked by stray dirty plan/manifest
// artifacts (.md/.json) that sit outside every stage's path contract — those files
// are never branched into a run and letting them fail reconcile is pure friction.
test("resume reconciles a paused same-checkout run despite out-of-contract dirty .md/.json", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Reconcile ignores plan artifacts",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 3, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "implement", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement", allowedPaths: ["src/**"], claimedPaths: ["src/feature.ts"] },
      { id: "integrate", type: "integration", needs: ["implement"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-reconcile-md-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const backend = new SimpleCheckoutBackend();
  const completed = await runManifestFile({ manifestPath, backend });
  assert.equal(completed.status, "completed", completed.pauseReason);

  // Simulate an interruption: the same-checkout implement stage is left paused with
  // its work uncommitted in the tree, exactly like an in-flight run.
  completed.status = "running";
  completed.completedAt = undefined;
  completed.stageStates.implement!.status = "paused";
  completed.stageStates.implement!.completedAt = undefined;
  completed.stageStates.integrate!.status = "pending";
  completed.stageStates.integrate!.completedAt = undefined;
  completed.lease!.leaseTimeoutMs = 1;
  const { writeRunState } = await import("../src/store.ts");
  await writeRunState(repository, completed);
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Stray plan + manifest artifacts, dirty and OUTSIDE the src/** contract.
  await writeFile(path.join(repository, "notes.md"), "# scratch notes\n");
  await writeFile(path.join(repository, "config.json"), JSON.stringify({ stray: true }));

  const { resumeRun } = await import("../src/runner.ts");
  const reconciled = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend, externalReaper: false });
  assert.equal(reconciled.status, "completed", reconciled.pauseReason);
  // The ignorable artifacts were left untouched, not swept into the run.
  assert.equal(await readFile(path.join(repository, "notes.md"), "utf8"), "# scratch notes\n");
  assert.equal(await readFile(path.join(repository, "config.json"), "utf8"), JSON.stringify({ stray: true }));
});

class StrayDocBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(request.cwd, { recursive: true });
    if (request.role === "research") return result("Context gathered.");
    if (request.stageId === "implement") {
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const feature = true;\n");
      // Off-task scratch doc OUTSIDE the src/** contract — must not fail the stage.
      await mkdir(path.join(request.cwd, "plans"), { recursive: true });
      await writeFile(path.join(request.cwd, "plans", "scratch.md"), "# stray scratch\n");
      return result("<status>complete</status><risk>low</risk><rationale>Implemented.</rationale>");
    }
    if (request.stageId === "integrate") return result("<status>complete</status><risk>low</risk><rationale>Finalized.</rationale>");
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

// An agent that jots a stray, off-task `plans/*.md` outside its path contract is
// off-task, not dangerous — it must not hard-fail the writer stage. The doc is
// left ignored in the tree and never swept into the scoped commit; the real
// in-contract work still completes and commits.
test("a stray non-high-risk .md written outside the contract does not fail the writer stage", async () => {
  const repository = await createRepository();
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Stray doc tolerance",
    workingDirectory: repository,
    settings: {
      autoCommit: true,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "implement", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement", allowedPaths: ["src/**"], claimedPaths: ["src/feature.ts"] },
      { id: "integrate", type: "integration", needs: ["implement"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `trip-stray-doc-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const state = await runManifestFile({ manifestPath, backend: new StrayDocBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.ok(state.resultCommit);
  const names = await git(repository, ["show", "--pretty=format:", "--name-only", state.resultCommit!]);
  assert.match(names, /src\/feature\.ts/);
  assert.doesNotMatch(names, /plans\/scratch\.md/); // stray doc is never committed
  assert.equal(await readFile(path.join(repository, "plans", "scratch.md"), "utf8"), "# stray scratch\n"); // left ignored in the tree
});

class ScopeViolationBackend implements AgentBackend {
  implementationCalls = 0;

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return result("Context gathered.");
    if (request.stageId === "implement" && request.role === "implementation") {
      this.implementationCalls += 1;
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), `export const version = ${this.implementationCalls};\n`);
      if (this.implementationCalls === 1) {
        await mkdir(path.join(request.cwd, "tests", "security"), { recursive: true });
        await writeFile(path.join(request.cwd, "tests", "security", "privacy-policy.test.ts"), "placeholder\n");
      }
      return result("<status>complete</status><risk>low</risk><rationale>Implemented.</rationale>");
    }
    if (request.stageId === "implement" && request.role === "review") {
      return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
    }
    if (request.stageId === "integrate") {
      return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
    }
    throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
  }
}

function sourceBoundaryManifest(repository: string, autoCommit = true): TripManifest {
  return {
    schemaVersion: 1,
    name: "Source boundary recovery",
    workingDirectory: repository,
    settings: {
      autoCommit,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "implement", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement", allowedPaths: ["src/**"], claimedPaths: ["src/feature.ts"] },
      { id: "integrate", type: "integration", needs: ["implement"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate", allowedPaths: ["src/**"] },
    ],
  };
}

test("portable manifests resolve workingDirectory relative to the manifest file", async () => {
  const repository = await createRepository();
  const manifest = sourceBoundaryManifest(repository, false);
  manifest.workingDirectory = "../..";
  const manifestPath = path.join(repository, "docs", "plans", "portable.trip.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));

  const state = await runManifestFile({ manifestPath, backend: new SimpleCheckoutBackend(), externalReaper: false });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(state.manifest.workingDirectory, repository);
});

test("pre-existing out-of-contract source files are baselined, preserved, and never committed", async () => {
  const repository = await createRepository();
  const stray = path.join(repository, "tests", "security", "privacy-policy.test.ts");
  await mkdir(path.dirname(stray), { recursive: true });
  await writeFile(stray, "pre-existing placeholder\n");
  const manifestPath = path.join(os.tmpdir(), `trip-baseline-source-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(sourceBoundaryManifest(repository)));

  const state = await runManifestFile({ manifestPath, backend: new SimpleCheckoutBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.match(state.workspaceBaseline?.["tests/security/privacy-policy.test.ts"] ?? "", /^file:/);
  assert.equal(await readFile(stray, "utf8"), "pre-existing placeholder\n");
  const patch = await readFile(state.stageStates.implement?.cumulativePatchPath ?? "", "utf8");
  assert.doesNotMatch(patch, /pre-existing placeholder|privacy-policy/);
  const committed = await git(repository, ["show", "--pretty=format:", "--name-only", state.resultCommit!]);
  assert.match(committed, /src\/feature\.ts/);
  assert.doesNotMatch(committed, /privacy-policy/);
});

test("new out-of-contract source writes pause safely and can resume after operator cleanup", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `trip-scope-pause-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(sourceBoundaryManifest(repository, false)));
  const backend = new ScopeViolationBackend();

  const paused = await runManifestFile({ manifestPath, backend, externalReaper: false });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseKind, "workspace_drift");
  assert.match(paused.pauseReason ?? "", /privacy-policy\.test\.ts/);

  await rm(path.join(repository, "tests", "security", "privacy-policy.test.ts"));
  const { resumeRun } = await import("../src/runner.ts");
  const resumed = await resumeRun({ repositoryRoot: repository, runId: paused.id, backend, externalReaper: false });
  assert.equal(resumed.status, "completed", resumed.pauseReason);
  assert.equal(await readFile(path.join(repository, "src", "feature.ts"), "utf8"), "export const version = 2;\n");
});

class BlockedIntegrationBackend implements AgentBackend {
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "research") return result("Context gathered.");
    if (request.stageId === "implement" && request.role !== "review") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const feature = true;\n");
      return result("<status>complete</status><risk>low</risk><rationale>Implemented.</rationale>");
    }
    if (request.stageId === "integrate" && request.role === "review") {
      return result("<status>continue</status><risk>high</risk><rationale>Release evidence is unavailable.</rationale><finding><severity>critical</severity><blocking>true</blocking><summary>Mandatory release evidence is unavailable</summary><evidence>release manifest has unavailable gates</evidence><remediation>Provide the mandatory evidence.</remediation></finding>");
    }
    return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
  }
}

test("required integration pauses instead of committing best-effort work with blockers", async () => {
  const repository = await createRepository();
  const manifest = sourceBoundaryManifest(repository);
  manifest.settings = {
    ...manifest.settings,
    continuationPolicy: { autoResumeTurnLimit: 1, automaticFollowUpPasses: 0 },
  };
  const manifestPath = path.join(os.tmpdir(), `trip-integration-blocked-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));

  const state = await runManifestFile({ manifestPath, backend: new BlockedIntegrationBackend(), externalReaper: false });
  assert.equal(state.status, "paused");
  assert.equal(state.pauseKind, "review_blocked");
  assert.equal(state.stageStates.integrate?.status, "paused");
  assert.equal(state.resultCommit, undefined);
  assert.ok(state.findings.some((finding) => finding.stageId === "integrate" && finding.blocking && finding.disposition === "open"));
});

// --- Slice 2: worker verdicts never mint findings ---

test("worker continue returns never create findings and their missing items drive the next prompt", async () => {
  const repository = await createRepository();
  class SelfReportingBackend implements AgentBackend {
    workerCalls = 0;
    repairPrompts: string[] = [];
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Context gathered.");
      if (request.stageId === "impl" && (request.role === "implementation" || request.role === "repair")) {
        this.workerCalls += 1;
        if (request.role === "repair") this.repairPrompts.push(request.prompt);
        if (this.workerCalls < 4) {
          return result("<status>continue</status><risk>medium</risk><rationale>Verified the module already satisfies the contract but the export is missing.</rationale><missingItems>Add the named export\nAdd a regression test</missingItems><finding><severity>major</severity><blocking>true</blocking><summary>Worker-invented blocker</summary><evidence>none</evidence></finding>");
        }
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "x.ts"), "export const x = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Added the export and test.</rationale>");
      }
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
      if (request.stageId === "integrate" && request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: "Worker self-reports",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 4, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "impl", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement x.", allowedPaths: ["src/**"], claimedPaths: ["src/x.ts"] },
      { id: "integrate", type: "integration", needs: ["impl"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate.", allowedPaths: ["src/**"] },
    ],
  };
  const manifestPath = path.join(os.tmpdir(), `worker-self-report-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const backend = new SelfReportingBackend();
  const state = await runManifestFile({ manifestPath, backend });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(backend.workerCalls, 4);
  assert.equal(state.findings.length, 0, "no finding may originate from the worker's own verdict");
  assert.equal(backend.repairPrompts.length, 3);
  for (const prompt of backend.repairPrompts) {
    assert.match(prompt, /REQUIRED ACTION\nComplete the items you reported as missing:\n- Add the named export\n- Add a regression test/);
    assert.match(prompt, /OPEN BLOCKING FINDINGS\nNo open findings\./);
    assert.doesNotMatch(prompt, /Worker-invented blocker/);
  }
});

test("legacy worker-sourced findings load as resolved", async () => {
  const repository = await createRepository();
  const runId = "trip-legacy-worker-finding";
  const root = path.join(repository, ".pi", "prompt-chain-hybrid", "runs", runId);
  await mkdir(root, { recursive: true });
  const legacy = {
    formatVersion: 1,
    id: runId,
    status: "paused",
    findings: [
      { id: "finding-legacy", runId, stageId: "impl", attempt: 2, source: "worker", severity: "major", blocking: true, summary: "Verified the module already satisfies the contract", evidence: "prose", affectedPaths: [], disposition: "open", createdAt: "2026-07-22T15:57:19.000Z", updatedAt: "2026-07-22T15:57:19.000Z" },
      { id: "finding-review", runId, stageId: "impl", attempt: 1, source: "independent-review", severity: "major", blocking: true, summary: "Missing export", evidence: "x.ts", affectedPaths: ["src/x.ts"], disposition: "open", createdAt: "2026-07-22T15:55:01.000Z", updatedAt: "2026-07-22T15:55:01.000Z" },
    ],
    stageStates: {},
    decisionRequests: [],
    decisions: [],
  };
  await writeFile(path.join(root, "run.json"), JSON.stringify(legacy));
  const state = await loadRunState(repository, runId);
  const migrated = state.findings.find((finding) => finding.id === "finding-legacy");
  assert.equal(migrated?.disposition, "resolved");
  assert.equal(migrated?.source, "operator");
  assert.equal(migrated?.resolutionEvidence?.rationale, "legacy worker self-report; not evidence");
  assert.equal(state.findings.find((finding) => finding.id === "finding-review")?.disposition, "open");
});

// --- Slice 3: validate every attempt; review completion claims ---

function slice3Manifest(repository: string, stage: Partial<TripManifest["stages"][number]>): TripManifest {
  return {
    schemaVersion: 1,
    name: "Completion claims",
    workingDirectory: repository,
    settings: {
      autoCommit: false,
      reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 4, malformedVerdict: "continue", requireFreshClosureReviewer: true },
    },
    stages: [
      { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "Research" },
      { id: "impl", type: "implementation", needs: ["research"], isolation: "same-checkout", prompt: "Implement x.", allowedPaths: ["src/**"], claimedPaths: ["src/x.ts"], ...stage },
      { id: "integrate", type: "integration", needs: ["impl"], isolation: "same-checkout", integrationStrategy: "same-checkout-finalize", prompt: "Integrate.", allowedPaths: ["src/**"] },
    ],
  };
}

async function writeManifest(name: string, manifest: TripManifest): Promise<string> {
  const manifestPath = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test("a worker continue with no missing items is a completion claim that reviewers can close", async () => {
  const repository = await createRepository();
  let reviewCalls = 0;
  let workerStatuses: string[] = [];
  class ContinueButDoneBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Context.");
      if (request.stageId === "impl" && request.role === "implementation") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "x.ts"), "export const x = 1;\n");
        workerStatuses.push("continue");
        return result("<status>continue</status><risk>low</risk><rationale>Implemented; someone should verify.</rationale><missingItems></missingItems>");
      }
      if (request.stageId === "impl" && request.role === "review") { reviewCalls += 1; return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>"); }
      if (request.stageId === "integrate" && request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Fine.</rationale>");
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }
  const manifestPath = await writeManifest("continue-claim", slice3Manifest(repository, { validationCommands: ["true"] }));
  const state = await runManifestFile({ manifestPath, backend: new ContinueButDoneBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.deepEqual(workerStatuses, ["continue"], "the worker never returned complete");
  assert.equal(reviewCalls, 1);
  assert.equal(state.stageStates.impl?.attempts.at(-1)?.status, "keep");
  assert.equal(state.stageStates.impl?.attempts.at(-1)?.asi.completionClaim, true);
});

test("validation runs on every attempt and a continue with missing items skips reviewers", async () => {
  const repository = await createRepository();
  let reviewCalls = 0;
  let workerCalls = 0;
  class MissingItemsBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Context.");
      if (request.stageId === "impl" && (request.role === "implementation" || request.role === "repair")) {
        workerCalls += 1;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "x.ts"), `export const x = ${workerCalls};\n`);
        if (workerCalls < 3) return result("<status>continue</status><risk>low</risk><rationale>Partial.</rationale><missingItems>Add docs\nAdd a test</missingItems>");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.stageId === "impl" && request.role === "review") { reviewCalls += 1; return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>"); }
      if (request.stageId === "integrate" && request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Fine.</rationale>");
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }
  const manifestPath = await writeManifest("missing-items", slice3Manifest(repository, { validationCommands: ["true"] }));
  const state = await runManifestFile({ manifestPath, backend: new MissingItemsBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(workerCalls, 3);
  assert.equal(reviewCalls, 1, "reviewers run only for the completion claim");
  for (const attempt of [1, 2, 3]) {
    const artifact = path.join(repository, ".pi", "prompt-chain-hybrid", "runs", state.id, "stages", "impl", `attempt-${attempt}`, "validation.json");
    const results = JSON.parse(await readFile(artifact, "utf8")) as Array<{ command: string; exitCode: number }>;
    assert.deepEqual(results.map((entry) => [entry.command, entry.exitCode]), [["true", 0]], `attempt ${attempt} must carry validation evidence`);
  }
  assert.equal(state.stageStates.impl?.attempts[0]?.asi.completionClaim, false);
});

test("a completion claim missing a declared output becomes a finding and a repair, not a failed stage", async () => {
  const repository = await createRepository();
  let workerCalls = 0;
  class ForgetfulBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Context.");
      if (request.stageId === "impl" && (request.role === "implementation" || request.role === "repair")) {
        workerCalls += 1;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "x.ts"), "export const x = 1;\n");
        if (workerCalls === 2) await writeFile(path.join(request.cwd, "src", "out.ts"), "export const out = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>");
      if (request.stageId === "integrate" && request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }
  const manifestPath = await writeManifest("missing-output", slice3Manifest(repository, { outputs: ["src/out.ts"], claimedPaths: ["src/x.ts", "src/out.ts"] }));
  const state = await runManifestFile({ manifestPath, backend: new ForgetfulBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.equal(workerCalls, 2);
  const outputFinding = state.findings.find((finding) => /Declared outputs are missing: src\/out\.ts/.test(finding.summary));
  assert.equal(outputFinding?.source, "deterministic-validation");
  assert.equal(outputFinding?.disposition, "resolved");
  assert.equal(state.stageStates.impl?.attempts[0]?.status, "checks_failed");
});

test("a writer stage without validation commands warns exactly once and tells reviewers it is a plan defect", async () => {
  const repository = await createRepository();
  let reviewPrompt = "";
  class NoCommandsBackend implements AgentBackend {
    async run(request: AgentRequest): Promise<AgentResult> {
      await mkdir(request.cwd, { recursive: true });
      if (request.role === "research") return result("Context.");
      if (request.stageId === "impl" && request.role === "implementation") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "x.ts"), "export const x = 1;\n");
        return result("<status>complete</status><risk>low</risk><rationale>Done.</rationale>");
      }
      if (request.stageId === "impl" && request.role === "review") { reviewPrompt = request.prompt; return result("<status>complete</status><risk>low</risk><rationale>Verified.</rationale>"); }
      if (request.stageId === "integrate" && request.role === "integration") return result("<status>complete</status><risk>low</risk><rationale>Integrated.</rationale>");
      if (request.role === "review") return result("<status>complete</status><risk>low</risk><rationale>Fine.</rationale>");
      throw new Error(`unexpected request: ${request.stageId}/${request.role}`);
    }
  }
  const manifestPath = await writeManifest("no-commands", slice3Manifest(repository, {}));
  const state = await runManifestFile({ manifestPath, backend: new NoCommandsBackend() });
  assert.equal(state.status, "completed", state.pauseReason);
  assert.match(reviewPrompt, /This stage declares no validation commands\. That is a plan defect/);
  const events = (await readFile(path.join(repository, ".pi", "prompt-chain-hybrid", "runs", state.id, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; stageId?: string });
  assert.equal(events.filter((event) => event.type === "stage.validation.none" && event.stageId === "impl").length, 1);
});
