/**
 * Research campaign: how comparable open-source projects solve the defects
 * found in the 2026-09-22 prompt-chain-dynamic review.
 *
 * Uses the research-orchestrator planning kit library API with structured
 * hints (exact code signals) so probes target source files, not README prose.
 *
 * Run:  bun scripts/research-fix-patterns.ts [slug ...]
 * Env:  set -a; source "$KIT/.env"; set +a  (then RESEARCH_OCTOCODE_BRIDGE absolute)
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const KIT = process.env.RESEARCH_ORCHESTRATOR_KIT
  ?? "/Users/taylor/Documents/Projects/00-in-progress/research_orchestrator_planning_kit";

const { resolveOctocodeProvider } = await import(`${KIT}/dist/adapters/bridge.js`);
const { runResearch } = await import(`${KIT}/dist/core/pipeline.js`);
const { writeArtifacts } = await import(`${KIT}/dist/core/writeArtifacts.js`);

const outRoot = resolve("docs/research");

interface Campaign {
  slug: string;
  goal: string;
  hints: Record<string, unknown>;
}

const campaigns: Campaign[] = [
  {
    slug: "pcd-v2-review-loop-convergence",
    goal: "Agentic coding loop that re-verifies after every worker iteration and detects a stuck or non-progressing agent instead of trusting the worker's self-reported status.",
    hints: {
      featureKey: "agent-loop-stuck-detection",
      feature: "stuck detection and re-verification in an autonomous coding agent loop",
      goalKind: "application",
      stack: ["Python", "TypeScript"],
      libraries: [],
      providers: [],
      mustHave: ["stuck detector", "repeated action/observation detection", "reflection cap", "independent verification each iteration"],
      shouldHave: ["diff-based progress check", "max reflections", "loop detector"],
      exclude: ["documentation-only", "prompt collections"],
      requiredConcepts: ["StuckDetector", "is_stuck", "max_reflections", "reflected_message", "_is_stuck_repeating_action_observation", "loop_detector"],
      likelyFiles: [
        "openhands/controller/stuck.py",
        "openhands/controller/agent_controller.py",
        "aider/coders/base_coder.py",
        "sweagent/run/hooks",
        "src/loop.ts",
      ],
      proofRequirements: [
        { key: "stuck_detection", description: "Loop detects repeated identical actions/observations or no progress and intervenes.", required: true, signals: ["StuckDetector", "is_stuck", "_is_stuck_repeating_action_observation", "loop_detector"] },
        { key: "reflection_cap", description: "Worker self-reports (reflections) are capped rather than trusted indefinitely.", required: true, signals: ["max_reflections", "reflected_message", "num_reflections"] },
      ],
    },
  },
  {
    slug: "pcd-v2-markdown-command-extraction",
    goal: "Task runner that parses runnable shell commands from fenced code blocks in markdown files and executes them, with explicit handling of blocks that yield no commands.",
    hints: {
      featureKey: "markdown-fenced-command-runner",
      feature: "markdown fenced code block command extraction and execution",
      goalKind: "application",
      stack: ["Go", "Rust", "TypeScript"],
      libraries: ["goldmark", "pulldown-cmark", "remark", "markdown-it"],
      providers: [],
      mustHave: ["fence parsing", "language tag handling", "command execution", "empty block handling"],
      shouldHave: ["allowlist of shells", "line continuation", "error on unrunnable block"],
      exclude: ["static site generators", "documentation-only"],
      requiredConcepts: ["CodeBlock", "FencedCodeBlock", "maskfile", "xcfile", "runme", "info string", "language"],
      likelyFiles: ["parser.go", "src/parser.rs", "internal/document/parser.go", "pkg/document/block.go", "src/parser/mod.rs", "README.md"],
      proofRequirements: [
        { key: "fence_extraction", description: "Fenced code blocks are located and their info string/language is read to decide runnability.", required: true, signals: ["FencedCodeBlock", "CodeBlock", "info string", "Fenced"] },
        { key: "execution", description: "Extracted block content is executed as a shell command.", required: true, signals: ["exec.Command", "Command::new", "spawn", "sh -c", "bash -c"] },
      ],
    },
  },
  {
    slug: "pcd-v2-dag-bounded-pool",
    goal: "Task graph executor in TypeScript or Rust that runs a dependency DAG with a bounded concurrency pool, backfills as tasks finish, and supports tasks marked to run exclusively.",
    hints: {
      featureKey: "dag-bounded-concurrency-executor",
      feature: "DAG task orchestration with bounded concurrency and exclusive tasks",
      goalKind: "application",
      stack: ["TypeScript", "Rust"],
      libraries: ["p-graph", "p-queue"],
      providers: [],
      mustHave: ["dependency graph walk", "max concurrency", "sliding pool", "exclusive or persistent tasks"],
      shouldHave: ["priority ordering", "cancellation on failure", "per-task concurrency"],
      exclude: ["documentation-only", "cron schedulers"],
      requiredConcepts: ["maxConcurrency", "TaskOrchestrator", "concurrency", "persistent", "runInParallel", "Walker", "in_flight", "parallelism"],
      likelyFiles: [
        "packages/nx/src/tasks-runner/task-orchestrator.ts",
        "packages/nx/src/tasks-runner/tasks-schedule.ts",
        "src/execution/executor.ts",
        "packages/p-graph/src/index.ts",
        "crates/turborepo-lib/src/task_graph/visitor.rs",
        "crates/turborepo-lib/src/engine/execute.rs",
        "packages/lage/src/runners",
      ],
      proofRequirements: [
        { key: "bounded_pool", description: "Executor caps in-flight tasks and starts the next ready task when one completes.", required: true, signals: ["maxConcurrency", "concurrency", "parallelism", "in_flight"] },
        { key: "exclusive_tasks", description: "Some tasks are marked to run alone (persistent/exclusive/serial) alongside parallel ones.", required: true, signals: ["persistent", "exclusive", "serial", "parallelism: false"] },
      ],
    },
  },
  {
    slug: "pcd-v2-parallel-safety-declarations",
    goal: "Build tool that parses per-task dependency declarations into DAG edges and reports why a task was serialized, rather than serializing the whole graph when any dependency exists.",
    hints: {
      featureKey: "dependson-dag-edges",
      feature: "dependsOn parsing into task graph edges with serialization reasons",
      goalKind: "application",
      stack: ["TypeScript", "Rust", "Go"],
      libraries: [],
      providers: [],
      mustHave: ["dependsOn parsing", "edge insertion", "topological ordering", "diagnostic for serialized tasks"],
      shouldHave: ["caret ^dependency syntax", "cycle detection", "persistent task rule"],
      exclude: ["documentation-only"],
      requiredConcepts: ["dependsOn", "TaskDependency", "topological", "addEdge", "add_edge", "cycle", "persistent", "^build"],
      likelyFiles: [
        "crates/turborepo-lib/src/engine/builder.rs",
        "packages/nx/src/tasks-runner/create-task-graph.ts",
        "packages/nx/src/tasks-runner/utils.ts",
        "crates/moon_task_graph/src/task_graph_builder.rs",
        "wireit/src/analyzer.ts",
      ],
      proofRequirements: [
        { key: "edges_from_dependson", description: "Declared dependencies become graph edges, not a global serialization switch.", required: true, signals: ["dependsOn", "addEdge", "add_edge", "TaskDependency"] },
        { key: "cycle_and_order", description: "Graph is validated (cycles) and ordered topologically for execution.", required: true, signals: ["topological", "cycle", "toposort"] },
      ],
    },
  },
  {
    slug: "pcd-v2-lease-heartbeat-liveness",
    goal: "Job queue or workflow worker that keeps a lock or lease alive with heartbeats while a long job runs, and recovers stalled jobs whose lease expired, without a fixed wall-clock job timeout.",
    hints: {
      featureKey: "job-lock-renewal-stalled-recovery",
      feature: "lock renewal heartbeat and stalled job recovery",
      goalKind: "application",
      stack: ["TypeScript", "Go", "Python"],
      libraries: ["bullmq", "graphile-worker", "temporalio"],
      providers: [],
      mustHave: ["lock renewal timer", "stalled detection", "reclaim on expiry", "heartbeat from activity"],
      shouldHave: ["renewal jitter", "max stalled count", "heartbeat timeout distinct from job timeout"],
      exclude: ["documentation-only", "cron-only schedulers"],
      requiredConcepts: ["lockDuration", "extendLock", "stalledInterval", "moveStalledJobsToWait", "heartbeatTimeout", "heartbeat", "maxStalledCount", "lockRenewTime"],
      likelyFiles: [
        "src/classes/worker.ts",
        "src/classes/job.ts",
        "src/classes/scripts.ts",
        "packages/worker/src/worker.ts",
        "packages/activity/src/index.ts",
        "src/main.ts",
      ],
      proofRequirements: [
        { key: "lock_renewal", description: "Worker periodically extends the job lock while the job is active.", required: true, signals: ["extendLock", "lockRenewTime", "lockDuration", "heartbeat"] },
        { key: "stalled_recovery", description: "A separate checker detects expired locks and re-queues or fails the job.", required: true, signals: ["stalledInterval", "moveStalledJobsToWait", "maxStalledCount", "heartbeatTimeout"] },
      ],
    },
  },
];

const only = new Set(process.argv.slice(2));
const selected = only.size ? campaigns.filter((c) => only.has(c.slug)) : campaigns;

const provider = await resolveOctocodeProvider({ requireConfigured: true, maxResultsPerProbe: 10 });

for (const campaign of selected) {
  const outDir = resolve(outRoot, campaign.slug);
  await mkdir(outDir, { recursive: true });
  const startedAt = Date.now();
  console.log(`\n=== ${campaign.slug} ===`);
  try {
    const { run, evidence, pattern } = await runResearch({
      goal: campaign.goal,
      provider,
      hints: campaign.hints as never,
      maxCandidates: 20,
      maxReposToProve: 8,
    });
    await writeArtifacts(run, outDir, { evidence, pattern });
    // Run status is derived at artifact-write time; read it from research.md / evidence.json.
    const selectedRepos = ((run as { selectedRepos?: unknown[] }).selectedRepos ?? []).length;
    console.log(`selected=${selectedRepos} anchors=${evidence.length} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s (status: see ${outDir}/research.md)`);
    for (const warning of (run as { warnings?: string[] }).warnings ?? []) console.log(`  warn: ${warning}`);
    console.log(`  out: ${outDir}`);
  } catch (error) {
    console.log(`FAILED after ${Math.round((Date.now() - startedAt) / 1000)}s: ${error instanceof Error ? error.message : String(error)}`);
  }
}
