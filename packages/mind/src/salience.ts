import { characterGrams, jaccard } from './minhash.js';

/**
 * Attention's salience (`SALIENCE_V1`, Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`). A noisy-OR of closed inputs,
 * s₀ = 1 − Π(1 − wᵢxᵢ) with xᵢ ∈ [0, 1], decaying as s₀·exp(−Δt/τ). Attention orders what was perceived; it never silences
 * (`voiceSilence` stays the only silencer), so nothing here decides whether she speaks.
 */
export const SALIENCE_V1 = Object.freeze({
  version: 'salience.v1',
  weights: Object.freeze({
    /** Verified owner speech. */
    ownerSpeech: 0.9,
    /** Her name called, or addressed to her. */
    addressed: 0.8,
    /** A touch: press 1, hover 0.5. */
    touch: 0.7,
    /** A promise due: exp(−|Δmin|/10) within ±30 minutes. */
    promiseDue: 0.8,
    /** A prediction error: min(1, |δ|/2σ). */
    predictionError: 0.6,
    /** Her own task's outcome. */
    ownTaskOutcome: 0.5,
    /** Others' speech; doubled when addressed to her (capped at 1). */
    othersSpeech: 0.3,
    /** Novelty: 1 − the highest trigram similarity over the last 30 minutes. */
    novelty: 0.4,
  }),
  touch: Object.freeze({ press: 1, hover: 0.5 }),
  promise: Object.freeze({ windowMinutes: 30, scaleMinutes: 10 }),
  othersAddressedFactor: 2,
  noveltyWindowMinutes: 30,
  /** τ: ambient items fade in minutes, promises and tasks in an hour. */
  tauMinutes: Object.freeze({ ambient: 10, sustained: 60 }),
  /** An item enters the workspace at s ≥ 0.5; at most 12 are held, the lowest evicted to the `[ほか]` line. */
  entry: 0.5,
  capacity: 12,
});

export type SalienceTerm = keyof typeof SALIENCE_V1.weights;

/** The closed inputs of one event (`mind.event.v1` `salienceInputs`). Absent means 0. */
export interface SalienceInputs {
  ownerSpeech?: boolean;
  addressed?: boolean;
  touch?: 'press' | 'hover' | null;
  /** Minutes from the promise's due time (negative before it). */
  promiseDeltaMinutes?: number | null;
  predictionError?: { delta: number; sigma: number } | null;
  ownTaskOutcome?: boolean;
  othersSpeech?: boolean;
  /** In [0, 1]; `novelty()` computes it. */
  novelty?: number | null;
}

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Each term's wᵢxᵢ, in [0, 1]. */
export function salienceTerms(inputs: SalienceInputs): Readonly<Record<SalienceTerm, number>> {
  const { weights } = SALIENCE_V1;
  const promise = inputs.promiseDeltaMinutes;
  const promiseX = typeof promise === 'number' && Number.isFinite(promise) && Math.abs(promise) <= SALIENCE_V1.promise.windowMinutes
    ? Math.exp(-Math.abs(promise) / SALIENCE_V1.promise.scaleMinutes) : 0;
  const error = inputs.predictionError;
  const errorX = error && Number.isFinite(error.delta) && Number.isFinite(error.sigma) && error.sigma > 0 ? Math.abs(error.delta) / (2 * error.sigma) : 0;
  const othersWeight = Math.min(1, weights.othersSpeech * (inputs.addressed ? SALIENCE_V1.othersAddressedFactor : 1));
  return Object.freeze({
    ownerSpeech: inputs.ownerSpeech ? weights.ownerSpeech : 0,
    addressed: inputs.addressed ? weights.addressed : 0,
    touch: weights.touch * (inputs.touch ? SALIENCE_V1.touch[inputs.touch] : 0),
    promiseDue: weights.promiseDue * unit(promiseX),
    predictionError: weights.predictionError * unit(errorX),
    ownTaskOutcome: inputs.ownTaskOutcome ? weights.ownTaskOutcome : 0,
    othersSpeech: inputs.othersSpeech ? othersWeight : 0,
    novelty: weights.novelty * unit(inputs.novelty ?? 0),
  });
}

/** s₀ = 1 − Π(1 − wᵢxᵢ), in [0, 1]. */
export function salience(inputs: SalienceInputs): number {
  const remaining = Object.values(salienceTerms(inputs)).reduce((product, term) => product * (1 - term), 1);
  return unit(1 - remaining);
}

export type SaliencePersistence = 'ambient' | 'sustained';

/** s₀·exp(−Δt/τ); an age below zero (a clock that went back) counts as zero. */
export function decayedSalience(initial: number, ageMilliseconds: number, persistence: SaliencePersistence): number {
  const tau = SALIENCE_V1.tauMinutes[persistence] * 60_000;
  return unit(initial) * Math.exp(-Math.max(0, Number.isFinite(ageMilliseconds) ? ageMilliseconds : 0) / tau);
}

/** 1 − the highest trigram similarity to what was perceived in the window (the caller hands the texts of the last 30 minutes). */
export function novelty(text: string, recent: readonly string[]): number {
  const grams = characterGrams(text);
  if (!grams.size) return 0;
  let highest = 0;
  for (const other of recent) highest = Math.max(highest, jaccard(grams, characterGrams(other)));
  return unit(1 - highest);
}

/** An item held in attention: the id of what was perceived, its s₀, when, and how fast it fades. */
export interface AttentionItem {
  readonly id: string;
  readonly initial: number;
  readonly at: string;
  readonly persistence: SaliencePersistence;
}

export function currentSalience(item: AttentionItem, at: string): number {
  return decayedSalience(item.initial, Date.parse(at) - Date.parse(item.at), item.persistence);
}

/** Highest current salience first; a tie goes to the newer item, then to the id. */
export function orderedItems(items: readonly AttentionItem[], at: string): readonly AttentionItem[] {
  return Object.freeze([...items].sort((left, right) => currentSalience(right, at) - currentSalience(left, at)
    || right.at.localeCompare(left.at) || left.id.localeCompare(right.id)));
}

export interface Admission {
  /** Whether the candidate entered (s₀ ≥ 0.5 and not the lowest of a full workspace). */
  admitted: boolean;
  /** What is held now, in order. */
  held: readonly AttentionItem[];
  /** What left for the `[ほか]` summary queue: the lowest when the workspace was full, or the candidate itself. */
  evicted: readonly AttentionItem[];
}

/**
 * Offers one item to attention at `at`. Below the entry line it is not admitted and not evicted (it never entered). Above it, when
 * twelve are held, the lowest by current salience leaves for the summary queue, which may be the candidate itself.
 */
export function admit(items: readonly AttentionItem[], candidate: AttentionItem, at: string): Admission {
  if (candidate.initial < SALIENCE_V1.entry || items.some(item => item.id === candidate.id)) {
    return { admitted: false, held: orderedItems(items, at), evicted: Object.freeze([]) };
  }
  const ordered = orderedItems([...items, candidate], at);
  const held = ordered.slice(0, SALIENCE_V1.capacity);
  const evicted = ordered.slice(SALIENCE_V1.capacity);
  return { admitted: held.includes(candidate), held: Object.freeze(held), evicted: Object.freeze(evicted) };
}

/** What a kind of event fades like: a promise and a task outcome persist for an hour, everything else is ambient. */
export function persistenceOf(kind: string): SaliencePersistence {
  return kind === 'promise_due' || kind === 'task_outcome' ? 'sustained' : 'ambient';
}
