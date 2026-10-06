#!/usr/bin/env bash
# The owner's controls of her value table on the server (Syzygy ADR-0008 stage 1; docs/cognition-ledger-contract.md).
#
#   scripts/shannon-values.sh show                 versions, the active version's cells, calibration, choices by status
#   scripts/shannon-values.sh rollback [--version ID]   back to an earlier version, frozen until resume (an owner action)
#   scripts/shannon-values.sh resume               a version from all the evidence again (an owner action)
#
# Options: --scope <scopeKey> (default SHANNON_OWNER_SCOPE_KEY or owner), --database <path> (default SHANNON_DATABASE_PATH).
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

exec "$node_bin" node_modules/tsx/dist/cli.mjs services/api/scripts/shannon-values.ts "$@"
