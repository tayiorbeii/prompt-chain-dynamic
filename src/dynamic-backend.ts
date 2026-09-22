import { WorkflowAgent } from "@quintinshaw/pi-dynamic-workflows";

interface AgentUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; }
import { Type } from "typebox";
import type { AgentBackend, AgentRequest, AgentResult, ReviewStatus, RiskLevel, Severity } from "./types.ts";

const findingSchema = Type.Object({
  severity: Type.Union([
    Type.Literal("critical"), Type.Literal("major"), Type.Literal("minor"), Type.Literal("suggestion"),
  ]),
  blocking: Type.Boolean(),
  summary: Type.String(),
  evidence: Type.String(),
  remediation: Type.Optional(Type.String()),
  affectedPaths: Type.Array(Type.String()),
});

const stageResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("complete"), Type.Literal("continue"), Type.Literal("blocked"), Type.Literal("needs_decision"),
  ]),
  risk: Type.Optional(Type.Union([
    Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical"),
  ])),
  rationale: Type.String(),
  summary: Type.Optional(Type.String()),
  missingItems: Type.Optional(Type.Array(Type.String())),
  recommendedFollowupPrompt: Type.Optional(Type.String()),
  findings: Type.Optional(Type.Array(findingSchema)),
  decisionQuestion: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), description: Type.String() }))),
  recommendedOption: Type.Optional(Type.String()),
  recommendationRationale: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.Array(Type.String())),
});


const decisionResultSchema = Type.Object({
  status: Type.Union([Type.Literal("decided"), Type.Literal("blocked")]),
  choice: Type.Optional(Type.String()),
  rationale: Type.String(),
  implementationDirection: Type.Optional(Type.String()),
  requiredVerification: Type.Optional(Type.Array(Type.String())),
  assumptions: Type.Optional(Type.Array(Type.String())),
});

export interface DynamicWorkflowBackendOptions {
  mainModel?: string;
  persistAgentSessions?: boolean;
  instructions?: string;
  roleTiers?: Partial<Record<AgentRequest["role"], string>>;
  roleModels?: Partial<Record<AgentRequest["role"], string>>;
  onUsage?: (request: AgentRequest, usage: AgentUsage) => void;
}

/**
 * Executes prompt-chain stages with pi-dynamic-workflows' WorkflowAgent while
 * leaving scheduling, path authorization, Git state, findings and promotion to
 * the prompt-chain transaction runtime.
 */
export class DynamicWorkflowBackend implements AgentBackend {
  readonly #agent: WorkflowAgent;
  readonly #options: DynamicWorkflowBackendOptions;

  constructor(options: DynamicWorkflowBackendOptions = {}) {
    this.#options = options;
    this.#agent = new WorkflowAgent({
      cwd: process.cwd(),
      mainModel: options.mainModel,
      persistAgentSessions: options.persistAgentSessions ?? true,
      instructions: [
        "You are executing one bounded stage from a frozen prompt-chain manifest.",
        "The host runtime—not you—owns scheduling, Git commits, path enforcement, finding closure, and promotion.",
        "Never commit, merge, tag, push, alter Git configuration, or broaden the approved path contract.",
        "Use the structured_output tool exactly once as your final response.",
        options.instructions ?? "",
      ].filter(Boolean).join("\n"),
    });
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    try {
      const common = {
        cwd: request.cwd,
        label: `${request.stageId}:${request.role}`,
        sessionName: `prompt-chain:${request.runId} ${request.stageId}:${request.role}${request.sessionScope ? ` ${request.sessionScope}` : ""}`,
        tier: this.#options.roleTiers?.[request.role] ?? defaultTier(request.role),
        model: this.#options.roleModels?.[request.role],
        toolNames: request.tools,
        onHistory: () => request.onActivity?.(),
        onUsageProgress: () => request.onActivity?.(),
        onUsage: (usage: AgentUsage) => this.#options.onUsage?.(request, usage),
      };
      const text = request.role === "decision"
        ? toDecisionXml(await this.#agent.run(request.prompt, { ...common, schema: decisionResultSchema }))
        : toLegacyCompatibleReview(await this.#agent.run(request.prompt, { ...common, schema: stageResultSchema }));
      return {
        success: true,
        text,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        text: "",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }
}

function defaultTier(role: AgentRequest["role"]): string {
  if (role === "decision" || role === "integration") return "big";
  if (role === "review") return "medium";
  if (role === "research") return "small";
  return "medium";
}

function toLegacyCompatibleReview(value: {
  status: ReviewStatus;
  risk?: RiskLevel;
  rationale: string;
  summary?: string;
  missingItems?: string[];
  recommendedFollowupPrompt?: string;
  findings?: Array<{
    severity: Severity;
    blocking: boolean;
    summary: string;
    evidence: string;
    remediation?: string;
    affectedPaths: string[];
  }>;
  decisionQuestion?: string;
  options?: Array<{ id: string; description: string }>;
  recommendedOption?: string;
  recommendationRationale?: string;
  constraints?: string[];
}): string {
  const findings = value.findings ?? [];
  const payload = {
    ...value,
    risk: value.risk ?? "low",
    missingItems: value.missingItems ?? [],
    findings,
  };
  return [
    `<status>${value.status}</status>`,
    `<risk>${payload.risk}</risk>`,
    `<rationale>${escapeXml(value.rationale)}</rationale>`,
    value.recommendedFollowupPrompt ? `<recommendedFollowupPrompt>${escapeXml(value.recommendedFollowupPrompt)}</recommendedFollowupPrompt>` : "",
    value.decisionQuestion ? `<decisionQuestion>${escapeXml(value.decisionQuestion)}</decisionQuestion>` : "",
    value.recommendedOption ? `<recommendedOption>${escapeXml(value.recommendedOption)}</recommendedOption>` : "",
    `<structured-json>${JSON.stringify(payload)}</structured-json>`,
  ].filter(Boolean).join("\n");
}

function toDecisionXml(value: {
  status: "decided" | "blocked";
  choice?: string;
  rationale: string;
  implementationDirection?: string;
  requiredVerification?: string[];
  assumptions?: string[];
}): string {
  return [
    "<decision>",
    `<status>${value.status}</status>`,
    value.choice ? `<choice>${escapeXml(value.choice)}</choice>` : "",
    `<rationale>${escapeXml(value.rationale)}</rationale>`,
    value.implementationDirection ? `<implementationDirection>${escapeXml(value.implementationDirection)}</implementationDirection>` : "",
    ...(value.requiredVerification ?? []).map((item) => `<requiredVerification>${escapeXml(item)}</requiredVerification>`),
    ...(value.assumptions ?? []).map((item) => `<assumption>${escapeXml(item)}</assumption>`),
    "</decision>",
  ].filter(Boolean).join("\n");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
