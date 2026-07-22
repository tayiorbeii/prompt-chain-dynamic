import { createHash } from "node:crypto";
import type { AmendmentProposal, TripManifest, TripStage } from "./types.ts";

const HIGH_RISK_PATTERNS = [
  /migration/i,
  /\bschema\b/i,
  /\bauth\b/i,
  /\bapi\b/i,
  /\broutes?\b/i,
  /\bdatabase\b/i,
  /\bsecurity\b/i,
  /credentials/i,
  /package\.json$/,
  /tsconfig/,
  /lock(?:file|\.json|\.yaml)/i,
];

function isHighRiskPath(filePath: string): boolean {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Computes a deterministic SHA-256 hash of a stage's contract:
 * allowed paths, claimed paths, declared outputs, and validation commands.
 *
 * Sorted before hashing so field order does not affect the result.
 */
export function hashContract(stage: TripStage): string {
  const content = JSON.stringify({
    allowedPaths: [...(stage.allowedPaths ?? [])].sort(),
    claimedPaths: [...(stage.claimedPaths ?? [])].sort(),
    outputs: [...(stage.outputs ?? [])].sort(),
    validationCommands: [...(stage.validationCommands ?? [])].sort(),
  });
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Classifies the risk of amending a stage's contract from `currentStage.allowedPaths`
 * to `proposedAllowedPaths`.
 *
 * Returns "auto-approve" when new paths are additions within semantically safe territory
 * with no cross-stage overlap.
 *
 * Returns "human-required" when:
 * - Any proposed path is a high-risk file (migration, schema, auth, API, lockfile)
 * - Any genuinely new path overlaps with another stage's claimed or allowed paths
 */
export function classifyAmendmentRisk(
  currentStage: TripStage,
  proposedAllowedPaths: string[],
  manifest: TripManifest,
): "auto-approve" | "human-required" {
  const existingAllowed = new Set(currentStage.allowedPaths ?? []);

  // High-risk path check — any proposed high-risk path that isn't already in the contract
  for (const p of proposedAllowedPaths) {
    if (!existingAllowed.has(p) && isHighRiskPath(p)) return "human-required";
  }

  // Cross-stage overlap check for genuinely new paths
  const genuinelyNew = proposedAllowedPaths.filter((p) => !existingAllowed.has(p));
  if (genuinelyNew.length > 0) {
    const otherStagesPaths = new Set(
      manifest.stages
        .filter((s) => s.id !== currentStage.id)
        .flatMap((s) => [...(s.allowedPaths ?? []), ...(s.claimedPaths ?? [])]),
    );
    if (genuinelyNew.some((p) => otherStagesPaths.has(p))) return "human-required";
  }

  return "auto-approve";
}

/**
 * Builds an AmendmentProposal comparing the current stage contract to a proposed set
 * of allowed paths. Computes contract hashes and risk classification automatically.
 */
export function buildAmendmentProposal(
  currentStage: TripStage,
  proposedAllowedPaths: string[],
  manifest: TripManifest,
  reason: string,
): AmendmentProposal {
  const oldHash = hashContract(currentStage);
  const proposedStage: TripStage = { ...currentStage, allowedPaths: proposedAllowedPaths };
  const newHash = hashContract(proposedStage);
  const riskClass = classifyAmendmentRisk(currentStage, proposedAllowedPaths, manifest);
  return {
    oldContractHash: oldHash,
    newContractHash: newHash,
    revalidatedPaths: proposedAllowedPaths,
    revalidatedDeps: currentStage.needs ?? [],
    riskClass,
    reason,
  };
}
