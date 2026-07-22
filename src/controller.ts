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
import { Supervisor } from "./supervisor.ts";
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
  let run = await runManifestFile({
    manifestPath,
    humanDecisions: options.humanDecisions,
    backend: options.backend,
    onEvent: async ({ message }) => await options.onEvent?.(`${issue.id}: ${message}`),
  });
  // If the run is not yet terminal, hand it to the supervisor to resume until done
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "aborted") {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TripManifest;
    const repository = await repositoryRoot(manifest.workingDirectory);
    const supervisor = new Supervisor({
      repositoryRoot: repository,
      runId: run.id,
      backend: options.backend,
      onEvent: async ({ message }) => await options.onEvent?.(`${issue.id}: ${message}`),
    });
    run = await supervisor.start();
  }
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
      message: run.pauseReason ?? `Run ${run.status}`,
    },
  });
  return { issue, run, message: `${issue.id} finished with run status ${run.status}.` };
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
  let run = await resumeRun({
    repositoryRoot: repository,
    runId: issue.runId,
    backend: options.backend,
    onEvent: async ({ message }) => await options.onEvent?.(`${issue.id}: ${message}`),
  });
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "aborted") {
    const supervisor = new Supervisor({
      repositoryRoot: repository,
      runId: run.id,
      backend: options.backend,
      onEvent: async ({ message }) => await options.onEvent?.(`${issue.id}: ${message}`),
    });
    run = await supervisor.start();
  }
  const type = run.status === "completed" ? "issue.completed" : run.status === "paused" ? "issue.paused" : "issue.failed";
  await appendIssueEvent(eventFile, {
    issueId: issue.id,
    type,
    idempotencyKey: `resume-result:${issue.id}:${run.id}:${run.updatedAt}:${run.status}`,
    payload: {
      runId: run.id,
      status: run.status,
      resultCommit: run.resultCommit,
      message: run.pauseReason ?? `Run ${run.status}`,
    },
  });
  return { issue, run, message: `${issue.id} resumed with run status ${run.status}.` };
}
