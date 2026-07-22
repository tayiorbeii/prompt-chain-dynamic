import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compilePlanFile } from "./compiler.ts";
import { describeManifest } from "./inspect.ts";
import { createIssue, processNextIssue, resumeIssue } from "./controller.ts";
import { projectIssues, readIssueEvents } from "./issues.ts";
import { repositoryRoot } from "./git.ts";
import { recordHumanDecision, requestAbort, resumeRun, runManifestFile } from "./runner.ts";
import { Supervisor } from "./supervisor.ts";
import { auditCompletion } from "./audit.ts";
import { loadRunState } from "./store.ts";
import { validateManifest } from "./validation.ts";
import type { TripManifest } from "./types.ts";

export default function durableTripExtension(pi: ExtensionAPI): void {
  if (process.env.PI_DURABLE_TRIP_WORKER === "1") return;

  pi.registerCommand("prompt-chain-validate", {
    description: "Validate and describe a Prompt-chain hybrid DAG manifest",
    handler: async (args, ctx) => {
      const file = path.resolve(ctx.cwd, args.trim());
      if (!args.trim()) return ctx.ui.notify("Usage: /prompt-chain-validate <manifest.json>", "warning");
      try {
        const manifest = JSON.parse(await readFile(file, "utf8")) as TripManifest;
        const result = validateManifest(manifest);
        const details = result.issues.map((issue) => `${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`).join("\n");
        ctx.ui.notify(
          `${result.valid ? "Valid" : "Invalid"} Prompt-chain hybrid manifest\nTopology: ${result.topology ?? "invalid"}\nStages: ${manifest.stages?.length ?? 0}${details ? `\n${details}` : ""}`,
          result.valid ? "info" : "error",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-compile", {
    description: "Compile an approved Markdown implementation plan into a validated DAG",
    handler: async (args, ctx) => {
      const parsed = parseCompileArgs(args);
      if (!parsed.plan) return ctx.ui.notify("Usage: /prompt-chain-compile <plan.md> [--out file.json] [--mode auto|serial|parallel]", "warning");
      try {
        const result = await compilePlanFile(path.resolve(ctx.cwd, parsed.plan), {
          outputPath: parsed.output ? path.resolve(ctx.cwd, parsed.output) : undefined,
          workingDirectory: parsed.workingDirectory ? path.resolve(ctx.cwd, parsed.workingDirectory) : ctx.cwd,
          mode: parsed.mode,
        });
        ctx.ui.notify(`Compiled ${result.manifest.name}\nTopology: ${result.manifest.metadata?.selectedTopology}\nStages: ${result.manifest.stages.length}\nOutput: ${result.outputPath ?? "not written"}`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-inspect", {
    description: "Render a prompt-chain manifest as an execution graph and path-claim summary",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("Usage: /prompt-chain-inspect <manifest.json>", "warning");
      try {
        const manifest = JSON.parse(await readFile(path.resolve(ctx.cwd, args.trim()), "utf8")) as TripManifest;
        ctx.ui.notify(describeManifest(manifest), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-run", {
    description: "Run a validated Prompt-chain hybrid manifest",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const manifestPath = tokens[0];
      if (!manifestPath) return ctx.ui.notify("Usage: /prompt-chain-run <manifest.json> [--human-decisions]", "warning");
      ctx.ui.setStatus("prompt-chain-hybrid", "Starting Prompt-chain hybrid run…");
      try {
        const state = await runManifestFile({
          manifestPath: path.resolve(ctx.cwd, manifestPath),
          humanDecisions,
          onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
        });
        ctx.ui.setStatus("prompt-chain-hybrid", `${state.id}: ${state.status}`);
        ctx.ui.notify(formatRunSummary(state), state.status === "completed" ? "info" : state.status === "paused" ? "warning" : "error");
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid", "Run failed");
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-status", {
    description: "Show Prompt-chain hybrid run status",
    handler: async (args, ctx) => {
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const runId = args.trim() || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("No Prompt-chain hybrid runs were found in this repository.", "warning");
        const state = await loadRunState(repository, runId);
        ctx.ui.notify(formatRunSummary(state), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-resume", {
    description: "Resume a paused or interrupted Prompt-chain hybrid run",
    handler: async (args, ctx) => {
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const runId = args.trim() || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("Usage: /prompt-chain-resume <run-id>", "warning");
        const state = await resumeRun({
          repositoryRoot: repository,
          runId,
          onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
        });
        ctx.ui.notify(formatRunSummary(state), state.status === "completed" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-decide", {
    description: "Record a human decision for a run started with --human-decisions",
    handler: async (args, ctx) => {
      const [runId, rest] = splitFirst(args.trim());
      if (!runId || !rest) return ctx.ui.notify("Usage: /prompt-chain-decide <run-id> <choice> [:: rationale]", "warning");
      const [choice, rationale] = rest.split("::", 2).map((value) => value.trim());
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const state = await recordHumanDecision(repository, runId, choice ?? rest, rationale || "Human selected this direction through /trip-decide.");
        ctx.ui.notify(`Decision recorded for ${runId}. Run /prompt-chain-resume ${runId} to continue.\n${formatRunSummary(state)}`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-abort", {
    description: "Request abort at the next durable boundary",
    handler: async (args, ctx) => {
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const runId = args.trim() || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("Usage: /prompt-chain-abort <run-id>", "warning");
        await requestAbort(repository, runId);
        ctx.ui.notify(`Abort requested for ${runId}. It will be observed at the next durable boundary.`, "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  pi.registerCommand("prompt-chain-issue-add", {
    description: "Add a ready issue to the local Prompt-chain hybrid JSONL backlog",
    handler: async (args, ctx) => {
      const [eventFile, remainder] = splitFirst(args.trim());
      const [title, manifestPath, priorityText] = (remainder ?? "").split("::").map((value) => value.trim());
      if (!eventFile || !title || !manifestPath) return ctx.ui.notify("Usage: /prompt-chain-issue-add <issues.jsonl> <title> :: <manifest.json> :: <priority>", "warning");
      try {
        const issue = await createIssue(path.resolve(ctx.cwd, eventFile), {
          title,
          manifestPath,
          priority: Number(priorityText || 0),
        });
        ctx.ui.notify(`Created ${issue.id}: ${issue.title} (${issue.status}, priority ${issue.priority})`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-issues", {
    description: "List projected issues from the local Prompt-chain hybrid JSONL backlog",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("Usage: /prompt-chain-issues <issues.jsonl>", "warning");
      try {
        const issues = [...projectIssues(await readIssueEvents(path.resolve(ctx.cwd, args.trim()))).values()]
          .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
        ctx.ui.notify(issues.length ? issues.map((issue) => `${issue.status.padEnd(9)} P${issue.priority} ${issue.id} — ${issue.title}${issue.runId ? ` (${issue.runId})` : ""}`).join("\n") : "No issues.", "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-loop-resume", {
    description: "Resume a paused local issue run and update its event projection",
    handler: async (args, ctx) => {
      const [eventFile, issueId] = splitFirst(args.trim());
      if (!eventFile || !issueId) return ctx.ui.notify("Usage: /prompt-chain-loop-resume <issues.jsonl> <issue-id>", "warning");
      try {
        const result = await resumeIssue(path.resolve(ctx.cwd, eventFile), issueId, {
          onEvent: (message) => ctx.ui.setStatus("prompt-chain-hybrid-loop", message.slice(0, 100)),
        });
        ctx.ui.notify(result.message, result.run?.status === "completed" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-supervise", {
    description: "Run a Prompt-chain hybrid manifest under continuous supervisor until terminal state",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const manifestPath = tokens[0];
      if (!manifestPath) return ctx.ui.notify("Usage: /prompt-chain-supervise <manifest.json> [--human-decisions]", "warning");
      ctx.ui.setStatus("prompt-chain-hybrid", "Starting supervised Prompt-chain run…");
      try {
        const initial = await runManifestFile({
          manifestPath: path.resolve(ctx.cwd, manifestPath),
          humanDecisions,
          onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
        });
        let state = initial;
        if (state.status !== "completed" && state.status !== "failed" && state.status !== "aborted") {
          // Derive the repository root from the manifest's workingDirectory, not ctx.cwd,
          // so the supervisor loads state from the correct .pi directory.
          const repository = await repositoryRoot(state.manifest.workingDirectory);
          const supervisor = new Supervisor({
            repositoryRoot: repository,
            runId: state.id,
            onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
          });
          state = await supervisor.start();
        }
        ctx.ui.setStatus("prompt-chain-hybrid", `${state.id}: ${state.status}`);
        ctx.ui.notify(formatRunSummary(state), state.status === "completed" ? "info" : state.status === "paused" ? "warning" : "error");
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid", "Supervised run failed");
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-audit", {
    description: "Audit a completed Prompt-chain hybrid run: map each acceptance criterion to its artifacts",
    handler: async (args, ctx) => {
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const runId = args.trim() || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("Usage: /prompt-chain-audit <run-id>", "warning");
        const state = await loadRunState(repository, runId);
        const result = await auditCompletion(repository, state);
        const lines = [
          `Audit: ${result.passed ? "PASS" : "FAIL"} (${result.criteria.filter((c) => c.passed).length}/${result.criteria.length} criteria passed)`,
          "",
          ...result.criteria.map((c) => `${c.passed ? "✓" : "✗"} [${c.stageId}] ${c.criterion}${c.reason ? ` — ${c.reason}` : ""}`),
          ...(result.unmapped.length ? ["", `Unmapped (${result.unmapped.length}):`, ...result.unmapped.map((u) => `  · ${u}`)] : []),
        ];
        ctx.ui.notify(lines.join("\n"), result.passed ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-loop-once", {
    description: "Claim and execute the highest-priority ready local issue",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const eventFile = tokens[0];
      if (!eventFile) return ctx.ui.notify("Usage: /prompt-chain-loop-once <issues.jsonl> [--human-decisions]", "warning");
      try {
        const result = await processNextIssue({
          eventFile: path.resolve(ctx.cwd, eventFile),
          humanDecisions,
          onEvent: (message) => ctx.ui.setStatus("prompt-chain-hybrid-loop", message.slice(0, 100)),
        });
        ctx.ui.setStatus("prompt-chain-hybrid-loop", result.run ? `${result.issue?.id}: ${result.run.status}` : "idle");
        ctx.ui.notify(result.message, result.run?.status === "completed" ? "info" : result.run ? "warning" : "info");
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid-loop", "failed");
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

}

function parseCompileArgs(args: string): {
  plan?: string;
  output?: string;
  workingDirectory?: string;
  mode?: "auto" | "serial" | "parallel";
} {
  const tokens = shellWords(args);
  const result: { plan?: string; output?: string; workingDirectory?: string; mode?: "auto" | "serial" | "parallel" } = {};
  result.plan = tokens.shift();
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "--out") result.output = tokens.shift();
    else if (token === "--working-directory") result.workingDirectory = tokens.shift();
    else if (token === "--mode") {
      const mode = tokens.shift();
      if (mode === "auto" || mode === "serial" || mode === "parallel") result.mode = mode;
    }
  }
  return result;
}

function shellWords(value: string): string[] {
  const output: string[] = [];
  const expression = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value))) output.push(match[1] ?? match[2] ?? match[3] ?? "");
  return output;
}

function removeFlag(tokens: string[], flag: string): boolean {
  const index = tokens.indexOf(flag);
  if (index < 0) return false;
  tokens.splice(index, 1);
  return true;
}

function splitFirst(value: string): [string | undefined, string | undefined] {
  const index = value.indexOf(" ");
  return index < 0 ? [value || undefined, undefined] : [value.slice(0, index), value.slice(index + 1).trim()];
}

async function latestRunId(repository: string): Promise<string | undefined> {
  const directory = path.join(repository, ".pi", "prompt-chain-hybrid", "runs");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
  } catch {
    return undefined;
  }
}

function formatRunSummary(state: Awaited<ReturnType<typeof loadRunState>>): string {
  const stages = state.manifest.stages.map((stage) => {
    const value = state.stageStates[stage.id];
    return `${value?.status === "completed" ? "✓" : value?.status === "running" ? "▶" : value?.status === "paused" ? "!" : value?.status === "failed" ? "×" : "·"} ${stage.id}: ${value?.status ?? "unknown"}`;
  }).join("\n");
  const open = state.findings.filter((finding) => finding.blocking && finding.disposition === "open").length;
  return `Run: ${state.id}\nStatus: ${state.status}\nDecision mode: ${state.decisionMode}\nOpen blockers: ${open}\nResult commit: ${state.resultCommit ?? "none"}${state.pauseReason ? `\nPause reason: ${state.pauseReason}` : ""}\n\n${stages}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
