import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryCompanionStateStore, SHANNON_EMOTION_KINDS, livingLingering, presentShannonFeeling,
} from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { SHANNON_CORE_PATHS } from '../src/autonomyCore.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { OpenAIResponsesChatModel, type ShannonChatModel, type ShannonChatModelRequest, type ShannonChatModelResult } from '../src/chatModel.js';
import { parseStructuredTurn } from '../src/chatModelSupport.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import {
  REPLY_FEELING_INSTRUCTIONS, REPLY_FEELING_SCHEMA, chatFeelingStrengthEnabled, decidedReplyFeeling, parsedReplyFeeling,
  replyFeelingOffer, usesDecidedFeeling, type ChatReplyFeeling,
} from '../src/chatReplyFeeling.js';
import { ChatReplyStreamDecoder } from '../src/chatReplyStreamDecoder.js';
import type { ChatStreamLine } from '../src/contracts.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { emotionTiming } from '../src/emotionTiming.js';
import { AFFECT_INTENSITY_STEPS, affectIntensityOf, affectIntensityValue } from '../src/voiceDecisionValues.js';
import { GOLDEN_BASE } from './chatModelGoldenCases.js';

// Whole conversations through the kernel on a loaded machine: the default five seconds says nothing about the code.
vi.setConfig({ testTimeout: 30_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const scope = 'owner';
/** 23:00 in the owner's zone. */
const NIGHT = '2026-10-02T14:00:00.000Z';
const at = (from: string, milliseconds: number) => new Date(Date.parse(from) + milliseconds).toISOString();
const LINE = 'まだ残っている気持ち';
/** A reply with no cue word in it: at 7e227e6 it carries no feeling at all. */
const QUIET = '……そうですか。';
const PLAIN = 'はい、わかりました。';
const HARSH = 'もういい、君とはもう話したくない';
const strong = (kind: ChatReplyFeeling['kind']): ChatReplyFeeling => ({ kind, intensity: 0.9 });
const moderate = (kind: ChatReplyFeeling['kind']): ChatReplyFeeling => ({ kind, intensity: 0.6 });
const subtle = (kind: ChatReplyFeeling['kind']): ChatReplyFeeling => ({ kind, intensity: 0.25 });

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = PLAIN;
  feeling: ChatReplyFeeling | undefined;
  streamed = 0;
  private result(): ShannonChatModelResult {
    return { mode: this.mode, model: this.model, reply: this.reply, ...(this.feeling ? { replyFeeling: this.feeling } : {}) };
  }
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return this.result();
  }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>) {
    this.requests.push(request);
    this.streamed += 1;
    await onReplyText(this.reply);
    return this.result();
  }
}

function harness(start = NIGHT) {
  const clock = { at: start };
  const now = () => clock.at;
  const model = new ScriptedModel();
  const stateStore = new InMemoryCompanionStateStore(now, emotionTiming());
  const conversationStore = new InMemoryConversationStore();
  const api = createLocalApiKernel(now, {
    chatModel: model, stateStore, conversationStore, body: { store: new SQLiteBodyStore(':memory:'), ingestEnabled: true },
  });
  const settle = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await api.waitForBackground(scope);
  };
  const chat = async (message: string, reply: string, feeling?: ChatReplyFeeling, extra: Record<string, unknown> = {}) => {
    model.reply = reply;
    model.feeling = feeling;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, message, ...extra }, deviceId: 'iphone' });
    await settle();
    return response.body as { reply: string; messageEmotion: { expression: string; feeling?: string }; state: Record<string, any>; systemPrompt: string };
  };
  const advance = (milliseconds: number) => { clock.at = at(clock.at, milliseconds); };
  const state = () => stateStore.snapshot(scope);
  const prompt = () => model.requests.at(-1)!.systemPrompt;
  const underneath = (kind: string) => livingLingering(state(), now(), emotionTiming()).find(item => item.feeling.kind === kind);
  const present = () => presentShannonFeeling(state(), now(), emotionTiming());
  return { clock, now, api, model, stateStore, chat, advance, state, prompt, underneath, present, settle };
}

/** Everything a client and the store can see of a run, for comparing two runs. */
function trace(run: ReturnType<typeof harness>, responses: readonly unknown[]) {
  // Ids are random per run: each is replaced by the order in which it first appears.
  const seen = new Map<string, string>();
  const text = JSON.stringify({ responses, state: run.state(), requests: run.model.requests })
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|prospective-[0-9a-f]{8}/gu, id => {
      if (!seen.has(id)) seen.set(id, `id-${seen.size}`);
      return seen.get(id)!;
    });
  return JSON.parse(text) as unknown;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('the field of the structured reply', () => {
  const offered = (request: Partial<ShannonChatModelRequest> = {}) =>
    chatTurnRequestBody('gpt-test', { ...GOLDEN_BASE, offerReplyFeeling: true, ...request }, undefined) as {
      instructions: string; max_output_tokens: number;
      text: { format: { strict: boolean; schema: { properties: Record<string, any>; required: string[] } } };
    };

  it('comes right after reply, so the first sentence of a streamed reply does not wait for it', () => {
    const { schema, strict } = offered().text.format;
    expect(strict).toBe(true);
    expect(Object.keys(schema.properties).slice(0, 3)).toEqual(['reply', 'feeling', 'threadSummary']);
    // Strict mode has no optional keys: where it is offered it is required, and "no feeling" is null.
    expect(schema.required).toContain('feeling');
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.feeling).toEqual(REPLY_FEELING_SCHEMA);
    // With every other optional field as well, reply is still first and every key is required.
    const all = offered({ generateThreadTitle: true, offerRoomLook: true, placeSearch: {} }).text.format.schema;
    expect(Object.keys(all.properties)[0]).toBe('reply');
    expect([...all.required].sort()).toEqual(Object.keys(all.properties).sort());
  });

  it('offers the existing vocabulary and the three steps voice uses, and nothing of its own', () => {
    const [none, chosen] = REPLY_FEELING_SCHEMA.anyOf as unknown as readonly [{ type: string }, { properties: { kind: { enum: string[] }; strength: { enum: string[] } }; required: string[]; additionalProperties: boolean }];
    expect(none).toEqual({ type: 'null' });
    expect(chosen.properties.kind.enum).toEqual(SHANNON_EMOTION_KINDS.filter(kind => kind !== 'neutral'));
    expect(chosen.properties.strength.enum).toEqual(['subtle', 'moderate', 'strong']);
    expect(chosen.required).toEqual(['kind', 'strength']);
    expect(chosen.additionalProperties).toBe(false);
    // One scale: the mapping the voice router's answers go through.
    expect(AFFECT_INTENSITY_STEPS.map(affectIntensityOf)).toEqual([0.25, 0.6, 0.9]);
    for (const step of AFFECT_INTENSITY_STEPS) expect(affectIntensityValue({ choice: step })).toBe(affectIntensityOf(step));
    expect(() => affectIntensityValue({ choice: 'huge' })).toThrow('JEV_RESPONSE_INVALID');
  });

  it('adds one short block of guidance, last, and changes nothing else of the request', () => {
    const plain = chatTurnRequestBody('gpt-test', GOLDEN_BASE, undefined) as ReturnType<typeof offered>;
    const body = offered();
    expect(body.instructions).toBe(`${plain.instructions}\n\n${REPLY_FEELING_INSTRUCTIONS}`);
    expect(Array.from(REPLY_FEELING_INSTRUCTIONS).length).toBeLessThanOrEqual(480);
    expect(body.max_output_tokens).toBe(plain.max_output_tokens);
    for (const phrase of ['strongはまれ', '人なら後まで残る出来事のときだけ使い、一つの会話で何度も使わない', 'moderate=数時間は気分として残る',
      '新しい出来事がなければ、前より弱くするかnullにする', '別の気持ちに替えて強く出し続けたりしない', 'すでに謝ってもらったことを理由にしない',
      'moderate以上にしてよいのは、今回のライ氏の発言そのものに実際の原因があるときだけ', '特に動いていなければnull', 'replyの文面と食い違う気持ちは選ばない']) {
      expect(REPLY_FEELING_INSTRUCTIONS).toContain(phrase);
    }
    const { feeling: _feeling, ...rest } = body.text.format.schema.properties;
    expect(rest).toEqual(plain.text.format.schema.properties);
    expect(body.text.format.schema.required.filter(key => key !== 'feeling')).toEqual(plain.text.format.schema.required);
  });

  it('is not in a request that does not offer it: those bytes are the ones recorded before the field existed', () => {
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/chat-model-turn-v1.json', import.meta.url), 'utf8')) as { requests: { plain: { body: string } } };
    const body = JSON.stringify(chatTurnRequestBody('gpt-5.6-luna', GOLDEN_BASE, undefined));
    expect(body).toBe(recorded.requests.plain.body);
    expect(body).not.toContain('feeling');
    expect(JSON.stringify(chatTurnRequestBody('gpt-5.6-luna', { ...GOLDEN_BASE, offerReplyFeeling: false }, undefined))).toBe(body);
  });
});

describe('reading the field', () => {
  const turn = (extra: Record<string, unknown> = {}) => JSON.stringify({
    reply: 'はい。', ...extra, threadSummary: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
  });

  it('maps the three steps to 0.25 / 0.60 / 0.90', () => {
    expect(parsedReplyFeeling({ kind: 'hurt', strength: 'subtle' })).toEqual({ kind: 'hurt', intensity: 0.25 });
    expect(parsedReplyFeeling({ kind: 'hurt', strength: 'moderate' })).toEqual({ kind: 'hurt', intensity: 0.6 });
    expect(parsedReplyFeeling({ kind: 'hurt', strength: 'strong' })).toEqual({ kind: 'hurt', intensity: 0.9 });
  });

  it('reads absent, null, neutral and anything unreadable as no decided feeling, and never fails the turn', () => {
    for (const value of [undefined, null, 'hurt', 7, [], {}, { kind: 'hurt' }, { strength: 'strong' }, { kind: 'neutral', strength: 'strong' },
      { kind: 'furious', strength: 'strong' }, { kind: 'hurt', strength: 'huge' }, { kind: 'hurt', strength: 0.9 }, { kind: 7, strength: 'strong' }]) {
      expect(parsedReplyFeeling(value)).toBeUndefined();
      const parsed = parseStructuredTurn(turn(value === undefined ? {} : { feeling: value }));
      expect(parsed.reply).toBe('はい。');
      expect(parsed).not.toHaveProperty('replyFeeling');
    }
    expect(parseStructuredTurn(turn({ feeling: { kind: 'happy', strength: 'strong' } })).replyFeeling).toEqual({ kind: 'happy', intensity: 0.9 });
  });

  it('reaches the result only in a turn that offered the field, on both ways of calling the provider', async () => {
    const text = turn({ feeling: { kind: 'hurt', strength: 'strong' } });
    const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
    const stream = () => new Response(new TextEncoder().encode([
      ...text.match(/.{1,5}/gsu)!.map(delta => sse({ type: 'response.output_text.delta', delta })),
      sse({ type: 'response.completed', response: { output_text: text } }),
    ].join('')));
    const bodies: string[] = [];
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return JSON.parse(String(init?.body)).stream ? stream() : new Response(JSON.stringify({ output_text: text }));
    }) as typeof fetch });
    const asked = { ...GOLDEN_BASE, offerReplyFeeling: true };
    expect((await model.generate(asked)).replyFeeling).toEqual({ kind: 'hurt', intensity: 0.9 });
    expect(await model.generate(GOLDEN_BASE)).not.toHaveProperty('replyFeeling');
    const pieces: string[] = [];
    const streamed = await model.generateStreaming(asked, piece => { pieces.push(piece); });
    expect(streamed.replyFeeling).toEqual({ kind: 'hurt', intensity: 0.9 });
    expect(pieces.join('')).toBe('はい。');
    expect(await model.generateStreaming(GOLDEN_BASE, () => {})).not.toHaveProperty('replyFeeling');
    // The streaming call sends the same body with `stream: true` and nothing else.
    expect(JSON.parse(bodies[2]!)).toEqual({ ...JSON.parse(bodies[0]!), stream: true });
  });

  it('lets the stream decoder give the whole reply before one byte of the field has arrived, and without the field', () => {
    for (const json of [turn({ feeling: { kind: 'hurt', strength: 'strong' } }), turn({ feeling: null }), turn()]) {
      const cut = json.indexOf('"', json.indexOf('はい。')) + 1;
      const early = new ChatReplyStreamDecoder();
      expect(early.push(json.slice(0, cut))).toBe('はい。');
      expect(early.push(json.slice(cut))).toBe('');
      expect(early.abandoned).toBe(false);
      let text = '';
      const perUnit = new ChatReplyStreamDecoder();
      for (const unit of json.split('')) text += perUnit.push(unit);
      expect(text).toBe('はい。');
    }
  });
});

describe('a text conversation may leave a feeling that lingers', () => {
  it('keeps a strong feeling for days of awake time: the next morning it is in the prompt, with its cause and for whom', async () => {
    const { chat, advance, state, prompt, underneath, model } = harness();
    const night = await chat(HARSH, QUIET, strong('hurt'));
    expect(model.requests.at(-1)!.offerReplyFeeling).toBe(true);
    expect(night.messageEmotion.expression).toBe(night.state.presence.mood.expression);
    expect(state().expressiveEmotion).toMatchObject({ primary: 'hurt', intensity: 0.9, target: 'ライ氏', cause: '生成した応答の内容と会話文脈' });
    expect(state().lingering).toMatchObject([{ kind: 'hurt', target: 'ライ氏', span: 'lingering', strength: 0.9, startedAt: NIGHT }]);
    // The resolver's notes to the reducer are not stored, and the response carries no new key.
    expect(JSON.stringify(state())).not.toMatch(/"decided"|"continued"|"presentAt"/u);
    expect(JSON.stringify(night)).not.toMatch(/"replyFeeling"|"decided"|"continued"/u);

    advance(9 * HOUR);
    await chat('おはよう', 'おはようございます。');
    expect(prompt()).toMatch(/まだ残っている気持ち: 9時間前にライ氏との会話で傷ついたことを、まだ引きずっている（hurt \/ 強さ 0\.88）。/u);
    // A day and a half of the wall clock later, with two awake hours in between, it is still there.
    for (let index = 0; index < 12; index += 1) { advance(10 * MINUTE); await chat('次の手順を教えて', PLAIN); }
    advance(24 * HOUR);
    await chat('ただいま', PLAIN);
    expect(underneath('hurt')!.strength).toBeGreaterThan(0.7);
    expect(prompt()).toContain(LINE);
  });

  it('keeps a moderate one as a mood for hours, and a subtle one or none not at all', async () => {
    const mood = harness();
    await mood.chat(HARSH, QUIET, moderate('sulky'));
    expect(mood.state().lingering).toMatchObject([{ kind: 'sulky', span: 'mood', strength: 0.6 }]);
    for (let index = 0; index < 36; index += 1) { mood.advance(10 * MINUTE); await mood.chat('次の手順を教えて', PLAIN); }
    expect(mood.state().lingering).toEqual([]);

    for (const feeling of [subtle('hurt'), undefined]) {
      const run = harness();
      await run.chat(HARSH, QUIET, feeling);
      expect(run.state().lingering ?? []).toEqual([]);
      run.advance(9 * HOUR);
      await run.chat('おはよう', 'おはようございます。');
      expect(run.prompt()).not.toContain(LINE);
    }
  });

  it('leaves a turn in which the model chose no feeling exactly as it is without the field', async () => {
    const script: Array<[string, string]> = [['今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。'], [HARSH, QUIET], ['すごいね', 'えへへ、照れます。']];
    const run = async (switchValue?: string) => {
      if (switchValue) vi.stubEnv('SHANNON_CHAT_FEELING_STRENGTH', switchValue);
      const h = harness();
      const responses = [];
      for (const [message, reply] of script) { responses.push(await h.chat(message, reply)); h.advance(3 * MINUTE); }
      vi.unstubAllEnvs();
      return { h, seen: trace(h, responses) as { requests: Array<Record<string, unknown>>; responses: unknown; state: unknown } };
    };
    const on = await run();
    const off = await run('off');
    expect(on.seen.responses).toEqual(off.seen.responses);
    expect(on.seen.state).toEqual(off.seen.state);
    // The only difference is that the field was offered.
    expect(on.seen.requests.map(({ offerReplyFeeling: _offer, ...rest }) => rest)).toEqual(off.seen.requests);
    expect(on.seen.requests.every(request => request.offerReplyFeeling === true)).toBe(true);
  });

  it('takes a strong great joy as a feeling that lingers too', async () => {
    const { chat, state } = harness();
    await chat('君の物語、読んで泣いたよ。本当にすごかった', 'ボク、いま胸がいっぱいです。', strong('happy'));
    expect(state().lingering).toMatchObject([{ kind: 'happy', span: 'lingering', strength: 0.9 }]);
  });
});

describe('every existing rule applies to it unchanged', () => {
  it('cannot raise what lingers, or keep it from fading, by choosing strong turn after turn; only the reaction of the moment is felt again', async () => {
    const repeated = harness();
    const once = harness();
    await repeated.chat(HARSH, QUIET, strong('hurt'));
    await once.chat(HARSH, QUIET, strong('hurt'));
    const first = repeated.state().lingering![0]!;
    for (let index = 0; index < 30; index += 1) {
      repeated.advance(10 * MINUTE);
      once.advance(10 * MINUTE);
      await repeated.chat('ふーん', QUIET, strong('hurt'));
      await once.chat('ふーん', QUIET);
      // The reaction of the moment is felt again at the one step for as long as she keeps choosing it, never above it;
      // what is underneath is never renewed: it is the entry of the first turn.
      expect(repeated.state().expressiveEmotion).toMatchObject({ primary: 'hurt', intensity: 0.9 });
      expect(repeated.state().lingering).toEqual([first]);
    }
    // Five awake hours later it has faded exactly as far as when she said it once and nothing after.
    expect(repeated.underneath('hurt')!.strength).toBe(once.underneath('hurt')!.strength);
    expect(repeated.underneath('hurt')!.strength).toBeCloseTo(0.9 * 0.5 ** (5 / 8), 5);
    expect(repeated.state().lingering).toEqual(once.state().lingering);
    // When she stops choosing it, the moment's reaction passes in minutes and what is left is that same fading entry.
    repeated.advance(10 * MINUTE);
    await repeated.chat('次の手順を教えて', PLAIN);
    repeated.advance(10 * MINUTE);
    await repeated.chat('次の手順を教えて', PLAIN);
    expect(repeated.present().intensity).toBeLessThan(0.9 * 0.5 ** (5 / 8));
    expect(repeated.state().lingering).toEqual([first]);
  });

  it('does not outlive the four wall-clock days, however often she chooses it again', async () => {
    const { chat, advance, state, prompt } = harness();
    await chat(HARSH, QUIET, strong('hurt'));
    for (let day = 1; day <= 3; day += 1) {
      advance(24 * HOUR);
      await chat('おはよう', QUIET, strong('hurt'));
      expect(state().lingering).toMatchObject([{ kind: 'hurt', startedAt: NIGHT, awakeAt: 0, strength: 0.9 }]);
    }
    advance(25 * HOUR);
    await chat('おはよう', PLAIN);
    expect(prompt()).not.toContain(LINE);
    expect(state().lingering).toEqual([]);
  });

  it('escalating from subtle to strong ends at the one strong step, once', async () => {
    const { chat, advance, state } = harness();
    await chat(HARSH, QUIET, subtle('sulky'));
    expect(state().lingering ?? []).toEqual([]);
    advance(MINUTE);
    await chat('ふーん', QUIET, moderate('sulky'));
    expect(state().lingering).toMatchObject([{ kind: 'sulky', span: 'mood', strength: 0.6 }]);
    advance(MINUTE);
    await chat('ふーん', QUIET, strong('sulky'));
    expect(state().lingering).toMatchObject([{ kind: 'sulky', span: 'lingering', strength: 0.9, startedAt: at(NIGHT, MINUTE) }]);
    const top = state().lingering;
    for (let index = 0; index < 6; index += 1) { advance(MINUTE); await chat('ふーん', QUIET, strong('sulky')); }
    expect(state().lingering).toEqual(top);
  });

  it('keeps an apology: for the hold after it, choosing strong again brings nothing back up', async () => {
    const { chat, advance, state, underneath, present } = harness();
    await chat(HARSH, QUIET, strong('hurt'));
    advance(9 * HOUR);
    await chat('昨日はごめん、言いすぎた', PLAIN);
    const eased = underneath('hurt')!.strength;
    expect(eased).toBeCloseTo(0.9 * 0.5 ** (12 / 480) * 0.4, 2);
    expect(state().lingering![0]).toMatchObject({ peak: 0.9 });
    for (let index = 0; index < 2; index += 1) {
      advance(5 * MINUTE);
      await chat('まだ怒ってる？', QUIET, strong('hurt'));
      expect(underneath('hurt')!.strength).toBeLessThan(eased);
      expect(present().intensity).toBeLessThan(0.45);
    }
  });

  it('puts grief and an emergency first, whatever she chose', async () => {
    const grief = harness();
    const mourning = await grief.chat('祖母が亡くなった', QUIET, strong('happy'));
    // At the strength the override has without the field, not at hers.
    expect(grief.state().expressiveEmotion).toMatchObject({ primary: 'caring', overrideReason: 'grief', intensity: 0.68 });
    expect(mourning.messageEmotion.expression).not.toBe('happy');
    expect(grief.state().lingering ?? []).toEqual([]);
    const danger = harness();
    await danger.chat('火事だ、助けて', QUIET, strong('sulky'));
    expect(danger.state().expressiveEmotion).toMatchObject({ primary: 'protective', overrideReason: 'emergency', intensity: 0.78 });
    // Accuracy before play, as without the field: a chosen sulk beside his health is not stored as a strong one.
    const health = harness();
    await health.chat('薬を飲み忘れたかも', QUIET, strong('sulky'));
    expect(health.state().lingering ?? []).toEqual([]);
    expect(health.state().expressiveEmotion?.primary).not.toBe('sulky');
    expect(danger.state().lingering ?? []).toEqual([]);
  });

  it('does not keep sadness, worry or regret as a mood, however strongly chosen, and lets them show over a mood', async () => {
    for (const kind of ['sad', 'anxious', 'regret'] as const) {
      const { chat, advance, state } = harness();
      await chat(HARSH, QUIET, strong('hurt'));
      advance(MINUTE);
      const response = await chat('今日は仕事でひどい失敗をした', 'それは、こたえますね。', strong(kind));
      // Strong is for what can linger: her sympathy is felt at moderate at most.
      expect(state().expressiveEmotion).toMatchObject({ primary: kind, intensity: 0.6 });
      expect(response.state.presence.mood.fromConversation).toBe(true);
      // Only the hurt is underneath.
      expect(state().lingering!.map(item => item.kind)).toEqual(['hurt']);
    }
  });

  it('does not let a strong tone, startle or sympathy ease what lies underneath', async () => {
    for (const kind of ['bright', 'gentle', 'relaxed', 'giggle', 'surprised', 'relief', 'caring'] as const) {
      const { chat, advance, state } = harness();
      await chat(HARSH, QUIET, strong('hurt'));
      const hurt = state().lingering;
      for (let index = 0; index < 3; index += 1) { advance(2 * MINUTE); await chat('それはそうと', QUIET, strong(kind)); }
      expect(state().lingering, kind).toEqual(hurt);
    }
    // Her sympathy for his bad news does not halve a joy she carries.
    const { chat, advance, state } = harness();
    await chat('君の物語、読んで泣いたよ', QUIET, strong('happy'));
    const joy = state().lingering;
    advance(2 * MINUTE);
    await chat('今日は仕事でひどい失敗をした', 'それは、こたえますね。', strong('sad'));
    expect(state().lingering).toEqual(joy);
    expect(decidedReplyFeeling({ replyFeeling: strong('sad') }, true, {})).toEqual({ decided: { primary: 'sad', intensity: 0.6 } });
    expect(decidedReplyFeeling({ replyFeeling: strong('bright') }, true, {})).toEqual({ decided: { primary: 'bright', intensity: 0.6 } });
    expect(decidedReplyFeeling({ replyFeeling: moderate('sad') }, true, {})).toEqual({ decided: { primary: 'sad', intensity: 0.6 } });
    expect(decidedReplyFeeling({ replyFeeling: subtle('sad') }, true, {})).toEqual({ decided: { primary: 'sad', intensity: 0.25 } });
  });

  it('holds a strong feeling against a weaker one she chooses next, which stays beside it', async () => {
    const { chat, advance, state } = harness();
    await chat(HARSH, QUIET, strong('hurt'));
    advance(MINUTE);
    const before = state().expressiveEmotion;
    await chat('それはそうと、今日の予定は？', PLAIN, subtle('curiosity'));
    expect(state().expressiveEmotion).toEqual(before);
    expect(state().lingering).toMatchObject([{ kind: 'hurt', strength: 0.9 }]);
  });

  it('never lends the chosen strength to a kind she did not choose: when her words name another, the turn is as without the field', async () => {
    /** The same turn with and without the chosen feeling, from the same start. */
    const both = async (message: string, reply: string, feeling: ChatReplyFeeling, before?: [string, string, ChatReplyFeeling]) => {
      const run = async (chosen: ChatReplyFeeling | undefined) => {
        const h = harness();
        if (before) { await h.chat(before[0], before[1], before[2]); h.advance(2 * MINUTE); }
        const response = await h.chat(message, reply, chosen);
        return { state: h.state(), messageEmotion: response.messageEmotion };
      };
      return { chosen: await run(feeling), plain: await run(undefined) };
    };
    // A strong curiosity beside 「ほかの子」 is the jealousy her words name, at the cue's 0.52: a mood, not days.
    const curious = await both('昨日は別の子と話してた', 'ほかの子の話も聞かせてください。', strong('curiosity'));
    expect(curious.chosen).toEqual(curious.plain);
    expect(curious.chosen.state.lingering).toMatchObject([{ kind: 'jealous', span: 'mood', strength: 0.52 }]);
    // A strong hurt beside a pleasant word does not become a joy that lingers.
    const mixed = await both(HARSH, '嬉しいです、でも……傷つきました。', strong('hurt'));
    expect(mixed.chosen).toEqual(mixed.plain);
    expect(mixed.chosen.state.lingering).toMatchObject([{ kind: 'excited', span: 'mood', strength: 0.52 }]);
    // Beside an apology it is her apology, at the cue's strength.
    const sorry = await both(HARSH, 'ご、ごめんなさい……。', strong('hurt'));
    expect(sorry.chosen).toEqual(sorry.plain);
    expect(sorry.chosen.state.expressiveEmotion).toMatchObject({ primary: 'apologetic', intensity: 0.52 });
    expect(sorry.chosen.state.lingering ?? []).toEqual([]);
    // A hurt she carries is not halved by a strong hurt whose reply happens to hold 「ふふ」.
    const laugh = await both('まだ怒ってる？', 'ふふ、そうですか。', strong('hurt'), [HARSH, QUIET, strong('hurt')]);
    expect(laugh.chosen).toEqual(laugh.plain);
    expect(laugh.chosen.state.lingering).toMatchObject([{ kind: 'hurt', strength: 0.9 }]);
    expect(laugh.chosen.state.lingering![0]).not.toHaveProperty('peak');
    // Nor a joy by a strong affection whose reply holds 「ごめん」.
    const fond = await both('また読ませて', 'ごめんなさい、うれし泣きです。', strong('affectionate'), ['君の物語、読んで泣いたよ', QUIET, strong('happy')]);
    expect(fond.chosen).toEqual(fond.plain);
    expect(fond.chosen.state.lingering).toMatchObject([{ kind: 'happy', strength: 0.9 }]);
    // The cue of the chosen kind is the chosen feeling: its strength stands.
    const sulk = await both(HARSH, 'ボク、ちょっとすねちゃいます。', strong('sulky'));
    expect(sulk.chosen.state.lingering).toMatchObject([{ kind: 'sulky', span: 'lingering', strength: 0.9 }]);
    expect(sulk.plain.state.lingering).toMatchObject([{ kind: 'sulky', span: 'mood', strength: 0.52 }]);

    expect(usesDecidedFeeling({ primary: 'hurt' }, { primary: 'hurt' })).toBe(true);
    expect(usesDecidedFeeling({ primary: 'hurt' }, { primary: 'sulky', continued: true })).toBe(true);
    expect(usesDecidedFeeling({ primary: 'hurt' }, { primary: 'giggle' })).toBe(false);
    expect(usesDecidedFeeling({ primary: 'hurt' }, { primary: 'giggle', continued: false })).toBe(false);
    expect(usesDecidedFeeling({ primary: 'caring' }, { primary: 'caring', overrideReason: 'grief' })).toBe(false);
  });
});

describe('guests and other people present never move her feeling toward the owner', () => {
  it('offers nothing and uses nothing in a turn other people can see', async () => {
    const { chat, state, model, advance } = harness();
    await chat('今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。');
    advance(MINUTE);
    const before = state();
    const shared = await chat('友達と一緒にいるよ', QUIET, strong('hurt'), { audience: 'others' });
    expect(model.requests.at(-1)).not.toHaveProperty('offerReplyFeeling');
    expect(state()).toBe(before);
    // The face is the one the turn has without the field.
    const control = harness();
    await control.chat('今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。');
    control.advance(MINUTE);
    expect(shared.messageEmotion).toEqual((await control.chat('友達と一緒にいるよ', QUIET, undefined, { audience: 'others' })).messageEmotion);
    expect(shared.state.lingering).toBeUndefined();
    expect(shared.systemPrompt).toBe('');
  });

  it('gives a decided feeling to no caller but the text turn of the owner alone', () => {
    expect(replyFeelingOffer(true, {})).toEqual({ offerReplyFeeling: true });
    expect(replyFeelingOffer(false, {})).toEqual({});
    expect(decidedReplyFeeling({ replyFeeling: strong('hurt') }, true, {})).toEqual({ decided: { primary: 'hurt', intensity: 0.9 } });
    expect(decidedReplyFeeling({ replyFeeling: strong('hurt') }, false, {})).toEqual({});
    expect(decidedReplyFeeling({}, true, {})).toEqual({});
    // A result built elsewhere cannot hand in a kind outside the vocabulary or a strength off the scale.
    expect(decidedReplyFeeling({ replyFeeling: { kind: 'hurt', intensity: 1 } }, true, {})).toEqual({});
    expect(decidedReplyFeeling({ replyFeeling: { kind: 'neutral', intensity: 0.9 } }, true, {})).toEqual({});
    expect(decidedReplyFeeling({ replyFeeling: { kind: 'furious' as never, intensity: 0.9 } }, true, {})).toEqual({});
    // Every production source is read: the field is named only by the adapter, this module, the presence entry and the kernel's chat turn.
    const directory = new URL('../src/', import.meta.url);
    const naming = readdirSync(directory).filter(file => file.endsWith('.ts'))
      .filter(file => /ReplyFeeling|resolveTextReplyEmotion|usesDecidedFeeling/u.test(readFileSync(new URL(file, directory), 'utf8'))).sort();
    // (`autonomyCore.ts` names the module's path among the core paths.)
    expect(naming).toEqual(['apiKernel.ts', 'autonomyCore.ts', 'chatModel.ts', 'chatModelSupport.ts', 'chatModelTurn.ts', 'chatReplyFeeling.ts', 'companionPresence.ts']);
    const kernel = readFileSync(new URL('apiKernel.ts', directory), 'utf8');
    expect(kernel.match(/replyFeelingOffer\(audience\.alone\)/gu)).toHaveLength(1);
    expect(kernel.match(/resolveTextReplyEmotion\(\{[^}]*\}, completion, audience\.alone\)/gu)).toHaveLength(1);
    expect(kernel.match(/ReplyFeeling|resolveTextReplyEmotion/gu)).toHaveLength(4);
  });
});

describe('a streamed reply', () => {
  it('sends its sentences while the model writes and commits the decided feeling of the completed turn', async () => {
    const { api, model, state, settle } = harness();
    model.reply = '……そうですか。わかりました。';
    model.feeling = strong('hurt');
    const lines: ChatStreamLine[] = [];
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', deviceId: 'iphone',
      body: { scopeKey: scope, message: HARSH, stream: 'sentences' }, chatSentences: { write: line => { lines.push(line); } } });
    await settle();
    expect(model.streamed).toBe(1);
    expect(model.requests.at(-1)!.offerReplyFeeling).toBe(true);
    expect(lines[0]).toMatchObject({ type: 'start' });
    expect(lines[1]).toMatchObject({ type: 'sentence', index: 0, text: '……そうですか。' });
    expect(response.status).toBe(200);
    expect(state().lingering).toMatchObject([{ kind: 'hurt', span: 'lingering', strength: 0.9 }]);
  });
});

describe('the kill switch SHANNON_CHAT_FEELING_STRENGTH=off', () => {
  it('reads unset as on and the usual words as off', () => {
    expect(chatFeelingStrengthEnabled({})).toBe(true);
    expect(chatFeelingStrengthEnabled({ SHANNON_CHAT_FEELING_STRENGTH: 'on' })).toBe(true);
    for (const value of ['off', 'OFF', ' off ', 'false', '0', 'disabled', 'no', 'none']) {
      expect(chatFeelingStrengthEnabled({ SHANNON_CHAT_FEELING_STRENGTH: value })).toBe(false);
      expect(replyFeelingOffer(true, { SHANNON_CHAT_FEELING_STRENGTH: value })).toEqual({});
      expect(decidedReplyFeeling({ replyFeeling: strong('hurt') }, true, { SHANNON_CHAT_FEELING_STRENGTH: value })).toEqual({});
    }
  });

  it('offers no field and derives the reply\'s feeling exactly as at 7e227e6, also from a model that returns one', async () => {
    const script: Array<[string, string, ChatReplyFeeling | undefined]> = [
      [HARSH, QUIET, strong('hurt')],
      ['今日はもう別のAIと話すね', 'ボク、ちょっとすねちゃいます。', strong('seriousAnger')],
      ['すごいね', 'えへへ、照れます。', moderate('happy')],
      ['次の手順を教えて', PLAIN, strong('jealous')],
    ];
    /** `withField`: the model returns a feeling. Without it the model is the one of 7e227e6, which has no such field. */
    const run = async (withField: boolean) => {
      const h = harness();
      const responses = [];
      for (const [message, reply, feeling] of script) { responses.push(await h.chat(message, reply, withField ? feeling : undefined)); h.advance(3 * MINUTE); }
      return { h, seen: trace(h, responses) as { requests: Array<Record<string, unknown>>; responses: unknown; state: unknown } };
    };
    vi.stubEnv('SHANNON_CHAT_FEELING_STRENGTH', 'off');
    const off = await run(true);
    const before = await run(false);
    expect(off.seen).toEqual(before.seen);
    // Recorded by running these four turns on the sources of 7e227e6 (responses, stored state and model requests, ids by order).
    expect(createHash('sha256').update(JSON.stringify(off.seen)).digest('hex')).toBe('ddddfebb24392e5957bfb741795ae44361c9fce57defdaad21846c966e0b7abd');
    for (const request of off.seen.requests) expect(request).not.toHaveProperty('offerReplyFeeling');
    // What 7e227e6 does with these four turns: a cue is 0.52 and a mood, no cue is nothing, and nothing lingers for days.
    expect(off.h.state().lingering).toMatchObject([{ kind: 'sulky', span: 'mood', strength: 0.52 }]);
    expect(off.h.state().lingering).toHaveLength(1);
    // The provider request of such a turn is the recorded one: no field, no guidance.
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/chat-model-turn-v1.json', import.meta.url), 'utf8')) as { requests: { plain: { body: string } } };
    expect(JSON.stringify(chatTurnRequestBody('gpt-5.6-luna', { ...GOLDEN_BASE, ...replyFeelingOffer(true) }, undefined))).toBe(recorded.requests.plain.body);
    vi.unstubAllEnvs();
    // With the switch on the same script does differ, so the comparison above is not vacuous.
    const on = await run(true);
    expect(on.seen.state).not.toEqual(before.seen.state);
    expect(on.h.state().lingering!.some(item => item.span === 'lingering')).toBe(true);
  });
});

describe('the emotion source stays core', () => {
  it('lists the module among the paths that need the owner\'s approval, and it holds no state', () => {
    expect(SHANNON_CORE_PATHS.emotion).toContain('services/api/src/chatReplyFeeling.ts');
    const source = readFileSync(new URL('../src/chatReplyFeeling.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stateStore|\.apply\(|DatabaseSync|new Map|let /u);
  });
});
