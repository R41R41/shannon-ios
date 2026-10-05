#!/usr/bin/env bash
# Reach measures (Syzygy ADR-0003): fixed scenarios judged from outside, and counts from use.
#
#   scripts/reach-measures.sh run                    model-free: free, deterministic, writes artifacts/reach/
#   scripts/reach-measures.sh run --live             prints the estimated cost of a real-model run; spends nothing
#   scripts/reach-measures.sh run --live --yes       the real-model run (billable; ask the owner first)
#   scripts/reach-measures.sh compare A.json B.json  version-to-version comparison
#   scripts/reach-measures.sh usage COPY.sqlite      counts and rates from a copy of the production database
#
# See docs/testing/reach-measures-runbook.md.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

node_bin="${SHANNON_NODE_BIN:-}"
if [[ -z "$node_bin" ]] && command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
fi
if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found. Set SHANNON_NODE_BIN to a Node.js executable." >&2
  exit 1
fi

revision="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  revision="${revision}-dirty"
fi

# Credentials are read only for a live run, from the ignored .env, after the model-free pass, and only by the
# model adapters (services/api/tests/reach/reachCli.ts loads it).
exec "$node_bin" node_modules/tsx/dist/cli.mjs services/api/tests/reach/reachCli.ts "$@" --revision "$revision"
