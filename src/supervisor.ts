import type { AgentBackend, RunState } from "./types.ts";
import { loadRunState, writeRunState } from "./store.ts";
import { resumeRun } from "./runner.ts";
import { classifyFailure, isInfraFailure } from "./failure-classifier.ts";

export interface SupervisorOptions {
  repositoryRoot: string;
  runId: string;
  backend?: AgentBackend;
  onEvent?: (event: { type: string; message: string; stageId?: string }) => void | Promise<void>;
  /** Hard cap on total resume turns (default 30). */
  maxTurns?: number;
  /** Hard cap on consecutive non-infra failures before the supervisor stops (default 5). */
  maxConsecutiveFailures?: number;
  /** Polling interval between resume attempts in ms (default 50). */
  continuationIntervalMs?: number;
  /** Run-state persist interval in ms (default 60 000). */
  persistIntervalMs?: number;
}

/**
 * Persistent run supervisor.
 *
 * Owns the run lease via generation tokens. Polls with a short continuation interval.
 * Uses classifyFailure to decide retry strategy per failure category so that infra
 * failures (transient, context-overflow, provider-quota) never consume the semantic
 * repair budget. Enforces a total turn limit and a consecutive non-infra failure limit
 * as hard stops.
 */
export class Supervisor {
  private readonly options: SupervisorOptions;
  private stopped = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  async start(): Promise<RunState> {
    const { repositoryRoot, runId, backend, onEvent } = this.options;
    const maxTurns = this.options.maxTurns ?? 30;
    const maxConsecutiveFailures = this.options.maxConsecutiveFailures ?? 5;
    const intervalMs = this.options.continuationIntervalMs ?? 50;
    const persistIntervalMs = this.options.persistIntervalMs ?? 60_000;

    let state = await loadRunState(repositoryRoot, runId);
    let consecutiveFailures = 0;
    let turns = 0;
    let lastPersistAt = Date.now();
    const categoryFailures: Record<string, number> = {};

    while (!this.stopped && turns < maxTurns && consecutiveFailures < maxConsecutiveFailures) {
      const { status } = state;
      if (status === "completed" || status === "failed" || status === "aborted") break;

      turns++;
      const leaseGeneration = state.lease?.generation;

      try {
        state = await resumeRun({
          repositoryRoot,
          runId,
          leaseGeneration,
          backend,
          onEvent,
        });

        if (state.status === "completed" || state.status === "failed" || state.status === "aborted") break;

        // Paused but not terminal — reset consecutive failure counter
        consecutiveFailures = 0;
        if (Date.now() - lastPersistAt >= persistIntervalMs) {
          await writeRunState(repositoryRoot, state);
          lastPersistAt = Date.now();
        }
        await sleep(intervalMs);
      } catch (error: unknown) {
        const category = classifyFailure(error);
        categoryFailures[category] = (categoryFailures[category] ?? 0) + 1;

        if (isInfraFailure(category)) {
          // Exponential back-off for infra failures; does not consume semantic repair budget
          const attempts = categoryFailures[category] ?? 1;
          const backoff = Math.min(1_000 * 2 ** Math.min(attempts - 1, 6), 30_000);
          await sleep(backoff);
        } else {
          consecutiveFailures++;
        }

        // Reload state after failure so lease generation is current
        try {
          state = await loadRunState(repositoryRoot, runId);
        } catch {
          /* keep current state if reload fails */
        }
        await sleep(intervalMs);
      }
    }

    return state;
  }

  /** Signal the supervisor to stop after the current resume attempt finishes. */
  stop(): void {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
