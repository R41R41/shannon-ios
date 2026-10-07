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

# A locked screen opens no window and runs no display cycle, so every case would pass without being tried.
require_unlocked_session() {
  local session_state
  # Drain ioreg before matching: grep -q exits early, making ioreg fail with SIGPIPE under pipefail.
  if ! session_state="$(ioreg -n Root -d1 2>/dev/null)"; then
    echo "The screen lock state could not be read; the launch smoke was not verified." >&2
    return 3
  fi
  if [[ "$session_state" == *'"CGSSessionScreenIsLocked"=Yes'* ]]; then
    echo "The screen is locked: the launch smoke needs an unlocked session (no window opens otherwise)." >&2
    return 3
  fi
}
require_unlocked_session

# Counts the on-screen windows of a process, so that a case where the window never opened fails.
cat >"$temporary_directory/window-count.swift" <<'SWIFT'
import CoreGraphics
let pid = Int(CommandLine.arguments[1]) ?? 0
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
print(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.count)
SWIFT
swiftc -O -o "$temporary_directory/window-count" "$temporary_directory/window-count.swift"

# The window of TestFlight build 145 that crashed at launch (2026-10-06): the default 1220 × 790 frame,
# the inspector restored beside 開発, where the sidebar (252) and the inspector (286) overlap the detail.
window_frame="94 30 1220 790 0 0 1408 851 "

run_case() {
  local page="$1"
  local panel="$2"
  local label="$page/$panel"
  local output="$temporary_directory/${page}-${panel}.log"
  local elapsed=0
  require_unlocked_session
  # The page is a default (`-key value`) or a bare preview flag. The bare flags go last: the argument domain reads
  # the word after any `-word` as its value, so a bare flag before a `-key value` pair leaves the value alone as a
  # file to open, and AppKit then opens that "document" instead of the main window (no window, the case not tried).
  local page_default=(-shannon.desktop.lastDestination "$page")
  local page_flag=()
  case "$page" in
    development) page_default=(); page_flag=(-ShannonPreviewDevelopment) ;;
    release) page_default=(); page_flag=(-ShannonPreviewRelease) ;;
  esac

  NSUnbufferedIO=YES "$executable" \
    ${page_default[@]+"${page_default[@]}"} \
    -ApplePersistenceIgnoreState YES \
    "-NSWindow Frame main-AppWindow-1" "$window_frame" \
    -shannon.desktop.lastShowsInspector YES \
    -shannon.desktop.lastAuxiliaryPanel "$panel" \
    -ShannonDesignPreview \
    ${page_flag[@]+"${page_flag[@]}"} \
    >"$output" 2>&1 &
  app_pid=$!

  while (( elapsed < survival_seconds )); do
    sleep 1
    elapsed=$((elapsed + 1))
    require_unlocked_session
    if ! kill -0 "$app_pid" 2>/dev/null; then
      wait "$app_pid" || status=$?
      echo "ShannonDesk exited during the restored $label inspector smoke (status ${status:-0})." >&2
      grep -m 3 "reason\|Update Constraints in Window" "$output" >&2 || sed -n '1,40p' "$output" >&2
      return 1
    fi
  done

  local windows
  require_unlocked_session
  windows="$("$temporary_directory/window-count" "$app_pid")"
  kill -TERM "$app_pid"
  wait "$app_pid" 2>/dev/null || true
  app_pid=""
  if [[ "$windows" -lt 1 ]]; then
    echo "ShannonDesk opened no window for the restored $label inspector smoke; the case was not tried." >&2
    return 1
  fi

  if grep -q "uncaught exception\|Update Constraints in Window" "$output"; then
    echo "ShannonDesk reported an AppKit constraint exception for the restored $label inspector." >&2
    sed -n '1,40p' "$output" >&2
    return 1
  fi
}

cases=(development/task development/outline release/task work/task talk/task talk/outline talk/figure)
for item in "${cases[@]}"; do
  run_case "${item%%/*}" "${item##*/}"
done
echo "ShannonDesk restored-inspector launch smoke passed (${survival_seconds}s each: ${cases[*]})."
