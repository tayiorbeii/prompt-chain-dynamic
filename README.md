# Prompt-Chain Dynamic Runtime

A Pi package that keeps **prompt-chain JSON as the canonical implementation contract** while using **pi-dynamic-workflows** to execute implementation, review, repair, research, integration, and decision-agent sessions.

The package combines four layers:

1. Markdown-first implementation planning.
2. A compiled, schema-validated prompt-chain JSON DAG.
3. Per-stage lifecycle state machines with mandatory feedback closure.
4. Git-aware worktree, patch, validation, checkpoint, and scoped-commit transactions.

`pi-dynamic-workflows` supplies typed Pi subagents, model routing, structured output, and agent-session persistence. It does not own the implementation graph or Git promotion.

## Interaction model

```text
implementation guide / plan.md
        ↓ prompt-chain compile
*.prompt-chain.json
        ↓ prompt-chain run
DAG scheduler + stage state machines
        ↓
pi-dynamic-workflows WorkflowAgent sessions
        ↓
Git verification, patch capture, integration and commit
```

Humans normally author Markdown. JSON is the frozen machine contract and may also be authored directly when desired.

## Implemented guarantees

- Acyclic stage dependencies through `needs`.
- Read-only, same-checkout writer, worktree writer, and integration stages.
- Concrete `claimedPaths` and constrained `allowedPaths`.
- Conservative parallel compilation: only an explicitly safe same-base worktree wave.
- Strict worktree creation owned by this runtime; no fallback to parallel shared-checkout writing.
- Direct agent commits rejected.
- Actual Git changes checked against the stage path contract.
- Required outputs and validation commands checked before review completion.
- Typed structured output through `WorkflowAgent` and TypeBox.
- Free-form corrective feedback defaults to `continue`, never completion.
- Durable blocking finding ledger and same-stage repair loop.
- Fresh independent reviewer ensemble after each repair.
- Agent decisions by default; `--human-decisions` pauses after an agent recommendation.
- Verified binary patch capture and SHA-256 hashing.
- Deterministic fan-in and runtime-owned scoped result commit.
- Run state, findings, decisions, patches and integration journals under `.pi/prompt-chain-hybrid/runs/`.
- Optional append-only JSONL issue controller.

## Requirements

- Node.js 22.19 or newer is recommended by current Pi packages.
- Git.
- Pi coding agent 0.80.8 or newer.
- An authenticated model available to Pi.

## Install for development

```sh
unzip prompt-chain-dynamic-runtime-0.2.0.zip
cd prompt-chain-dynamic-runtime
npm install
npm test
```

Install into one project first:

```sh
cd /path/to/target-repository
pi install -l /absolute/path/to/prompt-chain-dynamic-runtime
```

Restart Pi or run `/reload`.

Initialize project policy files:

```sh
bash /absolute/path/to/prompt-chain-dynamic-runtime/scripts/install.sh "$PWD"
```

Review and commit:

```text
docs/VISION.md
docs/ARCHI.md
docs/QUALITY-GATES.json
docs/REVIEW-CHECKLIST.md
.gitignore
```

## Pi commands

```text
/prompt-chain-compile <plan.md> [--out file.prompt-chain.json] [--mode auto|serial|parallel]
/prompt-chain-inspect <file.prompt-chain.json>
/prompt-chain-validate <file.prompt-chain.json>
/prompt-chain-run <file.prompt-chain.json> [--human-decisions]
/prompt-chain-status [run-id]
/prompt-chain-resume [run-id]
/prompt-chain-decide <run-id> <choice> :: <rationale>
/prompt-chain-abort [run-id]
```

Optional issue-loop commands:

```text
/prompt-chain-issue-add <issues.jsonl> <title> :: <manifest> :: <priority>
/prompt-chain-issues <issues.jsonl>
/prompt-chain-loop-once <issues.jsonl> [--human-decisions]
/prompt-chain-loop-resume <issues.jsonl> <issue-id>
```

Skills:

```text
/skill:prompt-chain-plan
/skill:prompt-chain-implement
/skill:prompt-chain-release
```

## Shell CLI

```sh
npm link

prompt-chain compile docs/plans/feature.plan.md \
  --out docs/plans/feature.prompt-chain.json \
  --mode auto

prompt-chain inspect docs/plans/feature.prompt-chain.json
prompt-chain validate docs/plans/feature.prompt-chain.json
prompt-chain run docs/plans/feature.prompt-chain.json --human-decisions
prompt-chain status <run-id>
```

## Authoring a plan

```markdown
# Stable cluster ordering

### Slice 1 — Preserve parent order

**File**: `src/features/clusters/parent-order.ts`

**Parallel-safe**: no

Keep the initial parent order stable while displayed counts update.

**Acceptance Criteria**:
- Excluding children does not reorder parents.
- Re-including children does not reorder parents.
- Counts continue to update.

**Targeted Validation**:
```sh
npm test -- src/features/clusters/parent-order.test.ts
npm run typecheck
```
```

Compilation freezes:

- Source-plan hash.
- Policy-document hashes when present.
- Fully expanded graph and path contracts.
- Selected topology and warnings.
- Runtime engine declaration.
- Contract hash.

## Agent model routing

A manifest may configure dynamic-workflows model tiers or explicit models:

```json
{
  "settings": {
    "modelRouting": {
      "persistAgentSessions": true,
      "roleTiers": {
        "research": "small",
        "implementation": "medium",
        "repair": "medium",
        "review": "medium",
        "decision": "big",
        "integration": "big"
      }
    }
  }
}
```

The user's `~/.pi/workflows/model-tiers.json` determines which concrete models back these tiers.

## Feedback closure

The runtime does not equate a successful session with a successful stage.

```text
agent output
  → structured normalization
  → deterministic validation
  → reviewer ensemble
  → open blocking findings?
       yes: focused repair of the same stage
       no: capture durable artifact and checkpoint
```

Repair exhaustion pauses as `review_blocked`. It never promotes the latest attempt merely because the loop limit was reached.

## Decision policy

Default:

```text
needs_decision → decision agent → implementation direction → repair → validation → review
```

Human mode:

```text
needs_decision → decision agent recommendation → durable pause → human choice → resume
```

A decision supplies direction only. It cannot close the associated implementation finding.

## Parallel writers

Parallel implementation is accepted only when the compiler and validator establish:

- Explicit `Parallel-safe: yes` declarations.
- Non-overlapping concrete claims.
- No dependency between writers.
- No recognized high-risk shared path.
- A common immutable Git base.
- A downstream worktree fan-in integration stage.

The runtime creates the worktrees itself and passes their exact `cwd` to `WorkflowAgent`. It intentionally does not use dynamic-workflows' throwaway worktree option for implementation writers.

## Validation

```sh
npm test
npm run smoke
npm pack --dry-run
```

Current automated suite: 21 tests, including real temporary Git repositories and worktrees.

## Important limitations

- The package has not been exercised here against a real authenticated model session.
- Only one same-base parallel writer wave is supported.
- The issue controller is local JSONL, not a GitHub/Linear adapter.
- There is no dedicated combined TUI; Pi commands expose status while dynamic-workflows persists agent sessions.
- This is not an OS sandbox. Installed Pi packages and agents operate with the user's permissions.
- Dynamic-workflows journal replay is not used as proof of code completion; Git evidence remains authoritative.

See [Architecture](docs/ARCHITECTURE.md), [Project creation](docs/PROJECT-CREATION.md), [Acceptance gates](docs/ACCEPTANCE-GATES.md), and [Implementation status](docs/IMPLEMENTATION-STATUS.md).
