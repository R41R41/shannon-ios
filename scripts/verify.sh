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

run_api() {
  "$node_bin" node_modules/typescript/bin/tsc -p services/api/tsconfig.json --noEmit
  "$node_bin" node_modules/vitest/vitest.mjs run services/api/tests
}

run_architecture() {
  "$node_bin" scripts/check-architecture.mjs
}

run_fast() {
  "$node_bin" scripts/check-harness.mjs
  "$node_bin" --test scripts/check-xcode-workspace.test.mjs
  "$node_bin" scripts/check-xcode-workspace.mjs
  "$node_bin" scripts/check-app-icons.mjs
  "$node_bin" scripts/check-semantic-role-map.mjs
  run_architecture
}

run_ios() {
  swift test --package-path apps/ios
}

run_app() {
  scripts/xcode.sh ios-debug
}

run_release_app() {
  scripts/xcode.sh ios-release
}

run_macos_app() {
  scripts/xcode.sh mac-debug
}

run_macos_launch_smoke() {
  run_macos_app
  scripts/smoke-macos-inspector-launch.sh
}

run_release_macos_app() {
  scripts/xcode.sh mac-release
}

run_release_runner() {
  "$node_bin" --test scripts/release-runner.test.mjs
}

target="${1:-all}"
case "$target" in
  fast) run_fast ;;
  architecture) run_architecture ;;
  api) run_fast; run_api ;;
  ios) run_fast; run_ios ;;
  app) run_fast; run_app ;;
  mac) run_fast; run_macos_app ;;
  mac-smoke) run_fast; run_macos_launch_smoke ;;
  mac-release) run_release_macos_app ;;
  release) run_release_app ;;
  release-runner) run_release_runner ;;
  all)
    run_fast
    run_api
    run_ios
    run_app
    run_macos_app
    run_release_runner
    ;;
  *)
    echo "Usage: scripts/verify.sh [fast|architecture|api|ios|app|mac|mac-smoke|mac-release|release|release-runner|all]" >&2
    exit 2
    ;;
esac
