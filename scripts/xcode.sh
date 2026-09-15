#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repository_root"

xcodebuild_bin="${SHANNON_XCODEBUILD_BIN:-xcodebuild}"
open_bin="${SHANNON_OPEN_BIN:-open}"
workspace="Shannon.xcworkspace"
profile="${1:-}"

resolve_scheme() {
  local scheme="$1"

  "$xcodebuild_bin" \
    -workspace "$workspace" \
    -scheme "$scheme" \
    -resolvePackageDependencies
}

preflight_workspace() {
  "$xcodebuild_bin" -workspace "$workspace" -list
  resolve_scheme ShannonApp
  resolve_scheme ShannonDesk
}

run_scheme() {
  local scheme="$1"
  local configuration="$2"
  local destination="$3"
  local derived_data="$4"
  local action="$5"

  "$xcodebuild_bin" \
    -workspace "$workspace" \
    -scheme "$scheme" \
    -configuration "$configuration" \
    -destination "$destination" \
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO \
    "$action"
}

case "$profile" in
  ios-debug)
    run_scheme ShannonApp Debug 'generic/platform=iOS' .build/SelfImprovementDerivedData build
    ;;
  ios-release)
    run_scheme ShannonApp Release 'generic/platform=iOS' .build/ReleaseRunnerDerivedData build
    ;;
  mac-debug)
    run_scheme ShannonDesk Debug 'platform=macOS' .build/ShannonDeskDerivedData test
    ;;
  mac-release)
    run_scheme ShannonDesk Release 'generic/platform=macOS' .build/ShannonDeskReleaseDerivedData build
    ;;
  resolve-ios)
    resolve_scheme ShannonApp
    ;;
  resolve-mac)
    resolve_scheme ShannonDesk
    ;;
  preflight)
    preflight_workspace
    ;;
  open)
    preflight_workspace
    "$open_bin" -a Xcode "$repository_root/$workspace"
    ;;
  list)
    "$xcodebuild_bin" -workspace "$workspace" -list
    ;;
  *)
    echo "Usage: scripts/xcode.sh ios-debug|ios-release|mac-debug|mac-release|resolve-ios|resolve-mac|preflight|open|list" >&2
    exit 2
    ;;
esac
