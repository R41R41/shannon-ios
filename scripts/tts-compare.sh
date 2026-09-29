#!/usr/bin/env bash
set -euo pipefail
task_repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_repo"
node_bin="${SHANNON_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then node_bin="/Users/arairyo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; fi
case "${1:-open}" in
  test)
    exec "$node_bin" --test scripts/tts-compare.test.mjs
    ;;
  serve)
    if [[ -f .env ]]; then exec "$node_bin" --env-file=.env scripts/tts-compare-server.mjs; fi
    exec "$node_bin" scripts/tts-compare-server.mjs
    ;;
  open)
    demo_port="${SHANNON_TTS_COMPARE_LOCAL_PORT:-4323}"
    [[ "$demo_port" =~ ^[0-9]+$ ]] && (( demo_port >= 1024 && demo_port <= 65535 )) || { echo "Invalid demo port" >&2; exit 1; }
    demo_url="http://127.0.0.1:${demo_port}"
    if curl --silent --fail --max-time 1 "${demo_url}/api/config" | "$node_bin" -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).demo==="shannon-tts-compare"?0:1)}catch{process.exit(1)}})' ; then
      open "$demo_url"
      echo "TTS comparison is available at $demo_url"
      exit 0
    fi
    demo_host="${SHANNON_AZURE_HOST:-azure-constant-server}"
    # Isolated private demo directory. No app service, database, or key is copied.
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$demo_host" 'mkdir -p /home/azureuser/shannon-tts-compare-demo'
    COPYFILE_DISABLE=1 tar --no-xattrs -cf - scripts/tts-compare-core.mjs scripts/tts-compare-server.mjs tools/tts-compare |
      ssh -o BatchMode=yes "$demo_host" 'tar -xf - -C /home/azureuser/shannon-tts-compare-demo'
    ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -L "127.0.0.1:${demo_port}:127.0.0.1:4323" "$demo_host" \
      'cd /home/azureuser/shannon-tts-compare-demo && SHANNON_TTS_COMPARE_PARENT_GUARD=1 SHANNON_TTS_COMPARE_LOCATION=Azure /home/azureuser/shannon-ios-runtime/bin/node --env-file=/home/azureuser/.config/shannon-ios/api.env scripts/tts-compare-server.mjs' &
    demo_pid=$!
    trap 'kill "$demo_pid" 2>/dev/null || true' EXIT INT TERM
    for _ in {1..40}; do
      if curl --silent --fail --max-time 1 "${demo_url}/api/config" >/dev/null 2>&1; then break; fi
      if ! kill -0 "$demo_pid" 2>/dev/null; then echo "The private demo could not start." >&2; exit 1; fi
      sleep .25
    done
    curl --silent --fail --max-time 2 "${demo_url}/api/config" >/dev/null
    open "$demo_url"
    echo "TTS comparison opened at $demo_url"
    echo "Keep this terminal open. Control-C stops the demo and its private tunnel."
    wait "$demo_pid"
    ;;
  *) echo "Usage: bash scripts/tts-compare.sh [open|serve|test]" >&2; exit 1 ;;
esac
