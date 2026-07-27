#!/usr/bin/env -S node --experimental-strip-types
import path from "node:path";
import { RunReaper } from "../src/reaper.ts";

const [repositoryRoot, runId] = process.argv.slice(2);
if (!repositoryRoot || !runId) {
  process.stderr.write("usage: trip-reaper <repository-root> <run-id>\n");
  process.exit(64);
}

const reaper = new RunReaper({ repositoryRoot: path.resolve(repositoryRoot), runId });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => reaper.stop());
}

try {
  const state = await reaper.start();
  process.exitCode = state.status === "completed" || state.status === "aborted" ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
