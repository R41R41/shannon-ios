import {
  SHANNON_PREDICTION_DOMAINS,
  advanceAffect,
  createAffectDynamics,
  createPredictionModel,
  impulseAffect,
  isPredictionDomain,
  observeOutcome,
  perceivedOutcome,
  projectAffect,
  type AffectDynamicsState,
  type AffectProjection,
  type PredictionModel,
} from '@shannon/cognition';
import type { PredictionDerived, PredictionOutcomeDraft } from './predictionStore.js';

/**
 * The shadow's mind: the prediction layer and the new dynamics, folded from outcome rows (Syzygy ADR-0006 stage 1).
 * Core: emotion. No store and no clock: the same rows in the same order give the same mind and the same derived
 * values, which is what lets the store recompute after forgetting.
 *
 * Each row advances the dynamics to its instant (its awake clock, sleep, the OU step with noise from the row's own
 * identity, never from its place in the table). A row with an outcome is then learned by its prediction domain; an
 * outcome on the valence scale is first perceived through the mood (f = 1 in this stage, so unchanged) and its error
 * moves her feeling. An `awake` row is an instant she was awake, with nothing to learn.
 */
export interface ShadowMind {
  model: PredictionModel;
  dynamics: AffectDynamicsState;
}

export interface FoldedOutcome extends PredictionDerived {
  /** The outcome on the domain's scale (ln seconds for a reply time). */
  outcome: number | null;
  /** The impulse to valence, for an outcome on the valence scale. */
  impulse: number | null;
  newCause: boolean;
  count: number;
}

const NOTHING: FoldedOutcome = Object.freeze({ outcome: null, expectation: null, uncertainty: null, error: null, learningRate: null, cause: null, impulse: null, newCause: false, count: 0 });

export function createShadowMind(): ShadowMind {
  return { model: createPredictionModel(), dynamics: createAffectDynamics() };
}

/** Folds one row into the mind (in place) and returns what was expected at that moment. */
export function foldOutcome(mind: ShadowMind, row: PredictionOutcomeDraft): FoldedOutcome {
  const at = Date.parse(row.observedAt);
  if (!Number.isFinite(at)) return NOTHING;
  mind.dynamics = advanceAffect(mind.dynamics, at, [row.domain, row.key, row.sourceId ?? '', row.observedAt].join('|'));
  if (row.outcome === null || !isPredictionDomain(row.domain)) return NOTHING;
  const domain = SHANNON_PREDICTION_DOMAINS[row.domain];
  const outcome = domain.valence ? perceivedOutcome(row.outcome, mind.dynamics.mood) : row.outcome;
  const update = observeOutcome(mind.model, {
    domain: row.domain, key: row.key, at, context: row.context, features: row.features, outcome, arousal: mind.dynamics.core.arousal,
  });
  let impulse: number | null = null;
  if (domain.valence) {
    const felt = impulseAffect(mind.dynamics, { key: `${row.domain}:${row.key}`, error: update.error, learningRate: update.learningRate });
    mind.dynamics = felt.state;
    impulse = felt.impulse;
  }
  return {
    outcome: update.outcome, expectation: update.expectation, uncertainty: update.uncertainty, error: update.error, learningRate: update.learningRate,
    cause: update.cause, impulse, newCause: update.newCause, count: update.count,
  };
}

/** Folds rows from an empty mind. */
export function foldOutcomes(rows: readonly PredictionOutcomeDraft[]): { mind: ShadowMind; folded: FoldedOutcome[] } {
  const mind = createShadowMind();
  return { mind, folded: rows.map(row => foldOutcome(mind, row)) };
}

/** Where the new dynamics would be at an instant with nothing more happening. */
export function readMind(mind: ShadowMind, at: string): AffectProjection {
  const time = Date.parse(at);
  return projectAffect(mind.dynamics, Number.isFinite(time) ? time : mind.dynamics.lastAt ?? 0);
}
