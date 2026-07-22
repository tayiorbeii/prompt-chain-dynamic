import type { AgentResult, FailureCategory } from "./types.ts";

const TRANSIENT_PATTERNS = [
  /network/i,
  /timeout/i,
  /connection\s+refused/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /\bsocket\b/i,
  /fetch\s+failed/i,
  /\bgateway\b/i,
  /\b503\b/,
  /service\s+unavailable/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
  /context\s+window/i,
  /context\s+length/i,
  /too\s+many\s+tokens/i,
  /compaction.needed/i,
  /maximum\s+context/i,
  /context_overflow/i,
  /context\s+too\s+long/i,
  /input\s+too\s+long/i,
];

const PROVIDER_QUOTA_PATTERNS = [
  /rate\s+limit/i,
  /quota\s+exceeded/i,
  /\b429\b/,
  /too\s+many\s+requests/i,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /provider.quota/i,
];

/**
 * Classifies a failure into one of the five FailureCategory values.
 *
 * Categories:
 * - transient: network, timeout, socket, gateway errors
 * - context-overflow: context window exceeded, compaction needed
 * - provider-quota: rate limits, 429s, quota exceeded
 * - structural: path contract violations, invariant breaches
 * - semantic: validation failures, review findings, logic errors (default)
 */
export function classifyFailure(error: unknown, result?: AgentResult): FailureCategory {
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    result?.error ?? "",
    result?.text ?? "",
  ].join("\n");

  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) return "transient";
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return "context-overflow";
  if (PROVIDER_QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "provider-quota";

  if (
    /outside\s+(its\s+)?allowed\s+path|path\s+contract|invariant|schema\s+mismatch|duplicate\s+stage|not\s+at\s+the\s+immutable/i.test(
      text,
    )
  ) {
    return "structural";
  }

  return "semantic";
}

/**
 * Returns true for infrastructure failures that should never consume the semantic repair budget:
 * transient, context-overflow, and provider-quota.
 */
export function isInfraFailure(category: FailureCategory): boolean {
  return category === "transient" || category === "context-overflow" || category === "provider-quota";
}
