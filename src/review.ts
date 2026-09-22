import { randomUUID } from "node:crypto";
import type {
  Finding,
  NormalizedReview,
  ReviewFinding,
  ReviewStatus,
  RiskLevel,
  Severity,
} from "./types.ts";

const STATUS_ORDER: Record<ReviewStatus, number> = {
  complete: 0,
  continue: 1,
  blocked: 2,
  needs_decision: 3,
};

export function normalizeReview(rawInput: string): NormalizedReview {
  const raw = rawInput.trim();
  const structured = parseStructuredJson(raw);
  const statusText = (structured?.status ?? firstTag(raw, "status"))?.toLowerCase().replaceAll("-", "_");
  const explicitStatus = normalizeStatus(statusText);
  const findings = structured?.findings?.map((finding) => ({
    severity: normalizeSeverity(finding.severity),
    blocking: finding.blocking ?? (finding.severity === "critical" || finding.severity === "major"),
    summary: finding.summary,
    evidence: finding.evidence,
    remediation: finding.remediation,
    affectedPaths: finding.affectedPaths ?? [],
  })) ?? extractFindings(raw);
  const freeformLooksActionable = looksLikeActionableFeedback(raw);
  // Dynamic-workflows structured output is authoritative: an explicit empty
  // findings array must not be overturned by prose heuristics (for example,
  // positive phrases such as "warnings but don't crash"). Retain the
  // contradiction guard only for legacy/unstructured reviewer responses.
  const contradictoryCompletionFeedback = structured === undefined
    && explicitStatus === "complete"
    && looksLikeContradictoryCompletionFeedback(raw);
  let status: ReviewStatus = explicitStatus ?? "continue";
  let malformed = explicitStatus === undefined;

  if (!findings.length && (malformed || contradictoryCompletionFeedback)) {
    findings.push(freeformFinding(raw || "Reviewer returned no machine-readable verdict."));
  }
  if (status === "complete" && findings.some((finding) => finding.blocking)) status = "continue";
  if (status === "complete" && contradictoryCompletionFeedback && !containsOnlyApprovalLanguage(raw)) status = "continue";
  if (malformed) status = "continue";

  return {
    status,
    risk: normalizeRisk(structured?.risk ?? firstTag(raw, "risk")),
    rationale: structured?.rationale ?? firstTag(raw, "rationale") ?? summarizeRaw(raw),
    missingItems: structured?.missingItems ?? tags(raw, "missingItem").concat(splitList(firstTag(raw, "missingItems"))),
    recommendedFollowupPrompt: structured?.recommendedFollowupPrompt ?? firstTag(raw, "recommendedFollowupPrompt") ?? firstTag(raw, "remediation"),
    findings,
    raw,
    malformed,
  };
}

export function synthesizeReviews(reviews: NormalizedReview[]): NormalizedReview {
  if (!reviews.length) return normalizeReview("<status>continue</status><rationale>No reviewers returned a result.</rationale>");
  const worst = reviews.reduce((current, review) => STATUS_ORDER[review.status] > STATUS_ORDER[current.status] ? review : current);
  return {
    status: worst.status,
    risk: reviews.reduce<RiskLevel>((current, review) => riskRank(review.risk) > riskRank(current) ? review.risk : current, "low"),
    rationale: reviews.map((review, index) => `Reviewer ${index + 1}: ${review.rationale}`).join("\n"),
    missingItems: [...new Set(reviews.flatMap((review) => review.missingItems))],
    recommendedFollowupPrompt: reviews.map((review) => review.recommendedFollowupPrompt).find(Boolean),
    findings: dedupeReviewFindings(reviews.flatMap((review) => review.findings)),
    raw: reviews.map((review) => review.raw).join("\n\n--- REVIEW ---\n\n"),
    malformed: reviews.some((review) => review.malformed),
  };
}

export function findingsFromReview(
  review: NormalizedReview,
  context: { runId: string; stageId: string; attempt: number; source: Finding["source"] },
): Finding[] {
  const now = new Date().toISOString();
  const sourceFindings = review.findings.length
    ? review.findings
    : review.status === "continue"
      ? [freeformFinding(review.rationale)]
      : [];
  return sourceFindings.map((entry) => ({
    id: `finding-${randomUUID()}`,
    runId: context.runId,
    stageId: context.stageId,
    attempt: context.attempt,
    source: context.source,
    severity: entry.severity,
    blocking: entry.blocking,
    summary: entry.summary,
    evidence: entry.evidence,
    suggestedRemediation: entry.remediation,
    affectedPaths: entry.affectedPaths,
    disposition: "open",
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * A worker's own verdict is direction for its next attempt, never evidence.
 * It cannot open a Finding; only reviewers and deterministic validation can.
 */
export function workerDirection(review: NormalizedReview): string {
  const missing = review.missingItems.map((item) => item.trim()).filter(Boolean);
  if (missing.length) return `Complete the items you reported as missing:\n${missing.map((item) => `- ${item}`).join("\n")}`;
  if (review.recommendedFollowupPrompt?.trim()) return review.recommendedFollowupPrompt.trim();
  return "Address every open blocking finding, then rerun validation and review.";
}

export function formatOpenFindings(findings: Finding[]): string {
  if (!findings.length) return "No open findings.";
  return findings.map((finding, index) => [
    `${index + 1}. [${finding.id}] ${finding.severity.toUpperCase()}: ${finding.summary}`,
    `   Evidence: ${finding.evidence}`,
    finding.suggestedRemediation ? `   Required remediation: ${finding.suggestedRemediation}` : undefined,
    finding.affectedPaths.length ? `   Paths: ${finding.affectedPaths.join(", ")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n");
}

export function markFindingsResolved(findings: Finding[], stageId: string, evidence: Finding["resolutionEvidence"]): void {
  const now = new Date().toISOString();
  for (const finding of findings) {
    if (finding.stageId === stageId && finding.disposition === "open") {
      finding.disposition = "resolved";
      finding.updatedAt = now;
      finding.resolutionEvidence = evidence;
    }
  }
}

/**
 * Reconcile a fresh review against the prior open findings for a stage.
 * Review prompts require the fresh reviewer to verify every open finding, so an
 * omitted finding is resolved rather than carried forever into later prompts.
 * Exact repeats retain their stable ID and receive the latest evidence.
 */
export function reconcileOpenFindings(
  findings: Finding[],
  stageId: string,
  current: Finding[],
  evidence: Finding["resolutionEvidence"],
): { additions: Finding[]; updated: Finding[] } {
  const now = new Date().toISOString();
  const prior = findings.filter((finding) => finding.stageId === stageId && finding.disposition === "open");
  const unmatched = [...current];
  const updated: Finding[] = [];

  for (const finding of prior) {
    const index = unmatched.findIndex((candidate) => candidate.summary.trim().toLowerCase() === finding.summary.trim().toLowerCase());
    if (index >= 0) {
      const latest = unmatched.splice(index, 1)[0]!;
      finding.attempt = latest.attempt;
      finding.source = latest.source;
      finding.severity = latest.severity;
      finding.blocking = latest.blocking;
      finding.evidence = latest.evidence;
      finding.suggestedRemediation = latest.suggestedRemediation;
      finding.affectedPaths = latest.affectedPaths;
      finding.updatedAt = now;
    } else {
      finding.disposition = "resolved";
      finding.updatedAt = now;
      finding.resolutionEvidence = evidence;
    }
    updated.push(finding);
  }

  return { additions: unmatched, updated };
}

export function openBlockingFindings(findings: Finding[], stageId?: string): Finding[] {
  return findings.filter((finding) => finding.disposition === "open" && finding.blocking && (!stageId || finding.stageId === stageId));
}

function parseStructuredJson(raw: string): {
  status?: string;
  risk?: string;
  rationale?: string;
  missingItems?: string[];
  recommendedFollowupPrompt?: string;
  findings?: Array<{
    severity?: string;
    blocking?: boolean;
    summary: string;
    evidence: string;
    remediation?: string;
    affectedPaths?: string[];
  }>;
} | undefined {
  const text = firstTag(raw, "structured-json");
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as ReturnType<typeof parseStructuredJson> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStatus(value: string | undefined): ReviewStatus | undefined {
  if (!value) return undefined;
  if (value === "needs_user_decision" || value === "needs_decision") return "needs_decision";
  if (value === "complete" || value === "continue" || value === "blocked") return value;
  if (value === "request_changes" || value === "requestchanges" || value === "implementation_partial") return "continue";
  if (value === "approved" || value === "implementation_complete") return "complete";
  if (value === "needs_rework") return "blocked";
  return undefined;
}

function extractFindings(raw: string): ReviewFinding[] {
  const blocks = tags(raw, "finding");
  return blocks.map((block) => {
    const severity = normalizeSeverity(firstTag(block, "severity"));
    const summary = firstTag(block, "summary") ?? firstSentence(block);
    const evidence = firstTag(block, "evidence") ?? block.trim();
    const remediation = firstTag(block, "remediation") ?? firstTag(block, "suggestedRemediation");
    const affectedPaths = tags(block, "path").concat(splitList(firstTag(block, "affectedPaths")));
    const blockingText = firstTag(block, "blocking")?.toLowerCase();
    const blocking = blockingText === "true" || severity === "critical" || severity === "major";
    return { severity, blocking, summary, evidence, remediation, affectedPaths };
  });
}

function freeformFinding(raw: string): ReviewFinding {
  return {
    severity: "major",
    blocking: true,
    summary: firstSentence(raw) || "Reviewer returned actionable feedback without a valid verdict.",
    evidence: raw || "Missing structured reviewer output.",
    remediation: extractFixClause(raw),
    affectedPaths: [],
  };
}

function looksLikeActionableFeedback(raw: string): boolean {
  if (!raw.trim()) return true;
  return /\b(fix|bug|issue|must|should|need to|fails?|incorrect|broken|regression|stop\s+the|do not|missing|reshuffl|los(?:e|ing) your place)\b/i.test(raw);
}

function looksLikeContradictoryCompletionFeedback(raw: string): boolean {
  return /\b(however|but|remaining|still needs?|not addressed|must (?:be )?fix(?:ed)?|should (?:be )?fix(?:ed)?|issue remains|regression remains|fails? to)\b/i.test(raw);
}

function containsOnlyApprovalLanguage(raw: string): boolean {
  const withoutTags = raw.replace(/<[^>]+>/g, " ").trim();
  return /^(approved|complete|looks good|no findings|all checks pass|implementation complete)[.!\s-]*$/i.test(withoutTags);
}

function extractFixClause(raw: string): string | undefined {
  const match = raw.match(/(?:^|\b)fix\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

function firstTag(raw: string, name: string): string | undefined {
  const match = raw.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match?.[1]?.trim();
}

function tags(raw: string, name: string): string[] {
  const expression = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "gi");
  const output: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(raw))) {
    const value = match[1]?.trim();
    if (value) output.push(value);
  }
  return output;
}

function normalizeRisk(value: string | undefined): RiskLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "medium";
}

function normalizeSeverity(value: string | undefined): Severity {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "critical" || normalized === "major" || normalized === "minor" || normalized === "suggestion") return normalized;
  return "major";
}

function riskRank(value: RiskLevel): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[value];
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\r?\n|;/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

function summarizeRaw(value: string): string {
  const compact = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return compact.slice(0, 500) || "No rationale was supplied.";
}

function firstSentence(value: string): string {
  const compact = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const match = compact.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? compact).slice(0, 240);
}

function dedupeReviewFindings(values: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const output: ReviewFinding[] = [];
  for (const value of values) {
    const key = `${value.severity}:${value.summary.toLowerCase()}:${value.affectedPaths.join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }
  return output;
}
