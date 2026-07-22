# Security and Trust Model

Prompt-chain hybrid-DAG is a coordination and Git-integrity layer, not a sandbox.

Pi extensions run with the current user's system permissions. Writer agents can invoke shell tools when granted. Path contracts are enforced against the resulting Git delta; they do not prevent reading secrets, network access, or writing outside the repository at the operating-system level.

For unattended use:

- Use a dedicated clone.
- Use a dedicated OS user, container, VM, or micro-VM.
- Do not expose production secrets.
- Restrict network access where practical.
- Use narrow credentials and repository permissions.
- Configure resource and process limits.
- Inspect the package source before installation.
- Keep high-risk release operations human-gated in `VISION.md`.
- Back up the repository and remote before testing crash recovery.

The current implementation allows reviewer agents only read-oriented Pi tools, but exact tool behavior is still determined by the installed Pi version and local extensions.
