# ADR-0006 stage 2 study: how a touch's prediction error moves her feeling

Study of 2026-10-06; **candidate B was approved by the owner the same day and is stage 2** (see [Stage 2 as built](#stage-2-as-built)). Answers Syzygy ADR-0006 「段 3 の前に決めること」 item 1 for the body (stage 2): with the §2.6 initial values the stage-1 form adds w_δ·δ to valence and |δ| to arousal at every outcome, which pins valence at ±1 and saturates arousal.

- Simulation: `services/api/tests/predictionStage2Candidates.ts` (run `pnpm exec tsx tests/predictionStage2Candidates.ts` in `services/api` for the full report).
- Tests: `services/api/tests/predictionStage2Candidates.test.ts` (vitest; pins the findings below and prints the report).
- Deterministic: the OU noise comes from each row's domain, key and instant (`shadowNoiseSeed`). Before stage 2 the shadow also seeded by the source id, a touch's random burst id, so the same scripted day differed from run to run; stage 2 fixed that, and the B replay now reproduces the shadow's comparisons to 6 decimals. The stage-1 form is kept in the script as `current`.

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
| … avoidance (trace above band, awake hours) | 23.0 | 23.0 | 23.0 | 16.1 | 3.0 |
| Next day, neck poke taken as dislike: startle owner / unknown; strength owner / unknown | .21/.30; −.61/−.88 | same | same | .21/.30; −.55/−.71 | .21/.30; −.33/−.40 |
| Stage-1 day (25 comparisons; old mean v .13, a .36): max |v|, mean a, max a | 1.00, .90, 1.00 | .30, .38, .47 | .59, .58, .83 | .94, .76, .97 | .57, .58, .83 |
| … mean |new − old| valence / arousal | .63 / .54 | .22 / .07 | .33 / .23 | .54 / .41 | .28 / .23 |

The startle on the first-ever neck poke (after five days of head pats) is .76; on the third touch there .25.

B across the literature range of γ (mean ± SD): first-pat valence .34 / .20 / .05 and stage-1 day max |v| .78 / .59 / .30, mean arousal .63 / .58 / .48 for γ = .31 / .61 / .91. Every value stays inside the scale and habituates.

## Production shadow

The coordinator's aggregates of `shannon_prediction_shadow` (54 rows, 2026-10-05 18:24Z – 10-06 07:15Z; 31 mood, 9 reply-feeling, 14 touch comparisons) show the same pattern as the stage-1 day replayed here with the current form: max |new valence| .996–1.0 and mean new arousal .89–.95 against old means of about .26 and .46–.53. No production row was read for this study; only the deterministic code paths were run. Calibration of γ (inside .31–.91), w_δ and the stance scoring will come from production data once stage 2 records stances as outcomes.

## Recommendation

B. It is the only candidate that keeps §2.2 (the error, not the outcome, moves momentary feeling; habituation), stays off the ends of the scale in every run, keeps the mood loop stable, and keeps the matched lingering of a strong refusal (about a day of awake time). A makes her inert (a welcomed pat moves nothing); C follows her appraisal to the end of the scale under repeated welcomes and does not habituate; B′ shows a tanh link alone still saturates.

Arousal under B is still about .2 above the old dynamics on the replayed day (mean .58 against .36). That is the first thing to watch in the stage-2 record and the first fit (γ toward .91 brings it to .48).

## Stage 2 as built

Switch: `SHANNON_PREDICTION` (default on). `off` gives stage 1b exactly: at the stage-2 commit `bodyTouchReflex.test.ts` still records f8a35ecb… with the switch off, and every stage-1b body test runs with it off.

- **The rule** (`affectDynamics.ts` `boundedAffectStep`, `touchAppraisal.ts`): at an outcome valence moves the share 1 − γ toward attractor + w_δ·δ + w_E·E, arousal the share 1 − γ toward a₀ + (1 − a₀)·u. For a touch, E is what she expected of it, held as her standing appraisal (review of 2026-10-06, below). The trace and the strength of the feeling she chose are |w_δ·δ|. When a touch arrives, before her stance, arousal rises (never falls) by the same step with u = the startle U/(U + N). The shadow's new dynamics use the same rule for every valence outcome.
- **γ = 0.61**, Rutledge, Skandali, Dayan & Dolan 2014 (PNAS 111:12252), forgetting factor per trial, 0.61 ± 0.30 over participants. Range used for fitting: 0.31–0.91 (`eventForgettingRange`); outside it needs the owner's approval. **Open (要確認): whether ± 0.30 is the SD or the SEM.** If it is the SEM, the range for fitting is narrower than recorded here.
- **No table for any part** under `on`, with no automatic joy on a head pat (ADR-0005 owner answer 6). Her stance is the outcome of key `gesture.part.who` (domain `body_stance`); a touch she is not asked about carries her stance for the key within the learned episode; she is told the closeness and her past stances on the part (owner alone only); her memory keeps the part.
- **Calibration** of γ (inside its range), w_δ and the stance scoring will come from production records once stage 2 has run; nothing here was fitted to production rows.

## Next: a faster stance (proposal)

How fast her stance is known is how fast her face can move under stage 2. The proposal to let the fast classifier jev judge the stance and feeling first, with luna writing the line, and to make one appraisal circuit with a context catalog for every surface, is in [`docs/design/appraisal-circuit-proposal.md`](../design/appraisal-circuit-proposal.md). It is not built.

## The expectation term (review of 2026-10-06)

The review found that without Rutledge's expected-value term an expected outcome pulls her valence toward neutral: a familiar welcome pat took her from 0.8 (joy carried over from chat) to 0.49. Rutledge et al. (2014) model momentary happiness with an EV term beside the RPE term, both positive, EV lower than RPE. The weights of their fMRI experiment (z-scored happiness), as reported by Daswani & Leike (2015), are w_CR 0.52, w_EV 0.35, w_RPE 0.80. **要確認** against the paper's own table. Scaled as w_δ was (w_δ = 1 stands for w_RPE), **w_E = 0.35 / 0.80 = 0.4375** (`SHANNON_AFFECT_DYNAMICS.expectationWeight`). In Rutledge's task the EV term belongs to a chosen gamble; a touch is not her choice, but its expectation is her standing appraisal of such a touch (as expectations carry momentary well-being in learning tasks: Blain & Rutledge 2020), so for a touch it joins the valence target (`held`) and not the memory trace, whose strength stays the error alone. A reply's feeling (stage 3) is left as it is. B0 below is B as first built, without E.

| | B (with E) | B0 (no E) |
| --- | --- | --- |
| Familiar welcome after chat joy (v 0.8): v after it / after 5 more | **0.66** / 0.45 | 0.49 / 0.04 |
| Familiar refusal from 0: v after it / after 5 more | −0.17 / **−0.42** | 0.00 / −0.01 |
| 20 pats in a row (fine): strength at pats 1 / 10 / 20 (habituation) | .50 / .01 / .00 | .50 / .01 / .00 |
| … valence after pats 1 / 5 / 20 | .20 / .42 / .21 (held at w_E × 0.5) | .20 / .27 / −.01 |
| Long random run: share \|v\| ≥ .95 / a ≥ .95; flood of welcomes v ≥ .95 | 0.2% / 0; 0% | 0.1% / 0; 0% |
| Mood loop at f = 1.763: max \|mood\| | .74 | .74 |
| Neck poke → dislike → refuse: valence | .16 → −.22 → −.54 | −.03 → −.40 → −.65 |
| Stage-1 day: max \|v\|, mean a | .60, .58 | .59, .58 |
| γ = .31 / .61 / .91: 20th-pat v; day max \|v\| | .23 / .23 / .24; .78 / .60 / .30 | .01 / .01 / .06; .78 / .59 / .30 |

Habituation of what she feels (the error and its strength), the bounds and the mood loop are unchanged; what changes is that a known pleasant touch keeps her warm and a known unpleasant one keeps her cool, instead of both returning her to neutral.
