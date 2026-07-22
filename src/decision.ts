import { randomUUID } from "node:crypto";
import type { DecisionRecord, DecisionRequest, Finding, NormalizedReview, RiskLevel } from "./types.ts";

export function decisionRequestFromReview(
  review: NormalizedReview,
  context: { runId: string; stageId: string; findings: Finding[] },
): DecisionRequest {
  const question = tag(review.raw, "decisionQuestion")
    ?? review.recommendedFollowupPrompt
    ?? review.rationale
    ?? "Choose the safest in-scope implementation direction.";
  const options = parseOptions(review.raw);
  return {
    id: `decision-request-${randomUUID()}`,
    runId: context.runId,
    stageId: context.stageId,
    findingIds: context.findings.filter((finding) => finding.stageId === context.stageId && finding.disposition === "open").map((finding) => finding.id),
    question,
    options: options.length ? options : [
      { id: "best-in-scope-option", description: "Choose the smallest reversible option consistent with the approved plan and repository architecture." },
    ],
    recommendation: tag(review.raw, "recommendedOption"),
    recommendationRationale: tag(review.raw, "recommendationRationale"),
    constraints: tags(review.raw, "constraint").concat(tags(review.raw, "constraints")),
    risk: normalizeRisk(tag(review.raw, "risk")),
    createdAt: new Date().toISOString(),
  };
}

export function parseDecision(
  raw: string,
  request: DecisionRequest,
  actor: DecisionRecord["actor"],
): DecisionRecord | undefined {
  const status = tag(raw, "status")?.toLowerCase();
  if (status !== "decided" && status !== "blocked") return undefined;
  const rationale = tag(raw, "rationale") ?? raw.trim();
  if (!rationale) return undefined;
  return {
    id: `decision-${randomUUID()}`,
    requestId: request.id,
    runId: request.runId,
    stageId: request.stageId,
    actor,
    status,
    choice: tag(raw, "choice"),
    rationale,
    implementationDirection: tag(raw, "implementationDirection"),
    requiredVerification: tags(raw, "requiredVerification").flatMap(splitList),
    assumptions: tags(raw, "assumption").concat(splitList(tag(raw, "assumptions"))),
    createdAt: new Date().toISOString(),
  };
}

export function buildDecisionPrompt(request: DecisionRequest, context: string): string {
  return `You are the autonomous decision authority for a durable implementation run.

Make the best defensible decision possible. Do not defer merely because multiple reasonable options exist.

Priority order:
1. Satisfy the approved requirements and acceptance criteria.
2. Obey VISION.md, ARCHI.md, and repository instructions.
3. Stay inside the stage's allowed paths (its path contract).
4. Prefer the smallest reversible change.
5. Preserve backward compatibility and user-visible stability.
6. Follow existing repository patterns.
7. Avoid dependencies or architecture changes unless required.
8. Prefer lower operational and maintenance risk.

Path scope is not a reason to block. Editing any file that matches the stage's allowed paths is pre-approved and in scope — never classify it as "unapproved scope" or defer it to the host. Uncommitted changes already present in the working tree from earlier stages in the chain (schema, generated code, fixtures, helpers) are expected and are not your concern; never block because the tree contains related or pre-existing changes.

You may return blocked only when every available option violates a hard policy, requires writing outside the stage's allowed paths, or no safe reversible option exists.

Decision question:
${request.question}

Options:
${request.options.map((option) => `- ${option.id}: ${option.description}`).join("\n")}

Known recommendation:
${request.recommendation ?? "None"}
${request.recommendationRationale ?? ""}

Constraints:
${request.constraints.length ? request.constraints.map((value) => `- ${value}`).join("\n") : "- Remain inside the existing stage contract."}

Context:
${context}

Return exactly:
<decision>
  <status>decided|blocked</status>
  <choice>option id or concise direction</choice>
  <rationale>why this is the best defensible choice</rationale>
  <implementationDirection>specific direction for the implementation agent</implementationDirection>
  <requiredVerification>one verification item</requiredVerification>
  <assumptions>assumptions made</assumptions>
</decision>`;
}

function parseOptions(raw: string): Array<{ id: string; description: string }> {
  return tags(raw, "option").map((block, index) => ({
    id: block.match(/<id>([\s\S]*?)<\/id>/i)?.[1]?.trim() ?? `option-${index + 1}`,
    description: block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

function tag(raw: string, name: string): string | undefined {
  return raw.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]?.trim();
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

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\r?\n|;/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

function normalizeRisk(value: string | undefined): RiskLevel {
  const normalized = value?.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") return normalized;
  return "medium";
}
