import type { AgentBackend, RunState } from "./types.ts";
import { RunReaper } from "./reaper.ts";

export interface SupervisorOptions {
  repositoryRoot: string;
  runId: string;
  backend?: AgentBackend;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
  /** @deprecated Completion is no longer stopped by a fixed supervisor turn cap. */
  maxTurns?: number;
  /** @deprecated Semantic exhaustion now crosses a best-effort completion boundary. */
  maxConsecutiveFailures?: number;
  /** Polling interval between stale-lease checks in ms. */
  continuationIntervalMs?: number;
  /** @deprecated State is persisted at each durable transition and heartbeat. */
  persistIntervalMs?: number;
}

/**
 * Compatibility facade over the liveness reaper. Unlike the old supervisor it
 * does not stop after arbitrary turn/failure caps: it waits for a live worker,
 * reclaims stale generations, and continues until completed or aborted.
 */
export class Supervisor {
  private readonly reaper: RunReaper;

  constructor(options: SupervisorOptions) {
    this.reaper = new RunReaper({
      repositoryRoot: options.repositoryRoot,
      runId: options.runId,
      backend: options.backend,
      onEvent: options.onEvent,
      pollIntervalMs: options.continuationIntervalMs,
    });
  }

  async start(): Promise<RunState> {
    return await this.reaper.start();
  }

  stop(): void {
    this.reaper.stop();
  }
}
