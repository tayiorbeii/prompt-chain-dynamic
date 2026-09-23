import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compilePlanFile } from "../src/compiler.ts";

test("compiler emits worktree fanout only for explicitly parallel-safe slices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "echo lint", typecheck: "echo typecheck", test: "echo test" } }));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Stable clusters

## Implementation Details

### Slice A [parallel]

**File**: \`src/a.ts\`

**Parallel-safe**: yes

Implement A.

### Slice B [parallel]

**File**: \`app/api/items/[id]/route.ts\`

**Parallel-safe**: yes

Implement B.
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto" });
  assert.equal(result.manifest.metadata?.selectedTopology, "worktree-fanout");
  assert.equal(result.manifest.stages.filter((stage) => stage.type === "implementation").every((stage) => stage.isolation === "worktree"), true);
  assert.ok(result.manifest.stages.some((stage) => stage.claimedPaths?.includes("app/api/items/[id]/route.ts")));
  assert.ok(result.manifest.settings?.finalValidationCommands?.includes("npm run lint"));
});

test("compiler serializes slices that lack an explicit parallel-safety declaration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Serial change

### Slice A
**File**: \`src/a.ts\`

### Slice B
**File**: \`src/b.ts\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto" });
  assert.equal(result.manifest.metadata?.selectedTopology, "same-checkout-serial");
  const writers = result.manifest.stages.filter((stage) => stage.type === "implementation");
  assert.deepEqual(writers[1]?.needs, [writers[0]?.id]);
});

test("compiler threads author-declared Needs into the compiled DAG instead of discarding them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Explicit dependencies

### Slice A
**File**: \`src/a.ts\`

Implement A.

### Slice B
**File**: \`src/b.ts\`

**Needs**: Slice A

Implement B.

### Slice C
**File**: \`src/c.ts\`

**Needs**: Slice A, Slice B

Implement C. Declares both prior slices explicitly, not just the immediately preceding one.
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto" });
  assert.equal(result.manifest.metadata?.selectedTopology, "same-checkout-serial");
  const writers = result.manifest.stages.filter((stage) => stage.type === "implementation");
  const byId = Object.fromEntries(writers.map((stage) => [stage.id, stage]));
  // Before the fix, buildStages ignored slice.needs entirely and always set
  // needs to [previousStageId] regardless of what the author declared. Assert
  // the compiled edges match the authored "**Needs**" list verbatim, not a
  // synthesized document-order chain.
  // Waves mode (the auto default) keeps every authored edge and adds the
  // per-wave chain edge, so assert on set membership rather than verbatim order.
  assert.deepEqual([...(byId["implement-slice-b"]?.needs ?? [])].sort(), ["implement-slice-a"]);
  assert.deepEqual([...(byId["implement-slice-c"]?.needs ?? [])].sort(), ["implement-slice-a", "implement-slice-b"]);
  const legacy = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: false });
  const legacyById = Object.fromEntries(legacy.manifest.stages.map((stage) => [stage.id, stage]));
  assert.deepEqual(legacyById["implement-slice-c"]?.needs, ["implement-slice-a", "implement-slice-b"], "legacy mode keeps the authored list verbatim");
});

test("compiler surfaces an explicit validation error when declared Needs skip an intervening same-checkout writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Skipped dependency

### Slice A
**File**: \`src/a.ts\`

Implement A.

### Slice B
**File**: \`src/b.ts\`

Implement B, unrelated to A or C.

### Slice C
**File**: \`src/c.ts\`

**Needs**: Slice A

Implement C, which only declares Slice A even though Slice B runs between them in the same checkout.
`);
  // Legacy (non-wave) compilation honors the declared edges verbatim, which
  // makes the same-checkout ordering conflict a loud validation failure.
  await assert.rejects(
    () => compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: false }),
    /same-checkout writers must be linearly ordered/,
  );
  // Wave-aware auto mode places B and C in the same wave and chains them, so
  // the plan compiles and C still depends on A transitively.
  const waved = await compilePlanFile(plan, { workingDirectory: root, mode: "auto" });
  const c = waved.manifest.stages.find((stage) => stage.id === "implement-slice-c");
  assert.ok(c?.needs.includes("implement-slice-b"), JSON.stringify(c?.needs));
  assert.ok(c?.needs.includes("implement-slice-a"));
});

test("compiler refuses to invent a path for an unresolved slice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Missing path

### Slice A
Implement the thing without naming any file.
`);
  await assert.rejects(() => compilePlanFile(plan, { workingDirectory: root }), /unresolved writer paths/);
});

test("written manifest round-trips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-compiler-"));
  const plan = path.join(root, "plan.md");
  const output = path.join(root, "docs", "plans", "plan.trip.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(plan, `# One slice

### Slice A
**File**: \`src/a.ts\`
`);
  await compilePlanFile(plan, { workingDirectory: root, outputPath: output, mode: "serial" });
  const manifest = JSON.parse(await readFile(output, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.metadata.selectedTopology, "same-checkout-serial");
  assert.equal(manifest.workingDirectory, "../..");
  assert.doesNotMatch(await readFile(output, "utf8"), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("compiler freezes source, policy and runtime metadata", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "trip-metadata-"));
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, "docs", "VISION.md"), "# Vision\n", "utf8");
  const plan = path.join(repo, "metadata.plan.md");
  await writeFile(plan, `# Metadata\n\n### Slice 1 — A\n\n**File**: \`src/a.ts\`\n\n**Parallel-safe**: no\n`, "utf8");
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial" });
  assert.match(result.manifest.metadata?.sourcePlanHash ?? "", /^sha256:/);
  assert.match(result.manifest.metadata?.contractHash ?? "", /^sha256:/);
  assert.match(result.manifest.metadata?.policyHashes?.vision ?? "", /^sha256:/);
  assert.equal(result.manifest.metadata?.runtime?.engine, "pi-dynamic-workflows");
});

// The permissive path policy is the default: a writer slice that lists concrete
// files (but no explicit "Allowed paths") is granted the DIRECTORY GLOBS of those
// files, so it can edit the sibling fixtures/tests its change ripples into without
// pausing on a path-contract scope gap. Claims stay concrete so parallel-safety
// analysis is unchanged.
async function permissivePlanRepo(): Promise<{ repo: string; plan: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "trip-path-policy-"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { "check-types": "echo types", test: "echo test" } }));
  const plan = path.join(repo, "plan.md");
  await writeFile(plan, `# Live authorization

## Implementation Details

### Phase F2 — Live authorization

**Files**: convex/auth.ts, convex/lib/liveAuthorization.ts, convex/lib/testGuards.ts

Enforce live authorization on every request and repair the fixtures it ripples into.
`, "utf8");
  return { repo, plan };
}

test("permissive path policy grants directory globs while keeping claims concrete", async () => {
  const { repo, plan } = await permissivePlanRepo();
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.ok(writer, "expected a writer stage");
  assert.deepEqual(writer?.allowedPaths, ["convex/**", "convex/lib/**"]);
  // Claims remain the exact files the plan named — overlap/parallel-safety logic is unchanged.
  assert.deepEqual(writer?.claimedPaths, ["convex/auth.ts", "convex/lib/liveAuthorization.ts", "convex/lib/testGuards.ts"]);
  // A rippled sibling that was never claimed (e.g. a fixture regenerated by codegen) is now in-contract.
  assert.ok(writer?.allowedPaths?.some((pattern) => pattern === "convex/**"));
  assert.equal(result.manifest.metadata?.pathPolicy, "permissive");
});

test("strict path policy pins allowedPaths to the exact claimed files", async () => {
  const { repo, plan } = await permissivePlanRepo();
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial", pathPolicy: "strict" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.allowedPaths, ["convex/auth.ts", "convex/lib/liveAuthorization.ts", "convex/lib/testGuards.ts"]);
  assert.equal(result.manifest.metadata?.pathPolicy, "strict");
});

test("an explicit Allowed paths list overrides the permissive default", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "trip-explicit-allowed-"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }));
  const plan = path.join(repo, "plan.md");
  await writeFile(plan, `# Explicit

### Phase — Scoped

**Files**: convex/auth.ts

**Allowed paths**:
- convex/auth.ts
- convex/lib/**

Do the work.
`, "utf8");
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.allowedPaths, ["convex/auth.ts", "convex/lib/**"]);
});

test("serial writer prompt frames pre-existing tree changes as in-contract and forbids path-scope blocking", async () => {
  const { repo, plan } = await permissivePlanRepo();
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  const prompt = writer?.prompt ?? "";
  assert.match(prompt, /EXPECTED and IN-CONTRACT/);
  assert.match(prompt, /produced by prior stages/);
  assert.match(prompt, /editable boundary/);
  assert.match(prompt, /Never return needs_decision or blocked for path scope/);
  assert.match(prompt, /docs\/VISION\.md/);
  assert.match(prompt, /docs\/ARCHI\.md/);
  assert.doesNotMatch(prompt, /Read VISION\.md, ARCHI\.md/);
  assert.doesNotMatch(prompt, /do not guess outside the frozen contract/);
  const research = result.manifest.stages.find((stage) => stage.id === "research");
  assert.match(research?.prompt ?? "", /docs\/VISION\.md/);
  assert.match(research?.prompt ?? "", /docs\/ARCHI\.md/);
});

test("worktree writer prompt describes an isolated clean-base checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-worktree-prompt-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }));
  const plan = path.join(root, "plan.md");
  await writeFile(plan, `# Parallel

### Slice A [parallel]

**Files**: src/a.ts

**Parallel-safe**: yes

Implement A and its ripple.

### Slice B [parallel]

**Files**: app/b.ts

**Parallel-safe**: yes

Implement B and its ripple.
`, "utf8");
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "parallel" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  const prompt = writer?.prompt ?? "";
  assert.match(prompt, /isolated worktree branched from a clean base/);
  assert.match(prompt, /editable boundary/);
});

test("permissive policy keeps a repository-root claim concrete instead of granting the whole repo", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "trip-root-claim-"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }));
  const plan = path.join(repo, "plan.md");
  await writeFile(plan, `# Root

### Phase — Server

**Files**: server.ts

Edit the root server entrypoint.
`, "utf8");
  const result = await compilePlanFile(plan, { workingDirectory: repo, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.allowedPaths, ["server.ts"]);
  assert.ok(!writer?.allowedPaths?.includes("**"));
  assert.ok(!writer?.allowedPaths?.includes("./**"));
});

// --- Slice 1: the Targeted Validation fence is the validation contract ---

async function fencePlanRepo(plan: string): Promise<{ root: string; plan: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trip-fence-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo test" } }));
  const planPath = path.join(root, "plan.md");
  await writeFile(planPath, plan, "utf8");
  return { root, plan: planPath };
}

test("fence commands are taken verbatim and prose never adds commands once a fence exists", async () => {
  const { root, plan } = await fencePlanRepo(`# Fence contract

### Slice 1 — Types

**Files**: \`src/a.ts\`

**Parallel-safe**: no

Do the work.

**Acceptance Criteria**:
- \`npm test\` passes with both tests green.

**Targeted Validation**:
\`\`\`sh
# type check first
npx tsc --noEmit
$ node --experimental-strip-types scripts/check.ts
\`\`\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.validationCommands, ["npx tsc --noEmit", "node --experimental-strip-types scripts/check.ts"]);
  assert.deepEqual(result.manifest.settings?.finalValidationCommands, ["npx tsc --noEmit", "node --experimental-strip-types scripts/check.ts"]);
  assert.equal(result.warnings.some((warning) => /no Targeted Validation fence/.test(warning)), false);
});

test("a declared Targeted Validation label with an empty fence fails compilation unless unresolved slices are allowed", async () => {
  const { root, plan } = await fencePlanRepo(`# Empty fence

### Slice 1 — Types

**Files**: \`src/a.ts\`

**Targeted Validation**:
\`\`\`sh
\`\`\`
`);
  await assert.rejects(
    compilePlanFile(plan, { workingDirectory: root, mode: "serial" }),
    /Targeted Validation is declared but no command was extracted:\n- Slice 1 — Types/,
  );
  const lenient = await compilePlanFile(plan, { workingDirectory: root, mode: "serial", allowUnresolved: true });
  const writer = lenient.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.validationCommands, []);
  assert.ok(lenient.warnings.some((warning) => /Slice 1 — Types: Targeted Validation fence yielded no commands/.test(warning)));
});

test("a slice without a Targeted Validation label keeps the loose-scan fallback and warns", async () => {
  const { root, plan } = await fencePlanRepo(`# Loose

### Slice 1 — Types

**Files**: \`src/a.ts\`

- \`npm test\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.validationCommands, ["npm test"]);
  assert.ok(result.warnings.some((warning) => /Slice 1 — Types: no Targeted Validation fence; validation commands came from the loose line scan/.test(warning)));
});

test("backticked Files entries produce bare claims that directory-glob allowed paths cover", async () => {
  const { root, plan } = await fencePlanRepo(`# Backticks

### Slice 1 — Types

**Files**: \`src/a.ts\`, \`tests/a.test.ts\`

**Allowed paths**:
- src/**
- tests/**

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "serial" });
  const writer = result.manifest.stages.find((stage) => stage.type === "implementation");
  assert.deepEqual(writer?.claimedPaths, ["src/a.ts", "tests/a.test.ts"]);
  assert.deepEqual(writer?.allowedPaths, ["src/**", "tests/**"]);
});

// --- Slice 6: wave-aware compilation behind a flag ---

const WAVE_PLAN = `# Waves

### Slice A

**Files**: \`src/a.ts\`

**Parallel-safe**: yes

Do A.

**Targeted Validation**:
\`\`\`sh
npm run check
\`\`\`

### Slice B

**Files**: \`src/b.ts\`

**Parallel-safe**: yes

Do B.

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`

### Slice C

**Files**: \`src/c.ts\`

**Parallel-safe**: yes

**Needs**:
- Slice A
- Slice B

Do C on top of A and B.

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`
`;

test("the bold Parallel-safe label is detected without a [parallel] title tag", async () => {
  const { root, plan } = await fencePlanRepo(`# Bold labels

### Slice A

**Files**: \`src/a.ts\`

**Parallel-safe**: yes

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`

### Slice B

**Files**: \`src/b.ts\`

**Parallel-safe:** yes

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto" });
  assert.equal(result.manifest.metadata?.selectedTopology, "worktree-fanout");
});

test("waves mode compiles two parallel slices plus a dependent third into a checkpointed mixed manifest", async () => {
  const { root, plan } = await fencePlanRepo(WAVE_PLAN);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: true });
  const manifest = result.manifest;
  assert.equal(manifest.metadata?.selectedTopology, "mixed");
  assert.deepEqual(manifest.stages.map((stage) => stage.id), ["research", "implement-slice-a", "implement-slice-b", "checkpoint-wave-1", "implement-slice-c", "integrate"]);
  const [, a, b, checkpoint, c, integrate] = manifest.stages;
  assert.equal(a?.isolation, "worktree");
  assert.equal(b?.isolation, "worktree");
  assert.equal(a?.wave, 1);
  assert.equal(a?.baseFrom, undefined);
  assert.equal(checkpoint?.type, "integration");
  assert.equal(checkpoint?.integrationStrategy, "worktree-wave-checkpoint");
  assert.deepEqual(checkpoint?.needs, ["implement-slice-a", "implement-slice-b"]);
  assert.deepEqual(checkpoint?.validationCommands, ["npm run check", "npm test"]);
  assert.deepEqual(checkpoint?.allowedPaths, ["src/**"]);
  assert.equal(c?.isolation, "same-checkout");
  assert.equal(c?.wave, 2);
  assert.ok(c?.needs.includes("checkpoint-wave-1"), `c needs ${JSON.stringify(c?.needs)}`);
  assert.ok((c?.schedulingNotes ?? []).length >= 1, "a serialized writer explains why");
  assert.match((c?.schedulingNotes ?? []).join("\n"), /fewer than two implementation slices/);
  assert.equal(integrate?.integrationStrategy, "same-checkout-finalize");
  assert.deepEqual(integrate?.needs, ["implement-slice-c"]);
  assert.ok(result.warnings.some((warning) => /^serialized: wave 2:/.test(warning)));

  const legacy = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: false });
  assert.equal(legacy.manifest.metadata?.selectedTopology, "same-checkout-serial");
  assert.equal(legacy.manifest.stages.some((stage) => stage.integrationStrategy === "worktree-wave-checkpoint"), false);
});

test("waves mode with a single qualifying wave keeps today's fan-out shape", async () => {
  const { root, plan } = await fencePlanRepo(WAVE_PLAN.split("### Slice C")[0] ?? "");
  const withWaves = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: true });
  const without = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: false });
  assert.equal(withWaves.manifest.metadata?.selectedTopology, "worktree-fanout");
  assert.deepEqual(withWaves.manifest.stages.map((stage) => stage.id), without.manifest.stages.map((stage) => stage.id));
  assert.equal(withWaves.manifest.stages.some((stage) => stage.integrationStrategy === "worktree-wave-checkpoint"), false);
});

test("waves mode serializes a wave that follows a shared-checkout wave and explains it", async () => {
  const { root, plan } = await fencePlanRepo(`# Serial then parallel

### Slice A

**Files**: \`src/a.ts\`

**Parallel-safe**: no

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`

### Slice B

**Files**: \`src/b.ts\`

**Parallel-safe**: yes

**Needs**:
- Slice A

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`

### Slice C

**Files**: \`src/c.ts\`

**Parallel-safe**: yes

**Needs**:
- Slice A

**Targeted Validation**:
\`\`\`sh
npm test
\`\`\`
`);
  const result = await compilePlanFile(plan, { workingDirectory: root, mode: "auto", waves: true });
  assert.equal(result.manifest.metadata?.selectedTopology, "same-checkout-serial");
  const notes = result.manifest.stages.filter((stage) => stage.type === "implementation").flatMap((stage) => stage.schedulingNotes ?? []);
  assert.ok(notes.length >= 1, "serialized writers explain why even when the whole plan stays serial");
  assert.ok(result.warnings.some((warning) => /wave 2 follows a shared-checkout wave/.test(warning)), result.warnings.join("\n"));
});

test("the serial golden fixture recompiles to the same stages, topology and settings", async () => {
  const fixtures = path.resolve(import.meta.dirname, "fixtures");
  const result = await compilePlanFile(path.join(fixtures, "serial-golden.plan.md"), { workingDirectory: fixtures, mode: "serial" });
  const golden = JSON.parse(await readFile(path.join(fixtures, "serial-golden.trip.json"), "utf8")) as typeof result.manifest;
  const shape = (manifest: typeof result.manifest) => JSON.stringify({ stages: manifest.stages, topology: manifest.metadata?.selectedTopology, settings: manifest.settings });
  assert.equal(shape(result.manifest), shape(golden));
});
