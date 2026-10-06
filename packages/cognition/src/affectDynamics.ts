import { SHANNON_MOOD_BASELINE } from './affect.js';
import { SHANNON_EMOTION_CONTINUITY, SHANNON_EMOTION_TIME } from './emotionTime.js';
import type { ShannonEmotion } from './types.js';

/**
 * How her feeling moves in time, after Syzygy ADR-0006 §2. Core: emotion. Stage 1 (影): computed beside the
 * half-life table of `emotionTime.ts` and compared with it; nothing reads it back into her state or a prompt.
 *
 * - Core affect (§2.1): valence and arousal (Russell 1980) as Ornstein–Uhlenbeck processes on her awake clock
 *   (DynAffect: Kuppens, Oravecz & Tuerlinckx 2010; Oravecz et al. 2011): dx = θ(attractor − x)dt + σ dW. It stays
 *   in the stationary band σ/√(2θ), which is also where a feeling counts as settled. Openness keeps the same form:
 *   no published dynamic model exists for it, so that is a modelling assumption (owner answer 5).
 * - Momentary impulses (§2.2, Rutledge et al. 2014), stage 2's bounded step (candidate B of
 *   `docs/testing/prediction-stage2-impact-study.md`, owner approval 2026-10-06): one outcome is one step of Rutledge's
 *   recency-weighted sum with their forgetting factor γ, normalised so that its weights (1 − γ)γ^k add up to one.
 *   Valence moves the share 1 − γ of the way to (attractor + w_δ × error, + w_E × expectation when a prediction preceded
 *   a choice of hers); arousal the share 1 − γ of the way to (its attractor + (1 − attractor) × u), u how improbable the
 *   outcome was under her own prediction (`unexpectedness`). A weighted average of points on the scale never leaves it
 *   and never passes its largest target: stage 1 added w_δ × error straight to valence, which pinned it at ±1 and held
 *   arousal at 1 (ADR-0006 「段 3 の前に決めること」 1). The OU return still runs between events.
 * - Mood (§2.3, Eldar & Niv 2015): mood ← mood + η_m (error − mood), and a perceived outcome is outcome × f^mood.
 *   The attractor of valence moves by w_δ × mood. f is fixed at 1 in this stage (owner answer 6).
 * - Emotional memory (§2.4): a trace per key, strength × (1 + t/τ)^(−ψ) on the awake clock (Wickelgren 1974,
 *   Wixted & Ebbesen 1991, Wixted 2004, Rubin & Wenzel 1996), with the smaller ψ for an event whose |impulse| is
 *   0.72 or more (McGaugh 2004, Yonelinas & Ritchey 2015: arousing events fade slowly; the impulse, which is also the
 *   event's arousal impulse, stands in for arousal at encoding) and ψ kept apart for pleasant and unpleasant (Walker, Skowronski &
 *   Thompson 2003). A trace lives while it is above the stationary band; there is no count limit. A new outcome of
 *   the same key recalls it, and a recalled trace is rewritten by the error at the learning rate of that key
 *   (reconsolidation: Nader, Schafe & LeDoux 2000; Sevenster, Beckers & Kindt 2013).
 * - Episodes (§2.5): the 12-minute idle cap is replaced by a learned boundary (Zacks et al. 2007): the gaps between
 *   her events are a mixture of "within an episode" and "between episodes", two log-normals estimated online from
 *   her own record, and the awake clock runs through a gap only while it is more likely within an episode.
 * - Sleep (§2.5, owner answer 3): a gap past the boundary is a sleep. Memories are consolidated (Diekelmann & Born
 *   2010; Payne & Kensinger 2010) and softened (Walker & van der Helm 2009; contrary: Baran et al. 2012).
 *
 * Deterministic: the noise of the OU step is derived from the event's id (`deterministicNormal`), never Math.random.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BAND = SHANNON_EMOTION_CONTINUITY.settledBelow;
/** The shared scale of a decided feeling's strength (`voiceDecisionValues.ts`): subtle 0.25, moderate 0.60, strong 0.90. */
const MODERATE = 0.6;
const STRONG = 0.9;
/** θ from an autocorrelation of 0.4 over two hours (ADR-0006 §2.6). */
const THETA = -Math.log(0.4) / (2 * HOUR);
const TAU = 1 / THETA;
/** How long the current table keeps a strong feeling (lingering half-life) and a moderate mood (mood half-life) above settled. */
const STRONG_SETTLES_MS = SHANNON_EMOTION_TIME.lingeringHalfLifeMs * Math.log2(STRONG / BAND);
const MODERATE_SETTLES_MS = SHANNON_EMOTION_TIME.moodHalfLifeMs * Math.log2(MODERATE / BAND);
const IDLE = SHANNON_EMOTION_TIME.idleCapMs / 1000;

/** The values the dynamics run with. Every one is in `SHANNON_AFFECT_COEFFICIENTS` with its source. */
export const SHANNON_AFFECT_DYNAMICS = Object.freeze({
  /** Per awake millisecond, for valence, arousal and openness. */
  theta: THETA,
  /** Per √(awake ms): the stationary band σ/√(2θ) equals the current `settledBelow` (0.15). */
  sigma: BAND * Math.sqrt(2 * THETA),
  attractor: SHANNON_MOOD_BASELINE,
  /**
   * w_E, the expectation's weight, in the same units as w_δ: w_δ × (w_EV / w_RPE) = 0.35 / 0.80 of Rutledge et al.'s 2014
   * fMRI experiment (z-scored happiness; as reported by Daswani & Leike 2015). 要確認 against the paper's own table. An
   * expected good outcome holds her valence up, an expected bad one holds it down, while the error alone fades with habit.
   */
  expectationWeight: 0.35 / 0.8,
  errorWeight: 1,
  /**
   * γ, the forgetting factor per event of Rutledge, Skandali, Dayan & Dolan 2014 (PNAS 111:12252): 0.61 ± 0.30 over
   * participants. 要確認: whether ± 0.30 is the SD or the SEM. The literature range used for fitting is that mean ± 0.30
   * (`eventForgettingRange`); a value outside it needs the owner's approval (ADR-0006 owner answer 4).
   */
  eventForgetting: 0.61,
  eventForgettingRange: Object.freeze([0.31, 0.91] as const),
  moodRate: SHANNON_EMOTION_CONTINUITY.moodColour,
  moodHalfLifeMs: SHANNON_EMOTION_TIME.moodHalfLifeMs,
  moodTilt: 1,
  /** τ of the memory curve: the OU time constant 1/θ. */
  memoryTimescaleMs: TAU,
  /** ψ of a trace encoded at `consolidatedFrom` or more: a strong feeling reaches the band when the current table's does. */
  consolidatedExponent: Math.log(STRONG / BAND) / Math.log(1 + STRONG_SETTLES_MS / TAU),
  /** ψ below it: a moderate feeling reaches the band when the current mood's does. */
  passingExponent: Math.log(MODERATE / BAND) / Math.log(1 + MODERATE_SETTLES_MS / TAU),
  consolidatedFrom: SHANNON_EMOTION_CONTINUITY.lingersFrom,
  pleasantExponentScale: 1,
  unpleasantExponentScale: 1,
  /** How much a sleep lowers ψ of a consolidated trace (multiplier). 1: no effect until fitted. */
  sleepConsolidation: 1,
  /** Per wall ms asleep: a strong feeling reaches the band after the current four-day bound. */
  sleepSoftening: Math.log(STRONG / BAND) / SHANNON_EMOTION_TIME.lingeringMaxWallMs,
  /** The episode prior, centred on the current idle cap: within ln(cap/12), between ln(cap·12), each σ = ln(12)/2, weight 2. */
  boundaryPrior: Object.freeze({ within: Math.log(IDLE / 12), between: Math.log(IDLE * 12), spread: Math.log(12) / 2, weight: 2 }),
});
const C = SHANNON_AFFECT_DYNAMICS;

/**
 * Which step at an outcome these dynamics take, kept on every comparison the shadow writes (`new_dynamics`): `bounded_b`
 * is stage 2's candidate B. A row without it was written by stage 1 (w_δ × δ added straight to valence).
 */
export const SHANNON_AFFECT_STEP = 'bounded_b';

/** One row of the coefficient table (ADR-0006 §2.6). `kind`: literature value, matched to current behaviour, given by the model, or an assumption. */
export interface AffectCoefficient {
  symbol: string;
  meaning: string;
  source: string;
  literature: string;
  initial: string;
  kind: 'literature' | 'matched' | 'model' | 'assumption';
  fit: string;
  /** The literature range is not yet checked against the source. */
  verify?: '要確認';
}

/**
 * Every coefficient, its source, the literature range and the initial value. Initial values are mostly matched to
 * the approved current behaviour so that switching over changes nothing at once (ADR-0006 §2.6); they are not new
 * fixed numbers, and they move to her own data later (owner answer 4: inside the literature range automatically and
 * recorded, outside it only with approval). Nothing here is a literature value unless `kind` says so.
 */
export const SHANNON_AFFECT_COEFFICIENTS: readonly AffectCoefficient[] = Object.freeze([
  { symbol: 'θ', meaning: 'return strength of valence, arousal (and openness)', source: 'Kuppens et al. 2010; Houben, Van Den Noortgate & Kuppens 2015',
    // 要確認: the range of the autocorrelation is the ADR's reading of the sources and has not been checked against them.
    literature: 'autocorrelation about 0.2–0.5 between measurements a few hours apart; half-life about 1–3 h', initial: '0.4 over 2 h (half-life ≈ 1.5 h)',
    kind: 'matched', fit: 'return in mood-history stretches without events', verify: '要確認' },
  { symbol: 'σ', meaning: 'fluctuation', source: 'Kuppens et al. 2010', literature: 'large individual differences',
    initial: 'stationary band σ/√(2θ) = 0.15 (the current settledBelow)', kind: 'matched', fit: 'residuals of the same stretches' },
  { symbol: 'attractor', meaning: 'where the mood returns', source: 'Kuppens et al. 2010', literature: '—',
    initial: 'current baseline (0, 0.30, 0.35); valence moves by w_δ × mood', kind: 'matched', fit: 'her long mean, very slowly' },
  { symbol: 'w_E, w_δ', meaning: 'weights of expectation and prediction error', source: 'Rutledge, Skandali, Dayan & Dolan 2014 (weights as reported by Daswani & Leike 2015)',
    // 要確認: w_CR 0.52, w_EV 0.35, w_RPE 0.80 (z-scored) are taken from Daswani & Leike's report of the fMRI experiment, not yet
    // from the paper's own table; "both positive, EV lower than RPE" is the paper's statement.
    literature: 'both positive, w_EV < w_RPE; fMRI experiment w_EV 0.35, w_RPE 0.80 (z-scored)',
    initial: 'w_δ 1 (an unexpected strong 0.90 appraisal is an impulse of 0.90); w_E = w_δ × 0.35/0.80 = 0.4375',
    kind: 'matched', fit: 'regression on the feelings she decided (reply feelings, touches)', verify: '要確認' },
  { symbol: 'γ', meaning: 'forgetting factor per event: the share 1 − γ an outcome moves valence and arousal toward its target', source: 'Rutledge, Skandali, Dayan & Dolan 2014',
    // 要確認: whether the ± 0.30 the range is built from is the SD or the SEM over participants.
    literature: '0.61 ± 0.30 over participants (range used: 0.31–0.91)', initial: '0.61', kind: 'literature',
    fit: 'inside 0.31–0.91 from the feelings she decided after touches and replies', verify: '要確認' },
  { symbol: 'u', meaning: 'how improbable an outcome was under her own prediction: erf(|δ| / √(2(U + N)))', source: 'Pearce & Hall 1980 (associability); Nassar et al. 2012 (surprise and arousal)',
    literature: '—', initial: 'from the prediction', kind: 'model', fit: '—' },
  { symbol: 'η_m', meaning: 'how fast mood moves', source: 'Eldar & Niv 2015', literature: 'estimated per person',
    initial: '0.3 per outcome (the current moodColour) and decay at the current mood half-life of 90 awake min', kind: 'matched', fit: 'mood history' },
  { symbol: 'f', meaning: 'mood tilt of perceived outcomes', source: 'Eldar & Niv 2015', literature: 'near 1, individual differences',
    initial: '1 (no tilt; owner answer 6)', kind: 'matched', fit: 'only inside the stability condition (isStableMoodTilt)' },
  { symbol: 'τ', meaning: 'timescale of the memory curve', source: 'Wixted & Ebbesen 1991; Wixted 2004', literature: 'varies by data set',
    initial: '1/θ (≈ 2.2 awake h)', kind: 'model', fit: 'strength she decides when she recalls' },
  { symbol: 'ψ (pleasant, unpleasant)', meaning: 'how memories fade', source: 'Wixted & Ebbesen 1991; Rubin & Wenzel 1996; Walker, Skowronski & Thompson 2003',
    literature: 'exponents differ widely by data set; unpleasant fades faster', initial: 'strong reaches the band in the current 1–2 awake days; equal for both signs',
    kind: 'matched', fit: 'strength she decides when she recalls' },
  { symbol: 'ψ by arousal', meaning: 'consolidation of arousing events', source: 'McGaugh 2004; Yonelinas & Ritchey 2015', literature: 'only the direction is sure',
    initial: 'smaller ψ from the current 0.72 (lingersFrom); moderate events reach the band with the current mood', kind: 'matched', fit: 'as ψ' },
  { symbol: 'noise, volatility', meaning: 'per prediction', source: 'Behrens et al. 2007; Mathys et al. 2011; Piray & Daw 2021', literature: '—',
    initial: 'the domain average', kind: 'model', fit: 'on line, from innovations (prediction.ts)' },
  { symbol: 'g', meaning: 'arousal gain on learning', source: 'McGaugh 2004; Nassar et al. 2012', literature: 'no transferable value',
    initial: '0', kind: 'matched', fit: 'compared in the shadow by how well the next outcome is predicted' },
  { symbol: 'α, kernel', meaning: 'new latent cause; recency kernel', source: 'Gershman, Blei & Niv 2010; Gershman et al. 2017', literature: 'simulation values',
    initial: 'α = 0.1, τ = 1 day, exponent 1 (prediction.ts)', kind: 'assumption', fit: 'her data', verify: '要確認' },
  { symbol: 'sleep softening', meaning: 'after a rest past the boundary', source: 'Walker & van der Helm 2009 (contrary: Baran et al. 2012)',
    literature: 'results differ', initial: 'strong reaches the band after the current four wall-clock days asleep (owner answer 3)', kind: 'matched', fit: 'feeling when recalled' },
  { symbol: 'sleep consolidation', meaning: 'lower ψ of a consolidated trace after sleep', source: 'Diekelmann & Born 2010; Payne & Kensinger 2010',
    literature: 'direction only', initial: '1 (no effect; the current table has none)', kind: 'matched', fit: 'as ψ' },
  { symbol: 'episode boundary', meaning: 'within / between episode gaps', source: 'Zacks et al. 2007', literature: '—',
    initial: 'two log-normals centred one factor of 12 either side of the current 12 min, σ = ln 12 / 2, weight 2: the boundary starts at 12 min',
    kind: 'assumption', fit: 'online from her own gaps' },
  { symbol: 'openness', meaning: 'same OU form', source: 'none (owner answer 5)', literature: 'no dynamic model',
    initial: 'θ and σ of valence, baseline 0.35, no impulses', kind: 'assumption', fit: 'as θ, σ' },
]);

interface Component { n: number; s: number; ss: number }
export interface EpisodeBoundaryModel { readonly within: Component; readonly between: Component }

export interface EmotionalTrace {
  key: string;
  /** Signed strength at encoding (valence units). */
  value: number;
  encodedAwakeMs: number;
  exponent: number;
  consolidated: boolean;
}

export interface AffectDynamicsState {
  core: ShannonEmotion;
  mood: number;
  traces: readonly EmotionalTrace[];
  boundary: EpisodeBoundaryModel;
  awakeMs: number;
  /** Wall-clock instant (ms) of her last event; null before the first. */
  lastAt: number | null;
  sleeps: number;
}

export interface AffectProjection extends ShannonEmotion {
  mood: number;
  /** The strongest trace now, signed; 0 when none is above the band. */
  present: number;
  awakeMs: number;
  band: number;
  boundaryMs: number;
}

/** σ/√(2θ): the ordinary size of her fluctuation. A feeling smaller than this cannot be told from it. */
export function stationaryBand(): number {
  return C.sigma / Math.sqrt(2 * C.theta);
}

export function createAffectDynamics(): AffectDynamicsState {
  const prior = C.boundaryPrior;
  const component = (mean: number): Component => ({ n: prior.weight, s: prior.weight * mean, ss: prior.weight * (prior.spread ** 2 + mean ** 2) });
  return {
    core: { ...C.attractor }, mood: 0, traces: [], boundary: { within: component(prior.within), between: component(prior.between) },
    awakeMs: 0, lastAt: null, sleeps: 0,
  };
}

/** A standard normal number derived from a seed (FNV-1a, a murmur3 finaliser, Box–Muller). The same seed always gives the same number. */
export function deterministicNormal(seed: string): number {
  const uniform = (text: string) => {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    return (((value ^ (value >>> 16)) >>> 0) + 1) / 4_294_967_297;
  };
  return Math.sqrt(-2 * Math.log(uniform(`${seed}#u`))) * Math.cos(2 * Math.PI * uniform(`${seed}#v`));
}

function parameters(component: Component): { mean: number; variance: number } {
  const mean = component.s / component.n;
  return { mean, variance: Math.max(1e-6, component.ss / component.n - mean ** 2) };
}

function logNormal(x: number, mean: number, variance: number): number {
  return -0.5 * (Math.log(2 * Math.PI * variance) + (x - mean) ** 2 / variance);
}

function withinOdds(boundary: EpisodeBoundaryModel, x: number): number {
  const within = parameters(boundary.within);
  const between = parameters(boundary.between);
  const share = boundary.within.n / (boundary.within.n + boundary.between.n);
  return Math.log(share) + logNormal(x, within.mean, within.variance) - Math.log(1 - share) - logNormal(x, between.mean, between.variance);
}

/** P(a gap of this length is inside an episode). */
export function withinEpisodeProbability(boundary: EpisodeBoundaryModel, gapMs: number): number {
  return 1 / (1 + Math.exp(-withinOdds(boundary, Math.log(Math.max(1, gapMs / 1000)))));
}

/** The gap at which "within an episode" stops being more likely than not (between the two centres). */
export function episodeBoundaryMs(boundary: EpisodeBoundaryModel): number {
  let low = parameters(boundary.within).mean;
  let high = parameters(boundary.between).mean;
  if (!(low < high)) return Math.exp((low + high) / 2) * 1000;
  if (withinOdds(boundary, low) <= 0) return Math.exp(low) * 1000;
  if (withinOdds(boundary, high) >= 0) return Math.exp(high) * 1000;
  for (let step = 0; step < 80; step += 1) {
    const middle = (low + high) / 2;
    if (withinOdds(boundary, middle) > 0) low = middle; else high = middle;
  }
  return Math.exp((low + high) / 2) * 1000;
}

/** One online EM step: the gap is shared between the two kinds by how likely each is. */
export function learnEpisodeGap(boundary: EpisodeBoundaryModel, gapMs: number): EpisodeBoundaryModel {
  const x = Math.log(Math.max(1, gapMs / 1000));
  const within = 1 / (1 + Math.exp(-withinOdds(boundary, x)));
  const add = (component: Component, weight: number): Component => ({ n: component.n + weight, s: component.s + weight * x, ss: component.ss + weight * x * x });
  return { within: add(boundary.within, within), between: add(boundary.between, 1 - within) };
}

/** A trace's strength (unsigned) at an awake instant. */
export function traceStrength(trace: EmotionalTrace, awakeMs: number): number {
  return Math.abs(trace.value) * (1 + Math.max(0, awakeMs - trace.encodedAwakeMs) / C.memoryTimescaleMs) ** -trace.exponent;
}

function exponentFor(value: number, consolidated: boolean): number {
  return (consolidated ? C.consolidatedExponent : C.passingExponent) * (value < 0 ? C.unpleasantExponentScale : C.pleasantExponentScale);
}

/** A trace recalled by a new outcome of its key is rewritten by the error, at that key's learning rate, and encoded anew. */
export function reconsolidateTrace(trace: EmotionalTrace, impulse: number, learningRate: number, awakeMs: number): EmotionalTrace {
  const now = Math.sign(trace.value) * traceStrength(trace, awakeMs);
  const value = clamp(now + clamp(learningRate, 0, 1) * (impulse - now), -1, 1);
  const consolidated = trace.consolidated || Math.abs(value) >= C.consolidatedFrom;
  return { key: trace.key, value, encodedAwakeMs: awakeMs, exponent: exponentFor(value, consolidated), consolidated };
}

function attractor(mood: number): ShannonEmotion {
  return { ...C.attractor, valence: clamp(C.attractor.valence + C.errorWeight * mood, -1, 1) };
}

function living(traces: readonly EmotionalTrace[], awakeMs: number): EmotionalTrace[] {
  return traces.filter(trace => traceStrength(trace, awakeMs) >= stationaryBand());
}

/**
 * Time passes until an event at `at`: the awake clock runs through the gap up to the learned boundary, the core
 * affect makes one exact OU step over that awake time (noise from `seed`), mood decays, and a gap past the
 * boundary is a sleep that softens memories. Then the gap is learned. An instant not after the last does nothing.
 */
export function advanceAffect(state: AffectDynamicsState, at: number, seed: string): AffectDynamicsState {
  if (state.lastAt === null) return { ...state, lastAt: at };
  const gap = at - state.lastAt;
  if (!(gap > 0)) return state;
  const boundaryMs = episodeBoundaryMs(state.boundary);
  const awake = Math.min(gap, boundaryMs);
  const slept = gap > boundaryMs;
  const target = attractor(state.mood);
  const decay = Math.exp(-C.theta * awake);
  const spread = C.sigma * Math.sqrt((1 - Math.exp(-2 * C.theta * awake)) / (2 * C.theta));
  const step = (name: keyof ShannonEmotion, minimum: number) => clamp(
    target[name] + (state.core[name] - target[name]) * decay + spread * deterministicNormal(`${seed}:${name}`), minimum, 1);
  const awakeMs = state.awakeMs + awake;
  const softening = slept ? Math.exp(-C.sleepSoftening * (gap - boundaryMs)) : 1;
  const traces = living(state.traces.map(trace => (slept ? {
    ...trace, value: trace.value * softening, exponent: trace.consolidated ? trace.exponent * C.sleepConsolidation : trace.exponent,
  } : trace)), awakeMs);
  return {
    core: { valence: step('valence', -1), arousal: step('arousal', 0), openness: step('openness', 0) },
    mood: state.mood * 0.5 ** (awake / C.moodHalfLifeMs), traces, boundary: learnEpisodeGap(state.boundary, gap),
    awakeMs, lastAt: at, sleeps: state.sleeps + (slept ? 1 : 0),
  };
}

export interface AffectOutcome {
  /** The prediction key the outcome belongs to: its trace. */
  key: string;
  /** Outcome − expectation, in valence units. */
  error: number;
  /** The expectation, applied (w_E) only when the prediction preceded a choice of hers. */
  expectation?: number;
  chosen?: boolean;
  /** The learning rate of that prediction: how far a recalled trace is rewritten. */
  learningRate: number;
  /** How improbable the outcome was under her prediction (`unexpectedness`), 0–1. Absent: no surprise is known (0). */
  unexpected?: number;
  /** γ for this step, when a fit inside `eventForgettingRange` is tried; absent: `eventForgetting`. */
  forgetting?: number;
  /**
   * The expectation is her standing appraisal of what happened (a touch: how she expects to take it), not a choice of hers:
   * w_E × expectation joins the valence target (Rutledge's EV term) but not the trace, whose strength is the error alone.
   */
  held?: boolean;
}

/**
 * The bounded step of one outcome (stage 2, candidate B): valence the share 1 − γ toward `target`, arousal the share
 * 1 − γ toward its attractor raised by u. Pure; openness is left as it is.
 */
export function boundedAffectStep(core: ShannonEmotion, target: number, unexpected: number, gamma: number = C.eventForgetting): ShannonEmotion {
  const u = clamp(finite(unexpected), 0, 1);
  const g = clamp(gamma, 0, 1);
  return {
    ...core,
    valence: clamp(g * core.valence + (1 - g) * clamp(target, -1, 1), -1, 1),
    arousal: clamp(g * core.arousal + (1 - g) * (C.attractor.arousal + (1 - C.attractor.arousal) * u), 0, 1),
  };
}

/** The impulses of one outcome at the current instant (call `advanceAffect` first). Returns the state and the impulse. */
export function impulseAffect(state: AffectDynamicsState, outcome: AffectOutcome): { state: AffectDynamicsState; impulse: number } {
  const error = finite(outcome.error);
  const impulse = clamp(C.errorWeight * error + (outcome.chosen ? C.expectationWeight * finite(outcome.expectation) : 0), -1, 1);
  const held = outcome.held && !outcome.chosen ? C.expectationWeight * finite(outcome.expectation) : 0;
  const core = boundedAffectStep(state.core, attractor(state.mood).valence + impulse + held, finite(outcome.unexpected), outcome.forgetting ?? C.eventForgetting);
  const recalled = state.traces.find(trace => trace.key === outcome.key);
  let traces = state.traces.filter(trace => trace !== recalled);
  if (recalled) traces = [...traces, reconsolidateTrace(recalled, impulse, outcome.learningRate, state.awakeMs)];
  else if (Math.abs(impulse) >= stationaryBand()) {
    const consolidated = Math.abs(impulse) >= C.consolidatedFrom;
    traces = [...traces, { key: outcome.key, value: impulse, encodedAwakeMs: state.awakeMs, exponent: exponentFor(impulse, consolidated), consolidated }];
  }
  return {
    state: { ...state, core, mood: state.mood + C.moodRate * (error - state.mood), traces: living(traces, state.awakeMs) },
    impulse,
  };
}

/** Eldar & Niv's perceived outcome: outcome × f^mood. With f = 1 it is the outcome. */
export function perceivedOutcome(outcome: number, mood: number, tilt: number = C.moodTilt): number {
  return outcome * tilt ** mood;
}

/** d(mood′)/d(mood) of one round mood → perceived outcome → error → mood, for an outcome y. */
export function moodLoopGain(tilt: number, rate: number, outcome: number, mood: number): number {
  return 1 - rate + rate * outcome * Math.log(tilt) * tilt ** mood;
}

/** The stability condition of owner answer 6: one round of the loop shrinks every deviation, for any outcome and mood on the scale. */
export function isStableMoodTilt(tilt: number, rate: number = C.moodRate): boolean {
  if (!(tilt > 0)) return false;
  return [-1, 1].every(outcome => [-1, 1].every(mood => Math.abs(moodLoopGain(tilt, rate, outcome, mood)) < 1));
}

/** Where she would be at `at` with nothing happening: the mean path (no noise, nothing learned). */
export function projectAffect(state: AffectDynamicsState, at: number): AffectProjection {
  const boundaryMs = episodeBoundaryMs(state.boundary);
  const gap = state.lastAt === null ? 0 : Math.max(0, at - state.lastAt);
  const awake = Math.min(gap, boundaryMs);
  const softening = gap > boundaryMs ? Math.exp(-C.sleepSoftening * (gap - boundaryMs)) : 1;
  const target = attractor(state.mood);
  const decay = Math.exp(-C.theta * awake);
  const awakeMs = state.awakeMs + awake;
  const strongest = state.traces
    .map(trace => Math.sign(trace.value) * traceStrength(trace, awakeMs) * softening)
    .filter(value => Math.abs(value) >= stationaryBand())
    .reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0);
  const value = (name: keyof ShannonEmotion) => target[name] + (state.core[name] - target[name]) * decay;
  return {
    valence: value('valence'), arousal: value('arousal'), openness: value('openness'),
    mood: state.mood * 0.5 ** (awake / C.moodHalfLifeMs), present: strongest, awakeMs, band: stationaryBand(), boundaryMs,
  };
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
