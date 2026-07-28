#!/usr/bin/env -S node --experimental-strip-types
import path from "node:path";
import { recordHumanDecision, requestAbort, resumeRun, runManifestFile } from "../src/runner.ts";
import { completeChainAutonomously, formatAutonomousReport } from "../src/followups.ts";
import { repositoryRoot } from "../src/git.ts";
import { loadRunState } from "../src/store.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) usage();

const onEvent = ({ type, message }: { type: string; message: string }): void => { process.stderr.write(`[${type}] ${message}\n`); };

if (command === "run") {
  const manifest = args.find((value) => !value.startsWith("--"));
  if (!manifest) usage();
  const humanDecisions = args.includes("--human-decisions");
  let state = await runManifestFile({ manifestPath: manifest, humanDecisions, onEvent });
  if (!args.includes("--no-follow-ups")) {
    const repository = await repositoryRoot(state.manifest.workingDirectory);
    const report = await completeChainAutonomously({ repositoryRoot: repository, state, humanDecisions, onEvent });
    state = report.state;
    process.stderr.write(`${formatAutonomousReport(report)}\n`);
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (state.status !== "completed") process.exitCode = 2;
} else if (command === "resume") {
  const runId = args.find((value) => !value.startsWith("--"));
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  let state = await resumeRun({
    repositoryRoot: repository,
    runId,
    adoptCurrentHead: args.includes("--adopt-current-head"),
    onEvent,
  });
  if (!args.includes("--no-follow-ups")) {
    const report = await completeChainAutonomously({ repositoryRoot: repository, state, onEvent });
    state = report.state;
    process.stderr.write(`${formatAutonomousReport(report)}\n`);
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (state.status !== "completed") process.exitCode = 2;
} else if (command === "status") {
  const runId = args[0];
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  process.stdout.write(`${JSON.stringify(await loadRunState(repository, runId), null, 2)}\n`);
} else if (command === "decide") {
  const [runId, choice, ...rationale] = args;
  if (!runId || !choice) usage();
  const repository = await repositoryRoot(process.cwd());
  const state = await recordHumanDecision(repository, runId, choice, rationale.join(" ") || "Human decision supplied through trip-headless.");
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} else if (command === "abort") {
  const runId = args[0];
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  process.stdout.write(`${JSON.stringify(await requestAbort(repository, runId), null, 2)}\n`);
} else {
  usage();
}

function usage(): never {
  process.stderr.write(`usage:\n  trip-headless run <manifest.json> [--human-decisions] [--no-follow-ups]\n  trip-headless resume <run-id> [--adopt-current-head] [--no-follow-ups]\n  trip-headless status <run-id>\n  trip-headless decide <run-id> <choice> [rationale]\n  trip-headless abort <run-id>\n`);
  process.exit(64);
}
