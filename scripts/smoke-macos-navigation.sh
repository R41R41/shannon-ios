#!/usr/bin/env bash
# Navigation smoke under an accessibility client (review of A10–A15, 2026-10-05). The Debug design preview
# walks by itself through シャノン with the 「すがた」 panel asked for, 設定, 作業 and Talk
# (-ShannonPreviewNavigationSmoke) while scripts/smoke-macos-ax-walk.swift reads its accessibility tree
# again and again. It fails when the walk stops being answered, the steps stop, or the process stays busy.
# Needs a Debug build (scripts/xcode.sh mac-debug) and a terminal allowed to use accessibility.
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
app_path="${1:-$repository_root/.build/ShannonDeskDerivedData/Build/Products/Debug/ShannonDesk.app}"
executable="$app_path/Contents/MacOS/ShannonDesk"
[[ -x "$executable" ]] || { echo "ShannonDesk executable was not found at $executable" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/shannon-navigation-smoke.XXXXXX")"
app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then kill -TERM "$app_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

swiftc -O -o "$work/ax-walk" "$repository_root/scripts/smoke-macos-ax-walk.swift"

NSUnbufferedIO=YES "$executable" -ShannonDesignPreview -ShannonPreviewNavigationSmoke \
  -ApplePersistenceIgnoreState YES -shannon.desktop.lastDestination shannon \
  -shannon.desktop.lastShowsInspector YES -shannon.desktop.lastAuxiliaryPanel figure \
  >"$work/app.log" 2>&1 &
app_pid=$!
sleep 2

walk_status=0
"$work/ax-walk" "$app_pid" 45 >"$work/walk.log" 2>&1 || walk_status=$?

busy=0
for _ in 1 2 3 4 5; do
  cpu="$(ps -o %cpu= -p "$app_pid" | tr -d ' ' | cut -d. -f1)"
  [[ "${cpu:-0}" -ge 80 ]] && busy=$((busy + 1))
  sleep 1
done

cat "$work/walk.log"
steps="$(grep -c '^navigation-smoke: [0-9]' "$work/app.log" || true)"
echo "navigation steps reached: $steps"
if [[ "$walk_status" -ne 0 ]] || ! grep -q '^navigation-smoke: done' "$work/app.log" || [[ "$busy" -ge 4 ]]; then
  echo "ShannonDesk navigation smoke failed (walk status $walk_status, busy samples $busy)." >&2
  grep -v '^navigation-smoke' "$work/app.log" | sed -n '1,40p' >&2
  exit 1
fi
echo "ShannonDesk navigation smoke passed under an accessibility client."
