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
 * 1. Fewer blocking findings wins.
 * 2. Tiebreak: fewer total findings wins.
 * 3. Tiebreak: fewer validation failures wins.
 * A tie means `a` is NOT better.
 */
export function isBetter(a: AttemptRecord, b: AttemptRecord): boolean {
  const aBlocking = a.reviewVerdict.findings.filter((f) => f.blocking).length;
  const bBlocking = b.reviewVerdict.findings.filter((f) => f.blocking).length;
  if (aBlocking !== bBlocking) return aBlocking < bBlocking;

  const aTotal = a.reviewVerdict.findings.length;
  const bTotal = b.reviewVerdict.findings.length;
  if (aTotal !== bTotal) return aTotal < bTotal;

  const aFailed = a.validationResults.filter((v) => v.exitCode !== 0).length;
  const bFailed = b.validationResults.filter((v) => v.exitCode !== 0).length;
  return aFailed < bFailed;
}
