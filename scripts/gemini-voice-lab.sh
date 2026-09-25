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
  if [[ -x "$bundled_node" ]]; then node_bin="$bundled_node"; fi
fi
if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found. Set SHANNON_NODE_BIN to a Node.js executable." >&2
  exit 1
fi

command_name="${1:-open}"
case "$command_name" in
  __test)
    shift
    exec "$node_bin" --test scripts/gemini-tts-lab.test.mjs scripts/gemini-voice-lab.test.mjs "$@"
    ;;
  serve)
    shift
    if [[ -f .env ]]; then
      exec "$node_bin" --env-file=.env scripts/gemini-voice-lab-server.mjs "$@"
    fi
    exec "$node_bin" scripts/gemini-voice-lab-server.mjs "$@"
    ;;
  open)
    remote_host="${SHANNON_AZURE_HOST:-azure-constant-server}"
    local_port="${SHANNON_GEMINI_VOICE_LAB_LOCAL_PORT:-4322}"
    remote_port="${SHANNON_GEMINI_VOICE_LAB_REMOTE_PORT:-4322}"
    url="http://127.0.0.1:${local_port}"
    if curl --silent --fail --max-time 1 "${url}/api/config" >/dev/null 2>&1; then
      open "$url"
      echo "Shannon Voice Lab is already available at $url"
      exit 0
    fi
    ssh -o ExitOnForwardFailure=yes -N -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" "$remote_host" &
    tunnel_pid=$!
    trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT INT TERM
    for _ in {1..30}; do
      if curl --silent --fail --max-time 1 "${url}/api/config" >/dev/null 2>&1; then break; fi
      sleep 0.2
    done
    if ! curl --silent --fail --max-time 2 "${url}/api/config" >/dev/null; then
      echo "The private Voice Lab did not become ready through the SSH tunnel." >&2
      exit 1
    fi
    open "$url"
    echo "Shannon Voice Lab opened at $url"
    echo "Keep this terminal open. Press Control-C to close the private tunnel."
    wait "$tunnel_pid"
    ;;
  *)
    echo "Usage: pnpm voice:gemini:web [open|serve]" >&2
    exit 1
    ;;
esac
