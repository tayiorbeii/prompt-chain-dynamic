---
name: prompt-chain-release
description: Release a completed Prompt-chain hybrid run after verifying the result commit, review evidence, quality gates, documentation, and risk policy.
---

# Prompt-chain hybrid Release

Release only a run whose durable state is `completed`.

## Verify the run

Use:

```text
/prompt-chain-status <run-id>
```

Confirm:

- Status is `completed`
- Open blocking findings are zero
- A result commit is recorded when auto-commit was enabled
- Final validation passed
- Aggregate review completed
- No worktree or workspace drift remains

Inspect `.pi/prompt-chain-hybrid/runs/<run-id>/` for the manifest, event log, findings, decisions, stage evidence, patches, validation, reviews, and integration journal.

## Risk gate

Read `docs/VISION.md`. Require explicit human release approval for high-risk categories named there, including auth, billing, deletion, migrations, secrets, dependencies, public API breaks, infrastructure, or irreversible effects.

Agent decisions made during implementation do not automatically authorize release risk.

## Documentation

Update only documentation materially affected by the implementation:

- `docs/ARCHI.md` for architectural changes
- Changelog/release notes
- User-facing documentation
- Known test debt or operational follow-up

## Git safety

Do not run unrestricted `git add -A` over an unverified checkout. The Prompt-chain hybrid runtime already creates the scoped implementation commit. Release operations should act on that recorded commit.

Before push:

```sh
git status --short
git show --stat --oneline <result-commit>
git diff --check <result-commit>^ <result-commit>
```

Tag and push only after the applicable human release gate.
