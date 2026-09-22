---
name: prompt-chain-plan
description: Create and review a file-specific implementation plan, then compile it into a validated Prompt-chain hybrid DAG. Use for non-trivial features, fixes, refactors, and multi-slice implementations.
---

# Prompt-chain hybrid Planning

Plan first; do not implement code in this skill.

## Read first

Read, when present:

1. `docs/VISION.md`
2. `docs/ARCHI.md`
3. `AGENTS.md` or `CLAUDE.md`
4. Relevant code and tests

## Clarify

Summarize the intended behavior, then ask only questions that materially affect scope, behavior, constraints, or risk. Use at most three rounds. When no blocking ambiguity remains, proceed with explicit assumptions.

## Write the plan

Create `docs/plans/<feature>.plan.md` with:

- Overview and problem statement
- Solution architecture
- Non-goals
- Risks and rollback considerations
- Test impact
- Exact implementation slices

Every implementation slice must contain:

```markdown
### Slice N — Name

**Files**: `relative/path.ts`, `relative/other.ts`

**Parallel-safe**: yes|no

**Allowed paths**:
- relative/**

Describe the complete bounded change.

**Needs**:
- prior-slice-id

**Acceptance Criteria**:
- observable behavior

**Targeted Validation**:
```sh
exact command
```
```

Never invent a path. If the repository evidence is insufficient, mark the slice unresolved and stop before compilation.

Declare `Parallel-safe: yes` only when the slice can start from the same Git base as its siblings, has concrete non-overlapping paths, does not depend on their edits, and avoids manifests, lockfiles, migrations, shared schemas/types, root configuration, auth policy, or generated snapshots.

### Path contracts and allowed paths

A slice's `**File**:` / `**Files**:` list is its concrete **claim** — the files it owns, used for overlap detection and parallel-safety. Its **allowed paths** are the editable boundary the writer agent is held to. The two are different, and the difference is the single most common cause of a stage that does correct work but then blocks.

- **Default is permissive.** With no explicit `**Allowed paths**` list, the compiler grants each slice the *directory globs* of its claimed files (a claim on `convex/auth.ts` grants `convex/**`). This lets the writer update the sibling fixtures, generated code, and related tests its change ripples into — without pausing. Claims stay concrete, so parallel-safety analysis is unchanged.
- **Prefer directory globs over exact file lists.** Declare `**Allowed paths**` explicitly only to set a deliberate boundary (usually one or more directory globs such as `convex/**`). An over-narrow allowed-path list forces the writer to treat a required ripple — a shared fixture, a generated file, a schema change carried in from an earlier serial stage — as "outside its contract," and it will block instead of finishing.
- **Serial stages inherit the tree.** In a same-checkout serial chain, each stage runs on top of the previous stage's *uncommitted* changes. That is by design: later stages build on earlier schema/helper/fixture edits, and the writer prompt tells them so. Do not re-list a prior stage's files in a later slice to "re-authorize" them — they are already in-contract.
- **`--path-policy strict`** pins allowed paths to exactly the claimed files. Use it only when you deliberately want hard per-file isolation, and expect more pauses.

### The Targeted Validation fence is the contract

When a slice has a `**Targeted Validation**:` label followed by a `sh`/`bash`
fence, every non-blank, non-comment line in that fence becomes a stage
validation command, verbatim and in order. There is no allowlist: a TypeScript
compiler invocation, a Node script, or a project-specific check all survive
exactly as written. Nothing outside the fence contributes to that slice's
commands, so command-like prose in **Acceptance Criteria** is harmless once a
fence exists.

Two rules follow:

- A slice that declares the label but whose fence yields no command **fails
  compilation** naming the slice. Under `--allow-unresolved` it compiles with an
  author warning and no stage commands. Either way the gap is visible, never
  silent.
- A slice with **no** Targeted Validation label falls back to the loose scan:
  allowlisted command-like lines (`npm test`, `pnpm lint`, `cargo test`, …)
  anywhere in the body, including bullets. That scan can mis-capture prose such
  as `` `npm test` passes with both tests green. `` as a malformed command, so
  for fence-less slices describe outcomes in prose without backticked commands,
  or better, add the fence.

The document-level final validation commands are the deduped union of every
Targeted Validation fence in the plan; only a plan with no fence at all falls
back to the loose scan and then to package scripts.

After compiling, inspect the emitted manifest's `validationCommands` per stage
(or run `/prompt-chain-inspect`) and confirm each command is real, complete, and
singular before approving the plan. A corrupted or duplicated command is a plan
or compiler defect: fix the wording and recompile; never approve a manifest with
a command that cannot possibly pass.

## Independent plan review

Use a fresh read-only reviewer session or subagent. Require one verdict:

- `APPROVED`
- `REQUEST_CHANGES`
- `NEEDS_REWORK`
- `NEEDS_DECISION`

Address legitimate findings and rerun review. A review cap without approval does not authorize implementation.

## User approval

Present the approach, files, risks, test impact, and reviewer status. Obtain approval for the plan.

## Compile and validate

Use the installed Pi commands:

```text
/prompt-chain-compile docs/plans/<feature>.plan.md --out docs/plans/<feature>.trip.json --working-directory . --mode auto
/prompt-chain-validate docs/plans/<feature>.trip.json
```

For a headless shell with the package linked through `npm link`, the equivalent commands are:

```sh
prompt-chain compile docs/plans/<feature>.plan.md \
  --out docs/plans/<feature>.trip.json \
  --working-directory "$PWD" \
  --mode auto
prompt-chain validate docs/plans/<feature>.trip.json
```

Forced parallel mode must fail rather than silently serialize when independence is not proven.

## Final response

Report:

- Plan path
- Manifest path
- Selected topology
- Stage and writer counts
- Parallelization reasons or blockers
- Targeted and final validation commands
- High-risk or unresolved paths
- Canonical validation result
- Implementation command: `/prompt-chain-run <manifest>`
