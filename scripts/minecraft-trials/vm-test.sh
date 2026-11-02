#!/bin/bash
# vm-test.sh — the tests, tsc and the shape check of a branch or commit, run on the 4-vCPU VM beside run59 (coordinator 2026-11-03: the PC's WSL memory is the limit).
#
#   vm-test.sh <body|head> <branch|sha> [--tsc | --shape | --related FILE... | FILTER...]
#
#   FILTER...   vitest filters (a test file path, relative to the package: head services/api/, body backend/), run once
#   --related   vitest related on changed files (paths relative to services/api/ or backend/)
#   --tsc       the typecheck of the API (head: services/api/tsconfig.json) or the backend (body: backend/tsconfig.json), incremental
#   --shape     head only: scripts/check-code-shape.mjs and scripts/check-api-layers.mjs --enforce
#   env: VM_TEST_WHO=<name>      your own work copy ~/vm-tests/<repo>-<name> (default "default"); the same name reuses its tsc cache and node_modules links
#        VM_TEST_MAX_WAIT=<s>    how long to wait for the load (1 minute) to fall to 3.5 and for one of the two test slots (default 900)
#
# What it does: fetches the ref from origin (a branch name) or finds the sha, puts the tree in ~/vm-tests/<repo>-<who> (git archive; node_modules are HARD-LINKED from production's
# checkout, so the workspace links point into the copy; a branch that changes the dependencies needs `pnpm install` and is not covered), and runs at `nice -n 10`, 2 workers, in a
# slot of two (flock) while the machine's 1-minute load is at most 3.5 (run59 runs here; S5 may make trials.stop when it is slowed). It reads nothing of production's environment
# (no api.env, no keys; the tests get the offline values). Nothing of ~/shannon-ios, ~/Shannon or their node_modules is written (a `git fetch` of the ref only). Prints the summary
# lines and where the whole log is (~/vm-tests/logs/); the exit code is the test's.
set -u
KIND=${1:?body or head}; REF=${2:?branch or sha}; shift 2
WHO=${VM_TEST_WHO:-default}; MAXWAIT=${VM_TEST_MAX_WAIT:-900}
case "$KIND" in
  body) REPO=$HOME/Shannon; DEV=$HOME/Shannon-dev; PKG=backend; NODEDIR=$HOME/.nvm/versions/node/v$(cat "$HOME/Shannon-dev/.nvmrc")/bin ;;
  head) REPO=$HOME/shannon-ios; DEV=$REPO; PKG=services/api; NODEDIR=$HOME/shannon-ios-runtime/bin ;;
  *) echo "usage: vm-test.sh <body|head> <branch|sha> [--tsc|--shape|--related FILE...|FILTER...]" >&2; exit 2 ;;
esac
[ -x "$NODEDIR/node" ] || { echo "no node at $NODEDIR" >&2; exit 2; }
export PATH=$NODEDIR:$PATH
W=$HOME/vm-tests/$KIND-$WHO; LOGS=$HOME/vm-tests/logs; CACHE=$HOME/vm-tests/cache
mkdir -p "$W" "$LOGS" "$CACHE"
log() { echo "[$(date +%T)] vm-test: $*"; }

# ---- the commit ------------------------------------------------------------------------------------------------------------------------------------------------------------------
if [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]]; then
  git -C "$REPO" rev-parse --verify -q "$REF^{commit}" >/dev/null || git -C "$REPO" fetch -q origin || { echo "fetch failed" >&2; exit 2; }
  SHA=$(git -C "$REPO" rev-parse "$REF^{commit}") || { echo "unknown sha $REF" >&2; exit 2; }
else
  git -C "$REPO" fetch -q origin "$REF" || { echo "fetch of $REF failed" >&2; exit 2; }
  SHA=$(git -C "$REPO" rev-parse FETCH_HEAD) || exit 2
fi
log "$KIND $REF = ${SHA:0:10}; work copy $W"

# ---- the work copy (only when the commit changed) -------------------------------------------------------------------------------------------------------------------------
exec 8>"$W.lock"; flock 8                                    # one run per work copy at a time
if [ "$(cat "$W/.vm-sha" 2>/dev/null)" != "$SHA" ]; then
  find "$W" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  git -C "$REPO" archive "$SHA" | tar -x -m -C "$W" || { echo "archive failed" >&2; exit 2; }
  # node_modules of production's checkout (or the body's dev checkout), hard-linked: relative workspace links then point into this copy
  ( cd "$DEV" && find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*' ) | while read -r d; do
    mkdir -p "$(dirname "$W/$d")"; cp -al "$DEV/$d" "$W/$d"
  done
  echo "$SHA" > "$W/.vm-sha"
  log "tree of ${SHA:0:10} in place"
fi

# ---- the machine: a test slot of two, and a load of at most 3.5 -----------------------------------------------------------------------------------------------------------
waited=0
while :; do
  got=0
  for slot in 1 2; do exec 9>"$HOME/vm-tests/slot.$slot.lock"; if flock -n 9; then got=1; break; fi; done
  if [ "$got" = 1 ] && awk '{ exit !($1 <= 3.5) }' /proc/loadavg; then break; fi
  [ "$got" = 1 ] && { flock -u 9; exec 9>&-; }
  [ "$waited" -ge "$MAXWAIT" ] && { echo "vm-test: no slot or the load stayed above 3.5 for ${MAXWAIT}s ($(cut -d' ' -f1 /proc/loadavg)): not run" >&2; exit 3; }
  [ "$waited" -eq 0 ] && log "waiting for a slot / load <= 3.5 (now $(cut -d' ' -f1 /proc/loadavg))"
  sleep 15; waited=$((waited + 15))
done

# ---- run -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
OUT=$LOGS/$KIND-$WHO-$(date +%m%dT%H%M%S).log
OFFLINE=(TMPDIR=/dev/shm SHANNON_ISOLATED_MINEBOT_PROBE=true OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/offline-not-used CI=true TZ=Etc/UTC LANG=C.UTF-8)
MODE=${1:-run}
if [ "$KIND" = body ]; then WORKERS=(--maxWorkers=1 --minWorkers=1); else WORKERS=(--maxWorkers=2); fi     # the backend's vitest config fixes minThreads: 1 worker, as its test:offline does
# file filters may be given from the repo root (services/api/tests/x.test.ts) or the package (tests/x.test.ts): vitest runs in the package
ARGS=(); for a in "$@"; do ARGS+=("${a#"$PKG"/}"); done; set -- "${ARGS[@]}"
cd "$W/$PKG" || exit 2
started=$(date +%s)
case "$MODE" in
  --tsc)
    log "tsc ($PKG/tsconfig.json, incremental)"
    nice -n 10 env NODE_OPTIONS=--max-old-space-size=${TSC_HEAP:-$([ "$KIND" = body ] && echo 14336 || echo 6144)} node "$W/node_modules/typescript/bin/tsc" -p tsconfig.json --noEmit --incremental --tsBuildInfoFile "$CACHE/$KIND-$WHO.tsbuildinfo" > "$OUT" 2>&1; rc=$? ;;
  --shape)
    [ "$KIND" = head ] || { echo "--shape is for head only" >&2; exit 2; }
    cd "$W" && { nice -n 10 node scripts/check-code-shape.mjs; nice -n 10 node scripts/check-api-layers.mjs --enforce; } > "$OUT" 2>&1; rc=$? ;;
  --related)
    shift; log "vitest related $*"
    nice -n 10 env "${OFFLINE[@]}" node "$W/node_modules/vitest/vitest.mjs" related --run --cache=false "${WORKERS[@]}" "$@" > "$OUT" 2>&1; rc=$? ;;
  *)
    [ "$MODE" = run ] && set --
    log "vitest run $*"
    nice -n 10 env "${OFFLINE[@]}" node "$W/node_modules/vitest/vitest.mjs" run --cache=false "${WORKERS[@]}" "$@" > "$OUT" 2>&1; rc=$? ;;
esac
sed -i 's/\x1b\[[0-9;]*m//g' "$OUT"
log "exit $rc in $(( $(date +%s) - started )) s; the whole log: $OUT"
grep -a -E '^ FAIL|^ +FAIL|Test Files|^ +Tests |Duration|error TS|Error:|violations|over the baseline|passed|failed' "$OUT" | head -60
exit $rc
