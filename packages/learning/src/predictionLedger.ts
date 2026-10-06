import {
  SHANNON_PREDICTION_DOMAINS,
  createPredictionModel,
  observeOutcome,
  predictOutcome,
  transformedOutcome,
  type PredictionDomain,
  type PredictionModel,
} from '@shannon/cognition';

/**
 * The prediction ledger (Syzygy ADR-0008 stage 1, 答え合わせ; `docs/cognition-ledger-contract.md`). Core: emotion. Pure.
 *
 * A prediction gets an id when it is opened, before its outcome, and is settled against the outcome later: matched, voided
 * (the outcome could not be a result of what was predicted), or expired. Its expectation comes from the one prediction
 * layer of ADR-0006 (`@shannon/cognition`), folded from the ledger's own settled rows in the order they were settled
 * (`outcomeSeq`). A row's derived values always equal that fold up to its `basisSeq`, so the store can recompute every row
 * after it deleted some (forgetting, retention): `recomputeLedger`.
 */
const DAY = 24 * 60 * 60_000;

export const LEDGER_DOMAINS = ['reply', 'call_answer', 'story_reacted', 'story_reaction', 'reading_used', 'step_success', 'body_stance'] as const;
export type LedgerDomain = typeof LEDGER_DOMAINS[number] & PredictionDomain;

export interface LedgerDomainRule {
  /** How long a prediction stays open. */
  expiresAfterMs: number;
  /**
   * What an expiry settles to: 0 for "it did not happen within the window" (a yes/no about that window), or null when an
   * expiry tells nothing about the outcome (unscored).
   */
  expiryOutcome: 0 | null;
}

/**
 * Expiry windows. `story_reacted`: 14 days, after which no reaction counts as none (owner override 5). `reading_used`: 7 days
 * (modelling assumption: a reading she has not noted in a week is not used). The others are settled within minutes and their
 * day is a technical bound: an expiry there means the outcome was lost, and it is not scored.
 */
export const LEDGER_DOMAIN_RULES: Readonly<Record<LedgerDomain, LedgerDomainRule>> = Object.freeze({
  reply: { expiresAfterMs: DAY, expiryOutcome: null },
  call_answer: { expiresAfterMs: DAY, expiryOutcome: null },
  story_reacted: { expiresAfterMs: 14 * DAY, expiryOutcome: 0 },
  story_reaction: { expiresAfterMs: 14 * DAY, expiryOutcome: null },
  reading_used: { expiresAfterMs: 7 * DAY, expiryOutcome: 0 },
  step_success: { expiresAfterMs: DAY, expiryOutcome: null },
  body_stance: { expiresAfterMs: DAY, expiryOutcome: null },
});

export function isLedgerDomain(value: string): value is LedgerDomain {
  return (LEDGER_DOMAINS as readonly string[]).includes(value);
}

/** How the owner reacted to a story she showed, as `story_reaction`'s outcome (the enum only; a comment is never read). */
export const STORY_REACTION_OUTCOME = Object.freeze({ like: 1, more: 0.5, unclear: 0 });

/** What became of a call of hers, as `call_answer`'s outcome; `failed` could not have been answered and is void (null). */
export const CALL_ANSWER_OUTCOME: Readonly<Record<'answered' | 'declined' | 'unanswered' | 'failed', 0 | 1 | null>> = Object.freeze({
  answered: 1, declined: 0, unanswered: 0, failed: null,
});

/** z of the central 80 % of a normal distribution. */
export const INTERVAL_80_Z = 1.2815515655446004;

export type LedgerStatus = 'open' | 'matched' | 'expired' | 'void';

export interface LedgerDerived {
  expectation: number;
  uncertainty: number;
  noise: number;
  intervalLow: number;
  intervalHigh: number;
  /** The domain prior's expectation at that moment: the reference forecast of the skill κ. */
  prior: number;
}

/** What a recompute needs of a row. */
export interface LedgerRow {
  predictionId: string;
  domain: LedgerDomain;
  key: string;
  context: string;
  madeAt: string;
  basisSeq: number;
  /** On the domain's scale; null while open, void, or expired unscored. */
  outcome: number | null;
  /** The place in the order of settling, for a row with an outcome. */
  outcomeSeq: number | null;
  settledAt: string | null;
}

/** The ledger's mind: the prediction model and the highest `outcomeSeq` folded into it. */
export interface LedgerMind { model: PredictionModel; seq: number; folded: number }

export function createLedgerMind(): LedgerMind {
  return { model: createPredictionModel(), seq: 0, folded: 0 };
}

/** The outcome as the ledger stores it: 0/1 for yes/no, clamped to the scale otherwise. */
export function ledgerOutcome(domain: LedgerDomain, value: number): number {
  return transformedOutcome(SHANNON_PREDICTION_DOMAINS[domain], value);
}

/** Folds one settled row into the mind (in place). Rows must come in `outcomeSeq` order. */
export function foldSettled(mind: LedgerMind, row: Pick<LedgerRow, 'domain' | 'key' | 'context' | 'outcome' | 'outcomeSeq' | 'settledAt'>): void {
  if (row.outcome === null || row.outcomeSeq === null || row.outcomeSeq <= mind.seq) return;
  const at = Date.parse(row.settledAt ?? '');
  observeOutcome(mind.model, { domain: row.domain, key: row.key, context: row.context, at: Number.isFinite(at) ? at : 0, outcome: row.outcome });
  mind.seq = row.outcomeSeq;
  mind.folded += 1;
}

/**
 * What she expects of a key now, with its 80 % interval and the domain prior. For a yes/no domain the interval is the
 * credible interval of the probability (e ± z√U); otherwise the predictive interval of the outcome (e ± z√(U + N)). Both are
 * clamped to the scale.
 */
export function ledgerPrediction(model: PredictionModel, query: { domain: LedgerDomain; key: string; context: string; at: number }): LedgerDerived {
  const spec = SHANNON_PREDICTION_DOMAINS[query.domain];
  const prediction = predictOutcome(model, query);
  // A key never seen: what the domain alone would expect (empirical Bayes over every key the domain has).
  const prior = predictOutcome(model, { domain: query.domain, key: '\u0000prior', at: query.at, context: query.context }).expectation;
  const spread = Math.sqrt(Math.max(0, prediction.uncertainty + (spec.family === 'bernoulli' ? 0 : prediction.noise)));
  const clamp = (value: number) => Math.min(spec.upper, Math.max(spec.lower, value));
  return {
    expectation: prediction.expectation, uncertainty: prediction.uncertainty, noise: prediction.noise,
    intervalLow: clamp(prediction.expectation - INTERVAL_80_Z * spread), intervalHigh: clamp(prediction.expectation + INTERVAL_80_Z * spread), prior,
  };
}

/** The settled rows in the order they are folded. */
export function settledInOrder<T extends Pick<LedgerRow, 'outcome' | 'outcomeSeq'>>(rows: readonly T[]): T[] {
  return rows.filter(row => row.outcome !== null && row.outcomeSeq !== null).sort((left, right) => left.outcomeSeq! - right.outcomeSeq!);
}

/**
 * Every row's derived values from the rows alone: the settled rows are folded in `outcomeSeq` order, and each row is
 * predicted from the fold of the settled rows up to its `basisSeq`, at the instant it was opened. Deterministic.
 */
export function recomputeLedger(rows: readonly LedgerRow[]): { derived: Map<string, LedgerDerived>; mind: LedgerMind } {
  const settled = settledInOrder(rows);
  const targets = [...rows].sort((left, right) => left.basisSeq - right.basisSeq || left.madeAt.localeCompare(right.madeAt) || left.predictionId.localeCompare(right.predictionId));
  const mind = createLedgerMind();
  const derived = new Map<string, LedgerDerived>();
  let next = 0;
  for (const row of targets) {
    while (next < settled.length && settled[next]!.outcomeSeq! <= row.basisSeq) foldSettled(mind, settled[next++]!);
    derived.set(row.predictionId, ledgerPrediction(mind.model, { domain: row.domain, key: row.key, context: row.context, at: Date.parse(row.madeAt) || 0 }));
  }
  while (next < settled.length) foldSettled(mind, settled[next++]!);
  return { derived, mind };
}

const DERIVED: readonly (keyof LedgerDerived)[] = ['expectation', 'uncertainty', 'noise', 'intervalLow', 'intervalHigh', 'prior'];

/** Whether two derived values are the same as stored (six decimals). Either side may be a whole row. */
export function sameDerived(left: LedgerDerived, right: LedgerDerived): boolean {
  return DERIVED.every(name => Math.abs(left[name] - right[name]) < 5e-7);
}

/** Six decimals: the stored value is what a recompute produces, also after a round trip through SQLite. */
export function roundedDerived(derived: LedgerDerived): LedgerDerived {
  const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0);
  return {
    expectation: round(derived.expectation), uncertainty: round(derived.uncertainty), noise: round(derived.noise),
    intervalLow: round(derived.intervalLow), intervalHigh: round(derived.intervalHigh), prior: round(derived.prior),
  };
}
