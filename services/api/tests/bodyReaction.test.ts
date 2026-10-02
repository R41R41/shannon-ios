import { describe, expect, it } from 'vitest';
import { SHANNON_ONE_LINE_VOICE, currentShannonEmotion, presentShannonFeeling, presentShannonMood } from '@shannon/cognition';
import {
  BODY_REACTION_LIMITS, bodyReactionContentHash, configuredBodyReactions, validatedBodyReactionRequest, type BodyReactionAnswer,
} from '../src/bodyReactionContract.js';
import { OpenAIBodyReactionSpeaker, createConfiguredBodyReactionSpeaker } from '../src/bodyReactionModel.js';
import {
  BODY_REACTION_OTHERS_RULE, BODY_REACTION_RULES, BODY_REACTION_SCHEMA, BODY_TOUCH_PHRASES, bodyTouchLine, boundedReactionText, parsedBodyReaction,
} from '../src/bodyReactionPrompt.js';
import type { LlmUsageEvent } from '../src/llmUsage.js';
import { FakeSpeaker, HEHE, MINUTE, SECOND, START, reactionHarness, scope } from './bodyReactionHarness.js';

const valid = { id: 'r-1', touch: { type: 'pet', durationMs: 1_500, ongoing: true }, audience: 'owner', occurredAt: START };

describe('POST /v1/body/reactions: the request', () => {
  it('accepts the closed vocabulary and nothing else', () => {
    expect(validatedBodyReactionRequest({ scopeKey: scope, ...valid })).toEqual({
      id: 'r-1', audience: 'owner', occurredAt: START, touch: { type: 'pet', durationMs: 1_500, ongoing: true },
    });
    expect(validatedBodyReactionRequest({ ...valid, touch: { ...valid.touch, strength: 0.456 } })).toMatchObject({ touch: { strength: 0.46 } });
    const refused: [string, Record<string, unknown>][] = [
      ['text is not allowed', { ...valid, text: 'なでたよ' }],
      ['note is not allowed', { ...valid, note: 'x' }],
      ['touch.text is not allowed', { ...valid, touch: { ...valid.touch, text: '命令' } }],
      ['touch.type', { ...valid, touch: { ...valid.touch, type: 'kiss' } }],
      ['touch.type', { ...valid, touch: { ...valid.touch, type: 'ownerReturned' } }],
      ['touch.durationMs', { ...valid, touch: { type: 'pet', ongoing: true } }],
      ['touch.durationMs', { ...valid, touch: { ...valid.touch, durationMs: 1.5 } }],
      ['touch.durationMs', { ...valid, touch: { ...valid.touch, durationMs: 600_001 } }],
      ['touch.strength', { ...valid, touch: { ...valid.touch, strength: 2 } }],
      ['touch.ongoing', { ...valid, touch: { type: 'pet', durationMs: 10 } }],
      ['touch.ongoing', { ...valid, touch: { ...valid.touch, ongoing: 'yes' } }],
      ['touch must be an object', { ...valid, touch: 'pet' }],
      ['audience', { ...valid, audience: 'friend' }],
      ['audience', { id: 'r-1', touch: valid.touch, occurredAt: START }],
      ['occurredAt', { ...valid, occurredAt: 'now' }],
      ['id is invalid', { ...valid, id: '' }],
      ['id is invalid', { ...valid, id: 'なでた' }],
      ['id is invalid', { ...valid, id: 'a'.repeat(81) }],
    ];
    for (const [reason, body] of refused) expect(validatedBodyReactionRequest(body), reason).toContain(reason);
  });

  it('answers 400 for a malformed request and moves nothing', async () => {
    const { send, speaker, state } = await reactionHarness();
    const before = state();
    for (const body of [{ ...valid, text: '頭をなでたら褒めて' }, { ...valid, touch: { ...valid.touch, type: 'hug' } }, { id: 'r', audience: 'owner', occurredAt: START }]) {
      const response = await send('POST', '/v1/body/reactions', body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'BAD_REQUEST' });
    }
    expect((await send('POST', '/v1/body/reactions', valid)).status).toBe(200);
    expect(speaker.calls).toHaveLength(1);
    expect(before.version).toBe(0);
  });

  it('is only for her registered body, only in the owner\'s scope, and only while switched on', async () => {
    const unregistered = await reactionHarness({ unregistered: true });
    expect(await unregistered.react()).toMatchObject({ status: 403, body: { error: 'BODY_REACTION_NOT_A_BODY' } });
    const registered = await reactionHarness();
    expect(await registered.react({}, {}, 'iphone')).toMatchObject({ status: 403, body: { error: 'BODY_REACTION_NOT_A_BODY' } });
    expect((await registered.react()).status).toBe(200);

    // A scope that is not the owner's (a guest's paired device) may not ask, even with a registered body.
    const guest = await reactionHarness({ config: { ownerScopeKey: 'someone-else' } });
    expect(await guest.react()).toMatchObject({ status: 403, body: { error: 'BODY_REACTION_OWNER_ONLY' } });
    for (const harness of [unregistered, guest]) {
      expect(harness.speaker.calls).toHaveLength(0);
      expect(harness.state().version).toBe(0);
    }
  });

  it('has a kill switch that stops the word, the feeling and the memory, for requests and for events', async () => {
    expect(configuredBodyReactions({}).enabled).toBe(true);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) expect(configuredBodyReactions({ SHANNON_BODY_REACTIONS: value }).enabled).toBe(false);
    expect(configuredBodyReactions({ SHANNON_BODY_REACTION_LISTEN_SECONDS: '9', SHANNON_BODY_REACTION_DEADLINE_MS: '3000', SHANNON_OWNER_SCOPE_KEY: 'rai' }))
      .toEqual({ enabled: true, listenSeconds: 9, deadlineMilliseconds: 3_000, ownerScopeKey: 'rai' });
    // Out of range: the defaults stand, and the deadline never passes what the body waits for.
    expect(configuredBodyReactions({ SHANNON_BODY_REACTION_LISTEN_SECONDS: '900', SHANNON_BODY_REACTION_DEADLINE_MS: '9000' }))
      .toMatchObject({ listenSeconds: 6, deadlineMilliseconds: 3_800, ownerScopeKey: 'owner' });
    expect(BODY_REACTION_LIMITS.deadlineMillisecondsMaximum).toBeLessThan(4_500);

    const off = await reactionHarness({ config: { enabled: false } });
    expect(await off.react()).toMatchObject({ status: 403, body: { error: 'BODY_REACTIONS_DISABLED' } });
    expect((await off.events({ id: 'e1', type: 'pet', audience: 'owner', occurredAt: START })).body).toMatchObject({ stored: 1 });
    expect(off.speaker.calls).toHaveLength(0);
    expect(off.state().version).toBe(0);
    expect(off.reactionStore.recentBursts(scope, START, START, 10)).toEqual([]);
    // With body events switched off, reactions are off as well.
    const ingestOff = await reactionHarness({ ingestEnabled: false });
    expect(await ingestOff.react()).toMatchObject({ status: 403, body: { error: 'BODY_INGEST_DISABLED' } });
    expect(ingestOff.state().version).toBe(0);
  });

  it('has a technical request limit and no count of how often she may be touched', async () => {
    const { react, advance, speaker } = await reactionHarness();
    for (let index = 0; index < BODY_REACTION_LIMITS.requestsPerMinute; index += 1) expect((await react()).status).toBe(200);
    expect(await react()).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
    advance(MINUTE);
    // Hour after hour: nothing but the per-minute limit ever refuses.
    for (let round = 0; round < 30; round += 1) {
      expect((await react()).status).toBe(200);
      advance(45 * SECOND);
    }
    expect(speaker.calls).toHaveLength(BODY_REACTION_LIMITS.requestsPerMinute + 30);
  });
});

describe('deciding and speaking', () => {
  it('answers a pat with one line, her face, the Talk a reply would continue, and how long to listen', async () => {
    const { said, speaker, chat } = await reactionHarness();
    const talk = await chat('おはよう');
    const answer = await said({ durationMs: 3_000, strength: 0.2 });
    expect(answer).toEqual({
      schemaVersion: 1, id: 'touch-1', status: 'said',
      message: { id: expect.stringMatching(/^[0-9a-f-]{36}$/u), text: HEHE, expression: 'bashful', threadId: talk.threadId, listenSeconds: 6 },
      mood: { expression: 'bashful' },
    });
    expect(speaker.calls).toHaveLength(1);
  });

  it('tells the model little: her one-line voice, the touch in words, her feeling, this sitting, and who can hear', async () => {
    const { said, speaker } = await reactionHarness();
    await said({ durationMs: 3_000, strength: 0.2 });
    const prompt = speaker.prompts[0]!;
    expect(prompt.startsWith(SHANNON_ONE_LINE_VOICE)).toBe(true);
    expect(prompt).toContain('- いま: ライ氏に頭をなでられている（3秒ほど、やさしく）');
    expect(prompt).toContain('- いまの気持ち: happy / 強度 ');
    expect(prompt).toContain('理由 ライ氏に頭をなでてもらった');
    expect(prompt).toContain('- この場: ライ氏と二人だけ');
    expect(prompt).toContain('- 頭をなでられた: いまのが1回目');
    expect(prompt).toContain('- 直前にボクが言ったこと: なし');
    for (const rule of BODY_REACTION_RULES) expect(prompt).toContain(rule);
    expect(prompt).not.toContain(BODY_REACTION_OTHERS_RULE);
    // No conversation is in progress, so no line of any Talk is in it, and it stays small.
    expect(prompt).not.toContain('[いまの会話]');
    expect(prompt.length).toBeLessThan(700);
    // No persona block, no capability list, no memory of the owner.
    for (const absent of ['[シャノンの人格]', '[ボクにできること', '記憶', 'ユーザー']) expect(prompt).not.toContain(absent);
  });

  it('words each touch, while it goes on and once it is over', () => {
    expect(bodyTouchLine({ type: 'pet', durationMs: 3_000, strength: 0.2, ongoing: true }, 'owner')).toBe('ライ氏に頭をなでられている（3秒ほど、やさしく）');
    expect(bodyTouchLine({ type: 'poke', durationMs: 120, ongoing: false }, 'owner')).toBe('ライ氏につつかれた（ほんの一瞬）');
    expect(bodyTouchLine({ type: 'carry', durationMs: 8_400, strength: 0.9, ongoing: false }, 'owner')).toBe('ライ氏に持ち上げて運ばれて、下ろされた（8秒ほど、強めに）');
    expect(bodyTouchLine({ type: 'tickle', durationMs: 1_200, strength: 0.5, ongoing: true }, 'others')).toBe('ライ氏か、そばにいる誰かにくすぐられている（1秒ほど）');
    expect(bodyTouchLine({ type: 'holdHand', durationMs: 90_000, ongoing: true }, 'owner')).toBe('ライ氏に手をつないでもらっている（2分ほど）');
    expect(Object.keys(BODY_TOUCH_PHRASES).sort()).toEqual(['carry', 'holdHand', 'pet', 'poke', 'tickle']);
  });

  it('lets her stay silent: the body gets her face and no message, and nothing waits for an answer', async () => {
    const { said, speaker, activity, reactionStore, state } = await reactionHarness();
    speaker.decision = { say: false, text: '', feeling: 'content' };
    const answer = await said();
    expect(answer).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'joyful' } });
    // The touch itself was felt.
    expect(state().expressiveEmotion?.primary).toBe('happy');
    expect(activity()).toEqual([]);
    expect(reactionStore.link(scope, 'touch-1', START)).toBeNull();
    // `say: true` with no words is silence too.
    speaker.decision = { say: true, text: '   ', feeling: 'happy' };
    expect(await said()).toMatchObject({ status: 'quiet', message: null });
  });

  it('stays quiet when the model fails or no model is configured, and still feels the touch', async () => {
    const failing = await reactionHarness();
    failing.speaker.decision = new Error('BODY_REACTION_UPSTREAM_500');
    expect(await failing.said()).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'joyful' } });
    const without = await reactionHarness({ speaker: null });
    expect(await without.said({ type: 'carry' })).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'embarrassed', feeling: 'flustered' } });
    expect(createConfiguredBodyReactionSpeaker({})).toBeNull();
  });

  it('keeps her line to one short sentence whatever the model returns', () => {
    expect(boundedReactionText(` 「${HEHE}」 `)).toBe(HEHE);
    expect(boundedReactionText('わっ！びっくりしました。')).toBe('わっ！びっくりしました。');
    const long = `${'とても長い反応です。'.repeat(4)}${'あ'.repeat(80)}`;
    expect(boundedReactionText(long)).toBe('とても長い反応です。'.repeat(4));
    expect(Array.from(boundedReactionText('あ'.repeat(200))).length).toBe(BODY_REACTION_LIMITS.textCharacters);
    expect(boundedReactionText(42)).toBe('');
    expect(parsedBodyReaction({ say: true, text: HEHE, feeling: 'bashful' })).toEqual({ say: true, text: HEHE, feeling: 'bashful' });
    expect(parsedBodyReaction({ say: true, text: HEHE, feeling: 'ecstasy' })).toMatchObject({ feeling: 'neutral' });
    expect(parsedBodyReaction({ say: false, text: '言わない', feeling: 'happy' })).toEqual({ say: false, text: '', feeling: 'happy' });
    expect(parsedBodyReaction({ text: HEHE })).toBeNull();
    expect(parsedBodyReaction('えへへ')).toBeNull();
  });

  it('tells her what already happened in this sitting, so she does not repeat herself and can escalate', async () => {
    const { said, speaker, advance } = await reactionHarness();
    speaker.script = call => [
      { say: true, text: HEHE, feeling: 'bashful' as const },
      { say: true, text: 'また？ ライ氏、今日は甘えん坊ですね。', feeling: 'teasing' as const },
      { say: false, text: '', feeling: 'content' as const },
      { say: true, text: 'もうっ、つつかないでください。', feeling: 'cuteAngry' as const },
    ][call - 1]!;
    await said();
    advance(50 * SECOND);
    await said();
    advance(50 * SECOND);
    expect(await said()).toMatchObject({ status: 'quiet' });
    advance(50 * SECOND);
    await said({ type: 'poke', durationMs: 100, ongoing: false });

    const [first, second, third, fourth] = speaker.prompts as [string, string, string, string];
    expect(first).toContain('- 頭をなでられた: いまのが1回目');
    expect(second).toContain('- 頭をなでられた: この数分で2回目');
    expect(second).toContain(`- 直前にボクが言ったこと: 「${HEHE}」`);
    expect(third).toContain('- 頭をなでられた: この数分で3回目');
    expect(third).toContain(`- 直前にボクが言ったこと: 「${HEHE}」「また？ ライ氏、今日は甘えん坊ですね。」`);
    // The feeling she is told escalates with the count (the one table): happy, then bashful from the third pat.
    expect(first).toContain('いまの気持ち: happy');
    expect(third).toContain('いまの気持ち: bashful');
    expect(third).toContain('（続けて3回目）');
    // Another kind of touch: its own count, and the earlier kind as something that happened a moment ago.
    expect(fourth).toContain('- いま: ライ氏につつかれた（ほんの一瞬）');
    expect(fourth).toContain('- つつかれた: いまのが1回目');
    expect(fourth).toContain('- 頭をなでられた: 1分前までに3回');
    expect(new Set(speaker.prompts).size).toBe(4);
  });

  it('includes the last lines of a conversation in progress with the owner alone, and none of an old one', async () => {
    const { said, speaker, chat, advance } = await reactionHarness();
    await chat('今日は原稿を進めたい');
    await chat('まず一章からやるよ');
    await said();
    const prompt = speaker.prompts[0]!;
    expect(prompt).toContain('[いまの会話]');
    const lines = prompt.slice(prompt.indexOf('[いまの会話]')).split('\n\n')[0]!.split('\n').slice(1);
    expect(lines).toEqual(['ボク: はい、ライ氏。', 'ライ氏: まず一章からやるよ', 'ボク: はい、ライ氏。']);
    advance(BODY_REACTION_LIMITS.conversationFreshMilliseconds + SECOND);
    await said();
    expect(speaker.prompts[1]).not.toContain('[いまの会話]');
  });
});

describe('others present', () => {
  it('still reacts in words, with the rule for the room and without any line of the owner\'s Talk', async () => {
    const { said, speaker, chat, state } = await reactionHarness();
    await chat('内緒だけど、来週の診察がこわい');
    const answer = await said({ type: 'tickle', durationMs: 1_200 }, { audience: 'others' });
    expect(answer).toMatchObject({ status: 'said', message: { text: HEHE, listenSeconds: 6 } });
    const prompt = speaker.prompts[0]!;
    expect(prompt).toContain('- いま: ライ氏か、そばにいる誰かにくすぐられている（1秒ほど）');
    expect(prompt).toContain('- この場: ほかの人もいる');
    expect(prompt).toContain(BODY_REACTION_OTHERS_RULE);
    for (const secret of ['[いまの会話]', '診察', '内緒']) expect(prompt).not.toContain(secret);
    // Her feeling moves all the same; its cause does not claim it was the owner, and no cause is told in front of others.
    expect(prompt).toContain('- いまの気持ち: giggle / 強度 ');
    expect(prompt).not.toContain('理由');
    expect(state().expressiveEmotion).toMatchObject({ target: '触れた人', cause: 'くすぐられた' });
  });

  it('repeats to the model in front of others only lines she said in front of others', async () => {
    const { said, speaker, advance } = await reactionHarness();
    speaker.script = call => ({ say: true, text: ['二人だけの時のひとこと。', 'みんなの前でのひとこと。', 'もうひとこと。'][call - 1]!, feeling: 'happy' as const });
    await said();
    advance(30 * SECOND);
    await said({}, { audience: 'others' });
    advance(30 * SECOND);
    await said({}, { audience: 'others' });
    expect(speaker.prompts[1]).toContain('- 直前にボクが言ったこと: なし');
    expect(speaker.prompts[2]).toContain('- 直前にボクが言ったこと: 「みんなの前でのひとこと。」');
    expect(speaker.prompts[2]).not.toContain('二人だけの時のひとこと');
    // Alone again she is told all of them.
    advance(30 * SECOND);
    await said();
    expect(speaker.prompts[3]).toContain('「二人だけの時のひとこと。」「みんなの前でのひとこと。」「もうひとこと。」');
  });

  it('returns nothing of a cause: the answer carries a face only', async () => {
    const { said } = await reactionHarness();
    const answer = await said({}, { audience: 'others' });
    expect(Object.keys(answer.mood).sort()).toEqual(['expression']);
    expect(JSON.stringify(answer)).not.toContain('cause');
  });
});

describe('her feeling', () => {
  it('moves with every accepted request, whether or not she speaks, and the answer shows the state after it', async () => {
    const { said, speaker, state, now } = await reactionHarness();
    speaker.decision = { say: false, text: '', feeling: 'neutral' };
    const before = state();
    const answer = await said({ type: 'poke', durationMs: 100, ongoing: false });
    const after = state();
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.expressiveEmotion).toMatchObject({ primary: 'surprised', cause: 'ライ氏につつかれた' });
    expect(after.emotion.arousal).toBeGreaterThan(before.emotion.arousal);
    expect(answer.mood).toEqual({ expression: presentShannonMood(after, now()).expression });
    expect(answer.mood.expression).toBe('surprised');
  });

  it('escalates: poked again and again she sulks, and the mood in each answer follows', async () => {
    const { said, speaker, state, advance } = await reactionHarness();
    speaker.decision = { say: false, text: '', feeling: 'neutral' };
    const faces: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      faces.push((await said({ type: 'poke', durationMs: 100, ongoing: false })).mood.expression);
      advance(20 * SECOND);
    }
    expect(faces).toEqual(['surprised', 'annoyed', 'annoyed', 'annoyed']);
    expect(state().expressiveEmotion).toMatchObject({ primary: 'sulky', cause: 'ライ氏につつかれた（続けて4回目）' });
    expect(state().emotion.valence).toBeLessThan(0);
  });

  it('takes the feeling of her line from her own words, as for any reply, and keeps the touch as its cause', async () => {
    const { said, speaker, state, now } = await reactionHarness();
    // The model names one feeling; her words show another: the reply cue decides, as everywhere.
    speaker.decision = { say: true, text: 'もうっ、びっくりするじゃないですか。', feeling: 'happy' };
    const answer = await said({ type: 'carry', durationMs: 4_000, ongoing: false });
    expect(answer.message).toMatchObject({ expression: 'annoyed' });
    expect(state().expressiveEmotion).toMatchObject({ primary: 'cuteAngry', cause: 'ライ氏に持ち上げて運ばれた' });
    expect(answer.mood).toEqual({ expression: presentShannonMood(state(), now()).expression });
    // A borrowed face carries its feeling name.
    speaker.decision = { say: true, text: 'わわっ、お、落ちます！', feeling: 'flustered' };
    expect((await said({ type: 'carry', durationMs: 4_000, ongoing: false })).message).toMatchObject({ expression: 'embarrassed', feeling: 'flustered' });
  });

  it('leaves a stronger feeling from the conversation in place, for the touch and for her line about it', async () => {
    const { said, stateStore, state, now } = await reactionHarness();
    stateStore.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'sad', secondary: [], intensity: 0.85, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.3, valence: -0.6,
      visibility: 'expressed', startedAt: now(), decay: 0.24, carryover: 0.7, updatedAt: now(),
    } });
    const answer = await said();
    expect(answer.status).toBe('said');
    expect(state().expressiveEmotion).toMatchObject({ primary: 'sad', cause: '生成した応答の内容と会話文脈' });
    expect(answer.mood).toEqual({ expression: 'sad' });
    // Her line still has the face of its own words.
    expect(answer.message).toMatchObject({ expression: 'bashful' });
  });

  it('stays while she is dormant and settles with the time she is awake', async () => {
    const { said, state, advance, now, stateStore } = await reactionHarness();
    await said();
    expect(presentShannonFeeling(state(), now()).primary).toBe('bashful');
    // Ninety minutes in which nothing happened: her clock stood still, and she is still glad to have been patted.
    advance(90 * MINUTE);
    expect(presentShannonMood(state(), now()).fromConversation).toBe(true);
    // A few hours awake (a session of her own) and it has settled.
    for (let step = 0; step < 30; step += 1) {
      advance(10 * MINUTE);
      stateStore.apply(scope, { type: 'awake-observed' });
    }
    expect(presentShannonFeeling(state(), now()).primary).toBe('neutral');
    expect(presentShannonMood(state(), now()).fromConversation).toBe(false);
    // The wall-clock rule the kill switch restores still reads the stored reaction as settled after ninety minutes.
    expect(currentShannonEmotion(state().expressiveEmotion, now()).primary).toBe('neutral');
  });
});

describe('idempotency', () => {
  it('returns the same answer for the same id, without a second model call, feeling or record', async () => {
    const { send, speaker, state, activity } = await reactionHarness();
    const first = await send('POST', '/v1/body/reactions', valid);
    const version = state().version;
    speaker.decision = { say: true, text: '別の言葉です。', feeling: 'happy' };
    const again = await send('POST', '/v1/body/reactions', valid);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(speaker.calls).toHaveLength(1);
    expect(state().version).toBe(version);
    expect(activity()).toHaveLength(1);
  });

  it('answers a reused id with different content as a conflict and changes nothing', async () => {
    const { send, speaker, state } = await reactionHarness();
    const first = await send('POST', '/v1/body/reactions', valid);
    const version = state().version;
    for (const changed of [{ ...valid, touch: { ...valid.touch, durationMs: 9_000 } }, { ...valid, audience: 'others' }, { ...valid, touch: { ...valid.touch, type: 'poke' } }]) {
      expect(await send('POST', '/v1/body/reactions', changed)).toMatchObject({ status: 409, body: { error: 'BODY_REACTION_CONFLICT' } });
    }
    expect(state().version).toBe(version);
    expect(speaker.calls).toHaveLength(1);
    expect((await send('POST', '/v1/body/reactions', valid)).body).toEqual(first.body);
    expect(bodyReactionContentHash(validatedBodyReactionRequest(valid) as never)).toHaveLength(32);
  });

  it('gives two requests with the same id that overlap one answer and one model call', async () => {
    const { send, speaker, state, activity } = await reactionHarness();
    speaker.delayMilliseconds = 30;
    const [left, right] = await Promise.all([send('POST', '/v1/body/reactions', valid), send('POST', '/v1/body/reactions', valid)]);
    expect(left.body).toEqual(right.body);
    expect((left.body as BodyReactionAnswer).status).toBe('said');
    expect(speaker.calls).toHaveLength(1);
    expect(activity()).toHaveLength(1);
    // One touch: one step of feeling for the touch, one for her line.
    expect(state().version).toBe(2);
    // Overlapping with other content is still a conflict.
    speaker.delayMilliseconds = 30;
    const other = { ...valid, id: 'r-2' };
    const [ok, conflict] = await Promise.all([send('POST', '/v1/body/reactions', other), send('POST', '/v1/body/reactions', { ...other, audience: 'others' })]);
    expect(ok.status).toBe(200);
    expect(conflict.status).toBe(409);
  });

  it('keeps the stored answer when something fails after it was stored', async () => {
    const { send, reactionStore, activity } = await reactionHarness();
    reactionStore.addSaid = () => { throw new Error('SQLITE_BUSY'); };
    const first = await send('POST', '/v1/body/reactions', valid);
    expect(first.body).toMatchObject({ status: 'said', message: { text: HEHE } });
    expect((await send('POST', '/v1/body/reactions', valid)).body).toEqual(first.body);
    expect(activity()).toHaveLength(1);
  });

  it('answers quietly for an id a stopped process left unanswered, without feeling the touch twice', async () => {
    const { send, speaker, state, reactionStore } = await reactionHarness();
    const request = validatedBodyReactionRequest(valid);
    if (typeof request === 'string') throw new Error(request);
    reactionStore.begin(scope, 'r-1', 'body-pc', bodyReactionContentHash(request), 'owner', START);
    const response = await send('POST', '/v1/body/reactions', valid);
    expect(response.body).toMatchObject({ status: 'quiet', message: null });
    expect(speaker.calls).toHaveLength(0);
    expect(state().version).toBe(0);
    expect((await send('POST', '/v1/body/reactions', valid)).body).toEqual(response.body);
  });
});

describe('the deadline', () => {
  it('gives up with quiet when the model is late, and a line that arrives afterwards is neither said nor kept', async () => {
    const { said, speaker, state, activity, reactionStore, delegate, persist, messages, chatModel, now } = await reactionHarness({ config: { deadlineMilliseconds: 25 } });
    speaker.delayMilliseconds = 90;
    const startedAt = Date.now();
    const answer = await said();
    expect(Date.now() - startedAt).toBeLessThan(85);
    expect(answer).toMatchObject({ status: 'quiet', message: null, mood: { expression: 'joyful' } });
    // The touch itself was felt and is remembered.
    expect(state().expressiveEmotion?.primary).toBe('happy');
    expect(reactionStore.burstOfTouch(scope, 'touch-1')).toMatchObject({ count: 1, said: [] });
    // Let the late answer arrive.
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(speaker.aborted).toBe(1);
    expect(speaker.completedLate).toBe(1);
    expect(state().expressiveEmotion?.primary).toBe('happy');
    expect(activity()).toEqual([]);
    expect(reactionStore.reaction(scope, 'touch-1')).toMatchObject({ status: 'quiet', line: null, linkState: 'none' });
    expect(reactionStore.burstOfTouch(scope, 'touch-1')?.said).toEqual([]);
    // A voice turn that happens to follow and names the id gets no line: it is an ordinary turn.
    expect((await delegate('なんでもないよ', { reactionId: 'touch-1' })).status).toBe(200);
    expect(chatModel.voiceRequests[0]!.history).toEqual([]);
    await persist('なんでもないよ', 'そうですか。', { reactionId: 'touch-1' });
    expect(messages()).toEqual([{ role: 'user', content: 'なんでもないよ' }, { role: 'assistant', content: 'そうですか。' }]);
    // The same id again: still the quiet answer.
    expect(await said({}, { id: 'touch-1', occurredAt: START })).toEqual(answer);
    expect(now()).toBe(START);
  });

  it('answers in time when the model is fast', async () => {
    const { said, speaker } = await reactionHarness({ config: { deadlineMilliseconds: 200 } });
    speaker.delayMilliseconds = 5;
    expect(await said()).toMatchObject({ status: 'said' });
    expect(speaker.aborted).toBe(0);
  });

  it('does not answer in words about a touch that is no longer now, and still remembers it', async () => {
    const { said, speaker, clock, reactionStore, state } = await reactionHarness();
    const old = new Date(Date.parse(clock.at) - BODY_REACTION_LIMITS.requestMaximumAgeMilliseconds - SECOND).toISOString();
    expect(await said({}, { occurredAt: old })).toMatchObject({ status: 'quiet', message: null });
    expect(speaker.calls).toHaveLength(0);
    expect(reactionStore.burstOfTouch(scope, 'touch-1')).toMatchObject({ count: 1 });
    expect(state().expressiveEmotion?.primary).toBe('happy');
    // Hours ago: remembered, and no feeling now.
    const longAgo = new Date(Date.parse(clock.at) - 3 * 60 * MINUTE).toISOString();
    const before = state().version;
    expect(await said({ type: 'poke' }, { occurredAt: longAgo })).toMatchObject({ status: 'quiet' });
    expect(state().version).toBe(before);
    expect(reactionStore.burstOfTouch(scope, 'touch-2')).toMatchObject({ type: 'poke', count: 1 });
    // Outside the bounds of a body event (more than a day old, or more than five minutes ahead): not taken in at all.
    const dayOld = new Date(Date.parse(clock.at) - 25 * 60 * MINUTE).toISOString();
    const ahead = new Date(Date.parse(clock.at) + 6 * MINUTE).toISOString();
    for (const occurredAt of [dayOld, ahead]) expect(await said({ type: 'carry' }, { occurredAt })).toMatchObject({ status: 'quiet', message: null });
    expect(state().version).toBe(before);
    expect(reactionStore.burstOfTouch(scope, 'touch-3')).toBeNull();
    expect(reactionStore.burstOfTouch(scope, 'touch-4')).toBeNull();
    expect(speaker.calls).toHaveLength(0);
  });
});

describe('the activity record and the cost', () => {
  it('records one entry per spoken reaction, as a step inside a conversation, and none for a silent one', async () => {
    const { said, speaker, activity, autonomy } = await reactionHarness();
    await said();
    speaker.decision = { say: false, text: '', feeling: 'content' };
    await said();
    const entries = activity();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'action', actor: 'shannon', tool: 'body.reaction', domain: 'conversation', outcome: 'done', approval: 'not_needed',
      summary: '体に触れられて（頭をなでられた）、ひとこと返しました。',
    });
    // What she said is not in the record, and nothing was spent from her own day.
    expect(JSON.stringify(entries)).not.toContain(HEHE);
    expect(autonomy.overview(scope).budget.spentYen).toBe(0);
  });

  it('calls the conversation model once, small and unstored, and records its tokens in the chat lane', async () => {
    const usage: LlmUsageEvent[] = [];
    const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ say: true, text: HEHE, feeling: 'bashful' }), usage: { input_tokens: 420, output_tokens: 30, total_tokens: 450 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'test-key', fetcher, usageStore: { recordLlmUsage: event => usage.push(event) }, now: () => START });
    const decision = await speaker.decide({ scopeKey: scope, prompt: 'PROMPT', signal: new AbortController().signal });
    expect(decision).toEqual({ say: true, text: HEHE, feeling: 'bashful' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0]!.body).toMatchObject({
      model: 'gpt-5.6-luna', instructions: 'PROMPT', reasoning: { effort: 'none' }, store: false, max_output_tokens: 160,
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'shannon_body_reaction', strict: true, schema: BODY_REACTION_SCHEMA } },
    });
    expect(requests[0]!.body.tools).toBeUndefined();
    expect(usage).toEqual([expect.objectContaining({ scopeKey: scope, lane: 'chat', model: 'gpt-5.6-luna', inputTokens: 420, outputTokens: 30, occurredAt: START })]);
    expect(usage[0]!.estimatedCostUsd).toBeGreaterThan(0);

    // A provider failure names no content and records nothing.
    const failing = new OpenAIBodyReactionSpeaker({ apiKey: 'k', fetcher: (async () => new Response('{"error":{"message":"secret detail"}}', { status: 500 })) as unknown as typeof fetch,
      usageStore: { recordLlmUsage: event => usage.push(event) } });
    await expect(failing.decide({ scopeKey: scope, prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('BODY_REACTION_UPSTREAM_500');
    const broken = new OpenAIBodyReactionSpeaker({ apiKey: 'k', fetcher: (async () => { throw new Error('socket: PROMPT'); }) as unknown as typeof fetch });
    await expect(broken.decide({ scopeKey: scope, prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('BODY_REACTION_UPSTREAM_FAILED');
    expect(usage).toHaveLength(1);
    expect(new FakeSpeaker().calls).toEqual([]);
  });
});
