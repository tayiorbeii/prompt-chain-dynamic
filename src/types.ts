export type StageType = "review" | "implementation" | "integration";
export type StageIsolation = "readonly" | "same-checkout" | "worktree";
export type IntegrationStrategy = "same-checkout-finalize" | "worktree-fan-in";
export type DecisionMode = "agent" | "human";
export type ReviewStatus = "complete" | "continue" | "blocked" | "needs_decision";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Severity = "critical" | "major" | "minor" | "suggestion";
export type FindingDisposition = "open" | "resolved" | "accepted-risk" | "obsolete" | "follow-up-created";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export type StageStatus = "pending" | "running" | "paused" | "completed" | "failed" | "skipped";

export interface GeneratorMetadata {
  name: string;
  version: string;
}

export interface ManifestMetadata {
  generator?: GeneratorMetadata;
  sourceGuide?: string;
  generatedAt?: string;
  requestedMode?: "auto" | "serial" | "parallel";
  selectedTopology?: "readonly-only" | "same-checkout-serial" | "worktree-fanout";
  topologyReasons?: string[];
  authorWarnings?: string[];
  unresolvedSections?: string[];
  sourcePlanHash?: string;
  contractHash?: string;
  policyHashes?: Record<string, string>;
  pathPolicy?: "permissive" | "strict";
  runtime?: { engine: "pi-dynamic-workflows"; version: string };
}

export interface DecisionPolicy {
  mode?: DecisionMode;
  maxDecisionRounds?: number;
  requireBestEffortDecision?: boolean;
  prepareHumanRecommendation?: boolean;
}

export interface ReviewPolicy {
  required?: boolean;
  reviewerCount?: number;
  maxRepairRounds?: number;
  malformedVerdict?: "continue";
  requireFreshClosureReviewer?: boolean;
}

export interface TripSettings {
  maxParallel?: number;
  failFast?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  decisionPolicy?: DecisionPolicy;
  reviewPolicy?: ReviewPolicy;
  defaultValidationCommands?: string[];
  finalValidationCommands?: string[];
  sessionTimeoutMs?: number;
  commandTimeoutMs?: number;
  modelRouting?: {
    mainModel?: string;
    persistAgentSessions?: boolean;
    roleTiers?: Partial<Record<AgentRequest["role"], string>>;
    roleModels?: Partial<Record<AgentRequest["role"], string>>;
  };
}

export interface TripStage {
  id: string;
  type: StageType;
  needs: string[];
  isolation: StageIsolation;
  prompt: string;
  parallel?: boolean;
  required?: boolean;
  allowedPaths?: string[];
  claimedPaths?: string[];
  outputs?: string[];
  validationCommands?: string[];
  allowedTools?: string[];
  integrationStrategy?: IntegrationStrategy;
}

export interface TripManifest {
  schemaVersion: 1;
  name: string;
  workingDirectory: string;
  metadata?: ManifestMetadata;
  settings?: TripSettings;
  stages: TripStage[];
}

export interface Finding {
  id: string;
  runId: string;
  stageId: string;
  attempt: number;
  source: "worker" | "deterministic-validation" | "independent-review" | "integration-review" | "operator";
  severity: Severity;
  blocking: boolean;
  summary: string;
  evidence: string;
  suggestedRemediation?: string;
  affectedPaths: string[];
  disposition: FindingDisposition;
  createdAt: string;
  updatedAt: string;
  resolutionEvidence?: {
    repairAttempt?: number;
    changedPaths?: string[];
    validationArtifact?: string;
    reviewArtifact?: string;
    actor?: string;
    rationale?: string;
  };
}

export interface DecisionRequest {
  id: string;
  runId: string;
  stageId: string;
  findingIds: string[];
  question: string;
  options: Array<{ id: string; description: string }>;
  recommendation?: string;
  recommendationRationale?: string;
  constraints: string[];
  risk: RiskLevel;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  requestId: string;
  runId: string;
  stageId: string;
  actor: "agent" | "human";
  status: "decided" | "blocked";
  choice?: string;
  rationale: string;
  implementationDirection?: string;
  requiredVerification?: string[];
  assumptions?: string[];
  createdAt: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ReviewFinding {
  severity: Severity;
  blocking: boolean;
  summary: string;
  evidence: string;
  remediation?: string;
  affectedPaths: string[];
}

export interface NormalizedReview {
  status: ReviewStatus;
  risk: RiskLevel;
  rationale: string;
  missingItems: string[];
  recommendedFollowupPrompt?: string;
  findings: ReviewFinding[];
  raw: string;
  malformed: boolean;
}

export interface AgentRequest {
  runId: string;
  stageId: string;
  role: "research" | "implementation" | "repair" | "review" | "decision" | "integration";
  cwd: string;
  prompt: string;
  tools: string[];
  timeoutMs: number;
  artifactDirectory: string;
}

export interface AgentResult {
  success: boolean;
  text: string;
  sessionFile?: string;
  error?: string;
  durationMs: number;
}

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentResult>;
}

export interface StageRunState {
  id: string;
  status: StageStatus;
  attempts: number;
  reviewRounds: number;
  startedAt?: string;
  completedAt?: string;
  pauseReason?: string;
  worktreePath?: string;
  patchPath?: string;
  patchSha256?: string;
  cumulativePatchPath?: string;
  cumulativePatchSha256?: string;
  changedPaths: string[];
  lastAgentOutput?: string;
  validationResults: ValidationResult[];
}

export interface RunState {
  formatVersion: 1;
  id: string;
  manifestPath: string;
  manifest: TripManifest;
  status: RunStatus;
  baseRevision: string;
  decisionMode: DecisionMode;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pauseKind?: "review_blocked" | "decision_pending" | "blocked" | "workspace_drift";
  pauseReason?: string;
  abortRequested: boolean;
  stageStates: Record<string, StageRunState>;
  findings: Finding[];
  decisionRequests: DecisionRequest[];
  decisions: DecisionRecord[];
  resultCommit?: string;
}

export interface ManifestValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ManifestValidationResult {
  valid: boolean;
  topology?: "readonly-only" | "same-checkout-serial" | "worktree-fanout";
  issues: ManifestValidationIssue[];
  normalized?: TripManifest;
}

export type IssueStatus = "backlog" | "ready" | "executing" | "paused" | "completed" | "failed";
export type IssueEventType =
  | "issue.created"
  | "issue.ready"
  | "issue.claimed"
  | "issue.claim.expired"
  | "issue.execution.started"
  | "issue.completed"
  | "issue.paused"
  | "issue.failed";

export interface IssueEvent {
  version: 1;
  sequence: number;
  id: string;
  issueId: string;
  type: IssueEventType;
  timestamp: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface IssueProjection {
  id: string;
  title: string;
  manifestPath: string;
  priority: number;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
  claimExpiresAt?: string;
  runId?: string;
  lastMessage?: string;
}
