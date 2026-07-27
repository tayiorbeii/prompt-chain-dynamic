import { createHash } from "node:crypto";
import type { AttemptRecord } from "./types.ts";

/**
 * Produces a deterministic hash of a single attempt's outcome.
 *
 * Two attempts with identical blocking findings, validation failures, diff hash,
 * and reviewer recommendation will produce the same fingerprint — indicating
 * the repair loop is not making progress.
 */
export function stagnationFingerprint(attempt: AttemptRecord): string {
  const blockingFindings = attempt.reviewVerdict.findings
    .filter((f) => f.blocking)
    .map((f) => f.summary)
    .sort()
    .join("|");

  const validationFailures = attempt.validationResults
    .filter((v) => v.exitCode !== 0)
    .map((v) => `${v.command}:${v.exitCode}`)
    .sort()
    .join("|");

  const content = [
    blockingFindings,
    validationFailures,
    attempt.diffHash,
    attempt.reviewVerdict.recommendedFollowupPrompt ?? "",
  ].join("\n");

  return createHash("sha256").update(content).digest("hex");
}

/**
 * Returns true when the last `windowSize` attempts all have the same fingerprint,
 * meaning the repair loop is stuck producing identical outcomes.
 */
export function isStagnant(attempts: AttemptRecord[], windowSize = 2): boolean {
  if (attempts.length < windowSize) return false;
  const recent = attempts.slice(-windowSize);
  const firstFingerprint = stagnationFingerprint(recent[0]!);
  return recent.every((a) => stagnationFingerprint(a) === firstFingerprint);
}

/**
 * Returns true when attempt `a` is strictly better than attempt `b`.
 *
 * Multi-dimensional comparison (priority order):
 * 1. Prefer attempts that reached stronger evidence boundaries (verified keep,
 *    validated review candidate, failed checks, worker-only discard, crash).
 * 2. Fewer blocking findings wins.
 * 3. Tiebreak: fewer total findings wins.
 * 4. Tiebreak: fewer validation failures/timeouts wins.
 * A tie means `a` is NOT better.
 */
export function isBetter(a: AttemptRecord, b: AttemptRecord): boolean {
  const aQuality = attemptQuality(a);
  const bQuality = attemptQuality(b);
  if (aQuality !== bQuality) return aQuality > bQuality;

  const aBlocking = a.reviewVerdict.findings.filter((f) => f.blocking).length;
  const bBlocking = b.reviewVerdict.findings.filter((f) => f.blocking).length;
  if (aBlocking !== bBlocking) return aBlocking < bBlocking;

  const aTotal = a.reviewVerdict.findings.length;
  const bTotal = b.reviewVerdict.findings.length;
  if (aTotal !== bTotal) return aTotal < bTotal;

  const aFailed = a.validationResults.filter((v) => v.exitCode !== 0 || v.timedOut).length;
  const bFailed = b.validationResults.filter((v) => v.exitCode !== 0 || v.timedOut).length;
  return aFailed < bFailed;
}

function attemptQuality(attempt: AttemptRecord): number {
  if (attempt.status === "keep") return 4;
  if (attempt.status === "discard"
    && (attempt.asi.source === "independent-review" || attempt.asi.source === "integration-review")
    && attempt.validationResults.every((result) => result.exitCode === 0 && !result.timedOut)) return 3;
  if (attempt.status === "checks_failed") return 2;
  if (attempt.status === "discard") return 1;
  return 0;
}
