import type { RunState, TripManifest, TripStage } from "./types.ts";

export function describeManifest(manifest: TripManifest): string {
  const lines = [
    `Plan: ${manifest.name}`,
    `Schema: ${manifest.schemaVersion}`,
    `Topology: ${manifest.metadata?.selectedTopology ?? "unspecified"}`,
    `Stages: ${manifest.stages.length}`,
    `Decision mode: ${manifest.settings?.decisionPolicy?.mode ?? "agent"}`,
    `Maximum concurrency: ${manifest.settings?.maxParallel ?? 1}`,
    "",
    "Graph:",
  ];
  for (const stage of manifest.stages) {
    const detail = [
      `${stage.type}/${stage.isolation}`,
      stage.integrationStrategy,
      stage.wave !== undefined ? `wave ${stage.wave}` : undefined,
      stage.baseFrom ? `base ${stage.baseFrom}` : stage.isolation === "worktree" ? "base run" : undefined,
    ].filter(Boolean).join(" ");
    lines.push(`  ${stage.id} [${detail}] <- ${stage.needs.join(", ") || "root"}`);
    for (const note of stage.schedulingNotes ?? []) lines.push(`      note: ${note}`);
  }
  const writers = manifest.stages.filter((stage) => stage.type === "implementation");
  if (writers.length) {
    lines.push("", "Path claims:");
    for (const stage of writers) {
      lines.push(`  ${stage.id}`);
      for (const claim of stage.claimedPaths ?? []) lines.push(`    - ${claim}`);
    }
  }
  const warnings = manifest.metadata?.authorWarnings ?? [];
  if (warnings.length) lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${warning}`));
  return lines.join("\n");
}

export function describeRun(state: RunState): string {
  const complete = Object.values(state.stageStates).filter((stage) => stage.status === "completed").length;
  const running = Object.values(state.stageStates).filter((stage) => stage.status === "running").map((stage) => stage.id);
  const blockers = state.findings.filter((finding) => finding.blocking && finding.disposition === "open");
  return [
    `Run: ${state.id}`,
    `Status: ${state.status}`,
    `Progress: ${complete}/${state.manifest.stages.length}`,
    `Decision mode: ${state.decisionMode}`,
    `Active: ${running.join(", ") || "none"}`,
    `Open blockers: ${blockers.length}`,
    state.pauseReason ? `Pause reason: ${state.pauseReason}` : undefined,
    state.resultCommit ? `Result commit: ${state.resultCommit}` : undefined,
  ].filter(Boolean).join("\n");
}

export function stageFingerprintInput(stage: TripStage): unknown {
  return {
    id: stage.id,
    type: stage.type,
    needs: stage.needs,
    isolation: stage.isolation,
    prompt: stage.prompt,
    allowedPaths: stage.allowedPaths ?? [],
    claimedPaths: stage.claimedPaths ?? [],
    outputs: stage.outputs ?? [],
    validationCommands: stage.validationCommands ?? [],
    integrationStrategy: stage.integrationStrategy,
  };
}
