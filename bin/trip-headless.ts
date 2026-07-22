#!/usr/bin/env -S node --experimental-strip-types
import path from "node:path";
import { recordHumanDecision, requestAbort, resumeRun, runManifestFile } from "../src/runner.ts";
import { repositoryRoot } from "../src/git.ts";
import { loadRunState } from "../src/store.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) usage();

if (command === "run") {
  const manifest = args.find((value) => !value.startsWith("--"));
  if (!manifest) usage();
  const state = await runManifestFile({
    manifestPath: manifest,
    humanDecisions: args.includes("--human-decisions"),
    onEvent: ({ type, message }) => { process.stderr.write(`[${type}] ${message}\n`); },
  });
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (state.status !== "completed") process.exitCode = 2;
} else if (command === "resume") {
  const runId = args[0];
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  const state = await resumeRun({ repositoryRoot: repository, runId, onEvent: ({ type, message }) => { process.stderr.write(`[${type}] ${message}\n`); } });
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
  process.stderr.write(`usage:\n  trip-headless run <manifest.json> [--human-decisions]\n  trip-headless resume <run-id>\n  trip-headless status <run-id>\n  trip-headless decide <run-id> <choice> [rationale]\n  trip-headless abort <run-id>\n`);
  process.exit(64);
}
