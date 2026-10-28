#!/usr/bin/env bash
# Gathers the records of ONE run into ONE folder for judge.ts (contract chapter 10, tools/continue-verify/).
#
#   collect.sh --scene <id> --run <task id> --head-rev <rev> --body-rev <rev> --benches <B,C> --out <dir> [--produced-rev <rev>]
#       local files:   --records-dir <dir> --receipts <file> --trace <file> [--probes <file>] [--marks <file>]
#       or from a VM:  --vm <user@host> --vm-records-dir <dir> --vm-receipts <file> --vm-trace <file> [--vm-probes <file>] [--vm-marks <file>] [--execute]
#
# The folder it writes (what judge.ts reads):
#   meta.json          {run, scene, benches, headRev, bodyRev, producedRev?, collectedAt}
#   events.jsonl       <records-dir>/<run>/events.jsonl   (the head's decision record)
#   receipts.jsonl     the receipts, one delivery to a line
#   body-trace.jsonl   the body's continuous file (never the 90-second ring)
#   probes.jsonl       (boundaries 9 and 10) what the head's bench wrote where there is no command
#   marks.json         the lab's own marks: {deaths, injections, moments, resumes, excludeCommands}; judge.ts merges it into meta
#
# From a VM nothing is fetched unless --execute is given: without it the commands are printed and nothing is touched (the PC cannot reach the VM from the
# tests; the commands are the plan). Nothing here writes to the VM, to a running head or to the production environment: it only reads and copies files.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib.sh"

SCENE=""; RUN=""; HEAD_REV=""; BODY_REV=""; BENCHES=""; OUT=""; PRODUCED_REV=""
RECORDS_DIR=""; RECEIPTS=""; TRACE=""; PROBES=""; MARKS=""
VM=""; VM_RECORDS_DIR=""; VM_RECEIPTS=""; VM_TRACE=""; VM_PROBES=""; VM_MARKS=""; EXECUTE=0
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || [ "$1" = "--execute" ] || die "$1 needs a value"
  case "$1" in
    --scene) SCENE=$2; shift 2;; --run) RUN=$2; shift 2;; --head-rev) HEAD_REV=$2; shift 2;; --body-rev) BODY_REV=$2; shift 2;;
    --benches) BENCHES=$2; shift 2;; --out) OUT=$2; shift 2;; --produced-rev) PRODUCED_REV=$2; shift 2;;
    --records-dir) RECORDS_DIR=$2; shift 2;; --receipts) RECEIPTS=$2; shift 2;; --trace) TRACE=$2; shift 2;; --probes) PROBES=$2; shift 2;; --marks) MARKS=$2; shift 2;;
    --vm) VM=$2; shift 2;; --vm-records-dir) VM_RECORDS_DIR=$2; shift 2;; --vm-receipts) VM_RECEIPTS=$2; shift 2;; --vm-trace) VM_TRACE=$2; shift 2;;
    --vm-probes) VM_PROBES=$2; shift 2;; --vm-marks) VM_MARKS=$2; shift 2;; --execute) EXECUTE=1; shift;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0;;
    *) die "unknown argument $1";;
  esac
done

need --scene "$SCENE"; check_re --scene "$SCENE" "$SCENE_RE"
[ -f "$HERE/scenes/$SCENE.json" ] || die "--scene: there is no scenes/$SCENE.json (run scenes/generate.ts)"
need --run "$RUN"; check_re --run "$RUN" "$RUN_RE"
need --head-rev "$HEAD_REV"; check_re --head-rev "$HEAD_REV" "$REV_RE"
need --body-rev "$BODY_REV"; check_re --body-rev "$BODY_REV" "$REV_RE"
need --benches "$BENCHES"; check_re --benches "$BENCHES" "$BENCH_RE"
[ -z "$PRODUCED_REV" ] || check_re --produced-rev "$PRODUCED_REV" "$REV_RE"
need --out "$OUT"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null || true)" ]; then die "--out: $OUT is not empty (one folder for one run)"; fi

if [ -n "$VM" ]; then
  [ -z "$RECORDS_DIR$RECEIPTS$TRACE" ] || die "give either the local files or --vm, not both"
  check_re --vm "$VM" "$VM_RE"
  need --vm-records-dir "$VM_RECORDS_DIR"; need --vm-receipts "$VM_RECEIPTS"; need --vm-trace "$VM_TRACE"
  for path in "$VM_RECORDS_DIR" "$VM_RECEIPTS" "$VM_TRACE" "$VM_PROBES" "$VM_MARKS"; do [ -z "$path" ] || check_re "a VM path" "$path" "$PATH_RE"; done
else
  need --records-dir "$RECORDS_DIR"; need --receipts "$RECEIPTS"; need --trace "$TRACE"
  [ -f "$RECORDS_DIR/$RUN/events.jsonl" ] || die "--records-dir: $RECORDS_DIR/$RUN/events.jsonl does not exist"
  [ -f "$RECEIPTS" ] || die "--receipts: $RECEIPTS does not exist"
  [ -f "$TRACE" ] || die "--trace: $TRACE does not exist"
  [ -z "$PROBES" ] || [ -f "$PROBES" ] || die "--probes: $PROBES does not exist"
  [ -z "$MARKS" ] || [ -f "$MARKS" ] || die "--marks: $MARKS does not exist"
fi

copy() {       # copy <from> <to name> [optional]: a local copy, or the plan of a scp; an optional file the VM does not have is told, not fatal
  if [ -n "$VM" ]; then
    if [ "$EXECUTE" = 1 ]; then scp -q -- "$VM:$1" "$OUT/$2" || { [ "${3:-}" = optional ] && say "(not on the VM: $1)"; }; else say "scp -q -- $VM:$1 $OUT/$2"; fi
  else
    cp -- "$1" "$OUT/$2"
  fi
}

WRITE=1; [ -z "$VM" ] || [ "$EXECUTE" = 1 ] || WRITE=0
if [ "$WRITE" = 1 ]; then
  mkdir -p "$OUT"
  PRODUCED_JSON=""; [ -z "$PRODUCED_REV" ] || PRODUCED_JSON=",\"producedRev\":\"$PRODUCED_REV\""
  printf '{"run":"%s","scene":"%s","benches":["%s"],"headRev":"%s","bodyRev":"%s"%s,"collectedAt":"%s"}\n' \
    "$RUN" "$SCENE" "${BENCHES//,/\",\"}" "$HEAD_REV" "$BODY_REV" "$PRODUCED_JSON" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/meta.json"
else
  say "(dry run: nothing is fetched; add --execute to copy the files below)"
fi
if [ -n "$VM" ]; then
  copy "$VM_RECORDS_DIR/$RUN/events.jsonl" events.jsonl; copy "$VM_RECEIPTS" receipts.jsonl; copy "$VM_TRACE" body-trace.jsonl
  [ -z "$VM_PROBES" ] || copy "$VM_PROBES" probes.jsonl optional; [ -z "$VM_MARKS" ] || copy "$VM_MARKS" marks.json optional
else
  copy "$RECORDS_DIR/$RUN/events.jsonl" events.jsonl; copy "$RECEIPTS" receipts.jsonl; copy "$TRACE" body-trace.jsonl
  [ -z "$PROBES" ] || copy "$PROBES" probes.jsonl; [ -z "$MARKS" ] || copy "$MARKS" marks.json
fi
if [ "$WRITE" = 1 ]; then say "collected $SCENE ($RUN) into $OUT: $(ls "$OUT" | tr '\n' ' ')"; fi
