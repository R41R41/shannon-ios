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
  "$node_bin" scripts/check-semantic-role-map.mjs
  run_architecture
}

run_ios() {
  swift test --package-path apps/ios
}

run_app() {
  xcodebuild \
    -project apps/ios-app/ShannonApp.xcodeproj \
    -scheme ShannonApp \
    -configuration Debug \
    -destination 'generic/platform=iOS' \
    -derivedDataPath .build/SelfImprovementDerivedData \
    CODE_SIGNING_ALLOWED=NO \
    build
}

run_release_app() {
  xcodebuild \
    -project apps/ios-app/ShannonApp.xcodeproj \
    -scheme ShannonApp \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath .build/ReleaseRunnerDerivedData \
    CODE_SIGNING_ALLOWED=NO \
    build
}

run_macos_app() {
  xcodebuild \
    -project apps/macos-app/ShannonDesk.xcodeproj \
    -scheme ShannonDesk \
    -configuration Debug \
    -destination 'platform=macOS' \
    -derivedDataPath .build/ShannonDeskDerivedData \
    CODE_SIGNING_ALLOWED=NO \
    test
}

run_release_macos_app() {
  xcodebuild \
    -project apps/macos-app/ShannonDesk.xcodeproj \
    -scheme ShannonDesk \
    -configuration Release \
    -destination 'generic/platform=macOS' \
    -derivedDataPath .build/ShannonDeskReleaseDerivedData \
    CODE_SIGNING_ALLOWED=NO \
    build
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
    echo "Usage: scripts/verify.sh [fast|architecture|api|ios|app|mac|mac-release|release|release-runner|all]" >&2
    exit 2
    ;;
esac
