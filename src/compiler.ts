import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isHighRiskPath, normalizeRepoPath, pathsMayOverlap } from "./paths.ts";
import { assertValidManifest, validateManifest } from "./validation.ts";
import type { TripManifest, TripStage } from "./types.ts";

export interface CompileOptions {
  outputPath?: string;
  workingDirectory?: string;
  mode?: "auto" | "serial" | "parallel";
  strictPaths?: boolean;
  allowUnresolved?: boolean;
  /**
   * Controls how a writer slice's allowedPaths are derived when the plan does
   * not spell out an explicit "Allowed paths" list.
   * - "permissive" (default): grant the directory globs of the claimed paths
   *   (e.g. a claim on convex/auth.ts grants convex/**), so a writer can edit
   *   the sibling fixtures/tests its change ripples into without pausing.
   * - "strict": grant exactly the claimed files (the pre-permissive behavior),
   *   for runs that want hard per-file isolation.
   * claimedPaths stay concrete under both policies, so worktree overlap and
   * parallel-safety analysis are unchanged.
   */
  pathPolicy?: "permissive" | "strict";
}

type PathPolicy = NonNullable<CompileOptions["pathPolicy"]>;

/**
 * Directory globs for the claimed paths, used as the permissive default
 * allowedPaths. A claim inside a directory grants that directory's subtree
 * (convex/lib/x.ts -> convex/lib/**); a repository-root claim stays concrete
 * so a lone root file never silently grants whole-repo write access.
 */
function permissiveAllowedPaths(claimedPaths: string[]): string[] {
  const globs = claimedPaths.map((value) => {
    const normalized = normalizeRepoPath(value);
    const directory = path.posix.dirname(normalized);
    return directory === "." ? normalized : `${directory}/**`;
  });
  return [...new Set(globs)].sort();
}

interface PlanSlice {
  id: string;
  title: string;
  body: string;
  sourceIndex: number;
  claimedPaths: string[];
  allowedPaths: string[];
  validationCommands: string[];
  /** Where the slice's validation commands came from. "fence" is authoritative. */
  validationSource: "fence" | "loose" | "none";
  /** A Targeted Validation label was present but its fence yielded no command. */
  emptyValidationLabel: boolean;
  needs: string[];
  acceptanceCriteria: string[];
  parallelDeclared: boolean;
  highRiskReasons: string[];
  unresolvedReasons: string[];
}

export interface CompileResult {
  manifest: TripManifest;
  outputPath?: string;
  warnings: string[];
}

export async function compilePlanFile(planPathInput: string, options: CompileOptions = {}): Promise<CompileResult> {
  const planPath = path.resolve(planPathInput);
  const markdown = await readFile(planPath, "utf8");
  const workingDirectory = path.resolve(options.workingDirectory ?? await inferWorkingDirectory(planPath));
  const title = firstHeading(markdown) ?? path.basename(planPath, path.extname(planPath));
  const pathPolicy: PathPolicy = options.pathPolicy ?? "permissive";
  const slices = parseSlices(markdown, pathPolicy);
  const unresolved = slices.filter((slice) => slice.unresolvedReasons.length);
  const strict = options.strictPaths ?? true;
  if (strict && unresolved.length && !options.allowUnresolved) {
    throw new Error(`cannot compile plan with unresolved writer paths:\n${unresolved.map((slice) => `- ${slice.title}: ${slice.unresolvedReasons.join("; ")}`).join("\n")}`);
  }
  const runnableSlices = slices.filter((slice) => slice.claimedPaths.length);
  if (!runnableSlices.length) throw new Error("no implementation slices with concrete repository paths were found");
  // The Targeted Validation fence is the author's explicit contract. A label
  // whose fence yields nothing would compile to a stage reviewers can never
  // see evidence for, so it fails loudly instead of silently.
  const emptyValidation = runnableSlices.filter((slice) => slice.emptyValidationLabel);
  if (emptyValidation.length && !options.allowUnresolved) {
    throw new Error(`cannot compile plan: Targeted Validation is declared but no command was extracted:\n${emptyValidation.map((slice) => `- ${slice.title}`).join("\n")}`);
  }

  const requestedMode = options.mode ?? "auto";
  const blockers = parallelBlockers(runnableSlices);
  let selectedTopology: "same-checkout-serial" | "worktree-fanout";
  if (requestedMode === "parallel") {
    if (blockers.length) throw new Error(`forced parallel mode rejected:\n${blockers.map((value) => `- ${value}`).join("\n")}`);
    selectedTopology = "worktree-fanout";
  } else if (requestedMode === "serial") {
    selectedTopology = "same-checkout-serial";
  } else {
    selectedTopology = blockers.length ? "same-checkout-serial" : "worktree-fanout";
  }

  const finalValidationCommands = await discoverFinalValidationCommands(workingDirectory, markdown);
  const stages = buildStages(runnableSlices, selectedTopology, finalValidationCommands, path.relative(workingDirectory, planPath));
  const warnings = [
    ...unresolved.map((slice) => `${slice.title}: ${slice.unresolvedReasons.join("; ")}`),
    ...emptyValidation.map((slice) => `${slice.title}: Targeted Validation fence yielded no commands; the stage has no validation commands`),
    ...runnableSlices
      .filter((slice) => !slice.emptyValidationLabel && slice.validationSource !== "fence")
      .map((slice) => `${slice.title}: no Targeted Validation fence; ${slice.validationSource === "loose" ? "validation commands came from the loose line scan" : "the stage has no validation commands"}`),
    ...(selectedTopology === "same-checkout-serial" && blockers.length
      ? blockers.map((value) => `serialized: ${value}`)
      : []),
  ];
  const manifest: TripManifest = {
    schemaVersion: 1,
    name: title,
    workingDirectory,
    metadata: {
      generator: { name: "prompt-chain-plan-compiler", version: "0.1.0" },
      sourceGuide: path.relative(workingDirectory, planPath),
      generatedAt: new Date().toISOString(),
      requestedMode,
      selectedTopology,
      topologyReasons: selectedTopology === "worktree-fanout"
        ? ["All implementation slices explicitly declared parallel safety", "Concrete claims are non-overlapping", "No high-risk shared path was detected"]
        : blockers,
      authorWarnings: warnings,
      unresolvedSections: unresolved.map((slice) => slice.title),
      sourcePlanHash: digest(markdown),
      policyHashes: await readPolicyHashes(workingDirectory),
      pathPolicy,
      runtime: { engine: "pi-dynamic-workflows", version: "3.0.0" },
    },
    settings: {
      maxParallel: Math.min(4, runnableSlices.length),
      failFast: false,
      autoCommit: true,
      decisionPolicy: {
        mode: "agent",
        maxDecisionRounds: 2,
        requireBestEffortDecision: true,
        prepareHumanRecommendation: true,
      },
      reviewPolicy: {
        required: true,
        reviewerCount: 2,
        maxRepairRounds: 4,
        malformedVerdict: "continue",
        requireFreshClosureReviewer: true,
      },
      defaultValidationCommands: [],
      finalValidationCommands,
    },
    stages,
  };
  let normalized = assertValidManifest(manifest);
  normalized.metadata = {
    ...normalized.metadata,
    contractHash: digest(JSON.stringify({ ...normalized, metadata: { ...normalized.metadata, contractHash: undefined } })),
  };
  normalized = assertValidManifest(normalized);
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    const portable: TripManifest = {
      ...normalized,
      workingDirectory: path.relative(path.dirname(outputPath), workingDirectory) || ".",
      metadata: { ...normalized.metadata },
    };
    if (portable.metadata) {
      delete portable.metadata.contractHash;
      portable.metadata.contractHash = digest(JSON.stringify(portable));
    }
    await writeFile(outputPath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
    return { manifest: portable, outputPath, warnings };
  }
  return { manifest: normalized, warnings };
}

export function validateCompiledManifest(manifest: TripManifest): ReturnType<typeof validateManifest> {
  return validateManifest(manifest);
}

function parseSlices(markdown: string, pathPolicy: PathPolicy = "permissive"): PlanSlice[] {
  const sections = splitSections(markdown);
  const candidateSections = sections.filter((section) => {
    const title = section.title.toLowerCase();
    return /^(?:\d+[.)]?\s*)?(?:slice|phase|step|task|component|module)\b/.test(title)
      || section.body.includes("**File**:")
      || section.body.includes("**Files**:")
      || /###\s+\d+\./.test(`### ${section.title}`);
  });
  const source = candidateSections.length ? candidateSections : sections.filter((section) => extractRepoPaths(section.body).length);
  return source.map((section, index) => {
    const claimedPaths = extractRepoPaths(section.body);
    const explicitAllowed = extractListUnderLabel(section.body, ["Allowed paths", "Allowed Paths"]);
    const allowedPaths = explicitAllowed.length
      ? explicitAllowed.map(normalizeRepoPath)
      : pathPolicy === "permissive"
        ? permissiveAllowedPaths(claimedPaths)
        : claimedPaths;
    const validation = sliceValidationCommands(section.body);
    const needs = extractListUnderLabel(section.body, ["Needs", "Dependencies"]).map(slug);
    const acceptanceCriteria = extractListUnderLabel(section.body, ["Acceptance criteria", "Acceptance Criteria", "Test Impact"]);
    const parallelDeclared = /(?:parallel[- ]safe|parallel safety)\s*(?::|\*\*)?\s*(?:yes|true|independent)/i.test(section.body)
      || /\[parallel\]/i.test(section.title);
    const highRiskPaths = claimedPaths.filter(isHighRiskPath);
    const unresolvedReasons = claimedPaths.length ? [] : ["no concrete repository path found"];
    return {
      id: `implement-${slug(section.title) || `slice-${index + 1}`}`.slice(0, 72),
      title: section.title,
      body: section.body.trim(),
      sourceIndex: section.index,
      claimedPaths,
      allowedPaths,
      validationCommands: validation.commands,
      validationSource: validation.source,
      emptyValidationLabel: validation.emptyLabel,
      needs,
      acceptanceCriteria,
      parallelDeclared,
      highRiskReasons: highRiskPaths.map((value) => `high-risk shared path: ${value}`),
      unresolvedReasons,
    };
  }).sort((a, b) => a.sourceIndex - b.sourceIndex);
}

function buildStages(
  slices: PlanSlice[],
  topology: "same-checkout-serial" | "worktree-fanout",
  finalValidationCommands: string[],
  sourceGuide: string,
): TripStage[] {
  const research: TripStage = {
    id: "research",
    type: "review",
    needs: [],
    isolation: "readonly",
    prompt: `Read the approved plan at ${sourceGuide}, docs/VISION.md, docs/ARCHI.md, and repository instructions. Confirm the implementation slices, dependencies, risks, and path contracts. Do not edit files. Return a concise context handoff.`,
    allowedTools: ["read", "grep", "find", "ls"],
    outputs: [],
  };
  const implementation: TripStage[] = [];
  let previous = "research";
  for (const slice of slices) {
    // Author-declared "**Needs**"/"**Dependencies**" labels are parsed onto
    // slice.needs (see parseSlices) as slugs matching other slice titles.
    // Thread them into the scheduler edges directly so the compiled DAG
    // matches the authored plan graph instead of silently falling back to a
    // pure document-order chain. Unmapped/typo'd slugs are passed through
    // unresolved on purpose: validateManifest already reports "unknown
    // dependency" for any id that doesn't match a real stage, which is a far
    // better failure mode than silently discarding the author's intent.
    const declaredNeeds = [...new Set(slice.needs.map((need) => `implement-${need}`))];
    const needs = declaredNeeds.length
      ? declaredNeeds
      : topology === "same-checkout-serial" ? [previous] : ["research"];
    implementation.push({
      id: slice.id,
      type: "implementation",
      needs,
      isolation: topology === "worktree-fanout" ? "worktree" : "same-checkout",
      parallel: topology === "worktree-fanout",
      prompt: buildSlicePrompt(slice, sourceGuide, topology),
      allowedPaths: slice.allowedPaths,
      claimedPaths: slice.claimedPaths,
      outputs: [],
      validationCommands: slice.validationCommands,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    previous = slice.id;
  }
  const unionAllowed = [...new Set(slices.flatMap((slice) => slice.allowedPaths))].sort();
  const integration: TripStage = {
    id: "integrate",
    type: "integration",
    needs: topology === "worktree-fanout" ? implementation.map((stage) => stage.id) : [previous],
    isolation: "same-checkout",
    integrationStrategy: topology === "worktree-fanout" ? "worktree-fan-in" : "same-checkout-finalize",
    prompt: `Integrate and finalize the approved implementation from ${sourceGuide}. Do not introduce new scope. Resolve only in-contract integration issues, run the final quality gates, and leave commit creation to the Prompt-chain hybrid runtime.`,
    allowedPaths: unionAllowed,
    claimedPaths: [],
    outputs: [],
    validationCommands: finalValidationCommands,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  };
  return [research, ...implementation, integration];
}

function buildSlicePrompt(
  slice: PlanSlice,
  sourceGuide: string,
  topology: "same-checkout-serial" | "worktree-fanout",
): string {
  const workingTree = topology === "same-checkout-serial"
    ? `WORKING TREE
This stage runs in the shared checkout, after earlier stages in the chain. Uncommitted changes already present in the working tree — schema edits, generated code, fixtures, and helpers produced by prior stages — are EXPECTED and IN-CONTRACT. Inspect them, build on top of them, and keep them. Do NOT treat pre-existing changes as foreign, "host-owned", out-of-scope, or a reason to pause or block; the runtime owns the commit, not you. Your job is to make the working tree under your allowed paths satisfy the acceptance criteria and return a verified complete.`
    : `WORKING TREE
This stage runs in an isolated worktree branched from a clean base, so only your own edits should appear. Keep every change within your allowed paths; disjoint sibling stages run in parallel and are fanned in later.`;
  return `Implement one frozen slice from the approved plan ${sourceGuide}.

SLICE
${slice.title}

PATH CONTRACT
Allowed paths (your editable boundary — you may create, edit, or extend ANY file that matches these):
${slice.allowedPaths.map((value) => `- ${value}`).join("\n")}

Primary files to implement (start here — a starting list, not a hard limit within the allowed boundary):
${slice.claimedPaths.map((value) => `- ${value}`).join("\n")}

${workingTree}

ACCEPTANCE CRITERIA
${slice.acceptanceCriteria.length ? slice.acceptanceCriteria.map((value) => `- ${value}`).join("\n") : "- Satisfy the plan section and preserve existing behavior outside this slice."}

RULES
- Read docs/VISION.md, docs/ARCHI.md, and repository instructions first when present.
- Your allowed paths are your full editable scope; editing any file that matches them is in-contract and needs no decision or escalation.
- When your change ripples into sibling files inside the allowed paths (shared fixtures, generated code, related tests), update them so the stage's tests pass — do not stop at the primary files and do not pause for permission.
- Implement behavioral tests for new logic when the plan requires them.
- Do not commit, tag, merge, push, or alter Git configuration.
- Return needs_decision ONLY for a genuine product or architecture choice. Never return needs_decision or blocked for path scope, for editing an allowed sibling file, or because the working tree already contains related changes.
- A prose report is not completion. End with one structured status.

PLAN SECTION
${slice.body}

FINAL RESPONSE
<status>complete|continue|blocked|needs_decision</status>
<risk>low|medium|high|critical</risk>
<rationale>what was done or why more work is needed</rationale>
<missingItems>remaining items</missingItems>
<recommendedFollowupPrompt>focused next action</recommendedFollowupPrompt>`;
}

function parallelBlockers(slices: PlanSlice[]): string[] {
  const blockers: string[] = [];
  if (slices.length < 2) blockers.push("fewer than two implementation slices");
  for (const slice of slices) {
    if (!slice.parallelDeclared) blockers.push(`${slice.title} does not explicitly declare parallel safety`);
    blockers.push(...slice.highRiskReasons.map((value) => `${slice.title}: ${value}`));
    if (slice.needs.length) blockers.push(`${slice.title} declares dependencies: ${slice.needs.join(", ")}`);
  }
  for (let left = 0; left < slices.length; left += 1) {
    for (let right = left + 1; right < slices.length; right += 1) {
      const a = slices[left];
      const b = slices[right];
      if (!a || !b) continue;
      for (const claimA of a.claimedPaths) {
        for (const claimB of b.claimedPaths) {
          if (pathsMayOverlap(claimA, claimB)) blockers.push(`claims overlap: ${a.title}:${claimA} and ${b.title}:${claimB}`);
        }
      }
    }
  }
  return [...new Set(blockers)];
}

async function inferWorkingDirectory(planPath: string): Promise<string> {
  let current = path.dirname(planPath);
  while (true) {
    if (await exists(path.join(current, "package.json"))
      || await exists(path.join(current, "pyproject.toml"))
      || await exists(path.join(current, "Cargo.toml"))
      || await exists(path.join(current, "go.mod"))) return current;
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(planPath);
    current = parent;
  }
}

async function discoverFinalValidationCommands(cwd: string, markdown: string): Promise<string[]> {
  // Union of every Targeted Validation fence in the document; only a document
  // with no fence at all falls back to the loose scan, then to package scripts.
  const fenced = extractFenceCommands(markdown);
  if (fenced.length) return fenced;
  const loose = extractLooseCommands(markdown);
  if (loose.length) return loose;
  const packagePath = path.join(cwd, "package.json");
  if (await exists(packagePath)) {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const manager = await packageManager(cwd);
    const commands: string[] = [];
    for (const name of ["format:check", "lint", "typecheck", "check", "test", "build"]) {
      if (packageJson.scripts?.[name]) commands.push(`${manager} run ${name}`);
    }
    commands.push("git diff --check");
    return [...new Set(commands)];
  }
  return ["git diff --check"];
}

async function packageManager(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(path.join(cwd, "bun.lock")) || await exists(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function splitSections(markdown: string): Array<{ title: string; body: string; index: number }> {
  const lines = markdown.split(/\r?\n/);
  const output: Array<{ title: string; body: string; index: number }> = [];
  let current: { title: string; body: string; index: number } | undefined;
  for (const line of lines) {
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      if (current?.body.trim()) output.push(current);
      current = { title: heading[2]?.trim() ?? "Implementation", body: "", index: output.length };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current?.body.trim()) output.push(current);
  return output;
}

function extractRepoPaths(text: string): string[] {
  const output = new Set<string>();
  const backticks = text.matchAll(/`([^`\n]+)`/g);
  for (const match of backticks) {
    const candidate = cleanCandidate(match[1] ?? "");
    if (candidate) output.add(candidate);
  }
  const fileLabels = text.matchAll(/\*\*(?:File|Files)\*\*:\s*([^\n]+)/gi);
  for (const match of fileLabels) {
    for (const part of (match[1] ?? "").split(/,|\s+and\s+/i)) {
      const candidate = cleanCandidate(part);
      if (candidate) output.add(candidate);
    }
  }
  return [...output].slice(0, 40).sort();
}

function cleanCandidate(input: string): string | undefined {
  // Files-label entries are commonly written as `path` in the plan template;
  // strip the backticks so the claim is the bare path the allowed-path check
  // can cover, not a second backticked duplicate.
  const value = input.trim().replace(/^[`'"(]+|[`'"),.;:]+$/g, "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.startsWith("http") || value.startsWith("/") || value.includes(" ")) return undefined;
  if (/^(npm|pnpm|yarn|bun|git|node|python|cargo|go)\b/.test(value)) return undefined;
  if (!value.includes("/") && !/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|py|go|rs|java|kt|swift|yml|yaml|toml|sql|sh|lock)$/.test(value)) return undefined;
  if (/^(node_modules|dist|build|\.git)(\/|$)/.test(value)) return undefined;
  try {
    return normalizeRepoPath(value);
  } catch {
    return undefined;
  }
}

const TARGETED_VALIDATION_LABEL = /\*{0,2}Targeted Validation\*{0,2}\s*:?/gi;

function hasTargetedValidationLabel(text: string): boolean {
  return /Targeted Validation/i.test(text);
}

/**
 * The fence that follows a Targeted Validation label is the author's contract:
 * every non-blank, non-comment line is a command, verbatim, in order. No
 * allowlist applies, so `npx tsc --noEmit` or a Node script survive intact.
 */
function extractFenceCommands(text: string): string[] {
  const output = new Set<string>();
  for (const label of text.matchAll(TARGETED_VALIDATION_LABEL)) {
    const rest = text.slice((label.index ?? 0) + label[0].length);
    const fence = rest.match(/^\s*```(?:sh|bash|shell|zsh)?[^\n]*\n([\s\S]*?)```/);
    if (!fence) continue;
    for (const line of (fence[1] ?? "").split(/\r?\n/)) {
      const command = line.trim().replace(/^[$>]\s*/, "");
      if (command && !command.startsWith("#")) output.add(command);
    }
  }
  return [...output].slice(0, 20);
}

/**
 * Fallback for slices without a Targeted Validation fence: allowlisted
 * command-like lines anywhere in the body, including unlabeled fences.
 */
function extractLooseCommands(text: string): string[] {
  const output = new Set<string>();
  for (const fence of text.matchAll(/```(?:sh|bash|shell|zsh)?\s*\n([\s\S]*?)```/gi)) {
    for (const line of (fence[1] ?? "").split(/\r?\n/)) {
      const command = line.trim().replace(/^[$>]\s*/, "");
      if (isValidationCommand(command)) output.add(command);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const command = line.trim().replace(/^[-*]\s*/, "").replace(/^`|`$/g, "");
    if (isValidationCommand(command)) output.add(command);
  }
  return [...output].slice(0, 20);
}

function sliceValidationCommands(body: string): { commands: string[]; source: "fence" | "loose" | "none"; emptyLabel: boolean } {
  const labeled = hasTargetedValidationLabel(body);
  if (labeled) {
    const fenced = extractFenceCommands(body);
    // A labeled fence, even an empty one, silences the loose scan: the author
    // declared the contract, so prose must not add commands behind their back.
    return { commands: fenced, source: fenced.length ? "fence" : "none", emptyLabel: fenced.length === 0 };
  }
  const loose = extractLooseCommands(body);
  return { commands: loose, source: loose.length ? "loose" : "none", emptyLabel: false };
}

function isValidationCommand(value: string): boolean {
  return /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build|format)|^pytest\b|^cargo\s+(?:test|check|clippy)|^go\s+test\b|^git\s+diff\s+--check/.test(value);
}

function extractListUnderLabel(text: string, labels: string[]): string[] {
  const output: string[] = [];
  const lines = text.split(/\r?\n/);
  let active = false;
  for (const line of lines) {
    const normalized = line.replace(/\*\*/g, "").trim();
    if (labels.some((label) => normalized.toLowerCase().startsWith(label.toLowerCase()))) {
      active = true;
      const inline = normalized.split(":").slice(1).join(":").trim();
      if (inline) output.push(...inline.split(/,|;/).map((value) => value.trim()).filter(Boolean));
      continue;
    }
    if (active) {
      const item = line.match(/^\s*[-*]\s+(.+)/)?.[1]?.trim();
      if (item) output.push(item);
      else if (line.trim()) active = false;
    }
  }
  return output;
}

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/\[parallel\]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function readPolicyHashes(workingDirectory: string): Promise<Record<string, string>> {
  const candidates = [
    ["vision", "docs/VISION.md"],
    ["architecture", "docs/ARCHI.md"],
    ["reviewChecklist", "docs/REVIEW-CHECKLIST.md"],
    ["agents", "AGENTS.md"],
  ] as const;
  const hashes: Record<string, string> = {};
  for (const [name, relative] of candidates) {
    try { hashes[name] = digest(await readFile(path.join(workingDirectory, relative), "utf8")); } catch {}
  }
  return hashes;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
