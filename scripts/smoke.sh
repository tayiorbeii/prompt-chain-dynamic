#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm test
node --experimental-strip-types bin/trip-validate.ts examples/example.trip.json

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp examples/example.plan.md "$tmp/plan.md"
printf '{"scripts":{"test":"echo test","typecheck":"echo typecheck"}}\n' > "$tmp/package.json"
node --experimental-strip-types bin/trip-compile.ts "$tmp/plan.md" \
  --out "$tmp/plan.trip.json" \
  --working-directory "$tmp" \
  --mode auto
node --experimental-strip-types bin/trip-validate.ts "$tmp/plan.trip.json"

echo "Smoke test passed."
