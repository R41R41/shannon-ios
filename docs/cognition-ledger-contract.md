# Cognition ledger contract (v1, Syzygy ADR-0008 stage 1)

答え合わせ・報酬系・価値表・判断ごとの記録. Syzygy ADR-0008 (accepted 2026-10-07) makes "predict, check, and let the outcome change the next choice" part of Shannon's architecture. Stage 1 is the bookkeeping that every later stage stands on: predictions with an id that are opened before the outcome and settled against it, her choices scored by her three instincts, a value table per kind of moment, and one content-free trace per decision. Owner decisions: ADR-0008 §2 and §7, and the owner overrides of the stage-1 plan (2026-10-07), below.

This file is the contract. The pure parts are in `packages/learning` (`@shannon/learning`); the service side is in `services/api/src/mind/learning/`, `services/api/src/mind/inhibition/` and `services/api/src/infra/` (the target layout of ADR-0008 §6). Core areas: `autonomyCore.ts`.

**Model weights are never trained.** The value table changes which choices look good from their outcomes; the models stay fixed (`AGENTS.md`, product invariants).

## Status

| Step | Content | State |
| --- | --- | --- |
| 1 | This contract, the instructions, `packages/learning`, core map | in place |
| 2 | Decision traces, Jev call count | in place (`mind/inhibition/decisionTraces.ts`, `tracedVoiceDecision.ts`, `infra/models/jev/`; tests `decisionTraces.test.ts`) |
| 3 | Prediction ledger, five new domains, calibration | in place (`packages/learning/src/{predictionLedger,calibration}.ts`, `mind/learning/`; tests `predictionLedger.test.ts`, `cognitionLedgerContention.test.ts`) |
| 4 | Choice ledger, reward settlement, nightly pass, tool-call choices | in place (`packages/learning/src/reward.ts`, `mind/learning/{choiceLedger,rewardSettlement}.ts`, `mind/sleep/valueSleep.ts`; tests `reward.test.ts`, `choiceLedger.test.ts`) |
| 5 | Value table, versions, CLI and owner route | not yet |
| 6 | Scenario suite v1 and a baseline report | in place (`packages/evaluation/src/reach/cognitionLedger.ts`, `services/api/tests/reach/reachCognition.ts`; `scripts/reach-measures.sh run --only cog.`) |
| 7a | Value facts in her thinking prompt | in place (`packages/learning/src/valueFacts.ts`, `wiring/cognitionLedgerTaps.ts` `valueFactsReader`; tests `valueFacts.test.ts`, `autonomyLoopKillSwitch.test.ts`); shown to the owner before deployment (override 4) |
| 7b | Reward mood, with the hourly safeguard | in place (`packages/learning/src/choiceAppraisal.ts`, `packages/cognition` `choice-appraised`, `mind/emotion/rewardMood.ts`, wiring `startRewardMood`; tests `rewardMood.test.ts`, `cog.mood-jitter` v2); shown to the owner before deployment (override 4) |

Until step 7 nothing here changes a prompt, a reply, her feeling or a step of hers: the tables are written and read by nothing that acts. Step 7a gives her thinking prompt the value facts; step 7b lets settled choices move her mood.

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

**Layout** (ADR-0008 §6 folder rules, `scripts/check-api-layers.mjs --enforce`): the connections of the loop's process and the traced voice gateway are built in `wiring/cognitionLedgerWiring.ts`, and the taps the loop, the study desk, a touch and the tool runner are handed in `wiring/cognitionLedgerTaps.ts`; the shared vocabulary (closed values, the quarter of the day, the touch's port) is `contracts/cognitionLedgerContract.ts` (one source with the ADR-0006 record), the trace vocabulary `contracts/decisionTraceContract.ts`; the nightly pass is handed the ledgers as functions. Only the `store/` folders, `infra/sqlite` and `wiring` name SQLite; the services are handed a connection (`SqliteConnection`).

## Decision traces (`shannon_decision_traces`, step 2)

One row per decision, content-free (ADR-0008 §3 抑制系: 「判断ごとの記録」, kept apart from the activity record).

| Column | Notes |
| --- | --- |
| `trace_id` | Random id. |
| `scope_key`, `at` | The scope and the instant the decision began. |
| `surface` | `voice`, `autonomy`; `text` from stage 2. |
| `decision` | `voice_route` (the voice turn's routing decision), `autonomy_think` (a thought of her own); from stage 2 `tool_menu`, `difficulty`, `recall_beam` (`docs/skill-and-routing-contract.md`). |
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

`shannon_prediction_ledger_seq` (`scope_key`, `last_seq`) keeps the last place given per scope, so a place is never given twice, also after the row that had it was deleted (a cached fold in another process can then tell what changed).

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

**Maintenance.** In the API's processes, at the first committed state write of an owner day per scope (the nightly pass of step 4 calls the same `maintain`): open rows whose time ran out expire, rows opened more than 90 days ago go, forgetting is reconciled against the state's memory controls (and at once on a memory-control event), every derived value is recomputed when settled rows went, and one line is logged:

```text
Shannon prediction ledger: day=2026-10-22 open=1 matched=12 expired=2 void=3 reading_used:n=4,brier=0.188,kappa=0.250 reply:n=9,brier=0.201,kappa=0.105 story_reaction:n=2,brier=0.063,kappa=-,cover=1.000
```

**Where it is wired.** Her own time: `autonomyLoopReachOutStep.ts` (sent), `autonomyLoopPhoneStep.ts` (called), `autonomyLoopSteps.ts` (read, noted, shown) and `autonomyLoopObserve.ts` (what followed, through the tap that also feeds the shadow), all through `AutonomyPredictionTap` (`wiring/cognitionLedgerTaps.ts` builds it in `autonomyWorker.ts`). The API: `StudyDesk.react` (the reaction's enum, after it is stored) and `TouchPredictions` (`expect` opens, `learn` matches, a carried stance is void).

### Calibration (`packages/learning/src/calibration.ts`)

Per domain, over settled rows with an outcome:
- **Brier score**: the mean of (outcome − expectation)², divided by the scale's width squared (for a yes/no domain, the Brier score itself).
- **Reliability**: five equal-count bins by expectation, each with its count, mean expectation and mean outcome.
- **80 % coverage**: the share of outcomes inside the interval, for gaussian domains (null for yes/no domains, whose interval is about the probability).
- **Skill κ** (Murphy 1973): 1 − Σ(outcome − expectation)² / Σ(outcome − prior)², against the domain prior; null while the reference is 0.

## Choice ledger and reward (`shannon_choices`, step 4)

A choice of hers, recorded when the gate allowed it and settled once by her three instincts (ADR-0008 §3 報酬系).

| Column | Notes |
| --- | --- |
| `choice_id`, `scope_key` | Random id; the scope. |
| `surface` | `autonomy` (a step of her own time), `text`, `voice` (a tool call of hers in a conversation). |
| `choice` | Closed: the step kind (`read`, `notion`, `note`, `draft`, `revise`, `show`, `put_away`, `copy`, `look`, `jot`), `reach_out.<reason>`, `call.<reason>`, `follow_up`, `tool.<registry name>`. Thinking and resting are not choices. |
| `context` | `<band>.<presence>`: the owner-local quarter of the day, and who was around (`alone`, `others`, `away`, `unknown` from what the server knows of her body; in a conversation, its audience). |
| `source_kind`, `source_id` | `step` and the loop step's id, or `tool_call` and a random id. |
| `subject_kind`, `subject_id` | What the step made or showed (`study_piece`), for delayed credit; null otherwise. |
| `chosen_at`, `value_version`, `expected`, `expected_sd`, `expected_noise`, `expected_level`, `expected_n` | When, and the value she held then: V, √U, N, the level of the cell that answered, how many settled choices it had learned from, and its version (the root cell, mean 0 and variance 1/3, until step 5). |
| `status` | `pending`, `settled`, `void` (unscored; moves nothing). |
| `success` | Her step's own outcome: 1 done, 0 failed; null until reported. |
| `world`, `serve`, `growth`, `reward`, `delta`, `unexpected` | W, S, G, r, δ = r − V, u = erf(|δ| / √(2(U + N))). |
| `cost_yen` | What the step cost by the price table (owner override 2: recorded and shown, never subtracted). |
| `settle_code`, `settled_at`, `settle_seq` | How it was settled (`reported`, `reply`, `call`, `story`, `inherited`, `superseded`, `stale`, `void`, `lost`), when, and its place in the order of settling (the value table folds in that order; `shannon_choice_ledger_seq` keeps the last place given). |
| `mood_claimed_at`, `mood_code` | Step 7: when and how it moved her mood. Empty until then. |

**Recording.** In her own time the loop hands the tap two closed facts: `chose` once the gate allowed a step (a step it refused, paused or held for the budget is never a choice) and `reported` when the step ended (done, failed, or void when another runner had closed it). `chose` also opens the step's `step_success` prediction; the predictions its step opens (`reply`, `call_answer`, `story_*`, `reading_used`) carry its `choice_id`. In a conversation, a tool call that ran (not one the gate or the turn refused) is recorded as a choice made and ended at once (`ShannonToolRunner.observeChoices`), as data for stage 2 only: the owner asked for it, so it is not her choice (owner override 1 covers her own time). It never enters the value table (the fold takes `surface = 'autonomy'` only), so it makes no `tool.*` cell and no value fact, and it is never claimed by the reward mood. In the loop's process the choices share the prediction ledger's connection and queue, so they are recorded only while that ledger is on.

**Settling** (`mind/learning/rewardSettlement.ts`, formulas in `packages/learning/src/reward.ts`). r = (W + S + G)/3 clamped to [−1, 1], equal weights (owner answer 2), cost weight 0 (override 2).
- W = min(1, Σ kᵢ|δᵢ| / (hi − lo)) over the choice's settled predictions, kᵢ = U/(U + N) of the prediction as opened; 0 with none.
- G = ½·s + ½·mean κᵢ, κᵢ = 1 − (y − e)² / (y − p)² clamped to [−1, 1] (0 when the prior was exact); G = s with none.
- S: a message: answered within the wait 1, else 0, void when away, hidden, unwatched or not watched; a call: answered 1, declined or unanswered 0, void when it failed or was not watched to its end; a showing: like 1, more 0.5, unclear 0, and 0 when no reaction came in 14 days (override 5); every other step 0.
- Delayed credit: the last draft or revision of a piece before it is shown inherits the showing's S (`inherited`); one followed by another draft or revision before any showing gets 0 (`superseded`); one never shown in 14 days gets 0 (`stale`, a modelling assumption).
- A choice is settled once, as soon as what it is scored by is known: at its report, when the owner reacts to a story, or in the nightly pass. One whose report never came is void after a day (`lost`).

**The nightly pass** (`mind/sleep/valueSleep.ts`), once a day per scope on its own trigger in the background worker (`valueNightSchedule`: from `SHANNON_SLEEP_HOUR` in `SHANNON_SLEEP_TIMEZONE`, whether or not a conversation's sleep job ran or succeeded): `PredictionLedger.maintain` (expiry, forgetting, 90-day retention, recompute, the calibration line), then `ChoiceLedger.sleep` (settling what waited, lost reports, 90-day retention), then `ValueVersions.nightly`, and one line `Shannon value sleep: expired=… predictions_pruned=… settled=… choices_pruned=… version=… versions_pruned=…`. The schedule keeps the day it ran in memory, so a restart later on the same owner day runs the pass again: the time-based parts (expiry, lost reports, retention) may run again, but the version is idempotent per owner day on durable state: a `sleep` version whose `created_at` is at or after today's sleep-hour boundary (owner-local) means no new one (`version=already`), so a deploy or a VM eviction never shifts V mid-day. Its failure is logged and never fails anything else. It calls no model.

## Value table (`shannon_value_versions`, `shannon_value_cells`, step 5)

What a choice in a kind of moment has been worth to her (ADR-0008 §3 価値表), as versions she can be rolled back to (§2 answer 1).

- **Cells** (`packages/learning/src/valueTable.ts`): a Gaussian per cell on five levels, root → family (`reach_out`) → choice (`reach_out.wonder`) → choice × band → choice × band × presence. Each settled choice teaches every cell of its path with the Kalman update of ADR-0006 (U′ = U + volatility·Δt in days, k = U′/(U′ + N)); noise and volatility per cell from its own innovations as a prediction key's are (`keyNoiseVolatility`), held toward its parent's. A new cell starts from its parent's mean with the variance between its siblings plus their mean uncertainty, or 1/3 (the reward's scale) while it has fewer than three; the root starts at mean 0, variance 1/3. V is read from the most specific cell with at least one outcome. A cell keeps `n`, `mean`, `uncertainty`, `noise`, `volatility`, `last_at` and the means of W, S, G and the cost.
- **Versions** (`packages/learning/src/versions.ts`, `mind/learning/valueTable.ts`). A version is a fold of all settled choices in the order they were settled (`evidence_from`, `evidence_to` are places in that order), with the formula (`r1`) and its weights; `cost_unit_yen` stays empty while the cost weight is 0. One version is active per scope, and a choice records the id of the version it read V from (`value_version`; `initial` for the root cell before the first version).
  - Nightly (`valueSleep`): a new version (`made_by` `sleep`) when something new was settled, unless the active version is frozen or a `sleep` version was already made since today's sleep-hour boundary (at most one per owner day, across restarts). Folded outside the lock, written under it.
  - Rollback (owner): a new active version (`owner_rollback`) with the cells of an earlier one, by default the newest version that learned from less than the active one (so a second rollback goes further back), and frozen: until resume, what is settled after it is not used (no nightly version). Its cells, and so every V read from it, are identical to the earlier version's.
  - Resume (owner): a new active version (`owner_resume`) from all the evidence again.
  - Retention: nightly versions 30 days unless active; the owner's are kept (override 5).
- **Owner controls** (the app's button is stage 5):
  - `GET /v1/autonomy/values` (a paired device of the owner's scope, `SHANNON_OWNER_SCOPE_KEY`): the versions, the active version's cells, whether it is frozen, the calibration of her predictions and her choices by status. `POST /v1/autonomy/values/rollback` (`{ "versionId"?: string }`) and `POST /v1/autonomy/values/resume` answer the same view; errors `VALUES_NO_ACTIVE_VERSION`, `VALUES_NO_EARLIER_VERSION`, `VALUES_NOT_FROZEN` (409), `VALUES_VERSION_NOT_FOUND` (404), `VALUES_DISABLED` (403, the choice ledger off). `infra/http/learningRoutes.ts`.
  - `scripts/shannon-values.sh show|rollback [--version ID]|resume [--scope S] [--database PATH]` on the server, the same controls.
  - Each control is written to the activity record as an owner action (`kind` control, `actor` owner, `tool` `values.rollback` or `values.resume`, the new version's id as its detail).

## Scenario suite v1 (step 6)

Eight model-free scenarios in the reach suite (`docs/testing/reach-measures-runbook.md`), each running the real ledgers over a temporary database with a scripted clock and judging the tables afterwards:

| Scenario | What passes |
| --- | --- |
| `cog.night-reply` | After ten days of unanswered night messages and answered evening ones, the next night message is opened expecting a reply below 0.3 and the evening one above 0.7; the reply predictions have positive skill over the prior; V of a night message is below an evening one's. |
| `cog.story-reaction` | A showing that got 「もっと」 is credited S = 0.5 and the last revision before it inherits it (earlier drafts superseded); a story nobody reacted to in 14 days gets S = 0, `story_expired`, not eligible for mood; every text value is closed. |
| `cog.reading-used` | Noted readings settle `reading_used` = 1, the others expire at 0 after 7 days; reading choices settle after them with W > 0. |
| `cog.tool-streak` (v2) | Twenty conversation tool calls (successes, then failures) are settled choices of surface text or voice; after nightly versions no cell is a conversation tool's and its V reads the root; the real reward mood claims none and her state is unchanged. |
| `cog.rollback` | The rollback version's cells and V reads equal the earlier version's; no version while frozen; resume equals a fold of all evidence; both controls are owner entries of the activity record. |
| `cog.kill-switch` | With `SHANNON_ADR8_STAGE1=off` no stage-1 table exists and every switch reads off; with only the choice ledger off, predictions are kept and no choice is. |
| `cog.calibration` | With known probabilities (0.8, 0.2), the Brier score of `call_answer` is within 0.03 of the best possible and every reliability bin within 0.15; 65–95 % of story reactions fall in their 80 % interval. |
| `cog.cold-start` | A first day of ordinary successes, through the real exit, leaves her state exactly as it was (every choice `warmup`); once a nightly version learned from three, a choice moves her again. |
| `cog.mood-jitter` | The planned step-7 exit (`impulseAffect`, chosen: γ 0.61, w_δ 1, w_E 0.4375, u), simulated over the settled choices: through a day of alternating small successes and failures the mood stays inside the stationary band and no swing between two choices exceeds it; repeating one success, the mean \|δ\| of the fifth day is at most half the first's; twenty mixed choices in ten minutes move valence less than 0.5; expired and void choices are never eligible (`moodEligible`). |

**Mood eligibility** (`packages/learning/src/reward.ts`, `moodEligible`): a settled choice with a δ, except those credited only because time ran out (`stale`, `story_expired`, `inherited_expired`, `<code>_expired` when a linked prediction expired). A choice whose linked prediction settles later by a scored expiry (`story_reacted`, `reading_used`) waits for it. Staleness against the learned episode boundary is judged by the exit itself in step 7.

## Value facts (step 7a)

`[これまでの手応え]（サーバーが数えた事実）` (`packages/learning/src/valueFacts.ts`): what the active version holds for the choices offered in this thought, for the moment she is in.

- **Where.** Last in her thinking prompt, after the session facts, as its own section: everything before it is unchanged, so the provider's cache prefix stays. No rule or line is added to the system prompt.
- **Which lines.** Only choices offered in this thought: her messages and calls by reason when they are offered (a second call and a jot when the thought offers them), showing, drafting, revising, putting away, reading, Notion, notes, copying, looking, and her registry tools in her own time (a tool the owner asked for in a conversation never has a cell). Only where a cell has at least one settled choice at the choice level or below; the cell is the most specific one for the moment (choice × band × presence, else × band, else the choice as a whole). At most 8 lines, picked kind by kind (messages, calls, stories, reading, notes, looking, tools), so every kind with a fact gets a line before any kind gets a second, and shown in that fixed order.
- **What a line says.** Facts only: `- 話しかける・いま何をしているか気になった（夜・ひとり）: +0.24 ±0.01（7回。世界0.15／ライ氏0.43／成長0.28／費用2円）` — V, its spread √U (never shown below ±0.01, so a narrow one does not read as certainty), the count, and the means of W, S, G and the cost (recorded, not subtracted). No advice.
- **Never with anyone else present.** The loop is handed one function (`valueFactsReader`); it reads who is around from what the server knows of her body and gives nothing while others may see or hear her.
- **Switch.** `SHANNON_VALUE_FACTS=off` (or the choice ledger off): the function is not handed and every prompt is byte for byte what it was (`autonomyLoopKillSwitch.test.ts`, also with the function answering nothing).

## Reward mood (step 7b)

Every settled choice of hers moves her mood (owner override 1), once, through `choice-appraised` (`packages/cognition`): the bounded step of ADR-0006 stage 2 (`appraiseTouch`, γ 0.61, w_δ 1, w_E 0.4375) with δ = r − V as the error, V as the expectation and u, valence the share 1 − γ toward attractor + w_δ·δ + w_E·V, arousal toward its attractor raised by u.

- **Where.** In the API process only (`server.ts` starts `startRewardMood`, `wiring/cognitionLedgerWiring.ts`; every 30 seconds): the loop's process writes her state only through the awake clock. `mind/emotion/rewardMood.ts` is handed functions, not stores.
- **Once.** A choice is claimed before it is applied (`mood_claimed_at`, `mood_code`, `mood_step` in one `UPDATE … WHERE mood_claimed_at IS NULL`), so two connections never apply it twice.
- **Her own time only.** Only choices of surface `autonomy` are claimed; a conversation's tool calls are data (above).
- **Never.** A choice that is not `moodEligible` (`stale`, `story_expired`, `inherited_expired`, `*_expired`, void, lost) is claimed `ineligible`; one settled longer ago than the episode she has learned (`episodeBoundaryMs` of the ADR-0006 record) is claimed `stale`. Neither moves her.
- **Warm-up (coordinator, 2026-10-07; pending the owner's review).** Before the value table knows a choice, V is the root prior 0 and every ordinary success gives δ ≈ +0.33, a steady upward push. A choice moves her mood only when the V it read at choice time came from a cell of the choice level or more specific that had learned from at least three settled choices (`expected_level`, `expected_n`); earlier ones are claimed `warmup`, move nothing, and do not count against the cap. They settle and are learned from as usual (`cog.cold-start`).
- **Measured on the stored state.** The pump first writes `awake-observed` (the fading the appraisal would apply anyway), then applies `choice-appraised`, and records |valence after − before| of the stored result as `mood_step` (the claim carries the expected step until then).
- **Rate safeguard (coordinator, 2026-10-07; pending the owner's review).** The summed |valence step| of choice appraisals within any rolling hour is at most the stationary band (σ/√(2θ) = 0.15). A choice whose step would pass it moves her only the share that is left (`applied_capped`, the event's `share`); once nothing is left a choice is claimed `rate_capped` and moves nothing. Every such choice stays settled and is learned from by the value table. Without it, twenty surprising choices in ten minutes moved valence 0.285 in the simulation; with it, 0.15 (`cog.mood-jitter` v2, `jitter.rate_cap`).
- **Switch.** `SHANNON_REWARD_MOOD=off` (or the choice ledger off): nothing is started and her state is exactly what it was (`rewardMood.test.ts`).

## Mood codes

`applied`, `applied_capped`, `stale`, `ineligible`, `warmup`, `rate_capped` (`shannon_choices.mood_code`); `mood_step` is the valence change an applied claim made in the stored state (what the safeguard sums). The ADR-0006 record takes no comparison of its own at a `choice-appraised` write: the `awake-observed` write just before it carries the instant she was awake and the mood comparison.
