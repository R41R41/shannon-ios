#!/bin/bash
# thru.sh — the thru run (rig section T: zero -> Ender Dragon, the 11/10 filming's shape) in the isolated rig, one trial (thru-1110, 11/9).
#
#   thru.sh --batch <name> --model haiku|sonnet --cap-usd <USD> --seed random|<world key> --body-pin <body pin> [--minutes <N>] [--ports <from>-<to>] [--owner-ok-sonnet "<who, when, cap>"]
#
# The head pin is the pin this file lives in. Game port 25590 (RCON 26590) by default, outside the queue's slot ports (25580-25589).
# --ports picks the queue slot's ports instead, when the queue hands this run that slot: slot1 25580-25582, slot2 25583-25585, slot3 25586-25589.
# Before anything starts, ~/budget-guard.py check <USD> must pass (exit 1 = the API floor kept for the filming would be broken: nothing starts).
# The yen cap is floor(USD x 160): the rig's and the head's books use 160 yen per dollar; the guard reads --batch-cap-yen at 152, a little on the safe side.
# Sonnet is paid by the owner's approval of this one run only (rig.py refuses --llm-model sonnet without --owner-ok-sonnet).
# Stop it with ~/rig-stop.sh <batch> <why> (SIGTERM to rig.py: the head, the body and the lab are stopped and the usage is booked), never with the stop file.
set -u
BATCH= MODEL= CAP= SEED= BODY= MINUTES= OKS= PORTS=25590-25590
while [ $# -gt 0 ]; do
  case "$1" in
    --batch) BATCH=$2; shift 2;;
    --model) MODEL=$2; shift 2;;
    --cap-usd) CAP=$2; shift 2;;
    --seed) SEED=$2; shift 2;;
    --body-pin) BODY=$2; shift 2;;
    --minutes) MINUTES=$2; shift 2;;
    --ports) PORTS=$2; shift 2;;
    --owner-ok-sonnet) OKS=$2; shift 2;;
    *) echo "thru.sh: unknown argument $1" >&2; exit 2;;
  esac
done
for v in BATCH MODEL CAP SEED BODY; do [ -n "${!v}" ] || { echo "thru.sh: --batch, --model, --cap-usd, --seed and --body-pin are required" >&2; exit 2; }; done
case "$MODEL" in haiku|sonnet) ;; *) echo "thru.sh: --model haiku|sonnet" >&2; exit 2;; esac
case "$PORTS" in 2558[0-9]-2558[0-9]|25590-25590) ;; *) echo "thru.sh: --ports <from>-<to> within 25580-25589, or 25590-25590" >&2; exit 2;; esac
PORT_FROM=${PORTS%-*} PORT_TO=${PORTS#*-}
[ "$PORT_FROM" -le "$PORT_TO" ] || { echo "thru.sh: --ports from > to" >&2; exit 2; }
# The owner 2026-11-09 10:46: no fixed seeds; the thru runs in a random world. --seed is the rig's world key, passed to rig.py --seeds
# as it is (random worlds are prepared by the rig's own key, meta-1110's part). Only the key is printed, never a seed value.
case "$SEED" in ''|*[!A-Za-z0-9_-]*) echo "thru.sh: --seed random|<world key> (letters, digits, - and _)" >&2; exit 2;; esac
[[ "$CAP" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "thru.sh: --cap-usd must be a number of dollars" >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); HEAD_PIN=$(cd "$HERE/../.." && pwd)
[ -d "$BODY/backend" ] || { echo "thru.sh: no body pin $BODY" >&2; exit 2; }
GUARD=${THRU_BUDGET_GUARD:-$HOME/budget-guard.py}
[ -f "$GUARD" ] || { echo "thru.sh: no budget guard $GUARD: not starting" >&2; exit 1; }
if ! python3 -I "$GUARD" check "$CAP"; then echo "thru.sh: the budget guard refused \$$CAP: not starting"; exit 1; fi
YEN=$(python3 -I -c 'import math, sys; print(math.floor(float(sys.argv[1]) * 160))' "$CAP")
LOAD=(--load-limit 0)                       # the load watch gives way to a production run; with shannon-home stopped it would only stop the other lanes' trials
systemctl is-active --quiet shannon-home 2>/dev/null && LOAD=()
EXTRA=()
[ -n "$MINUTES" ] && EXTRA+=(--minutes "$MINUTES")
[ -n "$OKS" ] && EXTRA+=(--owner-ok-sonnet "$OKS")
echo "thru.sh: batch $BATCH model $MODEL seed $SEED cap \$$CAP = ${YEN} rig yen, head $(basename "$HEAD_PIN") body $(basename "$BODY")${MINUTES:+ minutes $MINUTES}"
cd "$HERE"
python3 -I rig.py run --port-from "$PORT_FROM" --port-to "$PORT_TO" "${LOAD[@]}" --head-pin "$HEAD_PIN" --body-pin "$BODY" --sections T --seeds "$SEED" \
  --model real --llm-model "$MODEL" --keep --max-section-yen "$YEN" --batch-cap-yen "$YEN" --batch "$BATCH" "${EXTRA[@]}"
rc=$?
echo "thru.sh: rig.py exit $rc (10 = the plan is done)"
python3 -I rig.py report --batch "$BATCH" 2>&1 | tail -40
python3 -I "$GUARD" status 2>&1 | head -3
exit $rc
