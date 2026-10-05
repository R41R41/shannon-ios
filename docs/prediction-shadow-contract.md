# Prediction record contract (v1, shadow)

What Shannon expected and what happened, kept by the server for the prediction layer of Syzygy ADR-0006 (accepted by the owner on 2026-10-05). This is stage 1 (影, shadow): the record is written beside the current emotion code and read by nothing that acts. No route serves it yet, no prompt, state, reply, face, body answer, step of her own or model request reads it.

The vocabulary and checks are in `services/api/src/predictionStore.ts`; the taps, retention and forgetting are in `predictionShadow.ts`; the fold is `predictionShadowFold.ts` over the pure `packages/cognition/src/prediction.ts`, `predictionDomains.ts` and `affectDynamics.ts`; the readings and the log line are `predictionShadowReadings.ts`. The tests are `services/api/tests/predictionShadow.test.ts`, `services/api/tests/predictionShadowMaintenance.test.ts` (the write lock, retention, the daily reconciliation, the awake clock), `packages/cognition/tests/prediction.test.ts` and `packages/cognition/tests/affectDynamics.test.ts`.

Everything here is additive: two new tables, no new route, and no existing table, route, prompt or computation changed.

## What a row holds (`shannon_prediction_outcomes`)

One row per outcome, or per instant she was awake. **Symbols and numbers only: there is no column for words.** `SQLitePredictionStore.insert` refuses a value that is not a symbol (`^[A-Za-z][A-Za-z0-9_.:-]{0,95}$`), an identifier (`^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$`), an ISO instant or a finite number.

| Column | Notes |
| --- | --- |
| `seq` | Insertion order. Every fold and every recompute goes through the rows in this order. |
| `scope_key` | The scope. |
| `domain` | `reply`, `reply_time`, `owner_present`, `touch`, `reply_feeling`, or `awake` (an instant she was awake, with no outcome). |
| `key` | What is predicted, from closed vocabularies: `<reason>.<night\|morning\|afternoon\|evening>.<body\|mac\|iphone\|call\|unreported>` for `reply` and `reply_time`; the quarter of the day for `owner_present`; `<kind>.<part or unnamed>.<owner\|others>` for `touch`; `owner` for `reply_feeling`; `state` for `awake`. |
| `outcome` | `reply`, `owner_present`: 1 or 0. `reply_time`: seconds (learned as ln seconds), **censored at the loop's wait** (`SHANNON_AUTONOMY_REACH_OUT_WAIT_SECONDS`, 180 by default): an answer after the wait is recorded as `reply` 0 and has no time. `touch`: the valence of the row the current touch table chose (its appraisal today). `reply_feeling`: the decided kind's sign × its strength. `awake`: null. |
| `context` | `alone` or `others` (a message of hers), the body's surface (`windows`, `mac`, `iphone`, `unknown`) for a touch, or empty. |
| `features_json` | Named numbers that may seed a prior (owner answer 8): `closeness` and `talk` (days talked in the closeness window ÷ 30) for `reply` and `reply_time`; `{}` otherwise. Rounded to 6 decimals. |
| `source_kind` | `touch`, `reach_out`, `reply_feeling` or `state`. Retention and forgetting follow it. |
| `source_id` | The source record: a touch's burst id (the experience the owner may forget), a message's initiative id, or null (a reply's feeling: the state write does not know its turn). |
| `observed_at` | ISO 8601. |
| `expectation`, `uncertainty`, `error`, `learning_rate`, `cause` | What she expected at that moment (on the domain's scale), its variance, outcome − expectation, the learning rate, and the latent cause that took it. Derived: always equal to a fold of the rows before it, to 6 decimals. |

A message her body reported as `away` or `hidden` goes to `owner_present` (0) and not to `reply` (ADR-0006 §1: what is not a result of her action is not learned as its failure); `shown` and `shown_spoken` add an `owner_present` 1. A message whose wait was cut off (`unwatched`) adds nothing. A reply's feeling that only went on (`continued`), a neutral one, and a touch's feeling (its cause is the touch table's wording) add nothing.

## Comparisons (`shannon_prediction_shadow`)

The current and the new dynamics at one instant, as numbers: `tap` (`touch`, `reach_out`, `reply_feeling`, `mood`), `old_valence`, `old_arousal`, `old_openness`, `old_present` (what she feels now by `presentShannonFeeling`, signed by the kind; a kind without a sign counts as pleasant), and `new_valence`, `new_arousal`, `new_openness`, `new_present` (the strongest emotional trace, signed), `new_mood`, `new_awake_ms`, `new_boundary_ms` (the learned episode boundary). A `mood` comparison is written beside a committed state write, coalesced as the mood history is (a value moved by 0.05, otherwise at most every 10 minutes).

## Writers

- **The API and its workers** (`SQLiteShannonStore`, on the store's own connection): every committed state write is handed to `PredictionShadow.stateWritten` after the mood history, and a touch by `BodyTouches.observe` after the state write of the touch. The work itself runs on the next turn of the event loop (`setImmediate`), after the response and outside the caller's transaction, so no reply, touch answer or worker waits for it. A state write that a caller's surrounding transaction rolls back afterwards may still be recorded; the record is diagnostic. A store closed before the work's turn skips it. Only these processes create the tables, prune and reconcile forgetting.
- **The activity loop's process** (`configuredPredictionShadow`, its own connection): what followed a message of hers, from `observeStep`, and each instant the awake clock advanced (`autonomyAwakeClock.ts` writes the state directly, not through the API's store, so without this the new clock would count her time on her own as sleep). Both run after the loop's own transaction, so a step whose transaction is rolled back afterwards can still leave its reach-out rows. The loop and the clock are each handed one function (`AutonomyPredictionTap.reachOut`, `awake`), never the shadow. It reads `companion_states` for the two prior features (closeness, talk) and writes only `shannon_prediction_*`; it creates nothing and skips while the tables are absent; it hands the loop nothing.
- A failure is logged as `Shannon prediction shadow failed` with the error's name and code, and nothing else happens: deferred work has no caller left to fail. (Run at once, as tests may, the one error thrown on is SQLite rolling back a caller's whole transaction, as for the mood history.)

## Recompute, forgetting and retention

- **The write lock is never held through a fold.** A writer brings its mind up to the table first, outside any transaction (a cold fold of 6,000 rows takes about 0.3 s); under `BEGIN IMMEDIATE` it folds only the rows another process added meanwhile, then inserts. If rows were deleted meanwhile, it lets the lock go and folds again outside (the third attempt may fold under the lock, so that it always ends). A recompute is three steps: delete under the lock, fold outside, then under the lock fold on what arrived and rewrite the derived values that differ; if rows were deleted meanwhile it folds again, and the third time it reads and folds the table under the lock, so a fold made before the table changed is never written back.

- **Recomputable.** Folding the rows in `seq` order from an empty mind gives the same mind and the same derived values. Noise for the new dynamics comes from each row's own identity (domain, key, source id, instant), never from its place in the table or from `Math.random`.
- **Forgetting** (owner answer 7). When the owner has her forget something (`memory-control-upserted` or `memory-transaction` with a status other than `active`), every row whose `source_id` is that memory is deleted, everything is folded again, derived values that changed are rewritten, and comparisons from the earliest deleted instant on are deleted. The same reconciliation runs once a day per scope in the API's processes, against the state's memory controls, so a lost deferred task or a time with the switch off is caught up. Restoring the memory does not bring the rows back. Today only a touch's burst can be forgotten this way: no forgetting path names a message of hers (an initiative id) or a reply's feeling, so those rows go by retention.
- **Retention follows the source** (owner answer 7): `touch` rows the body's 30 days (`BODY_LIMITS.retentionDays`), `reach_out` rows the 14 days of the loop's observations, `awake` rows and comparisons the mood history's 14 days, and `reply_feeling` rows also the mood history's 14 days until stage 3 links each to its turn (then they follow the conversation and its forgetting). Pruned once a day per scope in the API's processes, then recomputed.

## Log line

One line per recorded outcome, symbols and numbers only (anything else is replaced by `_`):

```text
Shannon prediction shadow: tap=touch key=pet.head.owner n=2 e=+0.25 sd=0.41 y=+0.50 d=+0.25 k=0.33 c=0 i=+0.25 | old v=+0.16 a=0.33 p=+0.88 | new v=+1.00 a=1.00 m=+0.28 p=+0.41 epi=19m
Shannon prediction shadow: tap=touch key=pet.head.owner n=6 e=+0.52 sd=0.12 y=+0.60 d=+0.08 k=0.39 c=0 i=+0.08 | old v=+0.36 a=0.38 p=+0.88 | new v=+1.00 a=1.00 m=+0.14 p=+0.28 epi=16m
Shannon prediction shadow: tap=reply_feeling key=owner n=5 e=+0.58 sd=0.20 y=-0.90 d=-1.48 k=0.72 c=1+ i=-1.48 | old v=+0.13 a=0.42 p=-0.90 | new v=-1.00 a=1.00 m=-0.52 p=-1.00 epi=15m
Shannon prediction shadow: tap=reply key=wonder.evening.body n=1 e=+0.50 sd=0.29 y=+1.00 d=+0.50 k=0.33 c=0+
Shannon prediction shadow: tap=reply_time key=wonder.evening.body n=1 e=+5.68 sd=3.28 y=+4.55 d=-1.13 k=0.50 c=0+
Shannon prediction shadow: forgot sources=1 rows=2 recomputed=4 changed=2
```

`n` outcomes of the key, `e` expectation, `sd` its uncertainty, `y` outcome (both on the domain's scale: ln seconds for `reply_time`), `d` error, `k` learning rate, `c` cause (`+`: a new one), `i` the impulse to valence; `old`/`new` valence, arousal, present feeling and mood; `epi` the learned episode boundary. A line from the activity loop's process carries the comparison only when the state was readable.

## Server switch

`SHANNON_PREDICTION_SHADOW` (default on). `off`, `false`, `0`, `disabled`, `no` or `none` creates no table, records nothing and logs nothing, in every process. A restart applies it.

## Tables

Created with `CREATE TABLE IF NOT EXISTS` when a store of the API or its workers opens; outside the numbered migrations; schema version unchanged; an older binary ignores them. Indexes: `(scope_key, seq)` and `(scope_key, source_id)` on the outcomes, `(scope_key, recorded_at)` on the comparisons.
