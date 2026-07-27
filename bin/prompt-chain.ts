#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compilePlanFile } from "../src/compiler.ts";
import { repositoryRoot } from "../src/git.ts";
import { describeManifest, describeRun } from "../src/inspect.ts";
import { recordHumanDecision, requestAbort, resumeRun, runManifestFile } from "../src/runner.ts";
import { loadRunState } from "../src/store.ts";
import type { TripManifest } from "../src/types.ts";
import { validateManifest } from "../src/validation.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) usage();

if (command === "compile" || command === "plan") {
  const input = firstPositional(args);
  if (!input) usage();
  const out = valueAfter(args, "--out") ?? input.replace(/\.md$/i, ".prompt-chain.json");
  const mode = valueAfter(args, "--mode") as "auto" | "serial" | "parallel" | undefined;
  const workingDirectory = path.resolve(valueAfter(args, "--working-directory") ?? process.cwd());
  const pathPolicy = valueAfter(args, "--path-policy") as "permissive" | "strict" | undefined;
  const result = await compilePlanFile(path.resolve(input), { outputPath: path.resolve(out), workingDirectory, mode, pathPolicy });
  process.stdout.write(`${describeManifest(result.manifest)}\n\nOutput: ${result.outputPath}\n`);
} else if (command === "validate" || command === "inspect") {
  const input = firstPositional(args);
  if (!input) usage();
  const manifest = JSON.parse(await readFile(path.resolve(input), "utf8")) as TripManifest;
  const result = validateManifest(manifest);
  process.stdout.write(`${describeManifest(manifest)}\n\n${result.valid ? "VALID" : "INVALID"}\n`);
  for (const issue of result.issues) process.stdout.write(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}\n`);
  if (!result.valid) process.exitCode = 2;
} else if (command === "run") {
  const manifest = firstPositional(args);
  if (!manifest) usage();
  const state = await runManifestFile({
    manifestPath: path.resolve(manifest),
    humanDecisions: args.includes("--human-decisions"),
    onEvent: ({ type, message }) => { process.stderr.write(`[${type}] ${message}\n`); },
  });
  process.stdout.write(`${describeRun(state)}\n`);
  if (state.status !== "completed") process.exitCode = 2;
} else if (command === "resume") {
  const runId = firstPositional(args);
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  const state = await resumeRun({
    repositoryRoot: repository,
    runId,
    adoptCurrentHead: args.includes("--adopt-current-head"),
    onEvent: ({ type, message }) => { process.stderr.write(`[${type}] ${message}\n`); },
  });
  process.stdout.write(`${describeRun(state)}\n`);
  if (state.status !== "completed") process.exitCode = 2;
} else if (command === "status") {
  const runId = firstPositional(args);
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  process.stdout.write(`${describeRun(await loadRunState(repository, runId))}\n`);
} else if (command === "decide") {
  const [runId, choice, ...rationale] = args.filter((value) => !value.startsWith("--"));
  if (!runId || !choice) usage();
  const repository = await repositoryRoot(process.cwd());
  const state = await recordHumanDecision(repository, runId, choice, rationale.join(" ") || "Human decision supplied through prompt-chain.");
  process.stdout.write(`${describeRun(state)}\n`);
} else if (command === "abort") {
  const runId = firstPositional(args);
  if (!runId) usage();
  const repository = await repositoryRoot(process.cwd());
  process.stdout.write(`${describeRun(await requestAbort(repository, runId))}\n`);
} else usage();

function firstPositional(values: string[]): string | undefined {
  return values.find((value) => !value.startsWith("--") && !["auto", "serial", "parallel"].includes(value));
}
function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}
function usage(): never {
  process.stderr.write(`prompt-chain commands:\n  prompt-chain compile <plan.md> [--out manifest.json] [--mode auto|serial|parallel] [--working-directory <dir>] [--path-policy permissive|strict]\n  prompt-chain inspect <manifest.json>\n  prompt-chain validate <manifest.json>\n  prompt-chain run <manifest.json> [--human-decisions]\n  prompt-chain status <run-id>\n  prompt-chain resume <run-id> [--adopt-current-head]\n  prompt-chain decide <run-id> <choice> [rationale]\n  prompt-chain abort <run-id>\n`);
  process.exit(64);
}
