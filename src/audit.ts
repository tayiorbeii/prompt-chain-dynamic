import { access } from "node:fs/promises";
import path from "node:path";
import type { AttemptRecord, RunState } from "./types.ts";
import { runRoot } from "./store.ts";

export interface CriterionAudit {
  criterion: string;
  stageId: string;
  passed: boolean;
  validationArtifact?: string;
  reviewArtifact?: string;
  resolvedFindings: number;
  commitHash?: string;
  reason?: string;
}

export interface AuditResult {
  passed: boolean;
  criteria: CriterionAudit[];
  /** Criteria that could not be mapped to a validation artifact. */
  unmapped: string[];
}

function extractAcceptanceCriteria(prompt: string): string[] {
  const match = prompt.match(/\*\*Acceptance Criteria\*\*:([\s\S]*?)(?=\*\*|$)/);
  if (!match?.[1]) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

function resolvedAttemptCount(stageState: { attempts: unknown }): number {
  if (Array.isArray(stageState.attempts)) {
    return (stageState.attempts as AttemptRecord[]).length;
  }
  return typeof stageState.attempts === "number" ? stageState.attempts : 0;
}

/**
 * Maps each acceptance criterion from the manifest to its validation artifact,
 * review artifact, resolved findings, and commit hash.
 *
 * Returns passed=false and populates `unmapped` for any criterion that has no
 * validation artifact (the stage never reached a passing validation).
 */
export async function auditCompletion(repositoryRoot: string, state: RunState): Promise<AuditResult> {
  const criteria: CriterionAudit[] = [];
  const unmapped: string[] = [];

  for (const stage of state.manifest.stages) {
    const stageState = state.stageStates[stage.id];
    if (!stageState) continue;

    const stageCriteria = extractAcceptanceCriteria(stage.prompt);
    if (!stageCriteria.length) continue;

    const attemptCount = resolvedAttemptCount(stageState);
    const artifactBase =
      attemptCount > 0
        ? path.join(runRoot(repositoryRoot, state.id), "stages", stage.id, `attempt-${attemptCount}`)
        : null;

    const validationArtifactPath = artifactBase ? path.join(artifactBase, "validation.json") : null;
    const reviewArtifactPath = artifactBase ? path.join(artifactBase, "review-synthesis.json") : null;

    const hasValidation = validationArtifactPath ? await fileExists(validationArtifactPath) : false;
    const hasReview = reviewArtifactPath ? await fileExists(reviewArtifactPath) : false;
    const resolvedFindings = state.findings.filter(
      (f) => f.stageId === stage.id && f.disposition === "resolved",
    ).length;

    for (const criterion of stageCriteria) {
      const passed = stageState.status === "completed" && hasValidation;
      const audit: CriterionAudit = {
        criterion,
        stageId: stage.id,
        passed,
        resolvedFindings,
        commitHash: stageState.verifiedCommit ?? state.resultCommit,
        reason: !hasValidation ? "no validation artifact" : !passed ? "stage not completed" : undefined,
      };
      if (hasValidation && validationArtifactPath) audit.validationArtifact = validationArtifactPath;
      if (hasReview && reviewArtifactPath) audit.reviewArtifact = reviewArtifactPath;
      criteria.push(audit);
      if (!hasValidation) unmapped.push(`${stage.id}: ${criterion}`);
    }
  }

  return {
    passed: unmapped.length === 0 && criteria.length > 0 && criteria.every((c) => c.passed),
    criteria,
    unmapped,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
