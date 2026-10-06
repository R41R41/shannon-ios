import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SHANNON_TOUCH_FEELINGS } from '@shannon/cognition';
import type { BodyReactionAnswer } from '../src/bodyReactionContract.js';
import { OpenAIBodyReactionSpeaker } from '../src/bodyReactionModel.js';
import {
  BODY_REACTION_OWN_RULE, BODY_REACTION_SCHEMA, BODY_REACTION_SCHEMA_WITH_STANCE, parsedBodyReaction,
} from '../src/bodyReactionPrompt.js';
import { BODY_TOUCH_REFLEX_PARTS, BODY_TOUCH_STANCES } from '../src/bodyTouchReflex.js';
import { BODY_TOUCH_PART_WORDS } from '../src/bodyTouchWords.js';
import { START, reactionHarness, scope } from './bodyReactionHarness.js';

/**
 * Syzygy ADR-0005 stage 1b (owner answers of 2026-10-05; coordinator note of 2026-10-06: 「シャノンに任せる」). On the parts
 * where her body flinches first (neck, chest, waist, legs, skirt) the touch → feeling table is not read: only the reflex
 * moves her, she is told the part, the gesture and the flinch as they are, and how she takes the touch is her own answer
 * (`stance`, kept in the result table). Nothing fixes what she feels there. A touch in the old shape is as before.
 */
const reflexTouch = (part: string, gesture: string, extra: Record<string, unknown> = {}) => ({
  type: gesture === 'poke' ? 'poke' : gesture === 'tickle' ? 'tickle' : 'pet', durationMs: gesture === 'poke' ? 200 : 1_500,
  ongoing: gesture !== 'poke', region: 'body', part, gesture, reflex: 'flinch', ...extra,
});

describe('the parts where only the reflex moves her', () => {
  it('are the five of owner answer 1, each a part of the body', () => {
    expect([...BODY_TOUCH_REFLEX_PARTS].sort()).toEqual(['chest', 'leg', 'neck', 'skirt', 'waist']);
    for (const part of BODY_TOUCH_REFLEX_PARTS) expect(BODY_TOUCH_PART_WORDS[part].region).toBe('body');
  });
});

describe('a touch in the old shape (touch vocabulary 1)', () => {
  it('is told, felt, answered and recorded exactly as before stage 1b', async () => {
    const harness = await reactionHarness();
    const answers: unknown[] = [];
    // Every type, regions and none, both audiences, a silent answer, a failed model, and the finished events.
    const script: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ type: 'pet', region: 'head' }, {}], [{ type: 'pet' }, {}], [{ type: 'poke', region: 'body', ongoing: false, durationMs: 200 }, {}],
      [{ type: 'poke', region: 'face', ongoing: false, durationMs: 300, strength: 0.9 }, {}], [{ type: 'tickle', region: 'side' }, { audience: 'others' }],
      [{ type: 'holdHand', region: 'hand', durationMs: 2_500 }, {}], [{ type: 'carry', ongoing: false, durationMs: 4_000 }, {}],
      [{ type: 'poke', region: 'body', ongoing: false, durationMs: 150 }, {}],
    ];
    harness.speaker.script = call => call === 3 ? { say: false, text: '', feeling: 'surprised' } : call === 5 ? new Error('down')
      : { say: true, text: `ことば${call}`, feeling: call % 2 ? 'bashful' : 'cuteAngry' };
    for (const [index, [touch, extra]] of script.entries()) {
      harness.advance(50_000);
      const answer = await harness.said(touch, extra);
      answers.push({ ...answer, ...(answer.message ? { message: { ...answer.message, id: 'x' } } : {}) });
      await harness.events({ id: `touch-${index + 1}`, type: touch.type, audience: extra.audience ?? 'owner', occurredAt: harness.clock.at, durationMs: 3_000,
        ...(touch.region ? { region: touch.region } : {}) });
    }
    harness.advance(30_000);
    await harness.events({ id: 'plain-1', type: 'poke', audience: 'owner', occurredAt: harness.clock.at, region: 'body' });
    const { updatedAt: _updatedAt, ...snapshot } = harness.state() as unknown as Record<string, unknown>;
    // What the model was asked (prompt and request, without the abort signal): no stance was asked of an old-shape touch.
    const calls = harness.speaker.calls.map(({ signal: _signal, ...rest }) => rest);
    expect(calls.every(call => !('stance' in call))).toBe(true);
    const day = { calls, answers, snapshot, activity: harness.activity().map(entry => entry.summary) };
    // Recorded by running this same day on a10fdedd, the production commit before stage 1b (and before the new feeling kind).
    expect(createHash('sha256').update(JSON.stringify(day)).digest('hex')).toBe('f8a35ecb23a99642f2beae03d12ac9c0fd3f268a3ece4a64df9e99c938391601');
  });

  it('is asked with the answer of before, without a stance; a touch that names its part is asked its stance too', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ say: false, text: '', feeling: 'surprised', stance: 'unsure' }) }), { status: 200 });
    }) as unknown as typeof fetch;
    const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'k', fetcher });
    expect(await speaker.decide({ scopeKey: scope, prompt: 'P', signal: new AbortController().signal }))
      .toEqual({ say: false, text: '', feeling: 'surprised', stance: 'unsure' });
    await speaker.decide({ scopeKey: scope, prompt: 'P', signal: new AbortController().signal, stance: true });
    const schemaOf = (body: Record<string, unknown>) => (body.text as { format: { schema: unknown } }).format.schema;
    expect(schemaOf(bodies[0]!)).toEqual(BODY_REACTION_SCHEMA);
    expect(BODY_REACTION_SCHEMA.properties).not.toHaveProperty('stance');
    expect(schemaOf(bodies[1]!)).toEqual(BODY_REACTION_SCHEMA_WITH_STANCE);
    expect(BODY_REACTION_SCHEMA_WITH_STANCE.required).toContain('stance');
    expect(BODY_REACTION_SCHEMA_WITH_STANCE.properties.stance.enum).toEqual([...BODY_TOUCH_STANCES]);
    // A stance outside the five is no stance; the line and the feeling stand.
    expect(parsedBodyReaction({ say: true, text: 'もう。', feeling: 'annoyed', stance: 'maybe' })).toEqual({ say: true, text: 'もう。', feeling: 'annoyed' });
  });
});

describe('what she is told of a touch that names its part', () => {
  it('names the part, the side, the gesture and her flinch as they are, and adds only that how she takes it is hers', async () => {
    const harness = await reactionHarness();
    const prompts: string[] = [];
    const ask = async (touch: Record<string, unknown>) => {
      harness.advance(60_000);
      await harness.said(touch);
      prompts.push(harness.speaker.prompts.at(-1)!);
      return prompts.at(-1)!;
    };
    const neck = await ask(reflexTouch('neck', 'poke'));
    expect(neck).toContain('- いま: ライ氏に首をつつかれた（ほんの一瞬）');
    expect(neck).toContain('- 体: 思わず小さく身を引いた');
    expect(neck).toContain(`- ${BODY_REACTION_OWN_RULE}`);
    expect(harness.speaker.calls.at(-1)!.stance).toBe(true);
    expect(await ask(reflexTouch('chest', 'rest'))).toContain('- いま: ライ氏に胸に触れられている（2秒ほど）');
    expect(await ask(reflexTouch('leg', 'stroke', { side: 'left' }))).toContain('- いま: ライ氏に左の脚をなでられている（2秒ほど）');
    expect(await ask(reflexTouch('skirt', 'poke', { reflex: 'avoid' }))).toContain('- 体: 思わず身をそらした');
    expect(await ask(reflexTouch('waist', 'tickle'))).toContain('- いま: ライ氏に腰をくすぐられている（2秒ほど）');
    // An ordinary part is named the same way; no flinch line where the body reported none.
    const head = await ask({ type: 'pet', durationMs: 1_500, ongoing: true, region: 'head', part: 'head', gesture: 'stroke', input: 'hover', reflex: 'none' });
    expect(head).toContain('- いま: ライ氏に頭をなでられている（2秒ほど、なぞるように）');
    expect(head).not.toContain('- 体: ');
    expect(head).toContain(`- ${BODY_REACTION_OWN_RULE}`);
    for (const prompt of prompts) {
      // No reading of the touch is written for her, no rule against anything, and nothing of a sexual vocabulary.
      expect(prompt).not.toMatch(/禁|触れられたくない|嫌がるべき|喜ぶべき|性的|セクハラ|いやらし|揉|めく/u);
      expect(prompt).not.toContain('体をつつかれた（');
    }
  });

  it('with other people present, tells the part and the flinch, and keeps the rule for the room', async () => {
    const harness = await reactionHarness();
    await harness.said(reflexTouch('neck', 'poke'), { audience: 'others' });
    const prompt = harness.speaker.prompts[0]!;
    expect(prompt).toContain('- いま: ライ氏か、そばにいる誰かに首をつつかれた（ほんの一瞬）');
    expect(prompt).toContain('- 体: 思わず小さく身を引いた');
    expect(prompt).toContain('- この場: ほかの人もいる');
    expect(prompt).not.toContain('理由 ');
  });
});

describe('how she takes it is her own answer, never a table', () => {
  const run = async (decision: { say: boolean; text: string; feeling: 'uncomfortable' | 'bashful' | 'neutral' | 'annoyed'; stance: typeof BODY_TOUCH_STANCES[number] }) => {
    const harness = await reactionHarness();
    harness.speaker.decision = decision;
    const before = harness.state();
    const answer = await harness.said(reflexTouch('neck', 'poke'));
    return { harness, before, answer };
  };

  it('becomes the feeling she chose, as strong as the reflex was felt, also when she stays silent; the body is shown it as her face', async () => {
    const silent = await run({ say: false, text: '', feeling: 'uncomfortable', stance: 'dislike' });
    expect(silent.answer).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'annoyed' } });
    expect(silent.harness.state().expressiveEmotion).toMatchObject({ primary: 'uncomfortable', target: 'ライ氏', cause: 'ライ氏に首をつつかれた' });
    expect(silent.harness.reactionStore.outcome(scope, 'touch-1')).toMatchObject({ stance: 'dislike', feeling: 'uncomfortable', said: false });
    // The same touch, another answer of hers: she may welcome it. Nothing turns her toward either.
    const fond = await run({ say: true, text: 'えへへ、くすぐったいです。', feeling: 'bashful', stance: 'welcome' });
    expect(fond.answer).toMatchObject({ status: 'said', message: { text: 'えへへ、くすぐったいです。', expression: 'bashful' }, mood: { expression: 'bashful' } });
    expect(fond.harness.state().expressiveEmotion).toMatchObject({ primary: 'bashful', cause: 'ライ氏に首をつつかれた' });
    expect(fond.harness.reactionStore.outcome(scope, 'touch-1')).toMatchObject({ stance: 'welcome', feeling: 'bashful', said: true });
    expect(fond.harness.activity().map(entry => entry.summary)).toEqual(['体に触れられて（首をつつかれた）、ひとこと返しました。']);
    // A refusal said aloud is hers to say.
    const refused = await run({ say: true, text: '首はやめてください。', feeling: 'annoyed', stance: 'refuse' });
    expect((refused.answer as BodyReactionAnswer).message?.text).toBe('首はやめてください。');
    expect(refused.harness.reactionStore.outcome(scope, 'touch-1')).toMatchObject({ stance: 'refuse', said: true });
    // Silent and calm: only the reflex stays, and the mood is not moved toward pleasant or unpleasant.
    const calm = await run({ say: false, text: '', feeling: 'neutral', stance: 'fine' });
    expect(calm.answer).toMatchObject({ status: 'quiet', mood: { expression: 'surprised' } });
    expect(calm.harness.state().emotion.valence).toBe(calm.before.emotion.valence);
  });

  it('comes from no table on these parts, through the plain events too; elsewhere the table and her silence are as before', async () => {
    const harness = await reactionHarness({ speaker: null });
    const before = harness.state();
    for (const [index, part] of BODY_TOUCH_REFLEX_PARTS.entries()) {
      harness.advance(20_000);
      await harness.events({ id: `e-${index}`, type: 'pet', audience: 'owner', occurredAt: harness.clock.at, durationMs: 5_000, strength: 1, region: 'body', part, gesture: 'stroke' });
    }
    // Five strokes in a row would please her by the table; here they only startled her.
    expect(harness.state().expressiveEmotion).toMatchObject({ primary: 'surprised', cause: 'ライ氏にスカートをさわられた（続けて5回目）' });
    expect(harness.state().emotion.valence).toBe(before.emotion.valence);
    expect(harness.state().emotion.openness).toBe(before.emotion.openness);
    // A stroke on the head in the new shape is felt by the table, as a pat always was.
    harness.advance(20_000);
    await harness.events({ id: 'head-1', type: 'pet', audience: 'owner', occurredAt: harness.clock.at, region: 'head', part: 'head', gesture: 'stroke' });
    expect(harness.state().expressiveEmotion?.cause).toBe(`ライ氏に${SHANNON_TOUCH_FEELINGS.pet.done}（続けて6回目）`);
  });

  it('feels a touch on an ordinary part named in the new shape exactly as the same touch in the old shape', async () => {
    const day = async (detail: Record<string, unknown>) => {
      const harness = await reactionHarness();
      harness.speaker.decision = { say: false, text: '', feeling: 'bashful', stance: 'welcome' };
      for (const [index, [type, region, extra]] of ([['pet', 'head', { part: 'hair', gesture: 'stroke' }], ['poke', 'face', { part: 'cheek', gesture: 'poke', side: 'left' }],
        ['tickle', 'side', { part: 'side', gesture: 'tickle' }], ['holdHand', 'hand', { part: 'hand', gesture: 'hold' }], ['pet', 'body', { part: 'shoulder', gesture: 'rest' }]] as const).entries()) {
        harness.advance(40_000);
        await harness.said({ type, region, durationMs: 1_500, ongoing: true, ...(Object.keys(detail).length ? { ...extra, ...detail } : {}) }, { id: `o-${index}` });
      }
      const { updatedAt: _updatedAt, ...snapshot } = harness.state() as unknown as Record<string, unknown>;
      return snapshot;
    };
    expect(await day({ reflex: 'flinch', input: 'press' })).toEqual(await day({}));
  });
});

describe('the result table', () => {
  it('keeps only closed words and numbers, and goes with its touch', async () => {
    const harness = await reactionHarness();
    harness.speaker.decision = { say: true, text: '首はやめてください。', feeling: 'uncomfortable', stance: 'refuse' };
    await harness.said(reflexTouch('neck', 'poke'));
    const outcome = harness.reactionStore.outcome(scope, 'touch-1')!;
    expect(Object.keys(outcome).sort()).toEqual(['audience', 'burstId', 'decidedAt', 'feeling', 'said', 'stance', 'touchId']);
    expect(JSON.stringify(outcome)).not.toContain('やめて');
    expect(harness.reactionStore.touchDetail(scope, 'touch-1')).toEqual({ part: 'neck', gesture: 'poke', reflex: 'flinch' });
    // Pruned with the touch it came from, at the retention of the touches.
    harness.reactionStore.prune(scope, new Date(Date.parse(START) + 400 * 24 * 60 * 60_000).toISOString());
    expect(harness.reactionStore.outcome(scope, 'touch-1')).toBeNull();
  });
});

describe('what bodies read while her feeling is uncomfortable (body thread note, 2026-10-06)', () => {
  // Older embeds and the older Windows body ignore a kind they do not know and show `expression`: it must be a face they have.
  const read = async (harness: Awaited<ReturnType<typeof reactionHarness>>) => (await harness.api.dispatch({
    method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId: 'body-pc',
  })).body as { mood: { expression: string; feeling?: string; primary: string } };

  it('is annoyed in a spoken answer, its mood, a silent answer\'s mood and presence, on a reflex part and an ordinary one', async () => {
    const spoken = await reactionHarness();
    spoken.speaker.decision = { say: true, text: '首はちょっと…。', feeling: 'uncomfortable', stance: 'dislike' };
    const said = await spoken.said(reflexTouch('neck', 'poke'));
    expect(said).toMatchObject({ status: 'said', message: { expression: 'annoyed' }, mood: { expression: 'annoyed' } });
    expect(said.message).not.toHaveProperty('feeling');
    expect(said.mood).not.toHaveProperty('feeling');
    expect(spoken.state().expressiveEmotion?.primary).toBe('uncomfortable');
    expect(await read(spoken)).toMatchObject({ mood: { expression: 'annoyed', primary: 'uncomfortable' } });
    expect((await read(spoken)).mood).not.toHaveProperty('feeling');

    const silent = await reactionHarness();
    silent.speaker.decision = { say: false, text: '', feeling: 'uncomfortable', stance: 'dislike' };
    expect(await silent.said(reflexTouch('skirt', 'stroke'))).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'annoyed' } });
    expect(await read(silent)).toMatchObject({ mood: { expression: 'annoyed', primary: 'uncomfortable' } });

    const ordinary = await reactionHarness();
    ordinary.speaker.decision = { say: true, text: 'それはいやです。', feeling: 'uncomfortable', stance: 'dislike' };
    expect(await ordinary.said({ type: 'pet', durationMs: 1_500, ongoing: true, region: 'face', part: 'cheek', gesture: 'stroke' }))
      .toMatchObject({ status: 'said', message: { expression: 'annoyed' }, mood: { expression: 'annoyed' } });
    expect(ordinary.state().expressiveEmotion?.primary).toBe('uncomfortable');
    expect(await read(ordinary)).toMatchObject({ mood: { expression: 'annoyed', primary: 'uncomfortable' } });
  });
});
