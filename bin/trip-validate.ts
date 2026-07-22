#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateManifest } from "../src/validation.ts";
import type { TripManifest } from "../src/types.ts";

const file = process.argv[2];
const jsonMode = process.argv.includes("--json");
if (!file) {
  process.stderr.write("usage: trip-validate <manifest.json> [--json]\n");
  process.exit(64);
}
const manifest = JSON.parse(await readFile(path.resolve(file), "utf8")) as TripManifest;
const result = validateManifest(manifest);
if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`${result.valid ? "VALID" : "INVALID"}\nTopology: ${result.topology ?? "invalid"}\nStages: ${manifest.stages?.length ?? 0}\n`);
  for (const issue of result.issues) process.stdout.write(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}\n`);
}
if (!result.valid) process.exitCode = 1;
