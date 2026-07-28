import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compilePlanFile } from "./compiler.ts";
import { describeManifest } from "./inspect.ts";
import { createIssue, processNextIssue, resumeIssue } from "./controller.ts";
import { projectIssues, readIssueEvents } from "./issues.ts";
import { repositoryRoot } from "./git.ts";
import { recordHumanDecision, requestAbort, resumeRun, runManifestFile } from "./runner.ts";
import { auditCompletion } from "./audit.ts";
import { loadRunState } from "./store.ts";
import { readRunEvents, formatRunEventsNewestFirst } from "./logs.ts";
import { buildRunSummarySections, formatRunSummary, type RunSummarySections } from "./status.ts";
import {
  completeChainAutonomously,
  formatAutonomousReport,
  runFollowUpRounds,
} from "./followups.ts";
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
    description: "Run a Prompt-chain hybrid manifest to full completion, including recoveries and follow-ups",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const noFollowUps = removeFlag(tokens, "--no-follow-ups");
      const manifestPath = tokens[0];
      if (!manifestPath) return ctx.ui.notify("Usage: /prompt-chain-run <manifest.json> [--human-decisions] [--no-follow-ups]", "warning");
      ctx.ui.setStatus("prompt-chain-hybrid", "Starting Prompt-chain hybrid run…");
      try {
        const onEvent = ({ message }: { message: string }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100));
        const initial = await runManifestFile({
          manifestPath: path.resolve(ctx.cwd, manifestPath),
          humanDecisions,
          onEvent,
        });
        const repository = await repositoryRoot(initial.manifest.workingDirectory);
        const report = await completeChainAutonomously({
          repositoryRoot: repository,
          state: initial,
          humanDecisions,
          followUps: !noFollowUps,
          onEvent,
        });
        const state = report.state;
        ctx.ui.setStatus("prompt-chain-hybrid", `${state.id}: ${state.status}`);
        ctx.ui.notify(
          `${formatRunSummary(state)}\n\n${formatAutonomousReport(report)}`,
          state.status === "completed" ? "info" : state.status === "paused" ? "warning" : "error",
        );
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid", "Run failed");
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-status", {
    description: "Show Prompt-chain hybrid run status, or watch its durable event log with --watch",
    handler: async (args, ctx) => {
      try {
        const tokens = shellWords(args);
        const watch = removeFlag(tokens, "--watch");
        if (tokens.length > 1) return ctx.ui.notify("Usage: /prompt-chain-status [run-id] [--watch]", "warning");
        const repository = await repositoryRoot(ctx.cwd);
        const runId = tokens[0] || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("No Prompt-chain hybrid runs were found in this repository.", "warning");
        if (watch) return await showRunLogWatcher(ctx, repository, runId);
        const state = await loadRunState(repository, runId);
        await showStatusSummary(ctx, buildRunSummarySections(state));
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-resume", {
    description: "Resume a paused, interrupted, failed, or explicitly aborted Prompt-chain hybrid run",
    handler: async (args, ctx) => {
      try {
        const repository = await repositoryRoot(ctx.cwd);
        const tokens = shellWords(args);
        const adoptCurrentHead = removeFlag(tokens, "--adopt-current-head");
        const noFollowUps = removeFlag(tokens, "--no-follow-ups");
        const runId = tokens[0] || await latestRunId(repository);
        if (!runId || tokens.length > 1) return ctx.ui.notify("Usage: /prompt-chain-resume <run-id> [--adopt-current-head] [--no-follow-ups]", "warning");
        const requestedAt = new Date();
        ctx.ui.setStatus("prompt-chain-hybrid", `Resuming ${runId}…`);
        ctx.ui.notify(
          `Resume requested: ${requestedAt.toISOString()}\nRun: ${runId}\nProgress will appear here at each durable run or step transition. Long implementation and review attempts can take several minutes between updates.`,
          "info",
        );
        let state = await resumeRun({
          repositoryRoot: repository,
          runId,
          adoptCurrentHead,
          onEvent: ({ message, stageId }) => {
            ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100));
            ctx.ui.notify(`[${new Date().toISOString()}] ${message}${stageId ? `\nStep: ${stageId}` : ""}`, "info");
          },
        });
        let reportText: string | undefined;
        if (!noFollowUps) {
          const report = await completeChainAutonomously({
            repositoryRoot: repository,
            state,
            onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
          });
          state = report.state;
          reportText = formatAutonomousReport(report);
        }
        ctx.ui.setStatus("prompt-chain-hybrid", `${state.id}: ${state.status}`);
        ctx.ui.notify(`${formatRunSummary(state)}${reportText ? `\n\n${reportText}` : ""}`, state.status === "completed" ? "info" : "warning");
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
        const state = await requestAbort(repository, runId);
        const detail = state.status === "aborted"
          ? "The run is now durably aborted and can be explicitly reopened with /prompt-chain-resume."
          : "It will be observed at the next durable boundary.";
        ctx.ui.notify(`Abort requested for ${runId}. ${detail}`, "warning");
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
    description: "Run a Prompt-chain hybrid manifest under continuous supervision until chain, follow-ups, and audit are done",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const manifestPath = tokens[0];
      if (!manifestPath) return ctx.ui.notify("Usage: /prompt-chain-supervise <manifest.json> [--human-decisions]", "warning");
      ctx.ui.setStatus("prompt-chain-hybrid", "Starting supervised Prompt-chain run…");
      try {
        const onEvent = ({ message }: { message: string }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100));
        const initial = await runManifestFile({
          manifestPath: path.resolve(ctx.cwd, manifestPath),
          humanDecisions,
          onEvent,
        });
        // Derive the repository root from the manifest's workingDirectory, not ctx.cwd,
        // so the supervisor loads state from the correct .pi directory.
        const repository = await repositoryRoot(initial.manifest.workingDirectory);
        const report = await completeChainAutonomously({ repositoryRoot: repository, state: initial, humanDecisions, onEvent });
        const state = report.state;
        ctx.ui.setStatus("prompt-chain-hybrid", `${state.id}: ${state.status}`);
        ctx.ui.notify(
          `${formatRunSummary(state)}\n\n${formatAutonomousReport(report)}`,
          state.status === "completed" ? "info" : state.status === "paused" ? "warning" : "error",
        );
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid", "Supervised run failed");
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-follow-ups", {
    description: "Autonomously execute the deferred follow-ups and unverified criteria of a completed run",
    handler: async (args, ctx) => {
      try {
        const tokens = shellWords(args);
        const noAudit = removeFlag(tokens, "--no-audit");
        const rounds = takeOption(tokens, "--rounds");
        const repository = await repositoryRoot(ctx.cwd);
        const runId = tokens[0] || await latestRunId(repository);
        if (!runId) return ctx.ui.notify("Usage: /prompt-chain-follow-ups [run-id] [--rounds N] [--no-audit]", "warning");
        const state = await loadRunState(repository, runId);
        if (state.status !== "completed") {
          return ctx.ui.notify(`Run ${runId} is ${state.status}. Complete it first with /prompt-chain-resume ${runId}.`, "warning");
        }
        ctx.ui.setStatus("prompt-chain-hybrid", `Executing follow-ups for ${runId}…`);
        const report = await runFollowUpRounds({
          repositoryRoot: repository,
          state,
          maxRounds: rounds ? Number(rounds) : undefined,
          auditCriteria: !noAudit,
          onEvent: ({ message }) => ctx.ui.setStatus("prompt-chain-hybrid", message.slice(0, 100)),
        });
        ctx.ui.setStatus("prompt-chain-hybrid", `${runId}: follow-ups done`);
        const lines = [
          `Follow-up execution for ${runId}:`,
          ...(report.runs.length
            ? report.runs.map((run) => `  Round ${run.round}: ${run.runId} — ${run.status} (${run.itemCount} item(s), ${run.stageCount} step(s))`)
            : ["  No executable deferred work was found."]),
          `  Remaining deferred items: ${report.remainingItems}`,
          ...report.notes.map((note) => `  Note: ${note}`),
        ];
        ctx.ui.notify(lines.join("\n"), report.remainingItems === 0 ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("prompt-chain-loop", {
    description: "Drain the local issue backlog: claim and fully execute ready issues until none remain",
    handler: async (args, ctx) => {
      const tokens = shellWords(args);
      const humanDecisions = removeFlag(tokens, "--human-decisions");
      const maxText = takeOption(tokens, "--max");
      const eventFile = tokens[0];
      if (!eventFile) return ctx.ui.notify("Usage: /prompt-chain-loop <issues.jsonl> [--max N] [--human-decisions]", "warning");
      const max = Math.max(1, Number(maxText ?? 20) || 20);
      const messages: string[] = [];
      try {
        for (let processed = 0; processed < max; processed += 1) {
          const result = await processNextIssue({
            eventFile: path.resolve(ctx.cwd, eventFile),
            humanDecisions,
            onEvent: (message) => ctx.ui.setStatus("prompt-chain-hybrid-loop", message.slice(0, 100)),
          });
          if (!result.issue) {
            messages.push(processed ? "Backlog drained: no ready issue remains." : "No ready issue is available.");
            break;
          }
          messages.push(result.message);
          if (result.run && result.run.status !== "completed") {
            messages.push(`Stopping the loop: ${result.issue.id} ended ${result.run.status}.`);
            break;
          }
        }
        ctx.ui.setStatus("prompt-chain-hybrid-loop", "idle");
        ctx.ui.notify(messages.join("\n") || "No issues were processed.", "info");
      } catch (error) {
        ctx.ui.setStatus("prompt-chain-hybrid-loop", "failed");
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

function takeOption(tokens: string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  if (index < 0) return undefined;
  const [, value] = tokens.splice(index, 2);
  return value;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StatusRow {
  text: string;
  stageIndex?: number;
  isTitle?: boolean;
}

async function showStatusSummary(
  ctx: ExtensionCommandContext,
  sections: RunSummarySections,
): Promise<void> {
  const viewHeight = 16;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    // Individual steps start collapsed; only their one-line summary is shown.
    const expanded = sections.stages.map(() => false);
    let selected = sections.stages.length ? 0 : -1;
    let offset = 0;
    let maxOffset = 0;
    let revealSelected = true;
    const buildRows = (innerWidth: number): StatusRow[] => {
      const rows: StatusRow[] = [];
      for (const line of sections.header) {
        for (const wrapped of wrapStatusSummary(line, innerWidth)) rows.push({ text: wrapped });
      }
      rows.push({ text: "" });
      rows.push({ text: `Steps (${sections.stages.length}) — collapsed; expand for details:` });
      sections.stages.forEach((stage, index) => {
        const marker = expanded[index] ? "▾" : "▸";
        for (const wrapped of wrapStatusSummary(`${marker} ${stage.title}`, innerWidth)) {
          rows.push({ text: wrapped, stageIndex: index, isTitle: true });
        }
        if (expanded[index]) {
          for (const line of stage.lines) {
            for (const wrapped of wrapStatusSummary(line ? `    ${line}` : "", innerWidth)) {
              rows.push({ text: wrapped, stageIndex: index });
            }
          }
        }
      });
      return rows;
    };
    const renderLines = (width: number): string[] => {
      const innerWidth = Math.max(1, width - 4);
      const rows = buildRows(innerWidth);
      maxOffset = Math.max(0, rows.length - viewHeight);
      if (revealSelected && selected >= 0) {
        const titleIndex = rows.findIndex((row) => row.stageIndex === selected && row.isTitle);
        if (titleIndex >= 0) {
          if (titleIndex < offset) offset = titleIndex;
          else if (titleIndex >= offset + viewHeight) offset = titleIndex - viewHeight + 1;
        }
        revealSelected = false;
      }
      offset = Math.min(Math.max(0, offset), maxOffset);
      const border = theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
      const divider = theme.fg("accent", `├${"─".repeat(innerWidth + 2)}┤`);
      const row = (text: string, style: (value: string) => string = (value) => value): string =>
        `│ ${style(text.slice(0, innerWidth).padEnd(innerWidth))} │`;
      const visible = rows.slice(offset, offset + viewHeight);
      return [
        border,
        row("Prompt-chain status", (value) => theme.fg("accent", theme.bold(value))),
        row(
          `↑/↓ select step · enter/space expand · e all · c none · PgUp/PgDn scroll · esc/q close · rows ${offset + 1}-${Math.min(offset + viewHeight, rows.length)} of ${rows.length}`,
          (value) => theme.fg("dim", value),
        ),
        divider,
        ...visible.map((entry) => entry.isTitle && entry.stageIndex === selected
          ? row(entry.text, (value) => theme.fg("accent", theme.bold(value)))
          : row(entry.text)),
        ...Array.from({ length: viewHeight - visible.length }, () => row("")),
        border.replace("┌", "└").replace("┐", "┘"),
      ];
    };
    const moveSelection = (delta: number): void => {
      if (!sections.stages.length) return;
      const next = Math.min(sections.stages.length - 1, Math.max(0, selected + delta));
      if (next === selected && delta < 0) offset = 0; // moving above the first step reveals the header
      selected = next;
      revealSelected = true;
    };
    return {
      render: renderLines,
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "\u001b" || data === "q") return done();
        if (data === "\u001b[B" || data === "j") moveSelection(1);
        else if (data === "\u001b[A" || data === "k") moveSelection(-1);
        else if ((data === "\r" || data === "\n" || data === " " || data === "l" || data === "\u001b[C") && selected >= 0) {
          expanded[selected] = !expanded[selected];
          revealSelected = true;
        } else if ((data === "h" || data === "\u001b[D") && selected >= 0) {
          expanded[selected] = false;
          revealSelected = true;
        } else if (data === "e") expanded.fill(true);
        else if (data === "c") expanded.fill(false);
        else if (data === "\u001b[6~") offset = Math.min(maxOffset, offset + viewHeight);
        else if (data === "\u001b[5~") offset = Math.max(0, offset - viewHeight);
        else if (data === "g" || data === "\u001b[H") offset = 0;
        else if (data === "G" || data === "\u001b[F") offset = maxOffset;
        else return;
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%", margin: 1 },
  });
}

async function showRunLogWatcher(
  ctx: ExtensionCommandContext,
  repository: string,
  runId: string,
): Promise<void> {
  const viewHeight = 14;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let lines = ["Loading durable run events…"];
    let offset = 0;
    let maxOffset = 0;
    let follow = true;
    let closed = false;
    const refresh = async (): Promise<void> => {
      try {
        const events = await readRunEvents(repository, runId);
        lines = events.length ? formatRunEventsNewestFirst(events) : ["No durable events have been recorded yet."];
        if (follow) offset = 0;
      } catch (error) {
        lines = [`Unable to read the durable event log: ${errorMessage(error)}`];
        offset = 0;
      }
      tui.requestRender();
    };
    const timer = setInterval(() => { void refresh(); }, 1_000);
    void refresh();
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      done();
    };
    const renderLines = (width: number): string[] => {
      const innerWidth = Math.max(1, width - 4);
      const wrapped = lines.flatMap((line) => wrapStatusSummary(line, innerWidth));
      maxOffset = Math.max(0, wrapped.length - viewHeight);
      offset = Math.min(offset, maxOffset);
      const border = theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
      const divider = theme.fg("accent", `├${"─".repeat(innerWidth + 2)}┤`);
      const row = (text: string, style: (value: string) => string = (value) => value): string =>
        `│ ${style(text.slice(0, innerWidth).padEnd(innerWidth))} │`;
      const visible = wrapped.slice(offset, offset + viewHeight);
      return [
        border,
        row(`Prompt-chain logs — ${runId}`, (value) => theme.fg("accent", theme.bold(value))),
        row(`${follow ? "Following newest" : "Browsing history"} · lines ${offset + 1}-${Math.min(offset + viewHeight, wrapped.length)} of ${wrapped.length} · ↑/↓ scroll · f follow · r refresh · enter/esc close`, (value) => theme.fg("dim", value)),
        divider,
        ...visible.map((line) => row(line)),
        ...Array.from({ length: viewHeight - visible.length }, () => row("")),
        border.replace("┌", "└").replace("┐", "┘"),
      ];
    };
    return {
      render: renderLines,
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "\u001b" || data === "\r" || data === "\n") return close();
        if (data === "\u001b[B" || data === "j") {
          offset = Math.min(maxOffset, offset + 1);
          follow = false;
        } else if (data === "\u001b[A" || data === "k") {
          offset = Math.max(0, offset - 1);
          follow = offset === 0;
        } else if (data === " " || data === "\u001b[6~") {
          offset = Math.min(maxOffset, offset + viewHeight);
          follow = false;
        } else if (data === "\u001b[5~") {
          offset = Math.max(0, offset - viewHeight);
          follow = offset === 0;
        } else if (data === "f") {
          follow = true;
          offset = 0;
        } else if (data === "r") {
          void refresh();
        } else return;
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%", margin: 1 },
  });
}

function wrapStatusSummary(summary: string, width: number): string[] {
  return summary.split("\n").flatMap((line) => {
    if (!line) return [""];
    const wrapped: string[] = [];
    let remaining = line;
    while (remaining.length > width) {
      const breakAt = remaining.lastIndexOf(" ", width);
      const end = breakAt > 0 ? breakAt : width;
      wrapped.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    wrapped.push(remaining);
    return wrapped;
  });
}
