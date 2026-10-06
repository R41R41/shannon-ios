# Cognition ledger contract (v1, Syzygy ADR-0008 stage 1)

答え合わせ・報酬系・価値表・判断ごとの記録. Syzygy ADR-0008 (accepted 2026-10-07) makes "predict, check, and let the outcome change the next choice" part of Shannon's architecture. Stage 1 is the bookkeeping that every later stage stands on: predictions with an id that are opened before the outcome and settled against it, her choices scored by her three instincts, a value table per kind of moment, and one content-free trace per decision. Owner decisions: ADR-0008 §2 and §7, and the owner overrides of the stage-1 plan (2026-10-07), below.

This file is the contract. The pure parts are in `packages/learning` (`@shannon/learning`); the service side is in `services/api/src/mind/learning/`, `services/api/src/mind/inhibition/` and `services/api/src/infra/` (the target layout of ADR-0008 §6). Core areas: `autonomyCore.ts`.

**Model weights are never trained.** The value table changes which choices look good from their outcomes; the models stay fixed (`AGENTS.md`, product invariants).

## Status

| Step | Content | State |
| --- | --- | --- |
| 1 | This contract, the instructions, `packages/learning`, core map | in place |
| 2 | Decision traces, Jev call count | in place (`mind/inhibition/decisionTraces.ts`, `tracedVoiceDecision.ts`, `infra/models/jev/`; tests `decisionTraces.test.ts`) |
| 3 | Prediction ledger, five new domains, calibration | next |
| 4 | Choice ledger, reward settlement, nightly pass, tool-call choices | not yet |
| 5 | Value table, versions, CLI and owner route | not yet |
| 6 | Scenario suite v1 and a baseline report | not yet |
| 7 | Effects: 7a value facts, 7b reward mood | not yet; shown to the owner before deployment (override 4) |

Until step 7 nothing here changes a prompt, a reply, her feeling or a step of hers: the tables are written and read by nothing that acts.

## Owner overrides (2026-10-07)

1. **Mood moves with all of her own choices**, not only the owner's responses. Every settled choice of hers moves mood through `choice-appraised` (Rutledge step, γ 0.61, w_δ 1, w_E 0.4375, u from the cell's U+N), as long as the outcome is not stale (inside the learned `episodeBoundaryMs`). Expiries and stale outcomes never move mood. The scenario suite must show that mood does not jitter (habituation, band limits, a rate bound if needed).
2. **Cost is not subtracted from reward** (c weight 0). `cost_yen` is recorded and shown in breakdowns. The budget gate stays the only brake on spending.
3. **Jev's price is left unset.** Calls are counted and their cost is shown as unknown (未設定). `SHANNON_JEV_USD_PER_CALL` is optional.
4. **Before deployment** the owner is shown the scenario-suite report and the actual `[これまでの手応え]` lines and gives a final OK.
5. Retention: predictions and choices 90 days, decision traces 30 days, nightly value versions 30 days, versions the owner made kept. A rollback freezes evidence until resume. Controls are a CLI and an owner route now; the app button comes in stage 5. A story with no reaction in 14 days gives S = 0 and no mood change.

## Switches

All default on; `off`, `false`, `0`, `disabled`, `no` or `none` switches one off. **Off restores the behaviour of the commit before stage 1 exactly**: no table is created, nothing is recorded, every prompt, state and reply is what it was. A restart applies a change. The implications are in one place, `cognitionLedgerSwitches` (`packages/learning/src/switches.ts`).

| Switch | Off gives | Core area |
| --- | --- | --- |
| `SHANNON_ADR8_STAGE1` | all of the below off | — |
| `SHANNON_PREDICTION_LEDGER` | no prediction ledger | emotion, memory |
| `SHANNON_CHOICE_LEDGER` | no choices and no values (implies the next two off) | guard, emotion |
| `SHANNON_REWARD_MOOD` | no `choice-appraised` events; identical state | emotion source |
| `SHANNON_VALUE_FACTS` | byte-identical thinking prompt | purpose |
| `SHANNON_DECISION_TRACES` | no traces and no `jev` usage row | response path, record |

`SHANNON_PREDICTION_SHADOW=off` (the ADR-0006 record) implies the prediction ledger is off. `SHANNON_JEV_USD_PER_CALL` (unset by default) is Jev's price per call in USD; unset, Jev's cost is unknown.

## Privacy

- Every text column holds a closed symbol (`^[A-Za-z][A-Za-z0-9_.:-]{0,95}$`) or a record identifier (`^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$`); everything else is a number or an ISO instant. A store refuses anything else, so nothing can be written as words by mistake. `answers_json` of a trace holds closed enums, booleans and numbers only.
- A story's reaction enters as its enum (`like`, `more`, `unclear`); its comment is never read. Nothing the owner said enters any of these tables, and none of them is an observation table of the loop.
- The activity loop is handed functions, never a store (`AutonomyPredictionTap`, `StepDependencies.trace`). Its process opens its own connections for the traces and the ledger, writes only their tables, creates nothing, and skips while the API has not created them.
- Forgetting: a source the owner had her forget (today only a touch's burst can be) loses its ledger rows, and every derived value is recomputed (as in the ADR-0006 record).
- With guests or others present the value facts are not given (step 7).

## Writes and locks

All tables live in the same SQLite file and are created with `CREATE TABLE IF NOT EXISTS` by the API's processes only, outside the numbered migrations (schema version unchanged; an older binary ignores them). Writes are fewer than 2,000 rows a day. Every write is deferred (`setImmediate`, after the caller and its transaction) and follows the shadow's lock discipline: anything computed is computed outside the lock, and under `BEGIN IMMEDIATE` only what arrived meanwhile is folded on before the insert. The wait for the lock is measured (`infra/sqlite/lockWaits.ts`), and one log line a day per process gives the count and the p95/p99 of the waits. A separate database file is considered only if p99 exceeds 50 ms. A failure is logged by name and code and swallowed: no reply, touch or step waits for, or fails because of, this record.

## Decision traces (`shannon_decision_traces`, step 2)

One row per decision, content-free (ADR-0008 §3 抑制系: 「判断ごとの記録」, kept apart from the activity record).

| Column | Notes |
| --- | --- |
| `trace_id` | Random id. |
| `scope_key`, `at` | The scope and the instant the decision began. |
| `surface` | `voice`, `autonomy`. |
| `decision` | `voice_route` (the voice turn's routing decision), `autonomy_think` (a thought of her own). |
| `decider` | `jev`, `openai`, `local` (the local rules), `model` (her own time's planning model). |
| `model` | The model the decider asked (`jev-latest`, `gpt-5.6-luna`, `local-rules`, …). |
| `questions` | How many questions were asked (Jev); null when not counted. |
| `context_chars` | How many characters of context the decider was given (Jev: the JSON of its state; a thought: its prompt); never the characters themselves. |
| `latency_ms` | Wall time of the decision. |
| `outcome` | `ok`; `timeout` or `error` (the configured decider failed and a fallback answered); `fallback` (it answered but could not be used, and a fallback decided). |
| `fallback_decider` | Who decided instead (`openai`, `local`); null otherwise. |
| `answers_json` | The decision as closed enums and numbers (voice: respond, class, latency, affect, intensity, delivery, skills, silence; a thought: the step kinds she planned and a closed code). |
| `cost_usd` | Voice: Jev's cost of this decision, `SHANNON_JEV_USD_PER_CALL` × its calls; **null while the price is unset**; 0 when no Jev call was made. A thought: its cost by the autonomy price table. |
| `related_id` | A related record (a thought's cycle id); null for a voice turn, whose turn is stored later. |

- **Voice.** `TracedVoiceDecisionGateway` wraps the configured gateway (Jev → luna → rules, unchanged) and returns its decision untouched. The Jev client's fetch is counted (`infra/models/jev/jevClient.ts`): each HTTP call, its outcome (ok, timeout, error) and the number of questions and characters of state it carried.
- **Her own time.** The thinking step writes one trace through the function it is handed.
- **Jev usage.** `llmUsageSummary` gains one `jev` row from the traces (decider `jev`): `calls`, zero tokens, `estimatedCostUsd` the sum of known costs, and `costUnknown: true` while any call has no price (shown as 未設定). The `LlmUsageLane` type gains `jev`; `llm_usage_events` and its CHECK do not, so **the transcription cap of 0.10 USD a day (`voiceTranscription.ts`, lane `voice`) is untouched**.
- Retention 30 days, pruned at every open and once a day.

## Prediction ledger (`shannon_predictions`, step 3)

A prediction with an id, opened before its outcome and settled against it (ADR-0008 §3 答え合わせ, extending the ADR-0006 record).

| Column | Notes |
| --- | --- |
| `prediction_id` | Random id. |
| `scope_key`, `domain`, `key`, `context` | What is predicted, from closed vocabularies (below). |
| `expectation`, `uncertainty`, `noise` | What she expected when it was opened, on the domain's scale; the variance of the expectation; the outcome noise. |
| `interval_low`, `interval_high` | The 80 % interval: for a yes/no domain the credible interval of the probability (e ± 1.2816 √U), else the predictive interval of the outcome (e ± 1.2816 √(U + N)), both clamped to the scale. |
| `prior` | The domain prior's expectation at that moment (what a key never seen would be expected to do): the reference of the skill κ. |
| `basis_seq` | How many settled outcomes the expectation was folded from (the highest `outcome_seq` then). Recomputing folds up to it. |
| `made_at`, `expires_at` | When it was opened and when it expires (by domain). |
| `source_kind`, `source_id` | The record it is about (`reach_out`, `call`, `study_piece`, `reading`, `touch`, `choice`). Matching is by (source kind, source id, domain); forgetting and retention follow the source. |
| `choice_id` | The choice it belongs to (step 4); null otherwise. |
| `status` | `open`, `matched`, `expired`, `void`. |
| `outcome`, `outcome_seq`, `settled_at` | The outcome on the domain's scale, its place in the order of settling (the fold order), and when. |

**The ledger's own model.** Its expectations come from the same pure prediction layer as ADR-0006 (`packages/cognition/src/prediction.ts`: Kalman/Rescorla–Wagner, empirical-Bayes priors, latent causes), folded from the ledger's own settled rows in `outcome_seq` order. It is a separate fold from the ADR-0006 record: the shadow's rows, its derived values and what moves her feeling are unchanged. A row's derived values always equal a fold of the settled rows up to its `basis_seq`, so after forgetting or pruning every row is recomputed (delete under the lock, fold outside, write back what changed under the lock; the third attempt folds under the lock).

### Domains

`valence: false` for the five new ones (they never move her feeling through the ADR-0006 dynamics). Defined in `packages/cognition/src/predictionDomains.ts`, so the one prediction layer can hold them; the ADR-0006 record never writes them.

| Domain | Family, scale | Key | Opened | Settled | Expires |
| --- | --- | --- | --- | --- | --- |
| `reply` (existing) | yes/no | `<reason>.<band>` | a message of hers is sent (`autonomyLoopReachOutStep.ts`) | in observe: answered within the wait 1, else 0; away, hidden or unwatched: void | 1 day, unscored |
| `call_answer` | yes/no | `<reason>.<band>` | a call of hers is asked for (`autonomyLoopPhoneStep.ts`) | in observe: answered 1, declined or unanswered 0; failed or unwatched: void | 1 day, unscored |
| `story_reacted` | yes/no | `first` or `revised` | a story is shown (`autonomyLoopSteps.ts`) | the owner's reaction (`StudyDesk.react`): 1 | 14 days, settles 0 (override 5) |
| `story_reaction` | gaussian [0, 1] | `first` or `revised` | with `story_reacted` | like 1, more 0.5, unclear 0 | 14 days, unscored |
| `reading_used` | yes/no | `public` or `notion` | a page is read (`autonomyLoopSteps.ts`) | a note of it is written: 1 | 7 days, settles 0 (modelling assumption: a reading she has not noted in a week is not used) |
| `step_success` | yes/no | the choice | a step is authorized (step 4) | the step's report (step 4) | 1 day, unscored |
| `body_stance` (existing) | gaussian [−1, 1] | gesture.part.who | a touch is taken in (`TouchPredictions.expect`) | her stance (`learn`); a carried stance: void | 1 day, unscored |

`<reason>` is the message's reason (`share`, `wonder`, `upcoming`, `saw`), `<band>` the owner-local quarter of the day (`night`, `morning`, `afternoon`, `evening`); `context` is `alone` or `others` for a message or a call, the body's surface for a touch, empty otherwise.

Only an `open` row is settled; a second outcome for the same source is ignored. An expiry that settles 0 counts as an outcome for the fold and the calibration; one that is unscored does not. Void rows are kept (unscored) until retention.

### Calibration (`packages/learning/src/calibration.ts`)

Per domain, over settled rows with an outcome:
- **Brier score**: the mean of (outcome − expectation)², divided by the scale's width squared (for a yes/no domain, the Brier score itself).
- **Reliability**: five equal-count bins by expectation, each with its count, mean expectation and mean outcome.
- **80 % coverage**: the share of outcomes inside the interval, for gaussian domains (null for yes/no domains, whose interval is about the probability).
- **Skill κ** (Murphy 1973): 1 − Σ(outcome − expectation)² / Σ(outcome − prior)², against the domain prior; null while the reference is 0.

## Choice ledger, values, reward and mood (steps 4–7)

Designed in the stage-1 plan (Syzygy `notes/adr0008-stage1-plan.md`) and written here as each step lands: `shannon_choices`, `shannon_value_versions`, `shannon_value_cells`; r = (W + S + G)/3 clamped to [−1, 1] with the cost weight 0 (override 2); δ = r − V with V read at choice time; u = erf(|δ| / √(2(U+N))); the mood exit boundedAffectStep(core, attractor + w_δ·δ + w_E·V, u) for every settled choice that is not stale (override 1).
