import { appendRunEvent, leaseIsFresh, loadRunState } from "./store.ts";
import { resumeRun } from "./runner.ts";
import type { AgentBackend, RunState } from "./types.ts";

export interface RunReaperOptions {
  repositoryRoot: string;
  runId: string;
  backend?: AgentBackend;
  pollIntervalMs?: number;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
}

/**
 * Out-of-worker lease reaper. It waits while a live generation is renewing,
 * atomically reclaims an expired generation, and keeps recovering until the run
 * reaches completed/aborted. Failed and autonomously paused runs are retryable.
 */
export class RunReaper {
  private stopped = false;
  private readonly options: RunReaperOptions;

  constructor(options: RunReaperOptions) {
    this.options = options;
  }

  async start(): Promise<RunState> {
    const { repositoryRoot, runId, backend, onEvent } = this.options;
    let failures = 0;

    while (!this.stopped) {
      let state = await loadRunState(repositoryRoot, runId);
      if (state.status === "completed" || state.status === "aborted") return state;

      const configuredPoll = state.manifest.settings?.continuationPolicy?.reaperPollIntervalMs;
      const pollIntervalMs = this.options.pollIntervalMs ?? configuredPoll ?? 5_000;
      if (state.status === "running" && leaseIsFresh(state)) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (state.status === "paused" && (
        state.pauseKind === "workspace_drift"
        || state.pauseKind === "review_blocked"
        || state.pauseKind === "checkpoint_blocked"
        || state.manifest.settings?.continuationPolicy?.bestEffortCompletion === false
      )) {
        // Workspace cleanup and missing release evidence require operator action.
        // Do not repeatedly resume a stage that cannot make safe autonomous progress.
        return state;
      }
      try {
        const staleGeneration = state.lease?.generation;
        await appendRunEvent(repositoryRoot, runId, {
          type: "reaper.recovery.requested",
          priorStatus: state.status,
          staleGeneration,
        });
        state = await resumeRun({
          repositoryRoot,
          runId,
          leaseGeneration: staleGeneration,
          externalReaper: false,
          backend,
          onEvent,
        });
        failures = 0;
        if (state.status === "completed" || state.status === "aborted") return state;
        if (state.status === "failed" && (state.pauseKind === "workspace_drift" || state.pauseKind === "blocked")) return state;
      } catch (error) {
        failures += 1;
        await bestEffortEvent(repositoryRoot, runId, {
          type: "reaper.recovery.failed",
          error: errorMessage(error),
          failures,
        });
      }

      const backoff = Math.min(pollIntervalMs * 2 ** Math.min(failures, 4), 30_000);
      await sleep(backoff);
    }

    return await loadRunState(repositoryRoot, runId);
  }

  stop(): void {
    this.stopped = true;
  }
}

async function bestEffortEvent(repositoryRoot: string, runId: string, event: Record<string, unknown>): Promise<void> {
  try {
    await appendRunEvent(repositoryRoot, runId, event);
  } catch {
    // A state/event filesystem outage is retried by the outer polling loop.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
