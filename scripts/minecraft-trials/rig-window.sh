#!/bin/bash
# rig-window.sh — the isolated rig (rig.py) in run59's park windows, on the 2-vCPU VM (coordinator 2026-11-02 23:2x: the 4-vCPU change waits for the Spot vCPU quota).
#
#   rig-window.sh [--batch NAME] [--sections 6,7,9,8a,8b,10] [--seeds c1] [--max-wait SECONDS] [--not-before "YYYY-MM-DD HH:MM"] [--check] [-- extra rig.py args]
#
# Waits until run59 is parked: ~/.cache/minebot-lab/prod.lock is free (S5 released it), no production Minecraft task is active, and ~/.cache/minebot-lab/trials.stop does not
# exist. Then it runs ONE section through rig.py (the real model; 1 section at most ¥500, the whole batch ¥3,000; the pins are what is deployed: the head in ~/shannon-ios, the
# body in ~/Shannon, made by `git archive` when missing), and waits for the next window for the next section. rig.py gives way within a minute when trials.stop appears
# (S5's signal that run59 resumes) and this script never starts while the file exists: whoever made it removes it when a window is wanted again.
# It ends when the plan is done or the cap is reached (rig.py exit 10), after 3 rig failures in a row, or after --max-wait seconds (default 12 hours). It takes no lock of
# shannon-home and touches none of production's processes; it holds the lab slot (slot.lock) while a section runs, as every lab does.
#   --not-before   do not start a section before this time (the machine's clock); the window is only watched until then.
#   --check   print whether the window is open now (and why not), the pins that would be used, and stop.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAB=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
STOP=$LAB/trials.stop
PROD_LOCK=$LAB/prod.lock
SLOT=${RIG_WINDOW_LAB_SLOT:-$LAB/s4-tools/lab-slot.sh}
BATCH="rigwin-$(date +%Y%m%dT%H%M)"; SECTIONS="6,7,9,8a,8b,10"; SEEDS=c1; MAXWAIT=43200; CHECK=0; NOTBEFORE=0; BESIDE=0; EXTRA=()
OWNER_OK="ライ氏 2026-11-02 選択肢で回答（取りまとめ経由）"
while [ $# -gt 0 ]; do
  case "$1" in
    --batch) BATCH=$2; shift 2 ;; --sections) SECTIONS=$2; shift 2 ;; --seeds) SEEDS=$2; shift 2 ;; --max-wait) MAXWAIT=$2; shift 2 ;;
    --not-before) NOTBEFORE=$(date -d "$2" +%s) || exit 2; shift 2 ;; --check) CHECK=1; shift ;; --beside) BESIDE=1; shift ;; --) shift; EXTRA=("$@"); break ;;
    *) echo "usage: rig-window.sh [--batch N] [--sections S] [--seeds K] [--max-wait SEC] [--beside] [--check] [-- rig.py args]" >&2; exit 2 ;;
  esac
done

# --beside (the 4-vCPU VM, coordinator 2026-11-03 0:4x): run beside run59 with no park window to wait for: only trials.stop closes it; the lab slot is taken with --allow-run; the rig gives way
# by itself when the 1-minute load stays above 3.5 for 3 minutes (it makes trials.stop then: this script removes THAT file, and only that one, once the load is below 3 again for 5 minutes).
clear_own_stop() {
  [ -e "$STOP" ] && head -c 40 "$STOP" 2>/dev/null | grep -q '^rig.py: load' || return 0
  [ $(( $(date +%s) - $(stat -c %Y "$STOP") )) -ge 300 ] || return 0
  awk '{ exit !($1 < 3.0) }' /proc/loadavg && rm -f "$STOP" && echo "[$(date +%T)] rig-window: the rig's own load stop file is removed (load $(cut -d' ' -f1 /proc/loadavg))"
}

why_closed() {      # prints why the window is shut, empty when it is open
  [ "$BESIDE" = 1 ] && clear_own_stop
  [ -e "$STOP" ] && { echo "trials.stop exists ($(head -c 100 "$STOP" 2>/dev/null | tr '\n' ' '))"; return; }
  [ "$BESIDE" = 1 ] && return
  if [ -e "$PROD_LOCK" ] && ! (exec 7>"$PROD_LOCK"; flock -n 7); then echo "prod.lock is held ($(head -c 100 "$PROD_LOCK" 2>/dev/null | tr '\n' ' '))"; return; fi
  local active
  active=$(python3 -I -c "
import sys; sys.path.insert(0, '$HERE')
import trials; print(len(trials.minecraft_task_active()))" 2>/dev/null)
  [ "${active:-x}" = "0" ] || echo "a production Minecraft task is active or unknown (${active:-unreadable})"
}

pins() {            # makes (when missing) and prints the head pin and the body pin of what is deployed (RIG_HEAD_PIN / RIG_BODY_PIN name other trees: the A/B of two head branches)
  local hs bs hp bp d
  if [ -n "${RIG_HEAD_PIN:-}" ] && [ -n "${RIG_BODY_PIN:-}" ]; then
    cp "$HERE/minecraft-rig.ts" "$RIG_HEAD_PIN/services/api/scripts/minecraft-rig.ts" || return 1
    echo "$RIG_HEAD_PIN $RIG_BODY_PIN"; return 0
  fi
  hs=$(git -C "$HOME/shannon-ios" rev-parse --short=7 HEAD) || return 1
  bs=$(git -C "$HOME/Shannon" rev-parse --short=7 HEAD) || return 1
  hp=$HOME/s4-pins/head-$hs; bp=$HOME/s4-pins/body-$bs
  if [ ! -d "$hp/services" ]; then
    mkdir -p "$hp" && git -C "$HOME/shannon-ios" archive HEAD | tar -x -m -C "$hp" || return 1
    for d in node_modules services/api/node_modules packages/evaluation/node_modules packages/mind/node_modules packages/learning/node_modules; do
      [ -d "$HOME/shannon-ios/$d" ] && [ ! -e "$hp/$d" ] && { mkdir -p "$(dirname "$hp/$d")"; cp -al "$HOME/shannon-ios/$d" "$hp/$d"; }
    done
  fi
  cp "$HERE/minecraft-rig.ts" "$hp/services/api/scripts/minecraft-rig.ts" 2>/dev/null || [ -f "$hp/services/api/scripts/minecraft-rig.ts" ] || return 1
  if [ ! -d "$bp/backend" ]; then
    mkdir -p "$bp" && git -C "$HOME/Shannon" archive HEAD backend/src backend/scripts backend/package.json backend/tsconfig.json package.json backend/saves/minecraft/structures | tar -x -m -C "$bp" || return 1
  fi
  echo "$hp $bp"
}

if [ "$CHECK" = 1 ]; then
  closed=$(why_closed)
  echo "window: ${closed:-OPEN}"; echo "pins: $(pins)"; echo "load: $(cut -d' ' -f1-3 /proc/loadavg)  vCPU: $(nproc)"
  exit 0
fi

started=$(date +%s); failures=0
echo $$ > "$LAB/rig-window.pid"; trap 'rm -f "$LAB/rig-window.pid"' EXIT
echo "[$(date +%T)] rig-window: batch $BATCH, sections $SECTIONS, seeds $SEEDS; waiting for a park window (prod.lock free, no production task, no trials.stop)"
while [ $(( $(date +%s) - started )) -le "$MAXWAIT" ]; do
  closed=$(why_closed)
  if [ -n "$closed" ] || [ "$(date +%s)" -lt "$NOTBEFORE" ]; then sleep 15; continue; fi
  sleep 20; closed=$(why_closed); [ -n "$closed" ] && continue         # open for 20 s: not a moment between S5's release and its next take
  read -r HEADPIN BODYPIN < <(pins) || { echo "[$(date +%T)] rig-window: the pins could not be made"; sleep 60; continue; }
  echo "[$(date +%T)] rig-window: the window is open; one section with head $(basename "$HEADPIN") body $(basename "$BODYPIN")"
  # (the slot may be S2's for a while: wait for it up to 30 minutes instead of being refused, which would count as a failure)
  if [ "$BESIDE" = 1 ]; then SLOT_ARGS=(--allow-run --wait 1800); LOAD_ARGS=(--load-limit 3.5 --load-minutes 3); NICE=(nice -n 10); else SLOT_ARGS=(--wait 1800); LOAD_ARGS=(--load-limit 0); NICE=(nice -n 10); fi
  bash "$SLOT" "${SLOT_ARGS[@]}" --label rig -- "${NICE[@]}" python3 -I "$HERE/rig.py" run --head-pin "$HEADPIN" --body-pin "$BODYPIN" --sections "$SECTIONS" --seeds "$SEEDS" --batch "$BATCH" --limit 1 \
    --model real --max-section-yen 500 --batch-cap-yen 3000 --owner-ok-supply "$OWNER_OK" --cores 2 "${LOAD_ARGS[@]}" "${EXTRA[@]}"
  rc=$?
  last=$(tail -n 1 "$HERE/results/history.jsonl" 2>/dev/null)
  case "$rc" in
    10) echo "[$(date +%T)] rig-window: the plan is done or the cap is reached"; exit 0 ;;
    0)  if printf '%s' "$last" | grep -q '"reason": "rig_failed'; then failures=$((failures + 1)); else failures=0; fi ;;
    4)  echo "[$(date +%T)] rig-window: a production run became active; waiting for the next window" ;;
    *)  echo "[$(date +%T)] rig-window: rig.py or the slot ended with $rc"; failures=$((failures + 1)) ;;
  esac
  if [ "$failures" -ge 3 ]; then echo "[$(date +%T)] rig-window: three failures in a row: stopping (see $HERE/results/$BATCH and the rig logs)"; exit 4; fi
  sleep 30
done
echo "[$(date +%T)] rig-window: --max-wait passed without the plan being done"
exit 3
