#!/usr/bin/env bash
# The people migration of Syzygy ADR-0008 stage 3, step F6 (docs/mind-workspace-contract.md), as a dry-run only:
#
#   scripts/shannon-people-migration.sh --dry-run [--scope <scopeKey>] [--database <path>] [--json]
#
# Read-only: prints, per person, which impressions would change status with two-clock decay (SHANNON_EVIDENCE_DECAY, which
# stays off until the owner has seen this), and how many rows the additive temporal backfill would give their columns.
# Nothing is changed. Back up the production database before any switch of stage 3 is turned on (docs/self-improvement-runbook.md).
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

exec "$node_bin" node_modules/tsx/dist/cli.mjs services/api/scripts/peopleMigrationDryRun.ts "$@"
