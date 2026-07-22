#!/usr/bin/env -S node --experimental-strip-types
import { createIssue, processNextIssue, resumeIssue } from "../src/controller.ts";
import { projectIssues, readIssueEvents } from "../src/issues.ts";

const [command, eventFile, ...args] = process.argv.slice(2);
if (!command || !eventFile) usage();

if (command === "add") {
  const joined = args.join(" ");
  const [title, manifestPath, priorityText] = joined.split("::").map((value) => value.trim());
  if (!title || !manifestPath) usage();
  const issue = await createIssue(eventFile, { title, manifestPath, priority: Number(priorityText || 0) });
  process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
} else if (command === "list") {
  const issues = [...projectIssues(await readIssueEvents(eventFile)).values()];
  process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
} else if (command === "once") {
  const result = await processNextIssue({
    eventFile,
    humanDecisions: args.includes("--human-decisions"),
    onEvent: (message) => { process.stderr.write(`${message}\n`); },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.run && result.run.status !== "completed") process.exitCode = 2;
} else if (command === "resume") {
  const issueId = args[0];
  if (!issueId) usage();
  const result = await resumeIssue(eventFile, issueId, { onEvent: (message) => { process.stderr.write(`${message}\n`); } });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.run && result.run.status !== "completed") process.exitCode = 2;
} else {
  usage();
}

function usage(): never {
  process.stderr.write(`usage:\n  trip-loop add <issues.jsonl> "title :: manifest.json :: priority"\n  trip-loop list <issues.jsonl>\n  trip-loop once <issues.jsonl> [--human-decisions]\n  trip-loop resume <issues.jsonl> <issue-id>\n`);
  process.exit(64);
}
