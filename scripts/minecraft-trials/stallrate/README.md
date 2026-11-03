# stallrate — the stall-rate tool v1 (continuous-motion design R3-7)

Reads the exports of a run and says how long the body stood still, and why. No API, no database write. Python 3, standard library only.

```
STALLRATE_OPLOGS=... python3 stallrate.py --data <dir> [--json out.json] [--selftest]
```

`--selftest` on `C:\Shannon\wt\status\stallrate-run59` (the three finished run59 tasks) must print **A 43.3 % (±1) and B 81 % (±1)**; it did on 2026-11-03.

## What is counted

- **active time** = wall clock of the task minus the *holds* (the people's repairs, `tasks.json`).
- **moving** = time an act was running on the body (`ops-all.jsonl`, `bodyTimes`), minus what is not movement inside it: `wait` hands, path-search stands of 5 s (the `go`'s own search cap) and `go`/`walk` hands that ended with no progress.
- **stall** = the rest of the active time: gaps with no command (split by what the head was doing: the model's wait, looks, redeciding, other), `wait` hands, path search. Stalls that continue across a movement shorter than 1 s are one stall.
- **A** = stall / active (holds left out; the measure the forecasts use). **B** = (wall − moving) / wall (holds count).
- Fights are not stalls in the design; v1 does not separate them yet (run59's three tasks had none).

## Inputs (`--data`)

| file | what | where it comes from |
|---|---|---|
| `tasks.json` | `tasks`: key → `id`, `name`, `state` (the state log), `holds` [[start, end, why]…]; `oplogs`: the body's op logs | written by hand from the state logs |
| `events-<task id>.jsonl` | the head's decision events (`request`, `response`, `applied`, `call`, `sent`, `received`, `woke`, `discarded`, `failed`) | the head's FCA event log of the task |
| `ops-all.jsonl` | the operator ops of the tasks (`skill`, `bodyTimes`, `queue`, `hands`, `lines`, …) | the production database (`minecraft_body_requests`) |
| `oplog-*.jsonl` | the body's black box: `hand_start` and `op` rows | the body's logs |
| `state-<key>.log` | task state lines (`<ISO time> state=(…)`, `CANCEL`) | the watch's state log |

The modules are the analysis scripts of the run59 idle study (`analyze.py` … `analyze4.py`, `final_tables.py`, `top10.py`), vendored with two changes: the data directory and the task/hold table come from `tasks.json`.

## For the isolated rig (R3-9)

The rig's task has the same event and op rows in its own database and logs (`~/.cache/minebot-lab/rig/…`, `~/minecraft/shannon-home/trials/results/<batch>/`). Write its exports in the same shapes and run the tool; a stall the head detects (hold-free) is read from the task's events, not made a hold.
