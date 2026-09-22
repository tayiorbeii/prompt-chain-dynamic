export type StageType = "review" | "implementation" | "integration";
export type StageIsolation = "readonly" | "same-checkout" | "worktree";
/**
 * "worktree-wave-checkpoint" is a deterministic stage between waves: it folds
 * one wave's verified worktree patches into a checkpoint ref that the next
 * wave's worktrees branch from. It never commits to the branch.
 */
export type IntegrationStrategy = "same-checkout-finalize" | "worktree-fan-in" | "worktree-wave-checkpoint";
export type ManifestTopology = "readonly-only" | "same-checkout-serial" | "worktree-fanout" | "mixed";
export type DecisionMode = "agent" | "human";
export type ReviewStatus = "complete" | "continue" | "blocked" | "needs_decision";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Severity = "critical" | "major" | "minor" | "suggestion";
export type FindingDisposition = "open" | "resolved" | "accepted-risk" | "obsolete" | "follow-up-created";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export type StageStatus = "pending" | "running" | "paused" | "completed" | "failed" | "skipped";

/** The reason a stage cannot be scheduled or was skipped by the scheduler. */
export type StageSchedulingReason =
  | { kind: "waiting_on_active_stage" }
  | { kind: "waiting_on_failed_dependency"; dependencyId: string }
  | { kind: "decision_pending" }
  | { kind: "stale_worker_reclaimed" }
  | { kind: "invariant_violation" };

export type FailureCategory = "transient" | "context-overflow" | "provider-quota" | "semantic" | "structural";

export interface RunLease {
  owner: string;
  generation: number;
  heartbeatAt: string;
  leaseTimeoutMs: number;
}

export interface AttemptRecord {
  attempt: number;
  role: string;
  commitHash?: string;
  validationResults: ValidationResult[];
  reviewVerdict: NormalizedReview;
  diffHash: string;
  /** Durable candidate patch captured at this attempt boundary. */
  patchPath?: string;
  patchSha256?: string;
  asi: Record<string, unknown>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  startedAt: string;
  completedAt?: string;
  /** Hash of the stage contract in effect for this attempt, when contract tracking is enabled. */
  contractHash?: string;
}

export interface AmendmentProposal {
  oldContractHash: string;
  newContractHash: string;
  revalidatedPaths: string[];
  revalidatedDeps: string[];
  riskClass: "auto-approve" | "human-required";
  reason: string;
}

export interface ContinuationPolicy {
  mode?: "supervised";
  transientRetries?: number;
  contextOverflowCompactionRetries?: number;
  providerLimitAutoResumeMs?: number;
  continuationRetryMs?: number;
  runtimePersistIntervalMs?: number;
  stagnationRounds?: number;
  maxResearchEscalations?: number;
  autoResumeTurnLimit?: number;
  consecutiveFailureOverride?: number;
  leaseTimeoutMs?: number;
  /** Inactivity warning interval for backend calls; never cancels. Defaults to sessionTimeoutMs. */
  agentCallTimeoutMs?: number;
  /** Inactivity warning interval for decision calls; never cancels or selects a fallback. */
  decisionTimeoutMs?: number;
  /** Maximum time shutdown waits for an in-flight lease renewal. */
  heartbeatStopTimeoutMs?: number;
  /** Poll interval used by the detached stale-lease reaper. */
  reaperPollIntervalMs?: number;
  /** Disable only when an external scheduler provides equivalent stale-lease recovery. */
  reaperEnabled?: boolean;
  /** Accept the best safe attempt and create follow-up notes instead of pausing on exhaustion. Defaults to false (fail closed): exhaustion pauses the run for operator review. Set true to opt into the legacy accept-and-follow-up behavior. */
  bestEffortCompletion?: boolean;
  /** Automatically open bounded remediation windows before recording unresolved work as follow-ups. Defaults to 1. */
  automaticFollowUpPasses?: number;
  /** Attempts allowed in each automatic remediation window. Defaults to 5. */
  automaticFollowUpAttemptLimit?: number;
  /** Consecutive worker-only `continue` returns tolerated before the next return is forced through validation and review. Defaults to 3. */
  maxWorkerReflections?: number;
  checkpointVerifiedStages?: boolean;
  onRequiredExhaustion?: "research";
  onOptionalExhaustion?: "checkpoint-and-follow-up";
  /** @deprecated Use continuationRetryMs. */
  retryIntervalMs?: number;
  /** @deprecated Use autoResumeTurnLimit. */
  maxTurns?: number;
  /** @deprecated Use consecutiveFailureOverride. */
  maxConsecutiveFailures?: number;
  /** @deprecated Use runtimePersistIntervalMs. */
  persistIntervalMs?: number;
}

export interface ResearchPolicy {
  github?: boolean;
  sandboxedChild?: boolean;
  timeoutMs?: number;
  stdoutCapBytes?: number;
  requireCitations?: boolean;
  requireAdaptationPlan?: boolean;
  injectAs?: "steerMessage";
  /** @deprecated Research is configured by the presence of this policy. */
  enabled?: boolean;
  /** @deprecated Use maxResearchEscalations in continuationPolicy. */
  maxRounds?: number;
  /** @deprecated Use the runtime research integration instead. */
  hookCommand?: string;
}

export interface GeneratorMetadata {
  name: string;
  version: string;
}

export interface ManifestMetadata {
  generator?: GeneratorMetadata;
  sourceGuide?: string;
  generatedAt?: string;
  requestedMode?: "auto" | "serial" | "parallel";
  selectedTopology?: ManifestTopology;
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
  /** Legacy name: agent inactivity warning interval (default 30 minutes); 0 disables warnings. */
  sessionTimeoutMs?: number;
  /** Legacy name: validation inactivity warning interval (default 15 minutes); 0 disables warnings. */
  commandTimeoutMs?: number;
  modelRouting?: {
    mainModel?: string;
    persistAgentSessions?: boolean;
    roleTiers?: Partial<Record<AgentRequest["role"], string>>;
    roleModels?: Partial<Record<AgentRequest["role"], string>>;
  };
  checkpointStrategy?: "keep" | "squash";
  continuationPolicy?: ContinuationPolicy;
  researchPolicy?: ResearchPolicy;
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
  /** Id of the wave checkpoint stage whose verified commit is this stage's worktree base; unset means the run base revision. */
  baseFrom?: string;
  /** Dependency wave index assigned by the compiler in waves mode (1-based). */
  wave?: number;
  /** Why the compiler serialized this stage instead of isolating it in a worktree. */
  schedulingNotes?: string[];
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
  /** Who produced the evidence. Worker self-reports are direction, never findings. */
  source: "deterministic-validation" | "independent-review" | "integration-review" | "operator";
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
  /** Identifies agentic, human, or policy-driven decisions. */
  source?: "agent" | "human" | "auto";
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
  /** Runtime passes 0: no backend wall-clock deadline. */
  timeoutMs: number;
  /** Report observed agent/tool activity, not an unconditional heartbeat. */
  onActivity?: () => void;
  artifactDirectory: string;
  /**
   * Distinguishes persisted agent sessions beyond stage and role. Fresh closure
   * reviewers set it per attempt and reviewer index so no reviewer inherits a
   * transcript from an earlier verdict.
   */
  sessionScope?: string;
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
  /** Recovery-aware attempt history. */
  attempts: AttemptRecord[];
  reviewRounds: number;
  /** Consecutive worker `continue` returns that were not completion claims; reset by any claim. */
  workerReflections?: number;
  schedulingReason?: StageSchedulingReason;
  blockedBy?: string[];
  contractHash?: string;
  verifiedCommit?: string;
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
  /** How this stage crossed its durable completion boundary. */
  completionMode?: "verified" | "best-effort";
  /** The final cumulative attempt retained at the stage boundary. Kept for state-format compatibility. */
  bestAttempt?: number;
  /** Durable Markdown note containing work deferred after best-effort completion. */
  followUpArtifact?: string;
}

export interface RunState {
  formatVersion: 1;
  id: string;
  manifestPath: string;
  manifest: TripManifest;
  status: RunStatus;
  baseRevision: string;
  /** Immutable states of paths that were already dirty when the run began. */
  workspaceBaseline?: Record<string, string>;
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
  lease?: RunLease;
  /** Autonomous follow-up runs spawned from this run's deferred findings. */
  followUpRunIds?: string[];
}

export interface ManifestValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ManifestValidationResult {
  valid: boolean;
  topology?: ManifestTopology;
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
