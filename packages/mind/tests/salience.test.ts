import { describe, expect, it } from 'vitest';
import {
  SALIENCE_V1, admit, currentSalience, decayedSalience, novelty, orderedItems, persistenceOf, salience, salienceTerms, type AttentionItem,
} from '../src/index.js';

const AT = '2026-10-07T03:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

describe('SALIENCE_V1', () => {
  it('has the weights, the decay and the capacity of the plan', () => {
    expect(SALIENCE_V1.weights).toEqual({ ownerSpeech: 0.9, addressed: 0.8, touch: 0.7, promiseDue: 0.8, predictionError: 0.6, ownTaskOutcome: 0.5, othersSpeech: 0.3, novelty: 0.4 });
    expect(SALIENCE_V1.tauMinutes).toEqual({ ambient: 10, sustained: 60 });
    expect([SALIENCE_V1.entry, SALIENCE_V1.capacity]).toEqual([0.5, 12]);
    expect(Object.isFrozen(SALIENCE_V1.weights)).toBe(true);
  });

  it('is 0 with no input and each weight alone with one input', () => {
    expect(salience({})).toBe(0);
    expect(salience({ ownerSpeech: true })).toBeCloseTo(0.9);
    expect(salience({ addressed: true })).toBeCloseTo(0.8);
    expect(salience({ touch: 'press' })).toBeCloseTo(0.7);
    expect(salience({ touch: 'hover' })).toBeCloseTo(0.35);
    expect(salience({ ownTaskOutcome: true })).toBeCloseTo(0.5);
    expect(salience({ othersSpeech: true })).toBeCloseTo(0.3);
    expect(salience({ novelty: 1 })).toBeCloseTo(0.4);
  });

  it('combines inputs as a noisy-OR', () => {
    expect(salience({ ownerSpeech: true, addressed: true })).toBeCloseTo(1 - 0.1 * 0.2);
    expect(salience({ othersSpeech: true, novelty: 0.5 })).toBeCloseTo(1 - 0.7 * 0.8);
    const all = salience({ ownerSpeech: true, addressed: true, touch: 'press', promiseDeltaMinutes: 0, predictionError: { delta: 4, sigma: 1 }, ownTaskOutcome: true, othersSpeech: true, novelty: 1 });
    expect(all).toBeGreaterThan(0.999);
    expect(all).toBeLessThanOrEqual(1);
  });

  it('doubles the weight of others\' speech addressed to her, capped at 1', () => {
    expect(salienceTerms({ othersSpeech: true, addressed: true }).othersSpeech).toBeCloseTo(0.6);
    expect(salienceTerms({ othersSpeech: true }).othersSpeech).toBeCloseTo(0.3);
  });

  it('counts a promise within ±30 minutes, as exp(−|Δ|/10)', () => {
    expect(salienceTerms({ promiseDeltaMinutes: 0 }).promiseDue).toBeCloseTo(0.8);
    expect(salienceTerms({ promiseDeltaMinutes: -10 }).promiseDue).toBeCloseTo(0.8 * Math.exp(-1));
    expect(salienceTerms({ promiseDeltaMinutes: 10 }).promiseDue).toBeCloseTo(0.8 * Math.exp(-1));
    expect(salienceTerms({ promiseDeltaMinutes: 30 }).promiseDue).toBeCloseTo(0.8 * Math.exp(-3));
    expect(salienceTerms({ promiseDeltaMinutes: 31 }).promiseDue).toBe(0);
    expect(salienceTerms({ promiseDeltaMinutes: Number.NaN }).promiseDue).toBe(0);
  });

  it('counts a prediction error as min(1, |δ|/2σ), and nothing without a positive σ', () => {
    expect(salienceTerms({ predictionError: { delta: 1, sigma: 1 } }).predictionError).toBeCloseTo(0.3);
    expect(salienceTerms({ predictionError: { delta: -2, sigma: 1 } }).predictionError).toBeCloseTo(0.6);
    expect(salienceTerms({ predictionError: { delta: 9, sigma: 1 } }).predictionError).toBeCloseTo(0.6);
    expect(salienceTerms({ predictionError: { delta: 1, sigma: 0 } }).predictionError).toBe(0);
    expect(salienceTerms({ predictionError: { delta: 1, sigma: -1 } }).predictionError).toBe(0);
  });

  it('clamps novelty into [0, 1]', () => {
    expect(salienceTerms({ novelty: 2 }).novelty).toBeCloseTo(0.4);
    expect(salienceTerms({ novelty: -1 }).novelty).toBe(0);
  });

  it('decays as exp(−Δt/τ): ten minutes for ambient items, an hour for promises and tasks', () => {
    expect(decayedSalience(0.8, 10 * 60_000, 'ambient')).toBeCloseTo(0.8 * Math.exp(-1));
    expect(decayedSalience(0.8, 60 * 60_000, 'sustained')).toBeCloseTo(0.8 * Math.exp(-1));
    expect(decayedSalience(0.8, -5_000, 'ambient')).toBeCloseTo(0.8);
    expect(persistenceOf('promise_due')).toBe('sustained');
    expect(persistenceOf('task_outcome')).toBe('sustained');
    expect(persistenceOf('utterance')).toBe('ambient');
    expect(persistenceOf('touch')).toBe('ambient');
  });

  it('measures novelty as 1 − the highest trigram similarity to what was recent', () => {
    expect(novelty('今日は寒いね', [])).toBe(1);
    expect(novelty('今日は寒いね', ['今日は寒いね'])).toBe(0);
    const partial = novelty('今日は寒いね、雪かな', ['今日は寒いね']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(novelty('', ['x'])).toBe(0);
  });
});

describe('attention holds at most twelve items and orders them', () => {
  const item = (id: string, initial: number, at = AT, persistence: AttentionItem['persistence'] = 'ambient'): AttentionItem => ({ id, initial, at, persistence });

  it('admits an item at s ≥ 0.5 only, and never twice', () => {
    expect(admit([], item('a', 0.49), AT).admitted).toBe(false);
    expect(admit([], item('a', 0.49), AT).evicted).toEqual([]);
    const first = admit([], item('a', 0.5), AT);
    expect(first.admitted).toBe(true);
    expect(admit(first.held, item('a', 0.9), AT).admitted).toBe(false);
  });

  it('evicts the lowest by current salience when full, which may be the candidate itself', () => {
    let held: readonly AttentionItem[] = [];
    for (let index = 0; index < 12; index += 1) held = admit(held, item(`i${index}`, 0.6 + index * 0.02), AT).held;
    expect(held).toHaveLength(12);
    const strong = admit(held, item('strong', 0.99), AT);
    expect(strong.admitted).toBe(true);
    expect(strong.held).toHaveLength(12);
    expect(strong.evicted.map(entry => entry.id)).toEqual(['i0']);
    const weak = admit(held, item('weak', 0.55), AT);
    expect(weak.admitted).toBe(false);
    expect(weak.evicted.map(entry => entry.id)).toEqual(['weak']);
  });

  it('compares by current salience: an old ambient item loses to a newer, weaker one; a promise lasts', () => {
    const old = item('old', 0.9, AT);
    const promise = item('promise', 0.9, AT, 'sustained');
    const fresh = item('fresh', 0.6, later(20));
    expect(currentSalience(old, later(20))).toBeLessThan(0.2);
    expect(orderedItems([old, promise, fresh], later(20)).map(entry => entry.id)).toEqual(['promise', 'fresh', 'old']);
  });

  it('breaks ties by the newer item, then by id', () => {
    expect(orderedItems([item('b', 0.7), item('a', 0.7)], AT).map(entry => entry.id)).toEqual(['a', 'b']);
    expect(orderedItems([item('a', 0.7, later(-1)), item('b', 0.7, later(-1)), item('c', 0.7)], later(-1)).map(entry => entry.id)[0]).toBe('c');
  });
});
