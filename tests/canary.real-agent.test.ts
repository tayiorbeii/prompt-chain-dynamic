// Real-agent canary: exercises the implement -> review -> integrate loop
// against a real DynamicWorkflowBackend (a genuine coding-agent call via
// @quintinshaw/pi-dynamic-workflows), not the mocked AgentBackend fixtures
// every other test in this suite uses.
//
// The other 112 tests prove the scheduler/runner/compiler logic is correct
// against simulated backends. None of them prove that a real, authenticated
// agent can actually satisfy this runtime's contract: return the expected
// structured_output shape, respect its allowed-path contract, and produce a
// patch that passes the stage's validation command. This test is the first
// evidence-bearing check of that end-to-end loop.
//
// It is a real, metered call to a real model. It must never run silently:
//  - It is SKIPPED by default (both in `npm test` and in `npm run test:canary`
//    without the flag), so CI and normal local runs never spend money or
//    depend on network/auth availability.
//  - Run it deliberately with: npm run test:canary
//    (equivalent to: PROMPT_CHAIN_REAL_AGENT_CANARY=1 node --experimental-strip-types --test tests/canary.real-agent.test.ts)
//  - It requires whatever model auth pi-dynamic-workflows' WorkflowAgent
//    needs in the current environment (e.g. an authenticated `pi` model
//    registry, or provider API keys) — the same auth a live prompt-chain
//    run would need. There is no separate credential setup here.
//  - Override the model with PROMPT_CHAIN_CANARY_MODEL (a concrete
//    "provider/model-id"); otherwise it uses roleTiers: "small" for every
//    role to keep the call as cheap as the runtime's own tiering allows.
//
// See docs/CANARY.md for the full design rationale.

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.ts";
import { runManifestFile } from "../src/runner.ts";
import type { TripManifest } from "../src/types.ts";

const ENABLED = process.env.PROMPT_CHAIN_REAL_AGENT_CANARY === "1";
const CANARY_MODEL = process.env.PROMPT_CHAIN_CANARY_MODEL;

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-chain-canary-"));
  await git(root, ["init"]);
  await git(root, ["config", "core.fsmonitor", "false"]);
  await git(root, ["config", "user.email", "canary@example.com"]);
  await git(root, ["config", "user.name", "Canary"]);
  await writeFile(path.join(root, "README.md"), "canary fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

test(
  "real-agent canary: implement -> review -> integrate completes against a live backend",
  {
    skip: ENABLED ? false : "set PROMPT_CHAIN_REAL_AGENT_CANARY=1 to run this against a real, metered agent backend (see docs/CANARY.md)",
    // Real model latency is highly variable; give this generous headroom.
    timeout: 10 * 60 * 1000,
  },
  async () => {
    const repository = await createRepository();
    const expectedExport = "prompt-chain-real-agent-canary";
    const manifest: TripManifest = {
      schemaVersion: 1,
      name: "Real-agent canary",
      workingDirectory: repository,
      settings: {
        autoCommit: false,
        // Keep this minimal and deterministic: no decision loop, a single
        // lightweight reviewer pass, and a small bounded repair budget in
        // case the first attempt needs one correction.
        reviewPolicy: { required: true, reviewerCount: 1, maxRepairRounds: 2, malformedVerdict: "continue", requireFreshClosureReviewer: false },
        // Fail loud on exhaustion rather than masking a broken real-agent
        // loop as an accepted best-effort completion — a canary is only
        // useful if it can actually fail.
        continuationPolicy: { bestEffortCompletion: false, agentCallTimeoutMs: 4 * 60 * 1000 },
        modelRouting: CANARY_MODEL
          ? { mainModel: CANARY_MODEL }
          // Every role defaults to "small" wherever this runtime doesn't
          // already require otherwise (see dynamic-backend.ts defaultTier);
          // pin all roles to it explicitly to keep this canary as cheap as
          // the runtime's own tiering allows.
          : { roleTiers: { research: "small", implementation: "small", repair: "small", review: "small", decision: "small", integration: "small" } },
      },
      stages: [
        { id: "research", type: "review", needs: [], isolation: "readonly", prompt: "This is a real-agent canary run. Confirm you can read this repository and return a brief context handoff. Do not edit files." },
        {
          id: "implement",
          type: "implementation",
          needs: ["research"],
          isolation: "same-checkout",
          prompt: [
            "Create exactly one file: src/canary-proof.ts",
            `Its entire content must be exactly this line, with a trailing newline and nothing else:`,
            `export const canaryProofValue = "${expectedExport}";`,
            "Do not create, edit, or delete any other file. Do not add comments, types, or additional exports.",
          ].join("\n"),
          allowedPaths: ["src/canary-proof.ts"],
          claimedPaths: ["src/canary-proof.ts"],
          validationCommands: [
            `node -e "const fs=require('fs'); const want='export const canaryProofValue = ${JSON.stringify(expectedExport)};\\n'; const got=fs.readFileSync('src/canary-proof.ts','utf8'); process.exit(got===want?0:1)"`,
          ],
        },
        {
          id: "integrate",
          type: "integration",
          needs: ["implement"],
          isolation: "same-checkout",
          integrationStrategy: "same-checkout-finalize",
          prompt: "Integrate and finalize the canary implementation. Do not introduce new scope; run the final validation commands.",
          allowedPaths: ["src/canary-proof.ts"],
        },
      ],
    };
    const manifestPath = path.join(os.tmpdir(), `canary-manifest-${Date.now()}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const state = await runManifestFile({ manifestPath, externalReaper: false });

    assert.equal(state.status, "completed", state.pauseReason);
    assert.equal(state.stageStates.implement?.status, "completed");
    assert.equal(state.stageStates.implement?.completionMode, "verified", "the real agent's implementation should pass validation and review without falling back to best-effort");
    assert.equal(state.stageStates.integrate?.status, "completed");
    const written = await readFile(path.join(repository, "src", "canary-proof.ts"), "utf8");
    assert.equal(written, `export const canaryProofValue = "${expectedExport}";\n`);
  },
);
