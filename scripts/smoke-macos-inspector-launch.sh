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

run_case() {
  local panel="$1"
  local output="$temporary_directory/$panel.log"
  local elapsed=0

  NSUnbufferedIO=YES "$executable" \
    -ShannonDesignPreview \
    -ShannonPreviewDevelopment \
    -shannon.desktop.lastShowsInspector YES \
    -shannon.desktop.lastAuxiliaryPanel "$panel" \
    >"$output" 2>&1 &
  app_pid=$!

  while (( elapsed < survival_seconds )); do
    sleep 1
    elapsed=$((elapsed + 1))
    if ! kill -0 "$app_pid" 2>/dev/null; then
      wait "$app_pid" || status=$?
      echo "ShannonDesk exited during the restored $panel inspector smoke (status ${status:-0})." >&2
      sed -n '1,160p' "$output" >&2
      return 1
    fi
  done

  kill -TERM "$app_pid"
  wait "$app_pid" 2>/dev/null || true
  app_pid=""

  if grep -q "uncaught exception\|Update Constraints in Window" "$output"; then
    echo "ShannonDesk reported an AppKit constraint exception for the restored $panel inspector." >&2
    sed -n '1,160p' "$output" >&2
    return 1
  fi
}

run_case task
run_case outline
echo "ShannonDesk restored-inspector launch smoke passed (${survival_seconds}s each: task, outline)."
