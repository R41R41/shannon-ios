#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

node_bin="${SHANNON_NODE_BIN:-}"
if [[ -z "$node_bin" ]] && command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
fi
if [[ -z "$node_bin" ]]; then
  bundled_node="/Users/arairyo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if [[ -x "$bundled_node" ]]; then
    node_bin="$bundled_node"
  fi
fi
if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found. Set SHANNON_NODE_BIN to a Node.js executable." >&2
  exit 1
fi

if [[ "${1:-}" == "__test" ]]; then
  shift
  exec "$node_bin" --test scripts/gemini-tts-lab.test.mjs "$@"
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ -f .env ]]; then
  exec "$node_bin" --env-file=.env scripts/gemini-tts-lab.mjs "$@"
fi
exec "$node_bin" scripts/gemini-tts-lab.mjs "$@"
