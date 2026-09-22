import {
  assertPathCovered,
  isConcretePath,
  isHighRiskPath,
  normalizeRepoPath,
  pathsMayOverlap,
  uniquePaths,
} from "./paths.ts";
import type {
  ManifestValidationIssue,
  ManifestValidationResult,
  TripManifest,
  TripSettings,
  TripStage,
} from "./types.ts";

const DEFAULT_SETTINGS: Required<Pick<TripSettings,
  "maxParallel" | "failFast" | "autoCommit" | "sessionTimeoutMs" | "commandTimeoutMs"
>> = {
  maxParallel: 4,
  failFast: false,
  autoCommit: true,
  // Legacy field names retained for compiled manifests; these only trigger idle warnings.
  sessionTimeoutMs: 30 * 60_000,
  commandTimeoutMs: 15 * 60_000,
};

export function normalizeManifest(input: TripManifest): TripManifest {
  const stages = input.stages.map(normalizeStage);
  const writerIsolation = new Set(stages.filter((stage) => stage.type === "implementation").map((stage) => stage.isolation));
  const integration = stages.find((stage) => stage.type === "integration");
  const inferredStrategy = writerIsolation.has("worktree") ? "worktree-fan-in" : "same-checkout-finalize";
  return {
    ...input,
    workingDirectory: input.workingDirectory.trim(),
    settings: {
      ...DEFAULT_SETTINGS,
      ...input.settings,
      decisionPolicy: {
        mode: "agent",
        maxDecisionRounds: 2,
        requireBestEffortDecision: true,
        prepareHumanRecommendation: true,
        ...input.settings?.decisionPolicy,
      },
      reviewPolicy: {
        required: true,
        reviewerCount: 2,
        maxRepairRounds: 4,
        malformedVerdict: "continue",
        requireFreshClosureReviewer: true,
        ...input.settings?.reviewPolicy,
      },
      continuationPolicy: {
        reaperEnabled: true,
        reaperPollIntervalMs: 5_000,
        heartbeatStopTimeoutMs: 5_000,
        // Fail closed by default: exhausted/unresolved review findings pause
        // the run instead of being silently accepted as "best effort", which
        // previously undermined the mandatory-closure guarantee. Set
        // `continuationPolicy.bestEffortCompletion: true` explicitly to opt
        // back into the old accept-and-follow-up behavior.
        bestEffortCompletion: false,
        maxWorkerReflections: 3,
        ...input.settings?.continuationPolicy,
      },
      defaultValidationCommands: input.settings?.defaultValidationCommands ?? [],
      finalValidationCommands: input.settings?.finalValidationCommands ?? [],
    },
    stages: stages.map((stage) => stage === integration && !stage.integrationStrategy
      ? { ...stage, integrationStrategy: inferredStrategy }
      : stage),
  };
}

export function validateManifest(input: TripManifest): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];
  let manifest: TripManifest;
  try {
    manifest = normalizeManifest(input);
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "$", message: errorMessage(error), severity: "error" }],
    };
  }

  if (manifest.schemaVersion !== 1) {
    issue(issues, "schemaVersion", "only schemaVersion 1 is supported");
  }
  if (!manifest.name.trim()) issue(issues, "name", "name is required");
  if (!manifest.workingDirectory || manifest.workingDirectory.includes("\0")) {
    issue(issues, "workingDirectory", "workingDirectory must be a non-empty absolute path or a portable path relative to the manifest file");
  }
  if (!manifest.stages.length) issue(issues, "stages", "at least one stage is required");

  const ids = new Set<string>();
  for (const [index, stage] of manifest.stages.entries()) {
    const base = `stages[${index}]`;
    if (!stage.id.trim()) issue(issues, `${base}.id`, "stage id is required");
    if (ids.has(stage.id)) issue(issues, `${base}.id`, `duplicate stage id: ${stage.id}`);
    ids.add(stage.id);
    validateStage(stage, base, issues);
  }

  for (const [index, stage] of manifest.stages.entries()) {
    for (const dependency of stage.needs) {
      if (!ids.has(dependency)) issue(issues, `stages[${index}].needs`, `unknown dependency: ${dependency}`);
      if (dependency === stage.id) issue(issues, `stages[${index}].needs`, "a stage cannot depend on itself");
    }
  }

  detectCycle(manifest.stages, issues);
  const topology = classifyTopology(manifest.stages, issues);
  validateIntegration(manifest.stages, topology, issues);
  validateWorktreeClaims(manifest.stages, issues);
  validateSameCheckoutOrder(manifest.stages, topology, issues);

  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    topology,
    issues,
    normalized: manifest,
  };
}

export function assertValidManifest(input: TripManifest): TripManifest {
  const result = validateManifest(input);
  if (!result.valid || !result.normalized) {
    const detail = result.issues.map((entry) => `${entry.severity.toUpperCase()} ${entry.path}: ${entry.message}`).join("\n");
    throw new Error(`invalid Prompt-chain hybrid manifest:\n${detail}`);
  }
  return result.normalized;
}

function normalizeStage(stage: TripStage): TripStage {
  return {
    ...stage,
    needs: [...new Set(stage.needs ?? [])],
    required: stage.required ?? true,
    parallel: stage.parallel ?? stage.isolation === "worktree",
    allowedPaths: uniquePaths(stage.allowedPaths ?? []),
    claimedPaths: uniquePaths(stage.claimedPaths ?? []),
    outputs: uniquePaths(stage.outputs ?? []),
    validationCommands: [...new Set(stage.validationCommands ?? [])],
    allowedTools: [...new Set(stage.allowedTools ?? defaultTools(stage))],
  };
}

function defaultTools(stage: TripStage): string[] {
  return stage.isolation === "readonly"
    ? ["read", "grep", "find", "ls"]
    : ["read", "grep", "find", "ls", "bash", "edit", "write"];
}

function validateStage(stage: TripStage, base: string, issues: ManifestValidationIssue[]): void {
  if (!stage.prompt.trim()) issue(issues, `${base}.prompt`, "prompt is required");
  if (stage.type === "review" && stage.isolation !== "readonly") {
    issue(issues, `${base}.isolation`, "review stages must use readonly isolation");
  }
  if (stage.type === "implementation" && stage.isolation === "readonly") {
    issue(issues, `${base}.isolation`, "implementation stages must be writable");
  }
  if (stage.type === "integration" && stage.isolation !== "same-checkout") {
    issue(issues, `${base}.isolation`, "integration stages run in the main checkout");
  }
  if (stage.type === "implementation") {
    if (!stage.allowedPaths?.length) issue(issues, `${base}.allowedPaths`, "writer stages require non-empty allowedPaths");
    if (!stage.claimedPaths?.length) issue(issues, `${base}.claimedPaths`, "writer stages require concrete claimedPaths");
  }
  for (const [index, claim] of (stage.claimedPaths ?? []).entries()) {
    if (!isConcretePath(claim)) issue(issues, `${base}.claimedPaths[${index}]`, "claimed paths must be concrete");
    if (!assertPathCovered(claim, stage.allowedPaths ?? [])) {
      issue(issues, `${base}.claimedPaths[${index}]`, `claim is not covered by allowedPaths: ${claim}`);
    }
  }
  for (const [index, output] of (stage.outputs ?? []).entries()) {
    if (!assertPathCovered(output, stage.allowedPaths ?? [])) {
      issue(issues, `${base}.outputs[${index}]`, `output is not covered by allowedPaths: ${output}`);
    }
  }
  for (const [index, pattern] of (stage.allowedPaths ?? []).entries()) {
    try {
      normalizeRepoPath(pattern);
    } catch (error) {
      issue(issues, `${base}.allowedPaths[${index}]`, errorMessage(error));
    }
    if (pattern === "**/*" || pattern === "**") {
      issue(issues, `${base}.allowedPaths[${index}]`, "broad repository-wide write access requires manual review", "warning");
    }
  }
  if ((stage.claimedPaths ?? []).some(isHighRiskPath) && stage.isolation === "worktree") {
    issue(issues, `${base}.claimedPaths`, "high-risk shared files must be serialized in same-checkout mode");
  }
}

function classifyTopology(stages: TripStage[], issues: ManifestValidationIssue[]): ManifestValidationResult["topology"] {
  const writers = stages.filter((stage) => stage.type === "implementation");
  if (!writers.length) return "readonly-only";
  const isolation = new Set(writers.map((stage) => stage.isolation));
  if (isolation.size > 1) {
    issue(issues, "stages", "mixed same-checkout/worktree writer graphs are not supported");
    return undefined;
  }
  return isolation.has("worktree") ? "worktree-fanout" : "same-checkout-serial";
}

function validateIntegration(
  stages: TripStage[],
  topology: ManifestValidationResult["topology"],
  issues: ManifestValidationIssue[],
): void {
  const writers = stages.filter((stage) => stage.type === "implementation");
  const integrations = stages.filter((stage) => stage.type === "integration");
  if (!writers.length && integrations.length) {
    issue(issues, "stages", "an integration stage without writer stages is unnecessary", "warning");
  }
  if (writers.length && integrations.length !== 1) {
    issue(issues, "stages", "writer graphs require exactly one integration stage");
    return;
  }
  const integration = integrations[0];
  if (!integration) return;
  const expected = topology === "worktree-fanout" ? "worktree-fan-in" : "same-checkout-finalize";
  if (integration.integrationStrategy !== expected) {
    issue(issues, "stages", `integrationStrategy must be ${expected} for topology ${topology}`);
  }
  const descendants = findDescendants(integration.id, stages);
  if ([...descendants].some((id) => stages.find((stage) => stage.id === id)?.type === "implementation")) {
    issue(issues, "stages", "writer stages may not occur after integration");
  }
  for (const writer of writers) {
    if (!isAncestor(writer.id, integration.id, stages)) {
      issue(issues, `stages.${integration.id}.needs`, `integration must transitively depend on writer ${writer.id}`);
    }
  }
  if (topology === "worktree-fanout") {
    for (const writer of writers) {
      const writerAncestors = findAncestors(writer.id, stages);
      if ([...writerAncestors].some((id) => stages.find((stage) => stage.id === id)?.type === "implementation")) {
        issue(issues, `stages.${writer.id}.needs`, "dependent worktree writer waves are not supported");
      }
    }
  }
}

function validateWorktreeClaims(stages: TripStage[], issues: ManifestValidationIssue[]): void {
  const writers = stages.filter((stage) => stage.type === "implementation" && stage.isolation === "worktree");
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      const a = writers[left];
      const b = writers[right];
      if (!a || !b) continue;
      for (const claimA of a.claimedPaths ?? []) {
        for (const claimB of b.claimedPaths ?? []) {
          if (pathsMayOverlap(claimA, claimB)) {
            issue(issues, "stages", `worktree claims overlap: ${a.id}:${claimA} and ${b.id}:${claimB}`);
          }
        }
      }
    }
  }
}

function validateSameCheckoutOrder(
  stages: TripStage[],
  topology: ManifestValidationResult["topology"],
  issues: ManifestValidationIssue[],
): void {
  if (topology !== "same-checkout-serial") return;
  const writers = stages.filter((stage) => stage.type === "implementation");
  for (let index = 1; index < writers.length; index += 1) {
    const previous = writers[index - 1];
    const current = writers[index];
    if (previous && current && !isAncestor(previous.id, current.id, stages)) {
      issue(issues, `stages.${current.id}.needs`, `same-checkout writers must be linearly ordered; ${current.id} must depend on ${previous.id}`);
    }
  }
}

function detectCycle(stages: TripStage[], issues: ManifestValidationIssue[]): void {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.needs ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const stage of stages) {
    if (visit(stage.id)) {
      issue(issues, "stages", `dependency cycle detected at ${stage.id}`);
      return;
    }
  }
}

function findAncestors(id: string, stages: TripStage[]): Set<string> {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const output = new Set<string>();
  const walk = (current: string): void => {
    for (const dependency of byId.get(current)?.needs ?? []) {
      if (!output.has(dependency)) {
        output.add(dependency);
        walk(dependency);
      }
    }
  };
  walk(id);
  return output;
}

function findDescendants(id: string, stages: TripStage[]): Set<string> {
  const output = new Set<string>();
  const walk = (current: string): void => {
    for (const stage of stages) {
      if (stage.needs.includes(current) && !output.has(stage.id)) {
        output.add(stage.id);
        walk(stage.id);
      }
    }
  };
  walk(id);
  return output;
}

function isAncestor(ancestor: string, descendant: string, stages: TripStage[]): boolean {
  return findAncestors(descendant, stages).has(ancestor);
}

function issue(
  issues: ManifestValidationIssue[],
  pathValue: string,
  message: string,
  severity: ManifestValidationIssue["severity"] = "error",
): void {
  issues.push({ path: pathValue, message, severity });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
