#!/usr/bin/env bash
# Runs ONE boundary, seam or boundary-8 scene at a given head and body revision, then collects and judges (contract chapter 10).
#
#   run-boundary.sh --scene <id> --head-rev <rev> --body-rev <rev> --out <dir> --vm <user@host> \
#       --vm-head-dir <dir> --vm-body-dir <dir> --vm-runner <script> --vm-out <dir> --run <task id> [--produced-rev <rev>] [--execute]
#
#   <id>          boundary-1..10 (not 8), seam-1..8, or a boundary-8 scene: b8-lost-receipt, b8-dup-poll, b8-reconnect,
#                 b8-head-restart-unacked, b8-head-restart-notified, b8-body-restart, b8-lease-swap  (the files of scenes/)
#   --vm-runner   the VM-side entry of the benches, called as: <runner> <bench A|B|C|D> <scene file> <vm-out dir>. It is NOT written yet: the
#                 benches (run-replay.sh/scene-case.py, run-incident-lab.sh/run-hands-live, minecraftHoldResumeLab.ts) are the body's and the head's
#                 to widen (chapter 10, "台"); the contract here is only what the runner must leave in <vm-out>:
#                 events.jsonl (or the head's decision-records/<run>/), receipts.jsonl, body-trace.jsonl, probes.jsonl?, marks.json?
#
# WITHOUT --execute NOTHING RUNS: the script prints the steps and the remote script that would be streamed to the VM (over `ssh bash -s`, a file of LF
# lines, never a quoted command line: a quote lost on the way once broke an .env). With --execute it runs them. It never touches production: --vm names the
# lab VM (TSX=<command> picks the tsx to judge with), and the remote script only checks out the two revisions in the two directories you name, runs the runner, and leaves the files in --vm-out.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib.sh"

SCENE=""; HEAD_REV=""; BODY_REV=""; OUT=""; VM=""; VM_HEAD=""; VM_BODY=""; VM_RUNNER=""; VM_OUT=""; RUN=""; PRODUCED_REV=""; EXECUTE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0;;
    --scene|--head-rev|--body-rev|--out|--vm|--vm-head-dir|--vm-body-dir|--vm-runner|--vm-out|--run|--produced-rev)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --scene) SCENE=$2;; --head-rev) HEAD_REV=$2;; --body-rev) BODY_REV=$2;; --out) OUT=$2;; --vm) VM=$2;; --vm-head-dir) VM_HEAD=$2;;
        --vm-body-dir) VM_BODY=$2;; --vm-runner) VM_RUNNER=$2;; --vm-out) VM_OUT=$2;; --run) RUN=$2;; --produced-rev) PRODUCED_REV=$2;;
      esac; shift 2;;
    *) die "unknown argument $1";;
  esac
done

need --scene "$SCENE"; check_re --scene "$SCENE" "$SCENE_RE"
SCENE_FILE="$HERE/scenes/$SCENE.json"
[ -f "$SCENE_FILE" ] || die "--scene: there is no scenes/$SCENE.json (run scenes/generate.ts)"
need --head-rev "$HEAD_REV"; check_re --head-rev "$HEAD_REV" "$REV_RE"
need --body-rev "$BODY_REV"; check_re --body-rev "$BODY_REV" "$REV_RE"
need --out "$OUT"; need --run "$RUN"; check_re --run "$RUN" "$RUN_RE"
need --vm "$VM"; check_re --vm "$VM" "$VM_RE"
for pair in "--vm-head-dir:$VM_HEAD" "--vm-body-dir:$VM_BODY" "--vm-runner:$VM_RUNNER" "--vm-out:$VM_OUT"; do
  need "${pair%%:*}" "${pair#*:}"; check_re "${pair%%:*}" "${pair#*:}" "$PATH_RE"
done
[ -z "$PRODUCED_REV" ] || check_re --produced-rev "$PRODUCED_REV" "$REV_RE"
BENCHES=$(sed -n 's/^ *"benchesText": "\([ABCD,]*\)".*/\1/p' "$SCENE_FILE" | head -1)
check_re "benches of $SCENE" "$BENCHES" "$BENCH_RE"

remote_script() {   # the script that runs ON the VM. Every value in it was checked above against a strict pattern.
  cat <<REMOTE
set -euo pipefail
git -C $VM_HEAD fetch --quiet origin
git -C $VM_HEAD checkout --quiet --detach $HEAD_REV
git -C $VM_BODY fetch --quiet origin
git -C $VM_BODY checkout --quiet --detach $BODY_REV
test "\$(git -C $VM_HEAD rev-parse HEAD | cut -c1-${#HEAD_REV})" = "$HEAD_REV"
test "\$(git -C $VM_BODY rev-parse HEAD | cut -c1-${#BODY_REV})" = "$BODY_REV"
rm -rf $VM_OUT && mkdir -p $VM_OUT
REMOTE
  for bench in ${BENCHES//,/ }; do printf '%s %s ~/.continue-verify-scene.json %s\n' "$VM_RUNNER" "$bench" "$VM_OUT"; done
}

say "== $SCENE at head $HEAD_REV, body $BODY_REV, benches $BENCHES"
say "1. send the scene file:    scp -q $SCENE_FILE $VM:.continue-verify-scene.json"
say "2. run on the VM (ssh bash -s, LF script):"
remote_script | sed 's/^/     /'
say "3. collect:               $HERE/collect.sh --scene $SCENE --run $RUN --head-rev $HEAD_REV --body-rev $BODY_REV --benches $BENCHES --out $OUT --vm $VM --vm-records-dir $VM_OUT --vm-receipts $VM_OUT/receipts.jsonl --vm-trace $VM_OUT/body-trace.jsonl --vm-probes $VM_OUT/probes.jsonl --vm-marks $VM_OUT/marks.json --execute"
say "4. judge:                 tsx $HERE/judge.ts $OUT"
if [ "$EXECUTE" != 1 ]; then say "(dry run: nothing was run; add --execute)"; exit 0; fi

scp -q -- "$SCENE_FILE" "$VM:.continue-verify-scene.json"
remote_script | ssh -- "$VM" bash -s
# the runner leaves the head's decision record in <vm-out>/<run>/events.jsonl
"$HERE/collect.sh" --scene "$SCENE" --run "$RUN" --head-rev "$HEAD_REV" --body-rev "$BODY_REV" --benches "$BENCHES" --out "$OUT" --vm "$VM" \
  --vm-records-dir "$VM_OUT" --vm-receipts "$VM_OUT/receipts.jsonl" --vm-trace "$VM_OUT/body-trace.jsonl" --vm-probes "$VM_OUT/probes.jsonl" --vm-marks "$VM_OUT/marks.json" \
  ${PRODUCED_REV:+--produced-rev "$PRODUCED_REV"} --execute
exec ${TSX:-tsx} "$HERE/judge.ts" "$OUT"
