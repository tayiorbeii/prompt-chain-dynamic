import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.ts";
import { runManifestFile } from "../src/runner.ts";
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

test("human decision flag pauses after an agent recommendation and resumes after a human choice", async () => {
  const repository = await createRepository();
  const manifestPath = path.join(os.tmpdir(), `trip-human-decision-${Date.now()}.json`);
  await writeFile(manifestPath, JSON.stringify(decisionManifest(repository)));
  const backend = new DecisionBackend();
  const paused = await runManifestFile({ manifestPath, backend, humanDecisions: true });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseKind, "decision_pending");
  assert.ok(paused.decisions.some((decision) => decision.actor === "agent"));
  const { recordHumanDecision, resumeRun } = await import("../src/runner.ts");
  await recordHumanDecision(repository, paused.id, "initial", "Preserve stable navigation.");
  const completed = await resumeRun({ repositoryRoot: repository, runId: paused.id, backend });
  assert.equal(completed.status, "completed", completed.pauseReason);
  assert.ok(completed.decisions.some((decision) => decision.actor === "human"));
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
  const { writeRunState } = await import("../src/store.ts");
  await writeRunState(repository, completed);
  const { resumeRun } = await import("../src/runner.ts");
  const reconciled = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend });
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
  const { writeRunState } = await import("../src/store.ts");
  await writeRunState(repository, completed);

  // Stray plan + manifest artifacts, dirty and OUTSIDE the src/** contract.
  await writeFile(path.join(repository, "notes.md"), "# scratch notes\n");
  await writeFile(path.join(repository, "config.json"), JSON.stringify({ stray: true }));

  const { resumeRun } = await import("../src/runner.ts");
  const reconciled = await resumeRun({ repositoryRoot: repository, runId: completed.id, backend });
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
