#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/project" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$(cd "$1" && pwd)"

mkdir -p "$TARGET/docs/plans"
copy_if_missing() {
  local source="$1"
  local destination="$2"
  if [ -e "$destination" ]; then
    echo "keep: $destination"
  else
    cp "$source" "$destination"
    echo "create: $destination"
  fi
}

copy_if_missing "$PACKAGE_ROOT/templates/VISION.md" "$TARGET/docs/VISION.md"
copy_if_missing "$PACKAGE_ROOT/templates/ARCHI.md" "$TARGET/docs/ARCHI.md"
copy_if_missing "$PACKAGE_ROOT/templates/QUALITY-GATES.json" "$TARGET/docs/QUALITY-GATES.json"
copy_if_missing "$PACKAGE_ROOT/templates/REVIEW-CHECKLIST.md" "$TARGET/docs/REVIEW-CHECKLIST.md"

mkdir -p "$TARGET/.pi/prompt-chain-hybrid"
cat > "$TARGET/.pi/prompt-chain-hybrid/README.md" <<'TXT'
# Prompt-chain hybrid runtime directory

Run state is written beneath `.pi/prompt-chain-hybrid/runs/` and temporary worktrees beneath `.pi/prompt-chain-hybrid/worktrees/`.

Add runtime data to `.gitignore`; do not commit agent transcripts, patches, or run state unless your audit policy explicitly requires it.
TXT

GITIGNORE="$TARGET/.gitignore"
touch "$GITIGNORE"
if ! grep -qxF '.pi/prompt-chain-hybrid/' "$GITIGNORE"; then
  printf '\n# Prompt-chain hybrid runtime state\n.pi/prompt-chain-hybrid/\n' >> "$GITIGNORE"
  echo "update: $GITIGNORE"
fi

cat <<TXT

Prompt-chain hybrid templates are installed.

Next:
1. Edit docs/VISION.md and docs/ARCHI.md.
2. Replace placeholder quality commands in docs/QUALITY-GATES.json.
3. Review docs/REVIEW-CHECKLIST.md.
4. Commit these project documents.
5. In Pi, run /skill:prompt-chain-plan for a small first canary.
TXT
