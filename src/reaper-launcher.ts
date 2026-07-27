import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRoot } from "./store.ts";

/**
 * Launch redundant detached watchers that outlive the interactive Pi/CLI
 * worker. Two replicas matter: while one reaper owns a recovered worker call,
 * the other remains outside that process and can recover if it dies too.
 */
export function spawnRunReapers(repositoryRoot: string, runId: string, replicas = 2): number[] {
  if (process.env.PI_PROMPT_CHAIN_REAPER === "1") return [];
  const entrypoint = fileURLToPath(new URL("../bin/trip-reaper.ts", import.meta.url));
  const logFd = openSync(path.join(runRoot(repositoryRoot, runId), "reaper.log"), "a");
  const pids: number[] = [];
  try {
    for (let index = 0; index < replicas; index += 1) {
      const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, repositoryRoot, runId], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, PI_PROMPT_CHAIN_REAPER: "1", PI_PROMPT_CHAIN_REAPER_REPLICA: String(index + 1) },
      });
      child.once("error", () => {
        // The sibling reaper still provides recovery. Startup failures are also
        // visible in reaper.log when Node reached the child entrypoint.
      });
      if (child.pid !== undefined) pids.push(child.pid);
      child.unref();
    }
  } finally {
    closeSync(logFd);
  }
  return pids;
}
