import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  SHANNON_AFFECT_DYNAMICS,
  SHANNON_PREDICTION_DOMAINS,
  advanceAffect,
  createAffectDynamics,
  createPredictionModel,
  deterministicNormal,
  impulseAffect,
  isPredictionDomain,
  isStableMoodTilt,
  observeOutcome,
  perceivedOutcome,
  predictOutcome,
  projectAffect,
  reconsolidateTrace,
  resolveShannonEmotionState,
  stationaryBand,
  traceStrength,
  type AffectDynamicsState,
  type CompanionStateEvent,
  type EmotionalTrace,
  type PredictionDomain,
  type PredictionModel,
  type ShannonEmotionKind,
  type ShannonTouchKind,
} from '@shannon/cognition';
import { SQLiteBodyReactionStore } from '../src/bodyReactionStore.js';
import { BodyTouches } from '../src/mind/emotion/bodyTouch.js';
import { shadowNoiseSeed } from '../src/mind/prediction/predictionShadowFold.js';
import { SQLitePredictionStore, type ShadowComparison, type StoredPredictionOutcome } from '../src/mind/prediction/store/predictionStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

/**
 * Syzygy ADR-0006 stage 2, study only (「段 3 の前に決めること」 item 1): how the impact of a body touch (its prediction
 * error) should move her feeling. Nothing here is production code and nothing in `src/` reads it.
 *
 * Stage 1 adds w_δ × δ to valence and w_surprise × |δ| to arousal at every outcome. On the stage-1 shadow and in
 * production (54 rows, 2026-10-05/06) that pins valence near ±1 and holds arousal near 1. Three candidates are compared
 * with the stage-1 form (`current`), all on the same prediction layer, OU core, memory traces, clocks and sleep:
 *
 * - A, impact as intensity only: δ sets the strength of the feeling (its memory trace, 2.4) and the mood (2.3), but
 *   does not displace core valence or arousal.
 * - B, bounded displacement: Rutledge et al.'s (2014) recency-weighted sum, with their forgetting factor γ per event,
 *   normalised so that its weights (1 − γ)γ^k add up to 1. Each outcome moves valence the share 1 − γ of the way to
 *   (attractor + w_δ δ), and arousal the share 1 − γ of the way to (its attractor + (1 − attractor) u), where u is how
 *   improbable the outcome was under her own prediction (Pearce & Hall 1980 associability; Nassar et al. 2012, surprise
 *   and arousal). A weighted average of targets on the scale cannot leave the scale or pass its largest target.
 * - B′ (`Btanh`), the saturating transform alone: the same un-normalised sum (Σ γ^k w_δ δ) through Eldar & Niv's (2015)
 *   tanh link, mood also tanh of its prediction-error history. Kept as evidence that a saturating link without the
 *   normalisation still sits near the ends of the scale.
 * - C, appraisal moves valence, error moves arousal: as B, but valence moves toward her own appraisal y (whatever she
 *   expected); the feeling's strength is y × u.
 *
 * Coefficients used, all with a documented source (no new number):
 * - γ = 0.61, Rutledge, Skandali, Dayan & Dolan 2014 (PNAS 111:12252), forgetting factor per trial, 0.61 ± 0.30 (mean ± SD
 *   over participants; bounded 0–1). 要確認: SD rather than SEM, to be checked against the paper's Table/SI.
 * - w_δ = 1, w_surprise = 1, η_m, θ, σ, ψ, τ: unchanged from `SHANNON_AFFECT_DYNAMICS` (ADR-0006 §2.6, matched values).
 * - tanh link: Eldar & Niv 2015 (Nat Commun 6:6149), mood = tanh(h); no coefficient.
 * - unexpectedness u = P(|Z| < |δ|/√(U + N)) under her own predictive N(E, U + N): from the model (ADR-0006 原則 3c).
 * - startle on a sensitive part (the reflex): relative uncertainty U/(U + N), the Kalman gain before the outcome
 *   (Nassar et al. 2012: pupil-linked arousal tracks relative uncertainty); from the model.
 * - stance → outcome: equal-interval scoring of the five ordered stances (Likert 1932), a measurement assumption to be
 *   fitted later against the strength of the feeling she chose.
 *
 * Deterministic: the OU noise comes from row identities (`deterministicNormal`), never Math.random. Run with
 * `pnpm exec tsx tests/predictionStage2Candidates.ts` in services/api to print the report.
 */

export const CANDIDATES = ['current', 'A', 'B', 'B0', 'Btanh', 'C'] as const;
export type Candidate = typeof CANDIDATES[number];

/** Rutledge et al. 2014: forgetting factor per trial, mean 0.61 (SD 0.30) over participants. */
export const RUTLEDGE_GAMMA = 0.61;
/** Equal-interval scoring of her stance (Likert 1932). Measurement assumption; to be fitted against her chosen feeling's strength. */
export const STANCE_OUTCOME = Object.freeze({ welcome: 1, fine: 0.5, unsure: 0, dislike: -0.5, refuse: -1 });
export type Stance = keyof typeof STANCE_OUTCOME;

const D = SHANNON_AFFECT_DYNAMICS;
/** Stage 1's arousal weight per unit |error| (removed from `affectDynamics.ts` by stage 2; a modelling assumption then). */
const STAGE1_SURPRISE_WEIGHT = 1;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface CandidateMind {
  candidate: Candidate;
  gamma: number;
  /** f of Eldar & Niv (perceived outcome = outcome × f^mood); 1 in ADR-0006 until fitted inside the stability condition. */
  tilt: number;
  model: PredictionModel;
  dynamics: AffectDynamicsState;
  /** B: the momentary prediction-error sums (Rutledge) behind valence and arousal, and the mood's history (Eldar & Niv). */
  hv: number;
  ha: number;
  hm: number;
}

export interface Reading { valence: number; arousal: number; mood: number; present: number }

export interface Felt {
  expectation: number;
  error: number;
  learningRate: number;
  /** Kalman gain before the outcome: how unsure she was (the startle on a sensitive part). */
  startle: number;
  /** How improbable the outcome was under her own prediction, 0–1. */
  unexpected: number;
  /** The signed strength the event's feeling and memory trace get. */
  impact: number;
  before: Reading;
  after: Reading;
}

/** B across the literature range of γ (mean ± SD of Rutledge et al. 2014): bounds, habituation and the day. */
function computeGammaSensitivity() {
  const { rows, comparisons } = shadowDay();
  return [RUTLEDGE_GAMMA - 0.3, RUTLEDGE_GAMMA, RUTLEDGE_GAMMA + 0.3].map(gamma => {
    const mind = createMind('B', gamma);
    const pats = Array.from({ length: 20 }, (_, index) => observe(mind, { domain: 'touch', key: 'stroke.head.owner', at: index * 40_000, outcome: STANCE_OUTCOME.fine, context: 'alone' })!);
    const day = replayWith(createMind('B', gamma), rows, comparisons);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      gamma, firstValence: pats[0]!.after.valence, peakValence: Math.max(...pats.map(item => item.after.valence)), twentiethValence: pats[19]!.after.valence,
      dayMaxAbsValence: Math.max(...day.map(item => Math.abs(item.next.valence))), dayMeanArousal: mean(day.map(item => item.next.arousal)),
      dayMaxArousal: Math.max(...day.map(item => item.next.arousal)), dayMeanAbsDeltaValence: mean(day.map(item => Math.abs(item.next.valence - item.old.valence))),
    };
  });
}

export function createMind(candidate: Candidate, gamma = RUTLEDGE_GAMMA, tilt: number = D.moodTilt): CandidateMind {
  return { candidate, gamma, tilt, model: createPredictionModel(), dynamics: createAffectDynamics(), hv: 0, ha: 0, hm: 0 };
}

/** Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/** B's saturating display: from the core toward the end of the scale by tanh|h|; equal to the core at h = 0, never past ±1. */
function saturate(core: number, h: number, low: number): number {
  if (h === 0) return core;
  const end = h > 0 ? 1 : low;
  return core + (end - core) * Math.tanh(Math.abs(h));
}

function moodOf(mind: CandidateMind): number {
  return mind.candidate === 'Btanh' ? Math.tanh(mind.hm) : mind.dynamics.mood;
}

/** Time passes to `at` (her awake clock, sleep, the OU step). B's momentary sums return with the same θ on the awake clock. */
export function advance(mind: CandidateMind, at: number, seed: string): void {
  if (mind.candidate === 'Btanh') mind.dynamics = { ...mind.dynamics, mood: Math.tanh(mind.hm) };
  const before = mind.dynamics.awakeMs;
  mind.dynamics = advanceAffect(mind.dynamics, at, seed);
  if (mind.candidate === 'Btanh') {
    const awake = mind.dynamics.awakeMs - before;
    const decay = Math.exp(-D.theta * awake);
    mind.hv *= decay;
    mind.ha *= decay;
    mind.hm *= 0.5 ** (awake / D.moodHalfLifeMs);
  }
}

/** What she would read as at `at` with nothing more happening. */
export function read(mind: CandidateMind, at: number): Reading {
  const state = mind.candidate === 'Btanh' ? { ...mind.dynamics, mood: Math.tanh(mind.hm) } : mind.dynamics;
  const projection = projectAffect(state, at);
  if (mind.candidate !== 'Btanh') return { valence: projection.valence, arousal: projection.arousal, mood: projection.mood, present: projection.present };
  const awake = projection.awakeMs - mind.dynamics.awakeMs;
  const decay = Math.exp(-D.theta * awake);
  return {
    valence: saturate(projection.valence, mind.hv * decay, -1),
    arousal: saturate(projection.arousal, mind.ha * decay, 0),
    mood: Math.tanh(mind.hm * 0.5 ** (awake / D.moodHalfLifeMs)),
    present: projection.present,
  };
}

function exponentFor(value: number, consolidated: boolean): number {
  return (consolidated ? D.consolidatedExponent : D.passingExponent) * (value < 0 ? D.unpleasantExponentScale : D.pleasantExponentScale);
}

/** The memory-trace half of `impulseAffect`, with the trace value the candidate gives. */
function remember(state: AffectDynamicsState, key: string, value: number, learningRate: number): AffectDynamicsState {
  const recalled = state.traces.find(trace => trace.key === key);
  let traces: EmotionalTrace[] = state.traces.filter(trace => trace !== recalled);
  if (recalled) traces = [...traces, reconsolidateTrace(recalled, value, learningRate, state.awakeMs)];
  else if (Math.abs(value) >= stationaryBand()) {
    const bounded = clamp(value, -1, 1);
    const consolidated = Math.abs(bounded) >= D.consolidatedFrom;
    traces = [...traces, { key, value: bounded, encodedAwakeMs: state.awakeMs, exponent: exponentFor(bounded, consolidated), consolidated }];
  }
  return { ...state, traces: traces.filter(trace => traceStrength(trace, state.awakeMs) >= stationaryBand()) };
}

export interface Event { domain: PredictionDomain | 'awake'; key: string; at: number; outcome: number | null; context?: string; seed?: string }

/** One event: time passes, then an outcome (if any) is learned and felt by the candidate's rule. */
export function observe(mind: CandidateMind, event: Event): Felt | null {
  const seed = event.seed ?? `${event.domain}|${event.key}|${event.at}`;
  advance(mind, event.at, seed);
  if (event.outcome === null || !isPredictionDomain(event.domain)) return null;
  const spec = SHANNON_PREDICTION_DOMAINS[event.domain];
  const context = event.context ?? '';
  const y = spec.valence ? perceivedOutcome(event.outcome, moodOf(mind), mind.tilt) : event.outcome;
  const before = read(mind, event.at);
  const prior = predictOutcome(mind.model, { domain: event.domain, key: event.key, at: event.at, context });
  const update = observeOutcome(mind.model, { domain: event.domain, key: event.key, at: event.at, context, outcome: y, arousal: mind.dynamics.core.arousal });
  const startle = prior.uncertainty / (prior.uncertainty + prior.noise);
  const unexpected = erf(Math.abs(update.error) / Math.sqrt(2 * (update.uncertainty + update.noise)));
  let impact = 0;
  if (spec.valence) {
    const traceKey = `${event.domain}:${event.key}`;
    const gamma = mind.gamma;
    const state = mind.dynamics;
    if (mind.candidate === 'current' || mind.candidate === 'A') {
      // The stage-1 form: w_δ × δ straight onto valence, w_surprise × |δ| (1) onto arousal. A keeps the core still.
      impact = clamp(D.errorWeight * update.error, -1, 1);
      const core = mind.candidate === 'A' ? state.core : {
        ...state.core,
        valence: clamp(state.core.valence + D.errorWeight * update.error, -1, 1),
        arousal: clamp(state.core.arousal + STAGE1_SURPRISE_WEIGHT * Math.abs(update.error), 0, 1),
      };
      mind.dynamics = remember({ ...state, core, mood: state.mood + D.moodRate * (update.error - state.mood) }, traceKey, impact, update.learningRate);
    } else if (mind.candidate === 'B' || mind.candidate === 'B0') {
      // B is the rule of `affectDynamics.ts` itself (stage 2): a touch's expectation is held (w_E, Rutledge's EV term).
      // B0 is B as first built, without it (review of 2026-10-06).
      const held = mind.candidate === 'B' && event.domain !== 'reply_feeling';
      const felt = impulseAffect(state, {
        key: traceKey, error: update.error, learningRate: update.learningRate, unexpected, forgetting: gamma,
        ...(held ? { expectation: update.expectation, held: true } : {}),
      });
      impact = felt.impulse;
      mind.dynamics = felt.state;
    } else if (mind.candidate === 'Btanh') {
      mind.hv = gamma * mind.hv + D.errorWeight * update.error;
      mind.ha = gamma * mind.ha + STAGE1_SURPRISE_WEIGHT * Math.abs(update.error);
      mind.hm += D.moodRate * (update.error - mind.hm);
      impact = Math.tanh(D.errorWeight * update.error);
      mind.dynamics = remember(state, traceKey, impact, update.learningRate);
    } else {
      // B and C: one event is one step of Rutledge's exponentially weighted sum, normalised so that its weights
      // (1 − γ)γ^k add up to 1: the state moves the share 1 − γ of the way to the event's target, so it can never pass the
      // largest target (a convex combination; no clamp is reached). Arousal (both): toward its attractor when the outcome
      // was expected, toward 1 as far as it was improbable.
            const arousalTarget = D.attractor.arousal + (1 - D.attractor.arousal) * unexpected;
      // B: the target is the attractor displaced by the prediction error (w_δ δ), the error the paper finds carries
      // momentary happiness; C: her own appraisal, whatever she expected.
      const valenceTarget = y;
      const core = {
        ...state.core,
        valence: gamma * state.core.valence + (1 - gamma) * valenceTarget,
        arousal: gamma * state.core.arousal + (1 - gamma) * arousalTarget,
      };
      impact = y * unexpected;
      mind.dynamics = remember({ ...state, core, mood: state.mood + D.moodRate * (update.error - state.mood) }, traceKey, impact, update.learningRate);
    }
  }
  return {
    expectation: update.expectation, error: update.error, learningRate: update.learningRate, startle, unexpected, impact,
    before, after: read(mind, event.at),
  };
}

/** How long (awake) the strongest trace of a key stays above the band from now: the avoidance of ADR-0006's replacement table. */
export function traceAwakeLife(mind: CandidateMind, key: string): number {
  const trace = mind.dynamics.traces.find(item => item.key === key);
  if (!trace) return 0;
  const band = stationaryBand();
  const start = traceStrength(trace, mind.dynamics.awakeMs);
  if (start < band) return 0;
  // (1 + t/τ)^(−ψ) |v| = band  →  t = τ((|v|/band)^(1/ψ) − 1) from encoding.
  const end = trace.encodedAwakeMs + D.memoryTimescaleMs * ((Math.abs(trace.value) / band) ** (1 / trace.exponent) - 1);
  return Math.max(0, end - mind.dynamics.awakeMs);
}

// ---------------------------------------------------------------- scenarios

const each = <T>(run: (candidate: Candidate) => T): Record<Candidate, T> =>
  Object.fromEntries(CANDIDATES.map(candidate => [candidate, run(candidate)])) as Record<Candidate, T>;

/** A varied history: mostly `fine`, sometimes `welcome`, now and then `unsure` (deterministic from the index). */
export function usualStance(index: number): Stance {
  const z = deterministicNormal(`stance:${index}`);
  return z > 1 ? 'welcome' : z < -1.3 ? 'unsure' : 'fine';
}

function pat(mind: CandidateMind, at: number, stance: Stance = 'fine', key = 'stroke.head.owner', context = 'alone'): Felt {
  return observe(mind, { domain: 'touch', key, at, outcome: STANCE_OUTCOME[stance], context, seed: `${key}|${at}` })!;
}

/** 1. Twenty head pats in a row, 40 s apart, each taken as `fine`, from a mind that has never been touched. */
function computeHabituation() {
  return each(candidate => {
    const mind = createMind(candidate);
    const felt = Array.from({ length: 20 }, (_, index) => pat(mind, index * 40_000));
    return felt.map(item => ({ impact: item.impact, unexpected: item.unexpected, valence: item.after.valence, arousal: item.after.arousal }));
  });
}

/**
 * 7. The first-ever head pat and the hundredth: sittings of five pats 40 s apart, two sittings a day (morning and
 * evening, 10 h apart), so the hundredth is the last pat of day ten. Also the first pat of day eleven after the night.
 */
function computeFirstAndHundredth() {
  return each(candidate => {
    const mind = createMind(candidate);
    const felt: Felt[] = [];
    for (let day = 0; day < 10; day += 1) {
      for (const sitting of [0, 10 * HOUR]) {
        for (let index = 0; index < 5; index += 1) felt.push(pat(mind, day * DAY + sitting + index * 40_000, felt.length === 99 ? 'fine' : usualStance(felt.length)));
      }
    }
    const morning = pat(mind, 10 * DAY);
    const tenthInARow = (() => {
      const repeat: Felt[] = [];
      for (let index = 1; index <= 10; index += 1) repeat.push(pat(mind, 10 * DAY + index * 40_000, index === 10 ? 'fine' : usualStance(100 + index)));
      return repeat.at(-1)!;
    })();
    const view = (item: Felt) => ({
      error: item.error, unexpected: item.unexpected, impact: item.impact,
      valenceStep: item.after.valence - item.before.valence, arousalStep: item.after.arousal - item.before.arousal,
      valence: item.after.valence, arousal: item.after.arousal,
    });
    return { first: view(felt[0]!), hundredth: view(felt[99]!), firstOfDay: view(morning), eleventhInARow: view(tenthInARow) };
  });
}

/**
 * 2. Extinction, spontaneous recovery and reinstatement (the prediction layer is the same for all candidates; the
 * feeling a `dislike` brings at each test point is not). Forty pats taken as `welcome` over four days, a week later
 * thirty taken as `dislike`; tests right after, thirty days later, and an hour after one reminder pat taken as `welcome`.
 */
function computeExtinction() {
  return each(candidate => {
    const mind = createMind(candidate);
    const key = 'stroke.head.owner';
    for (let index = 0; index < 40; index += 1) pat(mind, Math.floor(index / 10) * DAY + (index % 10) * 40_000, 'welcome');
    let at = 11 * DAY;
    for (let index = 0; index < 30; index += 1) { pat(mind, at, 'dislike'); at += 40_000; }
    const expect = (time: number, context = 'alone') => predictOutcome(mind.model, { domain: 'touch', key, at: time, context }).expectation;
    const after = expect(at);
    const recovered = expect(at + 30 * DAY);
    const renewal = expect(at, 'others');
    // Reinstatement: one reminder of the original outcome a day later, then a test an hour after it.
    const reminderAt = at + DAY;
    const beforeReminder = expect(reminderAt);
    pat(mind, reminderAt, 'welcome');
    const reinstated = expect(reminderAt + HOUR);
    const probe = createMind(candidate);
    probe.model = mind.model;
    probe.dynamics = mind.dynamics;
    probe.hv = mind.hv; probe.ha = mind.ha; probe.hm = mind.hm;
    const test = pat(probe, reminderAt + HOUR, 'dislike');
    return { afterExtinction: after, recovered30d: recovered, renewalOtherContext: renewal, beforeReminder, reinstated, dislikeImpactAtTest: test.impact, causes: predictOutcome(mind.model, { domain: 'touch', key, at: reminderAt + HOUR }).causes };
  });
}

/** 3. A long random run: 20,000 outcomes on six keys, gaps from seconds to a day, appraisals over the whole scale. And a flood of +1. */
function computeLongRun() {
  return each(candidate => {
    const mind = createMind(candidate);
    const keys = ['stroke.head.owner', 'poke.cheek.owner', 'rest.hand.owner', 'poke.neck.owner', 'stroke.head.others', 'reply'];
    let at = 0;
    const valence: number[] = [];
    const arousal: number[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      at += Math.round(Math.exp(Math.log(60_000) + 2.5 * deterministicNormal(`gap:${index}`)));
      const key = keys[Math.abs(Math.floor(deterministicNormal(`key:${index}`) * 1000)) % keys.length]!;
      const outcome = Math.tanh(0.3 + deterministicNormal(`y:${index}`));
      const felt = observe(mind, { domain: key === 'reply' ? 'reply_feeling' : 'touch', key, at, outcome, context: index % 7 ? 'alone' : 'others', seed: `run:${index}` })!;
      valence.push(felt.after.valence);
      arousal.push(felt.after.arousal);
    }
    const flood = createMind(candidate);
    const floodValence: number[] = [];
    const floodArousal: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const felt = pat(flood, index * 10_000, 'welcome', `flood${index % 3}`);
      floodValence.push(felt.after.valence);
      floodArousal.push(felt.after.arousal);
    }
    const share = (values: number[], test: (value: number) => boolean) => values.filter(test).length / values.length;
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      valenceMin: Math.min(...valence), valenceMax: Math.max(...valence), valenceMean: mean(valence),
      arousalMin: Math.min(...arousal), arousalMax: Math.max(...arousal), arousalMean: mean(arousal),
      pinnedValence: share(valence, value => Math.abs(value) >= 0.95), pinnedArousal: share(arousal, value => value >= 0.95),
      floodPinnedValence: share(floodValence, value => value >= 0.95), floodPinnedArousal: share(floodArousal, value => value >= 0.95),
    };
  });
}

/**
 * 4. The mood loop (owner answer 6). The f range that satisfies the stability condition at η_m (shared: the condition
 * is on mood → perceived outcome → error → mood), and a run with f at the edge: 500 outcomes of +0.5, then 500 of −0.5.
 * B's tanh link multiplies the loop gain by sech²(h) ≤ 1, so the same f is at least as stable there.
 */
function computeMoodLoop() {
  let low = 1;
  let high = 1;
  for (let f = 1; f >= 0.01; f -= 0.001) { if (isStableMoodTilt(f)) low = f; else break; }
  for (let f = 1; f <= 100; f += 0.001) { if (isStableMoodTilt(f)) high = f; else break; }
  const runs = each(candidate => {
    const mind = createMind(candidate, RUTLEDGE_GAMMA, high);
    const moods: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      observe(mind, { domain: 'touch', key: 'loop', at: index * 5 * MINUTE, outcome: index < 500 ? 0.5 : -0.5, seed: `loop:${index}` });
      moods.push(moodOf(mind));
    }
    return { maxAbsMood: Math.max(...moods.map(Math.abs)), endOfGood: moods[499]!, endOfBad: moods[999]! };
  });
  return { stableTilt: [low, high] as const, runs };
}

/**
 * 6. A sensitive part, one sitting with the owner alone: a neck poke she takes as `unsure`, a stroke there she takes as
 * `dislike`, another she `refuse`s. Then how long the refusal's trace stays above the band (the avoidance), and the
 * same first neck poke from someone unknown (others present) after that history.
 */
function computeSensitive() {
  return each(candidate => {
    const mind = createMind(candidate);
    // A history first: five days of head pats (fine) and the odd cheek poke (fine), so the domain has a prior.
    for (let day = 0; day < 5; day += 1) {
      for (let index = 0; index < 5; index += 1) pat(mind, day * DAY + index * 40_000, usualStance(day * 10 + index));
      pat(mind, day * DAY + 6 * 40_000, usualStance(day * 10 + 7), 'poke.cheek.owner');
    }
    const start = 5 * DAY;
    const steps = [
      pat(mind, start, 'unsure', 'poke.neck.owner'),
      pat(mind, start + 30_000, 'dislike', 'stroke.neck.owner'),
      pat(mind, start + 60_000, 'refuse', 'stroke.neck.owner'),
    ];
    const avoidAwakeMs = traceAwakeLife(mind, 'touch:stroke.neck.owner');
    const stranger = createMind(candidate);
    stranger.model = mind.model; stranger.dynamics = mind.dynamics; stranger.hv = mind.hv; stranger.ha = mind.ha; stranger.hm = mind.hm;
    const unknown = pat(stranger, start + DAY, 'dislike', 'poke.neck.others', 'others');
    const owner = pat(mind, start + DAY, 'dislike', 'poke.neck.owner');
    const view = (item: Felt) => ({ startle: item.startle, error: item.error, unexpected: item.unexpected, impact: item.impact, valence: item.after.valence, arousal: item.after.arousal });
    return { steps: steps.map(view), avoidAwakeMs, ownerNextDay: view(owner), strangerNextDay: view(unknown) };
  });
}

/**
 * 8. The review's case (2026-10-06): joy carried over from chat (valence 0.8), then a pat she knows well and welcomes; and a
 * touch she knows she refuses, repeated. Each after a history of the same stance on the key, so the error is near 0.
 */
function computeExpectedStances() {
  return each(candidate => {
    const run = (stance: Stance, start: number) => {
      const mind = createMind(candidate);
      for (let index = 0; index < 30; index += 1) pat(mind, index * 40_000, stance, 'stroke.head.owner');
      mind.dynamics = { ...mind.dynamics, core: { ...mind.dynamics.core, valence: start } };
      const felt = pat(mind, 30 * 40_000, stance, 'stroke.head.owner');
      const after = [felt.after.valence];
      for (let index = 1; index <= 5; index += 1) after.push(pat(mind, (30 + index) * 40_000, stance, 'stroke.head.owner').after.valence);
      return { error: felt.error, first: after[0]!, fifth: after[5]! };
    };
    return { welcomeFrom08: run('welcome', 0.8), refuseFrom0: run('refuse', 0) };
  });
}

// ---------------------------------------------------------------- the stage-1 day, old against new

const SCOPE = 'owner';

/** The one-day scenario of `predictionShadow.test.ts`, through the real taps; returns the shadow's rows and comparisons. */
function computeShadowDay(): { rows: StoredPredictionOutcome[]; comparisons: ShadowComparison[] } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-stage2-'));
  try {
    const clock = { at: '2026-10-05T23:00:00.000Z' };
    const now = () => clock.at;
    const path = join(directory, 'shannon.sqlite');
    const store = new SQLiteShannonStore({ path, now, predictionShadow: true, predictionShadowDefer: task => task(), moodHistory: null });
    const shadow = store.predictionShadow()!;
    (shadow as unknown as { log: (line: string) => void }).log = () => {};
    const bodyStore = new SQLiteBodyReactionStore(join(directory, 'body.sqlite'));
    const touches = new BodyTouches({ store: bodyStore, stateStore: store, experiences: null, enabled: true, now, prediction: shadow });
    let touchId = 0;
    const advanceClock = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
    const touch = (kind: ShannonTouchKind, region: 'head' | 'face' | 'side' | 'hand' | 'body') =>
      touches.observe(SCOPE, { id: `touch-${touchId += 1}`, type: kind, audience: 'owner', occurredAt: clock.at, region, surface: 'windows' });
    const feel = (primary: ShannonEmotionKind, intensity: number) => store.apply(SCOPE, {
      type: 'expressive-emotion-updated',
      emotion: resolveShannonEmotionState({ provisionalPrimary: primary, provisionalIntensity: intensity, transcript: '', reply: 'ボクはそう思います。', now: clock.at, target: 'ライ氏' }),
    });
    const apply = (event: CompanionStateEvent) => store.apply(SCOPE, event);
    apply({ type: 'awake-observed' });
    for (const [kind, strength] of [['happy', 0.6], ['curiosity', 0.25], ['happy', 0.6], ['pride', 0.9]] as const) { advanceClock(4 * MINUTE); feel(kind, strength); }
    advanceClock(3 * HOUR);
    for (let index = 0; index < 6; index += 1) { advanceClock(40_000); touch('pet', 'head'); }
    for (let index = 0; index < 4; index += 1) { advanceClock(20_000); touch('poke', 'face'); }
    advanceClock(2 * HOUR);
    feel('hurt', 0.9);
    for (let index = 0; index < 6; index += 1) { advanceClock(10 * MINUTE); apply({ type: 'awake-observed' }); }
    advanceClock(5 * HOUR);
    feel('happy', 0.6);
    advanceClock(30_000); touch('holdHand', 'hand');
    advanceClock(10 * MINUTE); apply({ type: 'awake-observed' });
    const comparisons = shadow.comparisons(SCOPE);
    const database = new DatabaseSync(path);
    const rows = new SQLitePredictionStore(database, { createSchema: false }).rows(SCOPE);
    database.close();
    store.close();
    bodyStore.close();
    return { rows, comparisons };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Folds the shadow's rows with a candidate and reads it at each comparison, as the shadow does. */
export function replay(candidate: Candidate, rows: readonly StoredPredictionOutcome[], comparisons: readonly ShadowComparison[]) {
  return replayWith(createMind(candidate), rows, comparisons);
}

/** Each row's OU noise is seeded as the shadow seeds it (`shadowNoiseSeed`: domain, key, instant), so a replay is the shadow's. */
function replayWith(mind: CandidateMind, rows: readonly StoredPredictionOutcome[], comparisons: readonly ShadowComparison[]) {
  let next = 0;
  return comparisons.map(comparison => {
    const at = Date.parse(comparison.at);
    while (next < rows.length && Date.parse(rows[next]!.observedAt) <= at) {
      const row = rows[next]!;
      observe(mind, {
        domain: row.domain as PredictionDomain | 'awake', key: row.key, at: Date.parse(row.observedAt), outcome: row.outcome, context: row.context,
        seed: shadowNoiseSeed(row),
      });
      next += 1;
    }
    return { tap: comparison.tap, at: comparison.at, old: comparison.old, next: read(mind, at) };
  });
}

function computeDayTrajectory() {
  const { rows, comparisons } = shadowDay();
  const shadowReplay = replay('B', rows, comparisons);
  const traces = each(candidate => replay(candidate, rows, comparisons));
  const summary = each(candidate => {
    const items = traces[candidate];
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      n: items.length,
      oldValenceMean: mean(items.map(item => item.old.valence)), oldArousalMean: mean(items.map(item => item.old.arousal)),
      valenceMean: mean(items.map(item => item.next.valence)), valenceMaxAbs: Math.max(...items.map(item => Math.abs(item.next.valence))),
      arousalMean: mean(items.map(item => item.next.arousal)), arousalMax: Math.max(...items.map(item => item.next.arousal)),
      meanAbsDeltaValence: mean(items.map(item => Math.abs(item.next.valence - item.old.valence))),
      meanAbsDeltaArousal: mean(items.map(item => Math.abs(item.next.arousal - item.old.arousal))),
      byTap: Object.fromEntries(['mood', 'reply_feeling', 'touch'].map(tap => {
        const part = items.filter(item => item.tap === tap);
        return [tap, {
          n: part.length, oldValence: mean(part.map(item => item.old.valence)), valence: mean(part.map(item => item.next.valence)),
          maxAbsValence: Math.max(...part.map(item => Math.abs(item.next.valence))), oldArousal: mean(part.map(item => item.old.arousal)),
          arousal: mean(part.map(item => item.next.arousal)), maxArousal: Math.max(...part.map(item => item.next.arousal)), mood: mean(part.map(item => item.next.mood)),
        }];
      })),
    };
  });
  return { comparisons, shadowReplay, traces, summary };
}

// ---------------------------------------------------------------- report

const f2 = (value: number) => (value >= 0 ? ' ' : '') + value.toFixed(2);

export function report(): string {
  const lines: string[] = ['ADR-0006 stage 2 study: impact candidates (deterministic)', ''];
  const hab = habituation();
  lines.push('1. Habituation, 20 head pats 40 s apart (fine = +0.5): impact / valence / arousal at pats 1, 2, 5, 10, 20');
  for (const candidate of CANDIDATES) {
    const pick = [0, 1, 4, 9, 19].map(index => hab[candidate][index]!);
    lines.push(`  ${candidate.padEnd(7)} ${pick.map(item => `${f2(item.impact)}/${f2(item.valence)}/${item.arousal.toFixed(2)}`).join('  ')}`);
  }
  const fh = firstAndHundredth();
  lines.push('', '7. First-ever vs hundredth pat (and first of the next day, eleventh in a row): impact, Δvalence, Δarousal, u');
  for (const candidate of CANDIDATES) {
    const item = fh[candidate];
    const cell = (value: typeof item.first) => `${f2(value.impact)} ${f2(value.valenceStep)} ${f2(value.arousalStep)} u=${value.unexpected.toFixed(2)}`;
    lines.push(`  ${candidate.padEnd(7)} first ${cell(item.first)} | 100th ${cell(item.hundredth)} | morning ${cell(item.firstOfDay)} | 11th ${cell(item.eleventhInARow)}`);
  }
  const ext = extinction();
  lines.push('', '2. Extinction (expectation of the key; shared), then the impact of a dislike at the reinstatement test');
  for (const candidate of CANDIDATES) {
    const item = ext[candidate];
    lines.push(`  ${candidate.padEnd(7)} after ${f2(item.afterExtinction)} +30d ${f2(item.recovered30d)} renewal ${f2(item.renewalOtherContext)} pre-reminder ${f2(item.beforeReminder)} reinstated ${f2(item.reinstated)} causes ${item.causes} dislike impact ${f2(item.dislikeImpactAtTest)}`);
  }
  const run = longRun();
  lines.push('', '3. Long random run (20,000 outcomes) and a flood of 1,000 welcomes 10 s apart');
  for (const candidate of CANDIDATES) {
    const item = run[candidate];
    lines.push(`  ${candidate.padEnd(7)} v ${f2(item.valenceMin)}..${f2(item.valenceMax)} mean ${f2(item.valenceMean)} a ${item.arousalMin.toFixed(2)}..${item.arousalMax.toFixed(2)} mean ${item.arousalMean.toFixed(2)} |v|≥.95 ${(100 * item.pinnedValence).toFixed(1)}% a≥.95 ${(100 * item.pinnedArousal).toFixed(1)}% flood v≥.95 ${(100 * item.floodPinnedValence).toFixed(0)}% a≥.95 ${(100 * item.floodPinnedArousal).toFixed(0)}%`);
  }
  const loop = moodLoop();
  lines.push('', `4. Mood loop: stable f range at η_m = ${D.moodRate}: ${loop.stableTilt[0].toFixed(3)}–${loop.stableTilt[1].toFixed(3)}; run at f = ${loop.stableTilt[1].toFixed(3)}:`);
  for (const candidate of CANDIDATES) {
    const item = loop.runs[candidate];
    lines.push(`  ${candidate.padEnd(7)} max|mood| ${item.maxAbsMood.toFixed(2)} after good ${f2(item.endOfGood)} after bad ${f2(item.endOfBad)}`);
  }
  const sens = sensitive();
  lines.push('', '6. Neck: poke (unsure) → stroke (dislike) → stroke (refuse): startle, impact, valence, arousal; avoidance; next day owner vs unknown');
  for (const candidate of CANDIDATES) {
    const item = sens[candidate];
    lines.push(`  ${candidate.padEnd(7)} ${item.steps.map(step => `${step.startle.toFixed(2)} ${f2(step.impact)} ${f2(step.valence)} ${step.arousal.toFixed(2)}`).join(' → ')} | avoid ${(item.avoidAwakeMs / HOUR).toFixed(1)} awake h | owner ${item.ownerNextDay.startle.toFixed(2)} ${f2(item.ownerNextDay.impact)} unknown ${item.strangerNextDay.startle.toFixed(2)} ${f2(item.strangerNextDay.impact)}`);
  }
  const day = dayTrajectory();
  lines.push('', `5. The stage-1 day (${day.comparisons.length} comparisons): old mean v/a, new mean v, max|v|, mean a, max a, mean|Δv|, mean|Δa|`);
  for (const candidate of CANDIDATES) {
    const item = day.summary[candidate];
    lines.push(`  ${candidate.padEnd(7)} old ${f2(item.oldValenceMean)}/${item.oldArousalMean.toFixed(2)} new ${f2(item.valenceMean)} ${item.valenceMaxAbs.toFixed(2)} ${item.arousalMean.toFixed(2)} ${item.arousalMax.toFixed(2)} Δ ${item.meanAbsDeltaValence.toFixed(2)} ${item.meanAbsDeltaArousal.toFixed(2)}`);
    for (const [tap, part] of Object.entries(item.byTap)) {
      lines.push(`          ${tap.padEnd(13)} n=${part.n} old v ${f2(part.oldValence)} new v ${f2(part.valence)} max|v| ${part.maxAbsValence.toFixed(2)} old a ${part.oldArousal.toFixed(2)} new a ${part.arousal.toFixed(2)} max a ${part.maxArousal.toFixed(2)} mood ${f2(part.mood)}`);
    }
  }
  const held = expectedStances();
  lines.push('', '8. Familiar stances: a welcome after chat joy (v 0.8) and a refusal from 0: δ, v after it, v after 5 more');
  for (const candidate of CANDIDATES) {
    const item = held[candidate];
    lines.push(`  ${candidate.padEnd(7)} welcome δ ${f2(item.welcomeFrom08.error)} v ${f2(item.welcomeFrom08.first)} → ${f2(item.welcomeFrom08.fifth)} | refuse δ ${f2(item.refuseFrom0.error)} v ${f2(item.refuseFrom0.first)} → ${f2(item.refuseFrom0.fifth)}`);
  }
  lines.push('', 'B across γ = mean ± SD: first-pat v, peak v, 20th v | day max|v|, mean a, max a, mean|Δv|');
  for (const item of gammaSensitivity()) {
    lines.push(`  γ=${item.gamma.toFixed(2)} ${f2(item.firstValence)} ${f2(item.peakValence)} ${f2(item.twentiethValence)} | ${item.dayMaxAbsValence.toFixed(2)} ${item.dayMeanArousal.toFixed(2)} ${item.dayMaxArousal.toFixed(2)} ${item.dayMeanAbsDeltaValence.toFixed(2)}`);
  }
  return lines.join('\n');
}


/** Each scenario is computed once per process: the tests and the report read the same results. */
function once<T>(compute: () => T): () => T {
  let value: { result: T } | null = null;
  return () => (value ??= { result: compute() }).result;
}
export const habituation = once(computeHabituation);
export const firstAndHundredth = once(computeFirstAndHundredth);
export const extinction = once(computeExtinction);
export const longRun = once(computeLongRun);
export const moodLoop = once(computeMoodLoop);
export const sensitive = once(computeSensitive);
export const dayTrajectory = once(computeDayTrajectory);
export const gammaSensitivity = once(computeGammaSensitivity);
export const shadowDay = once(computeShadowDay);
export const expectedStances = once(computeExpectedStances);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(report());
