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
