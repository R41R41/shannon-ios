import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHANNON_STANCE_OUTCOME } from '@shannon/cognition';
import type { BodyReactionDecision } from '../src/bodyReactionPrompt.js';
import type { TouchExperience, TouchExperienceWriter } from '../src/bodyTouchMemory.js';
import { touchPredictionEnabled, touchPredictionKey } from '../src/bodyTouchPrediction.js';
import { PredictionShadow } from '../src/predictionShadow.js';
import { SQLitePredictionStore } from '../src/predictionStore.js';
import { MINUTE, SECOND, reactionHarness, scope } from './bodyReactionHarness.js';

/**
 * Syzygy ADR-0006 stage 2 (the body), candidate B: no table for any part, the startle moves arousal, her stance is the
 * outcome of key gesture.part.who and its prediction error moves her. Stage 1b under `SHANNON_PREDICTION=off` is pinned
 * by the stage-1b tests (`bodyTouchReflex.test.ts` and the others, which run with the switch off).
 */
afterEach(() => { vi.unstubAllEnvs(); });

async function world(options: { record?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  const record = options.record === false ? null : new PredictionShadow({ database, createsSchema: true, defer: task => task(), log: () => {} });
  const memories: TouchExperience[] = [];
  const experiences: TouchExperienceWriter = { write: (_scope, experience) => { memories.push(experience); return true; } };
  const harness = await reactionHarness({ stage2: true, ...(record ? { prediction: record } : {}), experiences });
  const rows = () => new SQLitePredictionStore(database, { createSchema: false }).rows(scope).filter(row => row.domain === 'body_stance');
  const decide = (stance: BodyReactionDecision['stance'], feeling: BodyReactionDecision['feeling'] = 'neutral', say = false) => {
    harness.speaker.decision = { say, text: say ? 'もう、ライ氏。' : '', feeling, ...(stance ? { stance } : {}) };
  };
  return { ...harness, record, rows, decide, memories };
}

describe('the switch', () => {
  it('is on unless SHANNON_PREDICTION switches it off', () => {
    expect(touchPredictionEnabled({})).toBe(true);
    for (const value of ['off', 'false', '0', 'OFF']) expect(touchPredictionEnabled({ SHANNON_PREDICTION: value })).toBe(false);
  });

  it('keys a touch by gesture, part and who, from closed words only', () => {
    expect(touchPredictionKey({ type: 'pet', audience: 'owner' })).toBe('stroke.unnamed.owner');
    expect(touchPredictionKey({ type: 'poke', part: 'neck', gesture: 'poke', region: 'body', audience: 'others' })).toBe('poke.neck.unknown');
    expect(touchPredictionKey({ type: 'holdHand', part: 'chest', audience: 'owner' })).toBe('rest.chest.owner');
    expect(touchPredictionKey({ type: 'holdHand', region: 'hand', audience: 'owner' })).toBe('hold.hand.owner');
  });
});

describe('no table for any part (ADR-0005 owner answer 6)', () => {
  it('does not please her by a pat on the head: only the startle moves her, and only her arousal', async () => {
    const w = await world();
    const before = w.state();
    await w.events({ id: 'pat-1', type: 'pet', audience: 'owner', occurredAt: w.clock.at, region: 'head' });
    const after = w.state();
    expect(after.emotion.valence).toBe(before.emotion.valence);
    expect(after.emotion.arousal).toBeGreaterThan(before.emotion.arousal);
    expect(after.expressiveEmotion?.primary).not.toBe('happy');
  });
});

describe('her stance is the outcome', () => {
  it('learns the stance of key gesture.part.who at once, and moves her by its error, as strongly as it was unexpected', async () => {
    const w = await world();
    w.decide('welcome', 'happy');
    const before = w.state();
    const answer = await w.said({ type: 'pet', part: 'head', region: 'head', gesture: 'stroke' });
    expect(w.speaker.calls[0]!.stance).toBe(true);
    const rows = w.rows();
    expect(rows.map(row => [row.key, row.outcome, row.sourceKind])).toEqual([['stroke.head.owner', SHANNON_STANCE_OUTCOME.welcome, 'touch']]);
    const after = w.state();
    expect(after.emotion.valence).toBeGreaterThan(before.emotion.valence);
    // The feeling she chose, as strong as |w_δ δ| (the empty prior expects 0, so a welcome is an error of 1).
    expect(after.expressiveEmotion?.primary).toBe('happy');
    expect(after.expressiveEmotion?.intensity).toBeCloseTo(1, 6);
    expect(answer.mood.feeling ?? answer.mood.expression).toBeDefined();
  });

  it('asks her stance of a touch in the old shape too', async () => {
    const w = await world();
    w.decide('fine');
    await w.said({ type: 'poke' });
    expect(w.speaker.calls[0]!.stance).toBe(true);
    expect(w.rows().map(row => row.key)).toEqual(['poke.unnamed.owner']);
  });

  it('habituates: taken the same way again and again, a touch startles and moves her less each time', async () => {
    const w = await world();
    w.decide('fine', 'relief');
    const startles: number[] = [];
    const steps: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      w.advance(40 * SECOND);
      const before = w.state().emotion;
      await w.said({ type: 'pet', part: 'head', region: 'head', gesture: 'stroke' });
      const after = w.state().emotion;
      steps.push(Math.abs(after.valence - before.valence));
      startles.push(w.state().expressiveEmotion?.intensity ?? 0);
    }
    expect(steps.at(-1)!).toBeLessThan(steps[0]! / 3);
    const errors = w.rows().map(row => Math.abs(row.error!));
    for (let index = 1; index < errors.length; index += 1) expect(errors[index]!).toBeLessThan(errors[index - 1]!);
    expect(startles.at(-1)!).toBeLessThan(startles[0]!);
  });

  it('carries her stance onto touches she is not asked about in the same episode, and not across a long gap', async () => {
    const w = await world();
    w.decide('dislike', 'annoyed');
    await w.said({ type: 'poke', part: 'cheek', region: 'face', gesture: 'poke' });
    w.advance(20 * SECOND);
    await w.events({ id: 'poke-2', type: 'poke', audience: 'owner', occurredAt: w.clock.at, region: 'face', part: 'cheek', gesture: 'poke' });
    expect(w.rows().map(row => row.outcome)).toEqual([SHANNON_STANCE_OUTCOME.dislike, SHANNON_STANCE_OUTCOME.dislike]);
    w.advance(6 * 60 * MINUTE);
    await w.events({ id: 'poke-3', type: 'poke', audience: 'owner', occurredAt: w.clock.at, region: 'face', part: 'cheek', gesture: 'poke' });
    expect(w.rows()).toHaveLength(2);
  });

  it('does not stay pinned: a neck poke, a stroke there she dislikes, one she refuses', async () => {
    const w = await world();
    const valences: number[] = [];
    for (const [stance, feeling, gesture] of [['unsure', 'surprised', 'poke'], ['dislike', 'uncomfortable', 'stroke'], ['refuse', 'indignant', 'stroke']] as const) {
      w.advance(30 * SECOND);
      w.decide(stance, feeling, true);
      await w.said({ type: gesture === 'poke' ? 'poke' : 'pet', part: 'neck', region: 'body', gesture });
      valences.push(w.state().emotion.valence);
    }
    expect(valences[2]!).toBeLessThan(valences[0]!);
    expect(valences[2]!).toBeGreaterThan(-0.95);
    expect(w.state().emotion.arousal).toBeLessThan(0.95);
  });

  it('startles more at a touch while others are present (who is unknown) than at the same touch from the owner she knows', async () => {
    const w = await world();
    w.decide('fine');
    for (let index = 0; index < 6; index += 1) { w.advance(40 * SECOND); await w.said({ type: 'poke', part: 'cheek', region: 'face', gesture: 'poke' }); }
    const owner = w.record!.predict(scope, { domain: 'body_stance', key: 'poke.cheek.owner', at: Date.parse(w.clock.at) })!;
    const unknown = w.record!.predict(scope, { domain: 'body_stance', key: 'poke.cheek.unknown', at: Date.parse(w.clock.at) })!;
    expect(unknown.uncertainty / (unknown.uncertainty + unknown.noise)).toBeGreaterThan(owner.uncertainty / (owner.uncertainty + owner.noise));
  });

  it('meets every touch with the empty prior when there is no record: nothing is learned or kept', async () => {
    const w = await world({ record: false });
    w.decide('welcome', 'happy');
    await w.said({ type: 'pet', part: 'head', region: 'head', gesture: 'stroke' });
    w.advance(40 * SECOND);
    const before = w.state().emotion.valence;
    await w.said({ type: 'pet', part: 'head', region: 'head', gesture: 'stroke' });
    expect(w.state().emotion.valence).toBeGreaterThan(before);
  });
});

describe('what she is told and what she remembers', () => {
  it('tells her, with the owner alone, their closeness and how she took this part before; with others present, neither', async () => {
    const w = await world();
    w.decide('dislike', 'uncomfortable');
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    w.advance(MINUTE);
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    w.advance(MINUTE);
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' }, { audience: 'others' });
    const [first, second, third] = w.speaker.prompts;
    expect(first).toContain('ライ氏との親密さ: ');
    expect(first).toContain('首に触れられてボクが受け取りを決めるのは、これが初めて');
    expect(second).toContain('これまで首に触れられた時のボクの受け取り: いや 1回');
    expect(third).not.toContain('親密さ');
    expect(third).not.toContain('これまで首に');
  });

  it('keeps the touched part in the memory of the touch', async () => {
    const w = await world();
    w.decide('dislike', 'uncomfortable');
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    expect(w.memories.at(-1)!.summary).toContain('首をつつかれた');
  });

  it('forgets her stance with the touch: the rows of a forgotten burst go and the rest is recomputed', async () => {
    const w = await world();
    w.decide('refuse', 'indignant');
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    const burst = w.rows()[0]!.sourceId!;
    expect(w.record!.forget(scope, [burst])).toBe(1);
    expect(w.rows()).toHaveLength(0);
  });
});
