import { spawn } from "node:child_process";

export interface ResearchHookOutput {
  success: boolean;
  steerMessage?: string;
  citations?: string[];
  adaptationPlan?: string;
  error?: string;
}

/** Maximum stdout bytes captured from the hook (8 KB). */
const MAX_STDOUT_BYTES = 8 * 1024;

/**
 * Spawns a sandboxed child process with a JSON-in stdout-out contract.
 *
 * - Times out after `timeoutMs` milliseconds (default 30s).
 * - Caps captured stdout at 8 KB; kills the child if exceeded.
 * - Returns structured output parsed from JSON stdout.
 * - Non-JSON stdout is treated as a plain steer message.
 * - Pattern-matched from the pi-autoresearch before.sh hook.
 */
export async function spawnResearchHook(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<ResearchHookOutput> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve({ success: false, error: "empty command" });
      return;
    }
    // Execute via a login shell so the hook author can use full shell syntax,
    // quoting, and PATH expansions — same pattern as runValidationCommands.
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2_000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        overflowed = true;
        stdout = stdout.slice(0, MAX_STDOUT_BYTES);
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, error: "research hook timed out" });
        return;
      }
      if (overflowed) {
        resolve({ success: false, error: "research hook stdout exceeded 8 KB cap" });
        return;
      }
      if (code !== 0) {
        resolve({ success: false, error: `hook exited ${code}: ${stderr.trim()}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as Partial<ResearchHookOutput>;
        resolve({
          success: true,
          steerMessage: parsed.steerMessage,
          citations: parsed.citations,
          adaptationPlan: parsed.adaptationPlan,
        });
      } catch {
        // Non-JSON stdout — treat the whole output as a steer message
        resolve({ success: true, steerMessage: stdout.trim() });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}
