import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHANNON_STANCE_OUTCOME, SHANNON_TEMPERAMENT } from '@shannon/cognition';
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
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

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
  const apply = (event: Parameters<typeof harness.stateStore.apply>[1]) => harness.stateStore.apply(scope, event);
  return { ...harness, record, rows, decide, memories, apply };
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

  it('feels her stance on touches she is not asked about in the same episode without learning it again, and not across a long gap', async () => {
    const w = await world();
    w.decide('dislike', 'annoyed');
    await w.said({ type: 'poke', part: 'cheek', region: 'face', gesture: 'poke' });
    const before = w.state().emotion.valence;
    w.advance(20 * SECOND);
    await w.events({ id: 'poke-2', type: 'poke', audience: 'owner', occurredAt: w.clock.at, region: 'face', part: 'cheek', gesture: 'poke' });
    // Felt: her valence moves by the carried dislike against what she expects now.
    expect(w.state().emotion.valence).not.toBe(before);
    // Not learned: only the stance she gave is an outcome.
    expect(w.rows().map(row => row.outcome)).toEqual([SHANNON_STANCE_OUTCOME.dislike]);
    // Hours later the episode is over: nothing is carried, only the startle (arousal) moves her.
    w.advance(6 * 60 * MINUTE);
    await w.apply({ type: 'awake-observed' });
    const late = w.state().emotion.valence;
    await w.events({ id: 'poke-3', type: 'poke', audience: 'owner', occurredAt: w.clock.at, region: 'face', part: 'cheek', gesture: 'poke' });
    expect(w.state().emotion.valence).toBeCloseTo(late, 9);
  });

  it('learns one refusal followed by ten plain pokes as one refusal: the expectation does not harden, so she still feels them', async () => {
    const w = await world();
    w.decide('refuse', 'indignant', true);
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    const expected = () => w.record!.predict(scope, { domain: 'body_stance', key: 'poke.neck.owner', at: Date.parse(w.clock.at), context: 'unknown' })!.expectation;
    const afterRefusal = expected();
    for (let index = 0; index < 10; index += 1) {
      w.advance(15 * SECOND);
      await w.events({ id: `plain-${index}`, type: 'poke', audience: 'owner', occurredAt: w.clock.at, region: 'body', part: 'neck', gesture: 'poke' });
    }
    expect(w.rows()).toHaveLength(1);
    expect(expected()).toBeCloseTo(afterRefusal, 9);
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

  it('falls back to stage 1b, and says so, when there is no prediction record to learn in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = await world({ record: false });
    expect(warn.mock.calls.some(call => String(call[0]).includes('touches run as stage 1b'))).toBe(true);
    w.decide('welcome', 'happy');
    await w.said({ type: 'pet', region: 'head' });
    // Stage 1b: no stance asked of a touch in the old shape, and the table's feeling.
    expect(w.speaker.calls[0]!.stance).toBeUndefined();
    expect(w.speaker.prompts[0]).not.toContain('親密さ');
    warn.mockRestore();
  });
});

describe('the request path with a real record (deferred, as in production)', () => {
  async function deferredWorld(config: { deadlineMilliseconds?: number } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-stage2-'));
    directories.push(directory);
    const database = new DatabaseSync(join(directory, 'shannon.sqlite'));
    const queue: Array<() => void> = [];
    const record = new PredictionShadow({ database, createsSchema: true, defer: task => { queue.push(task); }, log: () => {} });
    const harness = await reactionHarness({ stage2: true, prediction: record, config });
    const rows = () => new SQLitePredictionStore(database, { createSchema: false }).rows(scope).filter(row => row.domain === 'body_stance');
    const flush = () => { while (queue.length) queue.shift()!(); };
    return { ...harness, record, rows, flush, queue, database };
  }

  it('writes nothing in the request: her stance is learned after the caller, and her feeling moved already', async () => {
    const w = await deferredWorld();
    w.speaker.decision = { say: false, text: '', feeling: 'happy', stance: 'welcome' };
    const before = w.state().emotion.valence;
    await w.said({ type: 'pet', part: 'head', region: 'head', gesture: 'stroke' });
    expect(w.state().emotion.valence).toBeGreaterThan(before);
    expect(w.rows()).toHaveLength(0);
    expect(w.queue.length).toBeGreaterThan(0);
    w.flush();
    expect(w.rows().map(row => row.outcome)).toEqual([SHANNON_STANCE_OUTCOME.welcome]);
  });

  it('gives up at the deadline with only the startle, learns nothing, and keeps nothing the late answer says', async () => {
    const w = await deferredWorld({ deadlineMilliseconds: 50 });
    w.speaker.delayMilliseconds = 400;
    w.speaker.decision = { say: true, text: '遅い返事', feeling: 'happy', stance: 'welcome' };
    const before = w.state().emotion;
    const answer = (await w.react({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' }, {})).body as { status: string };
    expect(answer.status).toBe('quiet');
    await new Promise(resolve => setTimeout(resolve, 500));
    w.flush();
    expect(w.rows()).toHaveLength(0);
    expect(w.state().emotion.valence).toBe(before.valence);
    expect(w.state().emotion.arousal).toBeGreaterThan(before.arousal);
  }, 30_000);

  it('answers a replayed request with the stored answer and learns its stance once', async () => {
    const w = await deferredWorld();
    w.speaker.decision = { say: true, text: 'もう。', feeling: 'annoyed', stance: 'dislike' };
    const request = { id: 'replayed-1', touch: { type: 'poke', durationMs: 300, ongoing: false, part: 'cheek', region: 'face', gesture: 'poke' }, audience: 'owner', occurredAt: w.clock.at };
    const first = await w.send('POST', '/v1/body/reactions', request);
    const second = await w.send('POST', '/v1/body/reactions', request);
    expect(second.body).toEqual(first.body);
    w.flush();
    expect(w.rows()).toHaveLength(1);
    expect(w.speaker.calls).toHaveLength(1);
  });

  it('does not learn a stance whose touch the owner had her forget before the write ran', async () => {
    const w = await deferredWorld();
    w.speaker.decision = { say: false, text: '', feeling: 'annoyed', stance: 'dislike' };
    await w.send('POST', '/v1/body/reactions', { id: 'forgotten-1', touch: { type: 'poke', durationMs: 300, ongoing: false, part: 'neck', region: 'body', gesture: 'poke' }, audience: 'owner', occurredAt: w.clock.at });
    const burst = w.reactionStore.burstOfTouch(scope, 'forgotten-1')!;
    w.stateStore.apply(scope, { type: 'memory-control-upserted', control: {
      memoryId: burst.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.clock.at, changeReason: 'ライ氏が忘れてと言った',
    } });
    w.flush();
    expect(w.rows()).toHaveLength(0);
  });

  it('takes concurrent touches each once, with her own stance each, and records them all after the caller', async () => {
    const w = await deferredWorld();
    w.speaker.delayMilliseconds = 20;
    w.speaker.script = call => ({ say: false, text: '', feeling: 'neutral', stance: call % 2 ? 'fine' : 'unsure' });
    const answers = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      w.send('POST', '/v1/body/reactions', { id: `together-${index}`, touch: { type: 'pet', durationMs: 900, ongoing: true, part: 'hair', region: 'head', gesture: 'stroke' }, audience: 'owner', occurredAt: w.clock.at })));
    expect(answers.every(answer => answer.status === 200)).toBe(true);
    expect(w.rows()).toHaveLength(0);
    w.flush();
    expect(w.rows()).toHaveLength(5);
    expect(new Set(w.rows().map(row => row.sourceId)).size).toBe(1);
    w.database.close();
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

  it('names an old-shape region by its own word in the history line (脇, 頬), never as 体', async () => {
    const w = await world();
    w.decide('unsure');
    await w.said({ type: 'tickle', region: 'side' });
    w.advance(MINUTE);
    await w.said({ type: 'poke', region: 'face', ongoing: false, durationMs: 200 });
    expect(w.speaker.prompts[0]).toContain('脇に触れられてボクが受け取りを決めるのは、これが初めて');
    expect(w.speaker.prompts[1]).toContain('頬に触れられてボクが受け取りを決めるのは、これが初めて');
  });

  it('gives every touch reaction her temperament from the one persona source, with others present too', async () => {
    const w = await world();
    w.decide('fine');
    await w.said({ type: 'pet' });
    await w.said({ type: 'poke', part: 'cheek', region: 'face', gesture: 'poke' }, { audience: 'others' });
    for (const prompt of w.speaker.prompts) expect(prompt).toContain(`- ${SHANNON_TEMPERAMENT}`);
  });

  it('words an old-shape touch with favour only when she took it as welcome or fine (iPhone and Mac send that shape)', async () => {
    const refused = await world();
    refused.decide('refuse', 'indignant', true);
    await refused.said({ type: 'pet', region: 'head' });
    expect(refused.state().expressiveEmotion?.cause).toContain('頭をなでられた');
    expect(refused.state().expressiveEmotion?.cause).not.toContain('もらった');
    expect(refused.memories.at(-1)!.summary).not.toContain('もらった');
    const partless = await world();
    partless.decide('dislike', 'uncomfortable', true);
    await partless.said({ type: 'pet' });
    expect(partless.state().expressiveEmotion?.cause).toContain('なでられた');
    expect(partless.memories.at(-1)!.summary).not.toContain('もらった');
    const welcomed = await world();
    welcomed.decide('welcome', 'happy', true);
    await welcomed.said({ type: 'pet', region: 'head' });
    expect(welcomed.state().expressiveEmotion?.cause).toContain('頭をなでてもらった');
    expect(welcomed.memories.at(-1)!.summary).toContain('頭をなでてもらった');
  });

  it('words the surprise of a touch whose stance is not known yet without favour', async () => {
    const w = await world();
    await w.events({ id: 'first-pat', type: 'pet', audience: 'owner', occurredAt: w.clock.at });
    expect(w.state().expressiveEmotion?.primary).toBe('surprised');
    expect(w.state().expressiveEmotion?.cause).toContain('なでられた');
    expect(w.memories.at(-1)!.summary).not.toContain('もらった');
  });

  it('neither learns nor rewrites the memory of a touch forgotten while she was deciding', async () => {
    const w = await world();
    w.speaker.script = () => {
      const burst = w.reactionStore.burstOfTouch(scope, 'touch-1')!;
      w.stateStore.apply(scope, { type: 'memory-control-upserted', control: {
        memoryId: burst.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: w.clock.at, changeReason: 'ライ氏が忘れてと言った',
      } });
      return { say: false, text: '', feeling: 'indignant', stance: 'refuse' };
    };
    await w.said({ type: 'poke', part: 'neck', region: 'body', gesture: 'poke' });
    expect(w.rows()).toHaveLength(0);
    // Written once when the touch arrived, never rewritten after it was forgotten.
    expect(w.memories).toHaveLength(1);
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
