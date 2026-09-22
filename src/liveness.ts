export interface ActivityWarning {
  elapsedMs: number;
  idleMs: number;
}

/** Observe silence without rejecting, cancelling, or replacing the operation. */
export function monitorActivity(
  warningAfterMs: number,
  onWarning: (warning: ActivityWarning) => void | Promise<void>,
): { activity: () => void; stop: () => void } {
  const startedAt = performance.now();
  let lastActivityAt = startedAt;
  let stopped = false;
  let notifying = false;
  let timer: NodeJS.Timeout | undefined;
  const warningsEnabled = Number.isFinite(warningAfterMs) && warningAfterMs > 0;

  function arm(delayMs = warningsEnabled ? warningAfterMs : 2 ** 31 - 1): void {
    if (stopped) return;
    // Keep waiting operations alive even with warnings disabled and no other handles.
    timer = setTimeout(() => {
      if (!warningsEnabled) { arm(); return; }
      const remaining = warningAfterMs - (performance.now() - lastActivityAt);
      if (remaining > 0) { arm(remaining); return; }
      arm();
      if (notifying) return;
      notifying = true;
      void Promise.resolve().then(() => {
        const now = performance.now();
        if (!stopped && now - lastActivityAt >= warningAfterMs) {
          return onWarning({ elapsedMs: now - startedAt, idleMs: now - lastActivityAt });
        }
      }).catch(() => {
        // Warning delivery is advisory, never an operation failure.
      }).finally(() => { notifying = false; });
    }, Math.min(Math.ceil(delayMs), 2 ** 31 - 1));
  }

  arm();
  return {
    activity() {
      if (stopped) return;
      lastActivityAt = performance.now();
      if (timer) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export class OperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Bound an operation without trusting a backend/library to enforce its own timeout. */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await operation;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        // Keep the process alive until the deadline: this timeout is the control
        // flow that lets a detached worker return to its reaper loop.
        timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A wedged lease write must never wedge execute()'s finally block. Returns false
 * on timeout; the detached reaper will reclaim the lease after it expires.
 */
export async function waitForHeartbeatStop(pending: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await withTimeout(Promise.resolve(pending), timeoutMs, "lease heartbeat shutdown");
    return true;
  } catch {
    return false;
  }
}
