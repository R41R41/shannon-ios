import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { createInMemoryAutonomyService } from '../src/autonomyService.js';
import { ROOM_LOOK_UNAVAILABLE_REASON } from '../src/bodyLook.js';
import { configuredBodyLook, type BodyLookConfig } from '../src/bodyLookContract.js';
import { bodyLookNotSeenLine } from '../src/bodyLookLines.js';
import { SQLiteBodyLookStore } from '../src/bodyLookStore.js';
import type { RoomLookViewRequest, RoomLookViewer } from '../src/bodyLookVision.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import type { BodyPresence } from '../src/shannonBody.js';
import {
  JevVoiceDecisionGateway, LocalVoiceDecisionGateway, OpenAIVoiceDecisionGateway, VOICE_SKILLS,
  type VoiceDecisionGateway, type VoiceDecisionInput,
} from '../src/voiceDecision.js';
import {
  VOICE_ROOM_LOOK_READY_PROMPT, asksForLookAloud, voiceRoomLookPrompt, voiceRoomLookTurn, voiceRoomLookUnavailablePrompt,
} from '../src/voiceRoomLook.js';

const scope = 'owner';
const START = '2026-10-02T09:00:00.000Z';
const SECOND = 1_000;
const SEEN_TEXT = 'ライ氏が机に向かっているのが見えます。';
const delegations = '/v1/voice/live/delegations';

/** What the owner said in the call of 2026-10-02, in order. No look was ever opened then. */
const PRODUCTION_ASKS = ['僕のこと見れる?', 'もちろん、そう、カメラ使っていいよ、自由に。', 'うん、じゃあ部屋を見て。'];
/** What she said then, none of which was true. */
const INVENTED = ['許可', '届いていません', '送り直', '接続'];

afterEach(() => vi.unstubAllEnvs());

function jpeg(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    randomBytes(1_000), Buffer.from([0xff, 0xd9]),
  ]);
}
const seen = { outcome: 'seen', audience: 'owner', image: { mediaType: 'image/jpeg', base64: jpeg(960, 540).toString('base64'), width: 960, height: 540 } };

class VoiceModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  reply = '見てみますね。';
  async generate(request: ShannonChatModelRequest) { return { mode: this.mode, model: this.model, reply: `文字の返事:${request.message}` }; }
  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
}

class FakeViewer implements RoomLookViewer {
  readonly calls: RoomLookViewRequest[] = [];
  async see(request: RoomLookViewRequest): Promise<string> { this.calls.push(request); return SEEN_TEXT; }
}

/** The local rules, with what a model tier would add: how much it wants a look, and how far it trusts the transcript. */
function gateway(extra: { roomLookProbability?: number; transcriptReliabilityProbability?: number } = {}): VoiceDecisionGateway & { inputs: VoiceDecisionInput[] } {
  const local = new LocalVoiceDecisionGateway();
  const inputs: VoiceDecisionInput[] = [];
  return { mode: 'jev', model: 'test', inputs, decide: async input => { inputs.push(input); return { ...await local.decide(input), source: 'jev', ...extra }; } };
}

function harness(options: { config?: Partial<BodyLookConfig>; ingestEnabled?: boolean; viewer?: RoomLookViewer | null; voiceDecision?: VoiceDecisionGateway } = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const model = new VoiceModel();
  const viewer = options.viewer === undefined ? new FakeViewer() : options.viewer;
  const lookStore = new SQLiteBodyLookStore(':memory:');
  const conversationStore = new InMemoryConversationStore();
  const autonomy = createInMemoryAutonomyService(now);
  const api = createLocalApiKernel(now, {
    stateStore: new InMemoryCompanionStateStore(now), conversationStore, chatModel: model, autonomy,
    voiceDecision: options.voiceDecision ?? gateway({ transcriptReliabilityProbability: 0.95 }),
    body: {
      store: new SQLiteBodyStore(':memory:'), ingestEnabled: options.ingestEnabled ?? true,
      look: { store: lookStore, config: { ...configuredBodyLook({}), ...options.config }, viewer, timers: false },
    },
  });
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId = 'body-pc') =>
    api.dispatch({ method, path, body: { scopeKey: scope, ...body }, deviceId });
  const camera = (on = true) => send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { camera: on } });
  const presence = async (deviceId = 'body-pc') => (await api.dispatch({
    method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId,
  })).body as BodyPresence;
  /** One utterance of a voice call, as the body's client sends it. */
  const say = async (transcript: string, extra: Record<string, unknown> = {}, context: Record<string, unknown> = {}) => {
    const before = model.voiceRequests.length;
    const response = await send('POST', delegations, {
      threadId: 'voice-thread', transcript, ...extra,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `u-${before}-${clock.at}`, text: transcript, source: 'speech', rawText: transcript }, ...context },
    });
    expect(response.status).toBe(200);
    const body = response.body as { reply: string; threadId: string; voicePlan: { shouldRespond: boolean } };
    return { body, prompt: model.voiceRequests.length > before ? model.voiceRequests.at(-1)!.systemPrompt : '' };
  };
  const ready = async () => { await camera(); await presence(); };
  const openLook = async () => (await presence()).look ?? null;
  const answer = (id: string, body: Record<string, unknown> = seen) => send('POST', `/v1/body/looks/${id}`, body);
  const messages = () => conversationStore.conversationHistory(scope, 'voice-thread');
  return { clock, api, model, viewer: viewer as FakeViewer, lookStore, conversationStore, advance, send, camera, presence, say, ready, openLook, answer, messages };
}

describe('the owner asks her to look, aloud', () => {
  it('opens a look for each thing the owner said on 2026-10-02 when her body can look, and she only says she will', async () => {
    for (const transcript of PRODUCTION_ASKS) {
      const h = harness();
      await h.ready();
      const turn = await h.say(transcript);
      expect(turn.body.reply, transcript).toBe('見てみますね。');
      expect(turn.prompt, transcript).toContain(voiceRoomLookPrompt(true));
      expect(turn.prompt, transcript).toContain('まだ見ていないものを語らない');
      const look = await h.openLook();
      expect(look, transcript).toBeTruthy();
      expect(h.lookStore.get(scope, look!.id), transcript).toMatchObject({ threadId: 'voice-thread', deviceId: 'body-pc', ownerAsked: true, outcome: 'pending' });
    }
  });

  it('tells her the real reason, and nothing she could mistake for permission or connection trouble, when she cannot look', async () => {
    const cases: [keyof typeof ROOM_LOOK_UNAVAILABLE_REASON, Parameters<typeof harness>[0], (h: ReturnType<typeof harness>) => Promise<void>][] = [
      ['no_body', {}, async () => undefined],
      ['no_camera', {}, async h => { await h.camera(false); await h.presence(); }],
      ['body_away', {}, async h => { await h.camera(); }],
      ['body_away', {}, async h => { await h.ready(); h.advance(76 * SECOND); }],
      ['switched_off', { config: { enabled: false } }, async h => { await h.ready(); }],
      ['switched_off', { ingestEnabled: false }, async h => { await h.ready(); }],
      ['no_viewer', { viewer: null }, async h => { await h.ready(); }],
      ['limit_hour', { config: { perHour: 0 } }, async h => { await h.ready(); }],
      ['limit_day', { config: { perDay: 0 } }, async h => { await h.ready(); }],
    ];
    for (const [reason, options, prepare] of cases) {
      for (const transcript of PRODUCTION_ASKS) {
        const h = harness(options);
        await prepare(h);
        const turn = await h.say(transcript);
        const name = `${reason}: ${transcript}`;
        expect(turn.prompt, name).toContain(voiceRoomLookUnavailablePrompt(reason));
        expect(turn.prompt, name).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON[reason]}。`);
        expect(turn.prompt, name).not.toContain(voiceRoomLookPrompt(true));
        // The line itself names the excuses only to forbid them.
        expect(turn.prompt, name).toContain('カメラの許可、接続、画像が届かないなど、ここに書かれていない原因を作って言わない');
        h.advance(SECOND);
        await h.presence();
        expect(h.lookStore.waiting(scope), name).toEqual([]);
        expect(h.viewer?.calls ?? [], name).toEqual([]);
      }
    }
    // The reasons are the server's own words; none of them is what she invented in the real call.
    for (const reason of Object.values(ROOM_LOOK_UNAVAILABLE_REASON)) for (const word of INVENTED) expect(reason).not.toContain(word);
    expect(ROOM_LOOK_UNAVAILABLE_REASON).toMatchObject({
      no_body: '体（PCのアプリ）がつながっていない', no_camera: '体のカメラが入っていない', body_away: '体の窓が出ていない',
      busy: 'いま見ている途中', limit_hour: 'この1時間に見られる回数を使い切った', limit_day: '今日見られる回数を使い切った',
      switched_off: 'この機能は止めてある', not_alone: 'ほかの人がいる場では見ない',
    });
  });

  it('says that a look is already in progress instead of opening a second one', async () => {
    const h = harness();
    await h.ready();
    await h.say('部屋を見て。');
    const first = await h.openLook();
    const again = await h.say('ねえ、部屋を見て。');
    expect(again.prompt).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON.busy}。`);
    expect(h.lookStore.waiting(scope).map(look => look.id)).toEqual([first!.id]);
  });

  it('checks the conditions again when the reply is written: a camera switched off meanwhile opens nothing', async () => {
    const h = harness();
    await h.ready();
    const slow = h.model.generateVoice.bind(h.model);
    h.model.generateVoice = async request => { await h.camera(false); return slow(request); };
    const turn = await h.say('部屋を見て。');
    expect(turn.prompt).toContain(voiceRoomLookPrompt(true));
    expect(h.lookStore.waiting(scope)).toEqual([]);
  });

  it('never looks in 「友人も一緒」 or with someone listening, and says so', async () => {
    const guest = harness();
    await guest.ready();
    const friend = await guest.say('シャノン、部屋を見て。', { participantMode: 'guest' });
    expect(friend.prompt).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON.not_alone}。`);
    expect(guest.lookStore.waiting(scope)).toEqual([]);

    const companion = harness();
    await companion.ready();
    const listening = await companion.say('シャノン、部屋を見て。', {}, { companionPresent: true });
    expect(listening.prompt).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON.not_alone}。`);
    expect(companion.lookStore.waiting(scope)).toEqual([]);
  });

  it('ends a look in progress when the next voice turn can be heard by someone else', async () => {
    const h = harness();
    await h.ready();
    await h.say('部屋を見て。');
    const look = await h.openLook();
    await h.say('シャノン、こんにちは。', { participantMode: 'guest' });
    expect(h.lookStore.get(scope, look!.id)).toMatchObject({ outcome: 'refused', code: 'others_present' });
    expect((await h.answer(look!.id)).status).toBe(409);
    expect(h.viewer.calls).toEqual([]);
  });

  it('opens nothing from words that are not a request to look now', async () => {
    const h = harness();
    await h.ready();
    for (const transcript of ['私も見てみたい映画があるんだ。', 'メール見てくれた?', '昨日カメラ買ったんだ。', 'さっき部屋を見てたよね。', 'カメラで見ないで。', '今日はどんな日でしたか。']) {
      expect(asksForLookAloud(transcript), transcript).toBe(false);
      await h.say(transcript);
      expect(h.lookStore.waiting(scope), transcript).toEqual([]);
    }
    for (const transcript of [...PRODUCTION_ASKS, 'こっち見て', 'カメラで見てみて', '何が見える?', 'これ見てよ']) expect(asksForLookAloud(transcript), transcript).toBe(true);
  });

  it('tells her that she could look when the camera is mentioned and nobody chose a look', async () => {
    const h = harness();
    await h.ready();
    const turn = await h.say('カメラでちゃんと映るようになったかな。');
    expect(turn.prompt).toContain(VOICE_ROOM_LOOK_READY_PROMPT);
    expect(h.lookStore.waiting(scope)).toEqual([]);
  });
});

describe('she looks because she wants to', () => {
  it('only through the gateway\'s judgement, as a look she chose herself', async () => {
    const h = harness({ voiceDecision: gateway({ roomLookProbability: 0.92, transcriptReliabilityProbability: 0.95 }) });
    await h.ready();
    const turn = await h.say('じゃーん、髪を切ってきたんだ。');
    expect(turn.prompt).toContain(voiceRoomLookPrompt(false));
    const look = await h.openLook();
    expect(h.lookStore.get(scope, look!.id)).toMatchObject({ ownerAsked: false, threadId: 'voice-thread' });
  });

  it('not below the threshold, not on a transcript the gateway could not trust, and not without the gateway', async () => {
    for (const voiceDecision of [
      gateway({ roomLookProbability: 0.84, transcriptReliabilityProbability: 0.95 }),
      gateway({ roomLookProbability: 0.99, transcriptReliabilityProbability: 0.3 }),
      gateway({ roomLookProbability: 0.99 }),
      new LocalVoiceDecisionGateway(),
    ]) {
      const h = harness({ voiceDecision });
      await h.ready();
      const turn = await h.say('じゃーん、髪を切ってきたんだ。');
      expect(turn.prompt).not.toContain('[部屋を見る]');
      expect(h.lookStore.waiting(scope)).toEqual([]);
    }
  });

  it('a high judgement still opens nothing when the conditions fail, and then carries the reason', async () => {
    const h = harness({ voiceDecision: gateway({ roomLookProbability: 1, transcriptReliabilityProbability: 0.95 }) });
    await h.camera(false);
    await h.presence();
    const turn = await h.say('じゃーん、髪を切ってきたんだ。');
    expect(turn.prompt).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON.no_camera}。`);
    expect(h.lookStore.waiting(scope)).toEqual([]);
  });
});

describe('what she saw reaches the voice conversation', () => {
  it('as her next message in the thread of the call, seen with the turn that asked for it', async () => {
    const h = harness();
    await h.ready();
    await h.say('うん、じゃあ部屋を見て。');
    const look = await h.openLook();
    const response = await h.answer(look!.id);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'seen', message: { threadId: 'voice-thread', text: SEEN_TEXT } });
    // The voice turn itself is stored by the client only after her reply was spoken; the model that sees the frame is given it anyway.
    expect(h.viewer.calls[0]!.context).toEqual([
      { role: 'user', content: 'うん、じゃあ部屋を見て。' }, { role: 'assistant', content: '見てみますね。' },
    ]);
    expect(h.messages().map(message => [message.role, message.content])).toEqual([['assistant', SEEN_TEXT]]);
    // The client then stores the spoken turn; the next voice turn replays both.
    h.advance(SECOND);
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: 'うん、じゃあ部屋を見て。', shannonTranscript: '見てみますね。' });
    h.advance(SECOND);
    await h.say('どうだった、何か気づいた?');
    expect(JSON.stringify(h.model.voiceRequests.at(-1)!.history)).toContain(SEEN_TEXT);
  });

  it('does not repeat the turn in what the viewer is given once the client has stored it', async () => {
    const h = harness();
    await h.ready();
    await h.say('部屋を見て。');
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '部屋を見て。', shannonTranscript: '見てみますね。' });
    await h.answer((await h.openLook())!.id);
    expect(h.viewer.calls[0]!.context).toEqual([{ role: 'user', content: '部屋を見て。' }, { role: 'assistant', content: '見てみますね。' }]);
  });

  it('says one honest line when the body refuses a look the owner asked for', async () => {
    const h = harness();
    await h.ready();
    await h.say('部屋を見て。');
    const response = await h.answer((await h.openLook())!.id, { outcome: 'refused', code: 'window_hidden' });
    expect(response.body).toMatchObject({ status: 'refused', message: { threadId: 'voice-thread', text: bodyLookNotSeenLine('window_hidden') } });
  });

  it('counts voice looks in the same hourly limit as text looks', async () => {
    const h = harness({ config: { perHour: 1 } });
    await h.ready();
    await h.say('部屋を見て。');
    await h.answer((await h.openLook())!.id);
    h.advance(5 * SECOND);
    await h.presence();
    const turn = await h.say('もう一回、部屋を見て。');
    expect(turn.prompt).toContain(`本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON.limit_hour}。`);
    expect(await h.openLook()).toBeNull();
  });
});

describe('switches and the gateway question', () => {
  it('SHANNON_VOICE_ROOM_LOOK=off takes the look out of voice turns and says so truthfully', async () => {
    vi.stubEnv('SHANNON_VOICE_ROOM_LOOK', 'off');
    const h = harness();
    await h.ready();
    const turn = await h.say('部屋を見て。');
    expect(turn.prompt).toContain('本当の理由: 声の会話で部屋を見る機能は止めてある。');
    expect(h.lookStore.waiting(scope)).toEqual([]);
  });

  it('a turn she does not answer opens nothing', () => {
    const state = { unavailable: null, open: vi.fn(() => true) };
    const turn = voiceRoomLookTurn({ voiceTurn: () => state }, { scopeKey: scope, transcript: '部屋を見て。', at: START, audience: 'owner', uncertain: false,
      decision: { shouldRespond: false, roomLookProbability: 1 } as never });
    expect(turn.prompt).toBe('');
    expect(turn.open('thread', '')).toBe(false);
    expect(state.open).not.toHaveBeenCalled();
  });

  const input: VoiceDecisionInput = { scopeKey: scope, transcript: 'こっち見て', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    turn: { sheAsked: false, followsShannon: false, othersPresent: false } };

  it('asks Jev one more Noul in a call with the owner alone, and reads its answer', async () => {
    let payload: Record<string, any> = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: {
        ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0 }])),
        room_look: { type: 'noul', noul: 0.93 },
        reply_required: { type: 'noul', noul: 1 }, solution_wanted: { type: 'noul', noul: 0 }, transcript_reliable: { type: 'noul', noul: 0.9 },
        conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'neutral' },
        affect_intensity: { type: 'choice', choice: 'subtle' }, delivery: { type: 'choice', choice: 'conversational' },
        latency_class: { type: 'choice', choice: 'under_3s' },
      } }));
    };
    const jev = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const decision = await jev.decide(input);
    expect(payload.questions.room_look).toMatchObject({ type: 'noul' });
    expect(payload.questions.room_look.instructions).toContain('camera of her desktop body');
    expect(decision).toMatchObject({ source: 'jev', roomLookProbability: 0.93, conversationClass: 'direct', selectedSkills: [] });
    // Not a capability: it changes neither the class nor the waiting phrase, and the apps see no new skill.
    expect(VOICE_SKILLS).not.toContain('room_look');
    for (const without of [{ ...input, turn: { ...input.turn!, othersPresent: true } }, { ...input, participantMode: 'guest' as const }, { ...input, turn: undefined }]) {
      await jev.decide(without);
      expect(payload.questions.room_look).toBeUndefined();
    }
    vi.stubEnv('SHANNON_VOICE_ROOM_LOOK', 'off');
    await jev.decide(input);
    expect(payload.questions.room_look).toBeUndefined();
  });

  it('asks the OpenAI fallback for the same probability in its strict schema', async () => {
    let payload: Record<string, any> = {};
    const answer = (extra: Record<string, unknown>) => JSON.stringify({ output_text: JSON.stringify({
      replyRequiredProbability: 0.9, solutionWantedProbability: 0.2, transcriptReliabilityProbability: 0.9, conversationClass: 'direct',
      latencyClass: 'under_3s', affect: 'neutral', affectIntensity: 0.2, delivery: 'conversational',
      skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0])), ...extra,
    }) });
    let extra: Record<string, unknown> = { roomLookProbability: 0.88 };
    const fetcher = async (_url: unknown, init?: RequestInit) => { payload = JSON.parse(String(init?.body)); return new Response(answer(extra)); };
    const openai = new OpenAIVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    expect(await openai.decide(input)).toMatchObject({ source: 'openai', roomLookProbability: 0.88 });
    expect(payload.text.format.schema.properties.roomLookProbability).toEqual({ type: 'number', minimum: 0, maximum: 1 });
    expect(payload.text.format.schema.required).toContain('roomLookProbability');
    expect(payload.instructions).toContain('roomLookProbability: Would one look through the camera of her desktop body be right now?');
    // A malformed answer is no answer; the rest of the decision stands.
    extra = { roomLookProbability: 'yes' };
    const malformed = await openai.decide(input);
    expect(malformed.source).toBe('openai');
    expect(malformed.roomLookProbability).toBeUndefined();
    extra = {};
    await openai.decide({ ...input, participantMode: 'guest' });
    expect(payload.text.format.schema.properties.roomLookProbability).toBeUndefined();
    expect(payload.text.format.schema.required).not.toContain('roomLookProbability');
  });
});
