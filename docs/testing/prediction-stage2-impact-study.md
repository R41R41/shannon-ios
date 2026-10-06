# ADR-0006 stage 2 study: how a touch's prediction error moves her feeling

Study only (2026-10-06). No production code changed. Answers Syzygy ADR-0006 「段 3 の前に決めること」 item 1 for the body (stage 2): with the §2.6 initial values the stage-1 form adds w_δ·δ to valence and |δ| to arousal at every outcome, which pins valence at ±1 and saturates arousal.

- Simulation: `services/api/tests/predictionStage2Candidates.ts` (run `pnpm exec tsx tests/predictionStage2Candidates.ts` in `services/api` for the full report).
- Tests: `services/api/tests/predictionStage2Candidates.test.ts` (vitest; pins the findings below and prints the report).
- Deterministic: the OU noise comes from row identities; the day replay uses row positions instead of the shadow's random burst ids so that the tables repeat exactly. With the shadow's own seeds the current form reproduces the stage-1 comparisons to 6 decimals.

## Candidates

All use the same prediction layer (`prediction.ts`), OU core, power-law traces, clocks and sleep (`affectDynamics.ts`); only the step at an outcome differs.

| | At an outcome | New coefficients and their sources |
| --- | --- | --- |
| current (stage 1) | v += w_δ·δ, a += |δ|, clamped | — |
| A, intensity only | δ sets the feeling's strength (trace) and the mood; core v and a do not move | none |
| **B, bounded displacement** | v ← γv + (1−γ)(attractor + w_δ·δ); a ← γa + (1−γ)(a₀ + (1−a₀)u); trace = w_δ·δ | γ: Rutledge, Skandali, Dayan & Dolan 2014 (PNAS), forgetting factor per event, 0.61 ± 0.30 (mean ± SD over participants; 要確認 whether SD or SEM). The weights (1−γ)γᵏ sum to 1, so the state is a weighted average of targets on the scale and cannot pass the largest one. u (below) is from the model |
| B′, tanh link alone | Σγᵏw_δδ through tanh (Eldar & Niv 2015, mood = tanh h) | γ as B. Kept as evidence: a saturating link without the normalisation still sits near the ends |
| C, appraisal only | v ← γv + (1−γ)·y (her appraisal); a as B; trace = y·u | γ as B |

- u, how improbable the outcome was under her own prediction: erf(|δ| / √(2(U+N))). From the model (ADR-0006 原則 3c); the role of Pearce & Hall (1980) associability and of surprise-linked arousal (Nassar et al. 2012).
- Startle on a sensitive part (the reflex, before her stance): the Kalman gain before the outcome, U/(U+N), Nassar et al.'s (2012) relative uncertainty. Replaces the table's fixed first-poke 0.45. From the model.
- Stance as an outcome: welcome 1, fine 0.5, unsure 0, dislike −0.5, refuse −1. Equal-interval scoring of an ordered scale (Likert 1932): a measurement assumption, to be fitted against the strength of the feeling she chose.
- w_δ = 1, η_m, θ, σ, ψ, τ: unchanged (§2.6 matched values).

## Results

| | current | A | **B** | B′ | C |
| --- | --- | --- | --- | --- | --- |
| 20 pats in a row (fine): strength at pats 1 / 10 / 20 | .50 / .01 / .00 | same | .50 / .01 / .00 | .46 / .01 / .00 | .23 / .01 / .01 |
| … valence after pats 1 / 5 / 20 | .50 / **1.00** / .95 | .00 / .06 / .08 | .20 / .27 / −.01 | .46 / .31 / .08 | .20 / .48 / .48 |
| First-ever pat vs 100th (both fine): Δvalence | +.50 vs +.09 | 0 vs 0 | +.20 vs +.08 | +.46 vs +.26 | +.20 vs +.11 |
| Extinction → +30 d → renewal → reinstatement (expectation; shared) | −.33 → +.26 → −.36 (other context) → −.21 → −.15 after one reminder | same | same | same | same |
| Long random run (20,000): share |v| ≥ .95 / a ≥ .95 | 35.6% / 99.0% | 0 / 0 | 0.1% / 0 | 1.0% / 22.7% | 0 / 0 |
| … mean arousal | 1.00 | .30 | .68 | .89 | .68 |
| Flood of 1,000 welcomes: share v ≥ .95 | 21% | 0 | 0 | 0 | 99% |
| Mood loop at f = 1.763 (edge of the stable range .568–1.763): max |mood| | .74 | .74 | .74 | .64 | .74 |
| Neck poke (unsure) → stroke (dislike) → refuse: valence | +.42 → −.53 → **−1.00** | +.07 → +.08 → +.05 | −.03 → −.40 → −.65 | −.26 → −.80 → −.95 | +.28 → −.02 → −.42 |
| … arousal | 1.00 throughout | .27–.28 | .59 → .74 → .84 | .73 → .92 → .97 | .59 → .74 → .84 |
| … avoidance (trace above band, awake hours) | 24.1 | 24.1 | 23.0 | 16.1 | 3.0 |
| Next day, neck poke taken as dislike: startle owner / unknown; strength owner / unknown | .21/.30; −.61/−.88 | same | same | .21/.30; −.55/−.71 | .21/.30; −.33/−.40 |
| Stage-1 day (25 comparisons; old mean v .13, a .36): max |v|, mean a, max a | 1.00, .91, 1.00 | .19, .30, .37 | .56, .57, .75 | .93, .74, .96 | .56, .57, .75 |
| … mean |new − old| valence / arousal | .63 / .56 | .11 / .07 | .35 / .21 | .54 / .39 | .30 / .21 |

The startle on the first-ever neck poke (after five days of head pats) is .76; on the third touch there .25.

B across the literature range of γ (mean ± SD): first-pat valence .34 / .20 / .05 and stage-1 day max |v| .80 / .56 / .37, mean arousal .62 / .57 / .43 for γ = .31 / .61 / .91. Every value stays inside the scale and habituates.

## Production shadow

The coordinator's aggregates of `shannon_prediction_shadow` (54 rows, 2026-10-05 18:24Z – 10-06 07:15Z; 31 mood, 9 reply-feeling, 14 touch comparisons) show the same pattern as the stage-1 day replayed here with the current form: max |new valence| .996–1.0 and mean new arousal .89–.95 against old means of about .26 and .46–.53. No production row was read for this study; only the deterministic code paths were run. Calibration of γ (inside .31–.91), w_δ and the stance scoring will come from production data once stage 2 records stances as outcomes.

## Recommendation

B. It is the only candidate that keeps §2.2 (the error, not the outcome, moves momentary feeling; habituation), stays off the ends of the scale in every run, keeps the mood loop stable, and keeps the matched lingering of a strong refusal (about a day of awake time). A makes her inert (a welcomed pat moves nothing); C follows her appraisal to the end of the scale under repeated welcomes and does not habituate; B′ shows a tanh link alone still saturates.

Arousal under B is still about .2 above the old dynamics on the replayed day (mean .57 against .36). That is the first thing to watch in the stage-2 shadow and the first fit (γ toward .91 brings it to .43).

## Stage-2 plan with B (for approval; not started)

Switch: `SHANNON_PREDICTION` (`off` gives stage 1b exactly; the shadow keeps its own `SHANNON_PREDICTION_SHADOW`).

1. `packages/cognition/src/affectDynamics.ts`: γ (`eventForgetting`, Rutledge 2014, range .31–.91) in `SHANNON_AFFECT_DYNAMICS` and the coefficient table; `impulseAffect` takes B's step; `unexpectedness()`. `prediction.ts`: `relativeUncertainty()` for the startle.
2. New `packages/cognition/src/touchAppraisal.ts` (core): stance → outcome, startle, and B's step applied to the stored valence and arousal; the chosen feeling's strength is |w_δ·δ|. Between events the stored state still decays by the half-life table until stage 3.
3. `touchEmotion.ts`: under `on` no table for any part (owner answer 6, ADR-0005); the reflex moves arousal by the startle only. The table stays for `off`.
4. `bodyReaction.ts` / `bodyTouch.ts`: her stance is the outcome of key `gesture.part.who`; a touch she was not asked about takes her latest stance for that key inside the same learned episode, else only the startle. Every touch, sensitive parts included, reaches the prediction layer (closes the TODO in `touchEmotion.ts`).
5. `bodyReactionPrompt.ts`: closeness as a fact (owner alone only, answer 4); her past stances on the part as facts. `bodyTouchMemory.ts`: the touched part in the memory of the touch.
6. `predictionShadow*.ts`, `autonomyCore.ts` (new core path), `docs/body-contract.md`, `docs/prediction-shadow-contract.md`.

Pins: the conversation trace (`chatReplyFeeling.test.ts`, 34e375cd… at af21260c), the four `autonomyLoopKillSwitch` pairs and `othersPresentGoal` stay (no touches there). The old-shape body day of `bodyTouchReflex.test.ts` (f8a35ecb…) must hold under `off`; under `on` it changes and its new value needs approval. Body and touch-emotion tests are rewritten for `on` and kept for `off`. New tests: the scenarios of this note on the real taps, and the first steps of 「体の境界の一生」 (refuse → avoidance fades with the trace). Size: about 350 production lines over 11 files and 400 test lines.
