#!/usr/bin/env -S node --experimental-strip-types
import { compilePlanFile } from "../src/compiler.ts";

const args = process.argv.slice(2);
const plan = args.shift();
if (!plan) {
  process.stderr.write("usage: trip-compile <plan.md> [--out file.json] [--working-directory dir] [--mode auto|serial|parallel] [--allow-unresolved] [--waves]\n");
  process.exit(64);
}
let output: string | undefined;
let workingDirectory: string | undefined;
let mode: "auto" | "serial" | "parallel" = "auto";
let allowUnresolved = false;
let waves = false;
while (args.length) {
  const token = args.shift();
  if (token === "--waves") waves = true;
  else if (token === "--out") output = args.shift();
  else if (token === "--working-directory") workingDirectory = args.shift();
  else if (token === "--mode") {
    const value = args.shift();
    if (value !== "auto" && value !== "serial" && value !== "parallel") throw new Error(`invalid mode: ${value}`);
    mode = value;
  } else if (token === "--allow-unresolved") allowUnresolved = true;
  else throw new Error(`unknown argument: ${token}`);
}
const result = await compilePlanFile(plan, { outputPath: output, workingDirectory, mode, allowUnresolved, waves });
if (!output) process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
else process.stdout.write(`Wrote ${result.outputPath}\nTopology: ${result.manifest.metadata?.selectedTopology}\nStages: ${result.manifest.stages.length}\n`);
for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
