import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { ROOM_LOOK_UNAVAILABLE_REASON } from '../src/surfaces/body/bodyLook.js';
import { configuredBodyLook, type BodyLookConfig } from '../src/contracts/bodyLookContract.js';
import { BODY_LOOK_CUT_OFF_LINE, UNOPENED_LINE, bodyLookNotSeenLine } from '../src/mind/perception/bodyLookLines.js';
import { VoiceTurnWaits } from '../src/surfaces/body/bodyLookTurnWait.js';
import { SQLiteBodyLookStore } from '../src/surfaces/body/store/bodyLookStore.js';
import type { RoomLookViewRequest, RoomLookViewer } from '../src/surfaces/body/bodyLookVision.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import type { BodyPresence } from '../src/surfaces/body/shannonBody.js';
import {
  JevVoiceDecisionGateway, LocalVoiceDecisionGateway, OpenAIVoiceDecisionGateway, VOICE_SKILLS,
  type VoiceDecisionGateway, type VoiceDecisionInput,
} from '../src/mind/selectors/voiceDecision.js';
import {
  VOICE_ROOM_LOOK_CONFIRM_PROMPT, VOICE_ROOM_LOOK_READY_PROMPT, asksForLookAloud, lookRequest, voiceRoomLookPrompt, voiceRoomLookTurn, voiceRoomLookUnavailablePrompt,
} from '../src/surfaces/voice/voiceRoomLook.js';
import { promptOf } from './modelPrompt.js';

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
  generateVoiceStreaming?: ShannonChatModel['generateVoiceStreaming'];
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

function harness(options: { config?: Partial<BodyLookConfig>; ingestEnabled?: boolean; viewer?: RoomLookViewer | null; voiceDecision?: VoiceDecisionGateway; turnWait?: number } = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const model = new VoiceModel();
  const viewer = options.viewer === undefined ? new FakeViewer() : options.viewer;
  const lookStore = new SQLiteBodyLookStore(':memory:');
  const conversationStore = new InMemoryConversationStore();
  const autonomy = createInMemoryAutonomyService(now);
  const api = createLocalApiKernel(now, {
    stateStore: new InMemoryCompanionStateStore(now), conversationStore, chatModel: model, autonomy,
    // A model tier that trusts the transcript and neither confirms nor contradicts a look.
    voiceDecision: options.voiceDecision ?? gateway({ transcriptReliabilityProbability: 0.95, roomLookProbability: 0.3 }),
    body: {
      store: new SQLiteBodyStore(':memory:'), ingestEnabled: options.ingestEnabled ?? true,
      look: { store: lookStore, config: { ...configuredBodyLook({}), ...options.config }, viewer, timers: false, voiceTurnWaitMilliseconds: options.turnWait ?? 0 },
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
    return { body, prompt: model.voiceRequests.length > before ? promptOf(model.voiceRequests.at(-1)!) : '' };
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
        expect(turn.prompt, name).toContain(reason === 'body_away' ? 'カメラの許可、画像が届かないなど、ここに書かれていない原因を作って言わない'
          : 'カメラの許可、接続、画像が届かないなど、ここに書かれていない原因を作って言わない');
        h.advance(SECOND);
        await h.presence();
        expect(h.lookStore.waiting(scope), name).toEqual([]);
        expect(h.viewer?.calls ?? [], name).toEqual([]);
      }
    }
    // The reasons are the server's own words; none of them is what she invented in the real call.
    for (const reason of Object.values(ROOM_LOOK_UNAVAILABLE_REASON)) for (const word of INVENTED) expect(reason).not.toContain(word);
    expect(ROOM_LOOK_UNAVAILABLE_REASON).toMatchObject({
      no_body: '体（PCのアプリ）がつながっていない', no_camera: '体のカメラが入っていない', body_away: '体からの知らせがしばらく届いていない（体の窓が隠れているか、体が動いていない）',
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
    // She had said she would look: one honest line follows in the Talk of the call.
    expect(h.messages().map(message => [message.role, message.content])).toEqual([['assistant', bodyLookNotSeenLine('camera_off')]]);
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
    // Watching something, asking her to check a document, talk about cameras, seeing in general: none of these is a request to look.
    for (const transcript of [
      '僕もニュース見てるよ', '俺はテレビ見てる', '私は映画を見てる', '私今ドラマ見てる', '私もそれ見てる', '防犯カメラを見てる', '防犯カメラを見て',
      '私のメール見てくれる', '僕の予定見て', '私のノート見て', 'ここのバグ見てくれない', 'スライドのここを見てください', 'ここ見て、3行目', 'これ見てよ',
      'カメラの設定を見て', 'カメラロール見て', 'カメラで撮った写真見て', '新しいカメラを使ってる', 'カメラを買って使ってみて', 'オンライン会議でカメラをオンにして',
      '星が見えてる', '字幕見えてる', '画面見えてる', '窓の外が見えない', '外は雨が見える', '何が見えたの昨日', '僕のこと見てた?',
      // He is the one who sees; a video call; some other camera; reported speech.
      '私は見えるよ', '僕は見えてるよ', '俺も見えるけど', '私も見れるかな', '僕も見れる', '私見えますよ', '僕も見てみて',
      'こっちは見えてるよ', 'こっちも見えます', 'ビデオ会議でこっち見えてる', '相手にこっちが見えてますか', '向こうからこっち見える',
      '新しいカメラ使ってみて', '一眼レフカメラ使ってみてよ', 'このカメラ使ってね', 'このカメラ使っていい', 'カメラを使ってほしい', 'スマホのカメラで見て',
      'カメラ使っていい?って聞かれた', '周り見えてる', '次の部屋を見て',
      // The object has a modifier, the view is someone else's, the camera is another one, or he asks for leave himself.
      '窓から何が見える？', 'その展望台から何が見えるの', '子供部屋を見て', '昔の僕を見て', 'ビデオカメラで見て', 'カメラ使っていいかな',
    ]) expect(asksForLookAloud(transcript), transcript).toBe(false);
    expect(['僕のこと見れる?', '僕が見える?', 'カメラ使っていいよ', 'カメラ使ってもいいよ'].map(lookRequest)).toEqual(['plain', 'plain', 'plain', 'plain']);
    expect(['部屋を見て', 'こっち見て', 'カメラで見てみて', '何が見える?', '机の上見てくれる'].map(lookRequest)).toEqual(Array(5).fill('ambiguous'));
    // Plain requests open the camera without a model, so one clause among others, someone else's doing, or "I can watch" is never plain.
    for (const transcript of [
      'あの子、僕を見てくれない。', '息子に、カメラ使っていいよ、って言ったんだ。', '田中さんなら、カメラ使っていいよ。', '録画、私が見れるよ。', '向こうからは、私が見える？',
      '明日の撮影は、カメラ使っていいから。', 'その番組、僕が見れるの。', '犬がね、私を見てくれるの。', '先生は、私を見てくれるよ。',
      // A long clause before it is part of the utterance, and his own question is not leave.
      '田中さんが来週うちに来て配信の機材を全部セットしてくれることになったんだけどその時は、カメラ使っていいよ', 'カメラ使っていい？', 'カメラ使っていい',
      'カメラ使っていいです', 'カメラ使っていいね',
    ]) expect(lookRequest(transcript), transcript).not.toBe('plain');
    expect(['カメラ使っていいよ', 'カメラ使っていいですよ', 'カメラ使っていいから', 'うん、カメラ使って大丈夫だよ'].map(lookRequest)).toEqual(Array(4).fill('plain'));
    for (const transcript of [
      ...PRODUCTION_ASKS, 'もちろんそうカメラ使っていいよ自由に', 'こっち見て', '僕が見える?', '僕のこと見えてる?', 'カメラで見てみて', 'カメラ使ってもいいよ', '何が見える?', '机の上見てくれる',
      '部屋を見てほしいんだけど',
    ]) expect(asksForLookAloud(transcript), transcript).toBe(true);
    // Long or repetitive input costs nothing: the patterns repeat no alternation and look only at short clauses.
    const started = performance.now();
    expect(asksForLookAloud(`これ見て${'かな'.repeat(2_000)}x`)).toBe(false);
    expect(asksForLookAloud('部屋を見て'.repeat(1_500))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('a gateway that is sure no look is wanted sets the fixed rule aside, and she asks once instead of looking', async () => {
    const h = harness({ voiceDecision: gateway({ roomLookProbability: 0.05, transcriptReliabilityProbability: 0.95 }) });
    await h.ready();
    const turn = await h.say('部屋を見て。');
    // His words asked: never 「見てと言われたら見られる」 (owner's Windows call, 2026-10-14).
    expect(turn.prompt).toContain(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
    expect(turn.prompt).not.toContain(VOICE_ROOM_LOOK_READY_PROMPT);
    expect(h.lookStore.waiting(scope)).toEqual([]);
  });

  it('his words open nothing when a model tier could not trust the transcript; with no model\'s score they are taken as heard', async () => {
    const distrusted = harness({ voiceDecision: gateway({ transcriptReliabilityProbability: 0.3 }) });
    await distrusted.ready();
    expect((await distrusted.say('部屋を見て。')).prompt).toContain(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
    expect(distrusted.lookStore.waiting(scope)).toEqual([]);
    // The local tier alone: words that say it plainly (himself as what is looked at, leave to use the camera) open the look...
    for (const transcript of ['僕のこと見れる?', 'もちろん、そう、カメラ使っていいよ、自由に。']) {
      const local = harness({ voiceDecision: new LocalVoiceDecisionGateway() });
      await local.ready();
      expect((await local.say(transcript)).prompt, transcript).toContain(voiceRoomLookPrompt(true));
      expect(local.lookStore.waiting(scope), transcript).toHaveLength(1);
    }
    // ...and words that could be about another room, camera or view do not, without a model to judge them.
    for (const transcript of ['部屋を見て。', 'こっち見て', 'カメラで見てみて', '何が見える?']) {
      const local = harness({ voiceDecision: new LocalVoiceDecisionGateway() });
      await local.ready();
      expect((await local.say(transcript)).prompt, transcript).toContain(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
      expect(local.lookStore.waiting(scope), transcript).toEqual([]);
    }
  });

  it('a request to look from first word to last opens it under a low transcript score when the gateway agrees (owner\'s Windows call, 2026-10-14)', async () => {
    // Production: transcript scores .44–.84, roomLook .75 and .83, and she twice said she would look only when asked.
    for (const [transcript, reliability, look] of [['僕のこと見える？', 0.44, 0.75], ['部屋を見て。', 0.3, 0.83]] as const) {
      const h = harness({ voiceDecision: gateway({ roomLookProbability: look, transcriptReliabilityProbability: reliability }) });
      await h.ready();
      const turn = await h.say(transcript);
      expect(turn.prompt, transcript).toContain(voiceRoomLookPrompt(true));
      expect(turn.prompt, transcript).not.toContain(VOICE_ROOM_LOOK_READY_PROMPT);
      expect(h.lookStore.waiting(scope), transcript).toHaveLength(1);
    }
    // Below the gateway's half it is not taken on doubtful words: she asks once, and a bare 「見て」 then opens it.
    const doubtful = harness({ voiceDecision: gateway({ roomLookProbability: 0.4, transcriptReliabilityProbability: 0.3 }) });
    await doubtful.ready();
    expect((await doubtful.say('部屋を見て。')).prompt).toContain(VOICE_ROOM_LOOK_CONFIRM_PROMPT);
    expect(doubtful.lookStore.waiting(scope)).toEqual([]);
    // Talk about the camera that asks for nothing keeps the ready line.
    const mentioned = harness({ voiceDecision: gateway({ roomLookProbability: 0.6, transcriptReliabilityProbability: 0.3 }) });
    await mentioned.ready();
    expect((await mentioned.say('新しいカメラを買ったんだ。')).prompt).toContain(VOICE_ROOM_LOOK_READY_PROMPT);
    expect(mentioned.lookStore.waiting(scope)).toEqual([]);
  });

  it('a bare 「見て」 opens the look as the answer to her own offer, or when the gateway is fairly sure', async () => {
    // "She offered" is a fact the server keeps: the turn before was told that she could look (the READY line).
    const offer = 'カメラでちゃんと映るようになったかな。';
    for (const transcript of ['見てみて', 'じゃあ見て', '見てよ', 'うん、見て。']) {
      const offered = harness();
      await offered.ready();
      expect((await offered.say(offer)).prompt).toContain(VOICE_ROOM_LOOK_READY_PROMPT);
      offered.advance(20 * SECOND);
      await offered.presence();
      expect((await offered.say(transcript)).prompt, transcript).toContain(voiceRoomLookPrompt(true));
      expect(offered.lookStore.waiting(scope), transcript).toHaveLength(1);
      // Without that turn the same words are not a request to use the camera.
      const cold = harness();
      await cold.ready();
      await cold.say(transcript);
      expect(cold.lookStore.waiting(scope), transcript).toEqual([]);
    }
    // What she said is not read at all: lines of hers that speak of looking at something else set nothing.
    for (const hers of ['その資料、ボクが見てみましょうか？', 'Voyagerのタスクが3件ありますね。見てみましょうか？', '田中さんにこの資料を見てと言われたんですね。', '見られますか？', '見てみましょうか？']) {
      const other = harness();
      await other.ready();
      await other.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: 'ねえ', shannonTranscript: hers });
      await other.say('うん、見て。');
      expect(other.lookStore.waiting(scope), hers).toEqual([]);
    }
    // The offer lapses after a minute, belongs to its Talk, and is answered only by a bare request that is the whole utterance.
    for (const [transcript, wait, extra] of [['うん、見て。', 61, {}], ['うん、見て。', 5, { threadId: 'another-thread' }], ['このメール、見て', 5, {}], ['うん、それとこのメールも見て', 5, {}]] as const) {
      const lapsed = harness();
      await lapsed.ready();
      await lapsed.say(offer);
      lapsed.advance(wait * SECOND);
      await lapsed.presence();
      await lapsed.say(transcript, extra);
      expect(lapsed.lookStore.waiting(scope), `${transcript} after ${wait}s`).toEqual([]);
    }
    const sure = harness({ voiceDecision: gateway({ roomLookProbability: 0.6, transcriptReliabilityProbability: 0.95 }) });
    await sure.ready();
    expect((await sure.say('これ見てよ')).prompt).toContain(voiceRoomLookPrompt(true));
    expect(sure.lookStore.waiting(scope)).toHaveLength(1);
  });

  it('a presence read that arrives while the router decides does not make the body look away', async () => {
    const router = gateway({ transcriptReliabilityProbability: 0.95, roomLookProbability: 0.3 });
    const h = harness({ voiceDecision: router });
    await h.camera();
    await h.presence();
    h.advance(80 * SECOND);
    const decide = router.decide.bind(router);
    router.decide = async input => { h.advance(SECOND); await h.presence(); return decide(input); };
    expect((await h.say('僕のこと見れる?')).prompt).toContain(voiceRoomLookPrompt(true));
    expect(h.lookStore.waiting(scope)).toHaveLength(1);
    // The same for a caller that passes the instant the turn began (the text path): a later read is fresh, not "from the future".
    const text = harness();
    await text.camera();
    text.advance(2 * SECOND);
    await text.presence();
    const looks = (text.api as unknown as { body: { looks: { voiceTurn(scopeKey: string, at: string, audience: string): { unavailable: string | null } } } }).body.looks;
    expect(looks.voiceTurn(scope, START, 'owner').unavailable).toBeNull();
  });

  it('a turn someone else can hear that arrives while she is replying stops the look, and nothing is said', async () => {
    const h = harness();
    await h.ready();
    const speak = h.model.generateVoice.bind(h.model);
    let interrupted = false;
    h.model.generateVoice = async request => {
      if (!interrupted) { interrupted = true; await h.say('シャノン、こんにちは。', { participantMode: 'guest' }); }
      return speak(request);
    };
    expect((await h.say('僕のこと見れる?')).prompt).toContain(voiceRoomLookPrompt(true));
    expect(h.lookStore.waiting(scope)).toEqual([]);
    expect(h.messages()).toEqual([]);
  });

  it('leaves one honest line when the call is cut off after she began to say she would look', async () => {
    const h = harness();
    await h.ready();
    const stopped = new AbortController();
    h.model.generateVoiceStreaming = async (_request, onDelta) => { await onDelta('見てみ'); stopped.abort(); throw new Error('aborted'); };
    await expect(h.api.streamLiveVoiceDelegation({ method: 'POST', path: delegations, deviceId: 'body-pc',
      body: { scopeKey: scope, threadId: 'voice-thread', transcript: '僕のこと見れる?' } },
    { signal: stopped.signal, onPlan: () => undefined, onTextDelta: () => undefined })).rejects.toThrow();
    expect(h.lookStore.waiting(scope)).toEqual([]);
    expect(h.messages().map(message => [message.role, message.content])).toEqual([['assistant', BODY_LOOK_CUT_OFF_LINE]]);
    expect(BODY_LOOK_CUT_OFF_LINE).toBe('話が途中になったので、いまは見ないでおきました。');
    // Cut off before she had said anything about looking: nothing was promised, nothing is said.
    const early = harness({ voiceDecision: gateway({ roomLookProbability: 0.95, transcriptReliabilityProbability: 0.95 }) });
    await early.ready();
    const cut = new AbortController();
    early.model.generateVoiceStreaming = async (_request, onDelta) => { await onDelta('そうなんですね、'); cut.abort(); throw new Error('aborted'); };
    await expect(early.api.streamLiveVoiceDelegation({ method: 'POST', path: delegations, deviceId: 'body-pc',
      body: { scopeKey: scope, threadId: 'voice-thread', transcript: 'じゃーん、髪を切ってきたんだ。' } },
    { signal: cut.signal, onPlan: () => undefined, onTextDelta: () => undefined })).rejects.toThrow();
    expect(early.messages()).toEqual([]);
  });

  it('opens nothing when the call is cut off before her reply is written', async () => {
    const h = harness();
    await h.ready();
    const stopped = new AbortController();
    await expect(h.api.streamLiveVoiceDelegation({ method: 'POST', path: delegations, deviceId: 'body-pc',
      body: { scopeKey: scope, threadId: 'voice-thread', transcript: '部屋を見て。' } },
    { signal: stopped.signal, onPlan: () => stopped.abort(), onTextDelta: () => undefined })).rejects.toThrow();
    expect(h.lookStore.waiting(scope)).toEqual([]);
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
  it('only through the gateway\'s judgement; said aloud, so a failure would get her one honest line like a look he asked for', async () => {
    const h = harness({ voiceDecision: gateway({ roomLookProbability: 0.92, transcriptReliabilityProbability: 0.95 }) });
    await h.ready();
    const turn = await h.say('じゃーん、髪を切ってきたんだ。');
    expect(turn.prompt).toContain(voiceRoomLookPrompt(false));
    const look = await h.openLook();
    expect(h.lookStore.get(scope, look!.id)).toMatchObject({ ownerAsked: true, threadId: 'voice-thread' });
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

  it('holds her message until the client has stored the voice turn, so the Talk reads question, 「見てみますね」, what she saw', async () => {
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    await h.say('僕のこと見れる?');
    const look = await h.openLook();
    let answered = false;
    // An answer from another device is refused at once and does not end the wait of the right one.
    expect((await h.send('POST', `/v1/body/looks/${look!.id}`, seen, 'other-device')).status).toBe(403);
    const answer = h.answer(look!.id).then(response => { answered = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    expect(h.messages()).toEqual([]);
    h.advance(SECOND);
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと見れる?', shannonTranscript: '見てみますね。' });
    h.advance(SECOND);
    expect((await answer).body).toMatchObject({ status: 'seen', message: { text: SEEN_TEXT } });
    const stored = h.messages();
    expect(stored.map(message => [message.role, message.content])).toEqual([['user', '僕のこと見れる?'], ['assistant', '見てみますね。'], ['assistant', SEEN_TEXT]]);
    expect(Date.parse(stored[2]!.observedAt)).toBeGreaterThanOrEqual(Date.parse(stored[1]!.observedAt));
  });

  it('does not wait when the client stored the turn before her reply was written, and never holds a text look', async () => {
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    const speak = h.model.generateVoice.bind(h.model);
    h.model.generateVoice = async request => {
      await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと見れる?', shannonTranscript: '見てみますね。' });
      return speak(request);
    };
    await h.say('僕のこと見れる?');
    const started = performance.now();
    expect((await h.answer((await h.openLook())!.id)).body).toMatchObject({ status: 'seen' });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(h.messages().map(message => message.content)).toEqual(['僕のこと見れる?', '見てみますね。', SEEN_TEXT]);
  });

  it('is not released by a late store of the turn before it, and does not hold a text look in the same Talk', async () => {
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    await h.say('僕のこと見れる?');
    const look = await h.openLook();
    let answered = false;
    const answer = h.answer(look!.id).then(response => { answered = true; return response; });
    // The client now stores the turn BEFORE this one: other words, so this look still waits.
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '今日は何してたの', shannonTranscript: '本を読んでいました。' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと 見れる？', shannonTranscript: '見てみますね。' });
    expect((await answer).body).toMatchObject({ status: 'seen' });

    // A voice turn whose promised look was cut off is still waiting to be stored; a text look in the same Talk is answered at once.
    const mixed = harness({ turnWait: 5_000 });
    await mixed.ready();
    const stopped = new AbortController();
    mixed.model.generateVoiceStreaming = async (_request, onDelta) => { await onDelta('見てみ'); stopped.abort(); throw new Error('aborted'); };
    await expect(mixed.api.streamLiveVoiceDelegation({ method: 'POST', path: delegations, deviceId: 'body-pc',
      body: { scopeKey: scope, threadId: 'voice-thread', transcript: '僕のこと見れる?' } },
    { signal: stopped.signal, onPlan: () => undefined, onTextDelta: () => undefined })).rejects.toThrow();
    const looks = (mixed.api as unknown as { body: { looks: { turn(scopeKey: string, message: string, at: string, audience: string): { decide(choice: unknown, threadId: string): void } } } }).body.looks;
    looks.turn(scope, '部屋を見て', mixed.clock.at, 'owner').decide('asked', 'voice-thread');
    const started = performance.now();
    expect((await mixed.answer((await mixed.openLook())!.id)).body).toMatchObject({ status: 'seen' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('says nothing about a look that was not opened when someone else has joined while the line was waiting', async () => {
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    const speak = h.model.generateVoice.bind(h.model);
    let first = true;
    h.model.generateVoice = async request => { if (first) { first = false; await h.camera(false); } return speak(request); };
    await h.say('僕のこと見れる?');
    await h.say('シャノン、こんにちは。', { participantMode: 'guest' });
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと見れる?', shannonTranscript: '見てみますね。' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.messages().map(message => message.content)).toEqual(['僕のこと見れる?', '見てみますね。']);
  });

  it('does not wait for ever: after the bound her message is stored whatever the client did', async () => {
    const h = harness({ turnWait: 40 });
    await h.ready();
    await h.say('僕のこと見れる?');
    const response = await h.answer((await h.openLook())!.id);
    expect(response.body).toMatchObject({ status: 'seen', message: { text: SEEN_TEXT } });
    expect(h.messages().map(message => message.content)).toEqual([SEEN_TEXT]);
  });

  it('holds the line about a look that could not be opened in the same way, and gives the hourly limit its own true line', async () => {
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    const speak = h.model.generateVoice.bind(h.model);
    h.model.generateVoice = async request => { await h.camera(false); return speak(request); };
    await h.say('僕のこと見れる?');
    expect(h.messages()).toEqual([]);
    h.advance(SECOND);
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと見れる?', shannonTranscript: '見てみますね。' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.messages().map(message => message.content)).toEqual(['僕のこと見れる?', '見てみますね。', bodyLookNotSeenLine('camera_off')]);
    expect(UNOPENED_LINE.limit_hour).toEqual({ code: 'rate_limited', line: 'この1時間はもうたくさん見たので、少し間をあけます。' });
    expect(UNOPENED_LINE.limit_day!.line).toBe(bodyLookNotSeenLine('rate_limited'));
    for (const silent of ['not_alone', 'switched_off', 'no_viewer'] as const) expect(UNOPENED_LINE[silent]).toBeUndefined();
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
  it('SHANNON_VOICE_ROOM_LOOK=off makes a voice turn what it was before voice could look: no line, no look, no effect on a text look', async () => {
    const h = harness();
    await h.ready();
    await h.say('僕のこと見れる?');
    const open = await h.openLook();
    vi.stubEnv('SHANNON_VOICE_ROOM_LOOK', 'off');
    for (const extra of [{}, { participantMode: 'guest' }]) {
      const turn = await h.say('シャノン、部屋を見て。', extra);
      expect(turn.prompt).not.toContain('[部屋を見る]');
    }
    // Before voice could look, a voice turn did not touch a look in progress; it does not now.
    expect(h.lookStore.waiting(scope).map(look => look.id)).toEqual([open!.id]);
    const looks = { voiceTurn: vi.fn() };
    expect(voiceRoomLookTurn(looks as never, { scopeKey: scope, transcript: '部屋を見て。', at: START, audience: 'owner', uncertain: false,
      decision: { shouldRespond: true, roomLookProbability: 1 } as never })).toMatchObject({ prompt: '' });
    expect(looks.voiceTurn).not.toHaveBeenCalled();
  });

  it('takes a cut-off as a broken promise only when what she had said was about looking', () => {
    const cut = (said: string) => {
      const state = { unavailable: null, open: vi.fn(() => true), cutOff: vi.fn() };
      voiceRoomLookTurn({ voiceTurn: () => state }, { scopeKey: scope, transcript: '僕のこと見れる?', at: START, audience: 'owner', uncertain: false,
        decision: { shouldRespond: true } as never }).cutOff('thread', said);
      return state.cutOff.mock.calls.length;
    };
    for (const said of ['見てみ', 'ちょっと見ますね', 'みてみますね', 'のぞいてみますね', 'カメラで確認しますね']) expect(cut(said), said).toBe(1);
    for (const said of ['', 'そうなんですね、', 'ご意見ありがとうございます', '見つけました']) expect(cut(said), said).toBe(0);
    // Once cut off, nothing is opened, whatever reaches `open` afterwards.
    const state = { unavailable: null, open: vi.fn(() => true), cutOff: vi.fn() };
    const turn = voiceRoomLookTurn({ voiceTurn: () => state }, { scopeKey: scope, transcript: '僕のこと見れる?', at: START, audience: 'owner', uncertain: false,
      decision: { shouldRespond: true } as never });
    turn.cutOff('thread', '見てみ');
    expect(turn.open('thread', '見てみますね。')).toBe(false);
    expect(state.open).not.toHaveBeenCalled();
  });

  it('knows the awaited turn by the client\'s utterance id when both requests carry one, and otherwise by his words', async () => {
    const context = (id: string, text: string) => ({ userUtterance: { id, text, source: 'speech', rawText: text } });
    const h = harness({ turnWait: 5_000 });
    await h.ready();
    await h.say('僕のこと見れる?', {}, context('utt-7', '僕のこと見れる?'));
    let answered = false;
    const answer = h.answer((await h.openLook())!.id).then(response => { answered = true; return response; });
    // The same words under another id are another turn; the id decides.
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: '僕のこと見れる?', shannonTranscript: 'はい。', utteranceId: 'utt-6' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: 'ぼくのことみれる', shannonTranscript: '見てみますね。', utteranceId: 'utt-7' });
    expect((await answer).body).toMatchObject({ status: 'seen' });
    expect((await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: 'あ', shannonTranscript: 'い', utteranceId: 7 })).status).toBe(400);
    expect((await h.send('POST', '/v1/voice/realtime/turns', { threadId: 'voice-thread', userTranscript: 'あ', shannonTranscript: 'い', utteranceId: 'x'.repeat(121) })).status).toBe(400);

    // By words: equal, or one inside the other when it is long enough and most of it; empty words are no turn.
    let now = 0;
    const waits = new VoiceTurnWaits(5_000, () => now);
    const released = (awaited: string, stored: string) => {
      const wait = waits.await('s', 't', awaited, waits.mark);
      if (!wait) return 'no wait';
      let done = false;
      void wait.stored.then(() => { done = true; });
      waits.turnStored('s', 't', stored);
      const result = !(waits as unknown as { unstored: Set<unknown> }).unstored.has(wait);
      wait.done();
      return result && !done ? true : result;
    };
    expect(released('僕のこと見れる?', '僕のこと 見れる？')).toBe(true);
    expect(released('えっと、僕のこと見れる?', '僕のこと見れる')).toBe(true);
    expect(released('今日は朝から会議が三つもあって大変だったんだけど、部屋を見て', '部屋を見て')).toBe(false);
    expect(released('うん、見て', '見て')).toBe(false);
    expect(released('。', '。')).toBe('no wait');
    // A stored turn is remembered for a minute: after that it no longer counts as "already stored".
    const mark = waits.mark;
    waits.turnStored('s', 't', '僕のこと見れる?');
    expect(waits.await('s', 't', '僕のこと見れる?', mark)).toBeNull();
    now += 61_000;
    const later = waits.await('s', 't', '僕のこと見れる?', mark);
    expect(later).not.toBeNull();
    later!.done();
    expect((waits as unknown as { storedTurns: unknown[] }).storedTurns).toEqual([]);
    // With the wait switched off nothing is kept at all.
    const off = new VoiceTurnWaits(0);
    off.turnStored('s', 't', '僕のこと見れる?');
    expect((off as unknown as { storedTurns: unknown[] }).storedTurns).toEqual([]);
    expect(off.await('s', 't', '僕のこと見れる?', 0)).toBeNull();
  });

  it('a turn she does not answer opens nothing', () => {
    const state = { unavailable: null, open: vi.fn(() => true), cutOff: vi.fn() };
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
    const openai = new OpenAIVoiceDecisionGateway({ model: 'gpt-5.6-terra', apiKey: 'test-only', fetcher: fetcher as typeof fetch });
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
