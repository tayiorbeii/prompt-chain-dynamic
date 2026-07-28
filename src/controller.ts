import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, IssueProjection, RunState } from "./types.ts";
import {
  appendIssueEvent,
  expireStaleClaims,
  projectIssues,
  readIssueEvents,
  selectNextReadyIssue,
} from "./issues.ts";
import { resumeRun, runManifestFile } from "./runner.ts";
import { runFollowUpRounds, superviseToTerminal } from "./followups.ts";
import { repositoryRoot } from "./git.ts";
import type { TripManifest } from "./types.ts";

export interface ProcessIssueOptions {
  eventFile: string;
  humanDecisions?: boolean;
  leaseMs?: number;
  backend?: AgentBackend;
  onEvent?: (message: string) => void | Promise<void>;
}

export interface ProcessIssueResult {
  issue?: IssueProjection;
  run?: RunState;
  message: string;
}

export async function processNextIssue(options: ProcessIssueOptions): Promise<ProcessIssueResult> {
  const eventFile = path.resolve(options.eventFile);
  await expireStaleClaims(eventFile);
  const issues = projectIssues(await readIssueEvents(eventFile));
  const issue = selectNextReadyIssue(issues.values());
  if (!issue) return { message: "No ready issue is available." };

  const claimToken = randomUUID();
  const expiresAt = new Date(Date.now() + (options.leaseMs ?? 6 * 60 * 60_000)).toISOString();
  await appendIssueEvent(eventFile, {
    issueId: issue.id,
    type: "issue.claimed",
    idempotencyKey: `claim:${issue.id}:${claimToken}`,
    payload: { claimToken, expiresAt },
  });
  await appendIssueEvent(eventFile, {
    issueId: issue.id,
    type: "issue.execution.started",
    idempotencyKey: `execution-started:${issue.id}:${claimToken}`,
    payload: { message: `Launching ${issue.manifestPath}` },
  });

  const manifestPath = path.isAbsolute(issue.manifestPath)
    ? issue.manifestPath
    : path.resolve(path.dirname(eventFile), issue.manifestPath);
  await options.onEvent?.(`Claimed ${issue.id}: ${issue.title}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TripManifest;
  const repository = await repositoryRoot(manifest.workingDirectory);
  const forward = async ({ message }: { message: string }): Promise<void> => await options.onEvent?.(`${issue.id}: ${message}`);
  let run = await runManifestFile({
    manifestPath,
    humanDecisions: options.humanDecisions,
    backend: options.backend,
    onEvent: forward,
  });
  // If the run is not yet terminal, hand it to the supervisor to resume until done.
  run = await superviseToTerminal(repository, run, options.backend, forward);
  // A completed issue is only done once its deferred follow-ups are executed too.
  const followUpSummary = run.status === "completed"
    ? await executeIssueFollowUps(repository, run, options.backend, options.humanDecisions, forward)
    : "";
  const terminalType = run.status === "completed"
    ? "issue.completed"
    : run.status === "paused"
      ? "issue.paused"
      : "issue.failed";
  await appendIssueEvent(eventFile, {
    issueId: issue.id,
    type: terminalType,
    idempotencyKey: `run-result:${issue.id}:${run.id}:${run.status}`,
    payload: {
      runId: run.id,
      status: run.status,
      resultCommit: run.resultCommit,
      message: `${run.pauseReason ?? `Run ${run.status}`}${followUpSummary}`,
    },
  });
  return { issue, run, message: `${issue.id} finished with run status ${run.status}.${followUpSummary}` };
}

async function executeIssueFollowUps(
  repository: string,
  run: RunState,
  backend: AgentBackend | undefined,
  humanDecisions: boolean | undefined,
  onEvent: (event: { message: string }) => Promise<void>,
): Promise<string> {
  const report = await runFollowUpRounds({
    repositoryRoot: repository,
    state: run,
    backend,
    humanDecisions,
    onEvent: async ({ message }) => await onEvent({ message }),
  });
  if (!report.runs.length && !report.remainingItems) return "";
  const rounds = report.runs.map((entry) => `${entry.runId}:${entry.status}`).join(", ");
  return ` Follow-ups: ${report.runs.length} round(s)${rounds ? ` (${rounds})` : ""}, ${report.remainingItems} deferred item(s) remaining.`;
}

export async function createIssue(
  eventFileInput: string,
  input: { title: string; manifestPath: string; priority?: number; ready?: boolean; issueId?: string },
): Promise<IssueProjection> {
  const eventFile = path.resolve(eventFileInput);
  const issueId = input.issueId ?? `issue-${randomUUID().slice(0, 8)}`;
  await appendIssueEvent(eventFile, {
    issueId,
    type: "issue.created",
    idempotencyKey: `issue-created:${issueId}`,
    payload: { title: input.title, manifestPath: input.manifestPath, priority: input.priority ?? 0 },
  });
  if (input.ready !== false) {
    await appendIssueEvent(eventFile, {
      issueId,
      type: "issue.ready",
      idempotencyKey: `issue-ready:${issueId}:initial`,
      payload: { message: "Ready for Prompt-chain hybrid execution" },
    });
  }
  const issue = projectIssues(await readIssueEvents(eventFile)).get(issueId);
  if (!issue) throw new Error(`failed to project newly created issue ${issueId}`);
  return issue;
}


export async function resumeIssue(
  eventFileInput: string,
  issueId: string,
  options: { backend?: AgentBackend; onEvent?: (message: string) => void | Promise<void> } = {},
): Promise<ProcessIssueResult> {
  const eventFile = path.resolve(eventFileInput);
  const issue = projectIssues(await readIssueEvents(eventFile)).get(issueId);
  if (!issue) throw new Error(`unknown issue: ${issueId}`);
  if (!issue.runId) throw new Error(`issue ${issueId} has no recorded run id`);
  if (issue.status !== "paused" && issue.status !== "failed") {
    throw new Error(`issue ${issueId} is ${issue.status}, not paused or failed`);
  }
  const manifestPath = path.isAbsolute(issue.manifestPath)
    ? issue.manifestPath
    : path.resolve(path.dirname(eventFile), issue.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TripManifest;
  const repository = await repositoryRoot(manifest.workingDirectory);
  const forward = async ({ message }: { message: string }): Promise<void> => await options.onEvent?.(`${issue.id}: ${message}`);
  let run = await resumeRun({
    repositoryRoot: repository,
    runId: issue.runId,
    backend: options.backend,
    onEvent: forward,
  });
  run = await superviseToTerminal(repository, run, options.backend, forward);
  const followUpSummary = run.status === "completed"
    ? await executeIssueFollowUps(repository, run, options.backend, undefined, forward)
    : "";
  const type = run.status === "completed" ? "issue.completed" : run.status === "paused" ? "issue.paused" : "issue.failed";
  await appendIssueEvent(eventFile, {
    issueId: issue.id,
    type,
    idempotencyKey: `resume-result:${issue.id}:${run.id}:${run.updatedAt}:${run.status}`,
    payload: {
      runId: run.id,
      status: run.status,
      resultCommit: run.resultCommit,
      message: `${run.pauseReason ?? `Run ${run.status}`}${followUpSummary}`,
    },
  });
  return { issue, run, message: `${issue.id} resumed with run status ${run.status}.${followUpSummary}` };
}
