#!/usr/bin/env bash
set -euo pipefail
cat <<'TXT'
Remove the package reference with Pi:

  pi remove /absolute/path/to/prompt-chain-hybrid-dag

For a project-local install, run the command from that project with Pi's local settings option as appropriate, or remove the package entry from `.pi/settings.json`.

This script intentionally does not delete project docs or `.pi/prompt-chain-hybrid/runs/` because they may contain audit evidence.
TXT
