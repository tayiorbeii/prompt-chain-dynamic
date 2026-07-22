# Creating a Project

1. Install and test the package.

```sh
cd /path/to/prompt-chain-dynamic-runtime
npm install
npm test
```

2. Install project-locally.

```sh
cd /path/to/project
pi install -l /path/to/prompt-chain-dynamic-runtime
```

3. Initialize policy documents.

```sh
bash /path/to/prompt-chain-dynamic-runtime/scripts/install.sh "$PWD"
```

4. Customize `docs/VISION.md`, `docs/ARCHI.md`, `docs/QUALITY-GATES.json`, and `docs/REVIEW-CHECKLIST.md`.

5. Create a small plan under `docs/plans/` and compile it.

```text
/prompt-chain-compile docs/plans/canary.plan.md --out docs/plans/canary.prompt-chain.json --mode serial
/prompt-chain-inspect docs/plans/canary.prompt-chain.json
/prompt-chain-validate docs/plans/canary.prompt-chain.json
```

6. First run with human decisions.

```text
/prompt-chain-run docs/plans/canary.prompt-chain.json --human-decisions
```

7. Inspect `.pi/prompt-chain-hybrid/runs/<run-id>/`, the result commit, validation evidence, findings and decisions.

8. Enable autonomous decisions and then parallel writers only after serial canaries pass.
