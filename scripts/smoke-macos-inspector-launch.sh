#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
app_path="${1:-$repository_root/.build/ShannonDeskDerivedData/Build/Products/Debug/ShannonDesk.app}"
executable="$app_path/Contents/MacOS/ShannonDesk"
survival_seconds="${SHANNON_MACOS_SMOKE_SECONDS:-12}"

if [[ ! -x "$executable" ]]; then
  echo "ShannonDesk executable was not found at $executable" >&2
  exit 1
fi
if [[ ! "$survival_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "SHANNON_MACOS_SMOKE_SECONDS must be a positive integer." >&2
  exit 2
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/shannon-inspector-smoke.XXXXXX")"
app_pid=""

cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

# The window of TestFlight build 145 that crashed at launch (2026-10-06): the default 1220 × 790 frame,
# the inspector restored beside 開発, where the sidebar (252) and the inspector (286) overlap the detail.
window_frame="94 30 1220 790 0 0 1408 851 "

run_case() {
  local page="$1"
  local panel="$2"
  local label="$page/$panel"
  local output="$temporary_directory/${page}-${panel}.log"
  local elapsed=0
  local page_arguments=(-shannon.desktop.lastDestination "$page")
  case "$page" in
    development) page_arguments=(-ShannonPreviewDevelopment) ;;
    release) page_arguments=(-ShannonPreviewRelease) ;;
  esac

  NSUnbufferedIO=YES "$executable" \
    -ShannonDesignPreview \
    "${page_arguments[@]}" \
    -ApplePersistenceIgnoreState YES \
    "-NSWindow Frame main-AppWindow-1" "$window_frame" \
    -shannon.desktop.lastShowsInspector YES \
    -shannon.desktop.lastAuxiliaryPanel "$panel" \
    >"$output" 2>&1 &
  app_pid=$!

  while (( elapsed < survival_seconds )); do
    sleep 1
    elapsed=$((elapsed + 1))
    if ! kill -0 "$app_pid" 2>/dev/null; then
      wait "$app_pid" || status=$?
      echo "ShannonDesk exited during the restored $label inspector smoke (status ${status:-0})." >&2
      grep -m 3 "reason\|Update Constraints in Window" "$output" >&2 || sed -n '1,40p' "$output" >&2
      return 1
    fi
  done

  kill -TERM "$app_pid"
  wait "$app_pid" 2>/dev/null || true
  app_pid=""

  if grep -q "uncaught exception\|Update Constraints in Window" "$output"; then
    echo "ShannonDesk reported an AppKit constraint exception for the restored $label inspector." >&2
    sed -n '1,40p' "$output" >&2
    return 1
  fi
}

cases=(development/task development/outline release/task work/task talk/task talk/outline)
for item in "${cases[@]}"; do
  run_case "${item%%/*}" "${item##*/}"
done
echo "ShannonDesk restored-inspector launch smoke passed (${survival_seconds}s each: ${cases[*]})."
