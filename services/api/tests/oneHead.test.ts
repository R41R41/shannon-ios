import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { characterCoreBlock, CHARACTER_CORE, createInitialCompanionState, GUARD_FLAGS, shannonIdentityPrompt } from '@shannon/cognition';
import { SWITCHES } from '@shannon/switches';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeError, PlatformBridgeService, configuredPlatformBridge, platformBridgeThreadId } from '../src/mind/memory/platformBridge.js';
import { OPEN_CONVERSATION_TITLE, openConversationBinding } from '../src/mind/memory/platformBridgeBindings.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { PlatformReplyService } from '../src/surfaces/platform/platformReply.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { handlePlatformBridgeRequest, type PlatformBridgeRouteDependencies } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import { validatedConversationTurn } from '../src/surfaces/platform/platformConverse.js';
import { VoiceSentenceGuard } from '../src/surfaces/voice/voiceSentenceGuard.js';
import { GUARD_SAFE_REPLY, PRIVATE_SAFE_REPLY } from '../src/infra/models/feelingStrongChatModel.js';
import { expressionOf, oneHeadEnabled } from '../src/contracts/oneHeadContract.js';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingVoice } from '../src/mind/emotion/feelingPorts.js';
import type { VoiceMinecraftIntentInput, VoiceMinecraftPort } from '../src/surfaces/platform/voiceMinecraftPort.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/**
 * One head (owner 2026-10-20, `SHANNON_ONE_HEAD`): every entry through her one mind, the entries only hearing and speaking. Discord's
 * voice channel goes through the one voice turn the apps use; Discord's text, bound or not, through the text turn; `POST /v1/converse`
 * takes both in one shape; the voice turn reads her character space and checks her guard lines before each sentence.
 */
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const STRANGER = '900000000000000009';
const ROOM = 'discord:222:300'; // bound owner-private
const SERVER_ROOM = 'discord:111:222'; // the server's prefix binding: shared
const OPEN_ROOM = 'discord:555:666'; // bound by nobody
const START = '2026-10-20T12:00:00.000Z';
const TOKEN = 'c'.repeat(40);
const BINDINGS = [
  { platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: 'ライ氏の部屋', audience: 'owner-private' },
  { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
];
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
const ON = { SHANNON_DC_VOICE: 'on', SHANNON_ONE_HEAD: 'on' };
const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A model with both of her ways to speak: the plain spoken stream (voice) and the structured reply (text, and a voice turn with a field). */
class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  readonly kinds: string[] = [];
  reply = 'うん、いいよ。';
  intent: { kind: 'none' | 'task' | 'stop'; goal: string } | null = null;
  private result(): ShannonChatModelResult {
    return { mode: this.mode, model: this.model, reply: this.reply, ...(this.intent ? { minecraftIntent: this.intent } : {}) };
  }
  private async pieces(onText: (text: string) => void | Promise<void>): Promise<void> {
    for (let at = 0; at < this.reply.length; at += 3) await onText(this.reply.slice(at, at + 3));
  }
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    this.kinds.push('generate');
    return this.result();
  }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    this.kinds.push('structured-stream');
    await this.pieces(onReplyText);
    return this.result();
  }
  async generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    this.kinds.push('voice-stream');
    await this.pieces(onTextDelta);
    return this.result();
  }
}

class Body implements VoiceMinecraftPort {
  connected = true;
  running: { id: string; goal: string } | null = null;
  calls: VoiceMinecraftIntentInput[] = [];
  state() { return { connected: this.connected, running: this.running }; }
  async intent(input: VoiceMinecraftIntentInput) { this.calls.push(input); return { delivered: true, as: 'message' as const, taskId: 'task-1' }; }
}

function harness(environment: Record<string, string> = ON, options: { people?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-one-head-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const oneHead = () => oneHeadEnabled(environment);
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
    () => options.people !== false, oneHead);
  const voiceTurns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const replyTurns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
  const body = new Body();
  const conversation = { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api) };
  const voice = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation, turns: voiceTurns, now, chatModel: model, minecraft: () => body,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
    environment: () => environment, log: () => undefined,
  });
  const reply = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation, turns: replyTurns, now });
  let counter = 0;
  const say = async (userMessage: string, fields: Record<string, unknown> = {}) => {
    const lines: VoiceTurnLine[] = [];
    await voice.turn({
      platform: 'discord', requestId: `v-${(counter += 1)}`, conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
      userMessage, observedAt: now(), participants: [OWNER], ...fields,
    }, line => lines.push(line));
    return lines;
  };
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    voiceTurns.close(); replyTurns.close(); peopleStore.close(); store.close();
  };
  return { store, background, bridge, api, model, body, voice, reply, say, close, now };
}

const sentences = (lines: VoiceTurnLine[]) => lines.flatMap(line => (line.type === 'sentence' ? [line] : []));
const typeOf = (lines: VoiceTurnLine[]) => lines.map(line => line.type);

describe('the switch', () => {
  it('is off unless set, and names what it opens', () => {
    expect(oneHeadEnabled({})).toBe(false);
    expect(oneHeadEnabled({ SHANNON_ONE_HEAD: 'on' })).toBe(true);
    expect(SWITCHES.find(entry => entry.name === 'SHANNON_ONE_HEAD')).toMatchObject({ default: 'off', kind: 'explicit_on' });
  });
});

describe('a Discord voice channel through the one voice turn', () => {
  it('speaks the owner\'s room through the apps\' voice turn (plain stream), keeps it in the room\'s thread without voice tags', async () => {
    const { say, model, store, background, close } = harness();
    model.reply = 'ねえ、[whispers] 今日はもう寝ようかな。おやすみ。';
    const lines = await say('今日はもう遅いね、そろそろ寝ようか');
    expect(lines[0]).toMatchObject({ type: 'decision', respond: true });
    expect(typeOf(lines).filter(type => type !== 'expression').at(-1)).toBe('done');
    expect(model.kinds).toEqual(['voice-stream']);
    const spoken = sentences(lines);
    expect(spoken.map(line => line.text).join('')).not.toContain('[');
    expect(spoken.some(line => line.voiceText?.includes('[whispers]'))).toBe(true);
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[Live voice conversation]');
    expect(prompt).toContain('[Discordのボイスチャンネルでの会話]');
    expect(prompt).toContain('いま聞こえているのはライ氏だけ');
    expect(prompt).not.toContain('[Shannon shared audience]');
    await background.waitForIdle('owner');
    const thread = platformBridgeThreadId('discord', ROOM);
    const kept = store.conversationHistory('owner', thread).map(message => message.content);
    expect(kept[0]).toBe('今日はもう遅いね、そろそろ寝ようか');
    expect(kept[1]).not.toContain('[whispers]');
    await close();
  });

  it('reads with a friend there the channel as one audience, and never notes others beside the owner in his apps', async () => {
    const { say, model, api, close } = harness();
    await say('ねえ、今日の予定を教えて', { participants: [OWNER, FRIEND] });
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[Shannon shared audience]');
    expect(prompt).toContain('2人いる');
    expect(api.ownerPresenceForFeedback('owner')).not.toBe('others');
    await close();
  });

  it('answers a friend who named her with a guest\'s identity and her words prefixed by the name', async () => {
    const { say, model, close } = harness();
    await say('シャノン、いまマイクラで何してるの？', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    const request = model.requests[0]!;
    expect(request.message).toBe('ユウ: シャノン、いまマイクラで何してるの？');
    const prompt = promptOf(request);
    expect(prompt).toContain('いま話しかけているのは「ユウ」');
    expect(prompt).toContain('体や道具を動かす頼みごとは引き受けない');
    expect(prompt).toContain(shannonIdentityPrompt('guest').slice(0, 40));
    await close();
  });

  it('asks the structured reply for the owner\'s request to her body, streamed, and delivers it', async () => {
    const { say, model, body, close } = harness();
    body.running = { id: 'task-1', goal: 'エンダードラゴンを倒す' };
    model.reply = 'わかった、伝えておくね。';
    model.intent = { kind: 'task', goal: 'まず鉄の剣を作ってから向かって' };
    const lines = await say('シャノン、先に鉄の剣を作ってからにして', { participants: [OWNER, FRIEND] });
    expect(model.kinds).toEqual(['structured-stream']);
    expect((model.requests[0] as ShannonChatModelRequest).offerMinecraftIntent).toBe(true);
    expect(body.calls[0]).toMatchObject({ allowNew: false, intent: { kind: 'task' } });
    expect(body.calls[0]!.experienceId).toBeTruthy();
    expect(lines.find(line => line.type === 'intent')).toMatchObject({ kind: 'task_message', delivered: true });
    await close();
  });

  it('is the text turn read aloud while the switch is off (dc-voice as it was)', async () => {
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' });
    await say('こんばんは');
    expect(model.kinds).toEqual(['structured-stream']);
    await close();
  });
});

describe('conversations nobody bound, and people she cannot remember', () => {
  it('opens a Discord conversation nobody bound as one its people read, only when the bindings name one owner', () => {
    const configuration = configuredPlatformBridge(BRIDGE)!;
    expect(openConversationBinding(configuration, 'discord', OPEN_ROOM)).toMatchObject({ ownerUserId: OWNER, audience: 'shared', title: OPEN_CONVERSATION_TITLE });
    expect(openConversationBinding(configuration, 'discord', 'discord::777')).toMatchObject({ audience: 'shared' });
    expect(openConversationBinding(configuration, 'discord', 'slack:1:2')).toBeNull();
    const two = configuredPlatformBridge({ ...BRIDGE, SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([...BINDINGS,
      { platform: 'discord', conversationId: 'discord:999:1', ownerUserId: FRIEND, title: 'x' }]) })!;
    expect(openConversationBinding(two, 'discord', OPEN_ROOM)).toBeNull();
  });

  it('refuses them while off, and with one head answers a stranger without remembering anything of them', async () => {
    const off = harness({ SHANNON_DC_VOICE: 'on' }, { people: false });
    const refused = (() => {
      try { off.bridge.audiencePolicy({ platform: 'discord', conversationId: OPEN_ROOM, sourceUserId: OWNER }); return 'none'; } catch (error) {
        return error instanceof PlatformBridgeError ? error.code : 'other';
      }
    })();
    expect(refused).toBe('PLATFORM_CONVERSATION_DENIED');
    await off.close();
    const { reply, model, bridge, close } = harness(ON, { people: false });
    const policy = bridge.audiencePolicy({ platform: 'discord', conversationId: OPEN_ROOM, sourceUserId: STRANGER, conversationKind: 'channel' });
    expect(policy.ownerWrote).toBe(false);
    expect(policy.present.kind).toBe('group');
    const answer = await reply.replyRequest({ platform: 'discord', requestId: 't-1', conversationId: OPEN_ROOM, conversationKind: 'channel',
      sourceUserId: STRANGER, sourceDisplayName: 'たろう', userMessage: 'こんにちは、シャノン', observedAt: START, title: '雑談部屋' });
    expect(answer.reply).toBe('うん、いいよ。');
    expect(answer.ignored).toBe('people_disabled');
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('「雑談部屋」');
    expect(prompt).toContain(shannonIdentityPrompt('guest').slice(0, 40));
    await close();
  });
});

describe('POST /v1/converse', () => {
  async function serve(environment: Record<string, string>) {
    const h = harness(environment);
    const configuration = configuredPlatformBridge(BRIDGE)!;
    const dependencies = { configuration, chatModel: h.model, service: h.bridge, reply: h.reply,
      voice: { service: h.voice, mouth: null, speech: null, scopeKey: 'owner', environment: () => environment }, environment: () => environment,
    } as unknown as PlatformBridgeRouteDependencies;
    const server = createServer((request, response) => {
      void handlePlatformBridgeRequest(new URL(request.url ?? '/', 'http://127.0.0.1').pathname, request, response, dependencies);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const call = (body: unknown, token = TOKEN) => fetch(`http://127.0.0.1:${port}/v1/converse`, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` } });
    return { ...h, call };
  }
  const turn = (fields: Record<string, unknown> = {}) => ({
    version: 1, requestId: `c-${Math.random().toString(36).slice(2)}`, observedAt: START, modality: 'voice',
    where: { platform: 'discord', conversationId: ROOM, conversationKind: 'channel', voiceChannelId: '700' },
    who: { userId: OWNER, displayName: 'ライ氏' }, presence: { participants: [OWNER] }, words: 'こんばんは', ...fields,
  });
  const lines = async (response: Response) => (await response.text()).trim().split('\n').map(line => JSON.parse(line) as VoiceTurnLine);

  it('is closed while the switch is off, and needs the token', async () => {
    const off = await serve({ SHANNON_DC_VOICE: 'on' });
    expect((await off.call(turn())).status).toBe(503);
    expect((await off.call(turn(), 'x'.repeat(40))).status).toBe(401);
    await off.close();
  });

  it('answers a spoken turn and a typed one in the one shape, a typed one in a channel nobody bound included', async () => {
    const h = await serve({ ...ON, SHANNON_PLATFORM_REPLY: 'on' });
    const spoken = await h.call(turn());
    expect(spoken.status).toBe(200);
    const said = await lines(spoken);
    expect(said[0]).toMatchObject({ type: 'decision', respond: true });
    expect(said.at(-1)).toMatchObject({ type: 'done', duplicate: false });
    const typed = await lines(await h.call(turn({ modality: 'text', where: { platform: 'discord', conversationId: OPEN_ROOM, conversationKind: 'channel',
      title: '雑談部屋' }, words: 'シャノン、おはよう' })));
    expect(typed.map(line => line.type)).toEqual(['decision', 'sentence', 'done']);
    expect(typed[1]).toMatchObject({ text: 'うん、いいよ。' });
    expect(promptOf(h.model.requests.at(-1)!)).toContain('「雑談部屋」');
    expect((await h.call(turn({ modality: 'video' }))).status).toBe(400);
    expect((await h.call({ ...turn(), extra: 1 })).status).toBe(400);
    expect(() => validatedConversationTurn({ ...turn(), where: { platform: 'discord', conversationId: ROOM, conversationKind: 'group' } })).toThrow();
    await h.close();
  });
});

describe('her guard lines on a spoken reply (one head)', () => {
  const crossing = (sentence: string) => (/行くな/u.test(sentence) ? GUARD_SAFE_REPLY : /二人きり/u.test(sentence) ? PRIVATE_SAFE_REPLY : null);

  it('says whole sentences that pass, replaces the first that does not with the safe line, and drops the rest', () => {
    const guard = new VoiceSentenceGuard(crossing);
    expect(guard.pass('うん、わかっ')).toBe('');
    expect(guard.pass('た。今日は')).toBe('うん、わかった。');
    expect(guard.pass('飲み会なんて行くな。それと')).toBe(GUARD_SAFE_REPLY);
    expect(guard.pass('ね、明日は早く寝て。')).toBe('');
    expect(guard.end()).toBe('');
    expect(guard.swallowed).toBe(true);
    expect(guard.reply('ignored')).toBe(`うん、わかった。${GUARD_SAFE_REPLY}`);
  });

  it('checks an unstreamed reply whole, and leaves a reply that passes as written', () => {
    expect(new VoiceSentenceGuard(crossing).reply('ライ氏と二人きりの時の話だけど。')).toBe(PRIVATE_SAFE_REPLY);
    const clean = new VoiceSentenceGuard(crossing);
    expect(clean.pass('おやすみ')).toBe('');
    expect(clean.end()).toBe('おやすみ');
    expect(clean.reply('おやすみ')).toBe('おやすみ');
  });

  it('is made only for a turn whose check reads the lines (her region), from the same flags a text draft is held to', () => {
    expect(VoiceSentenceGuard.of(null)).toBeNull();
    const context = { stance: 'sulk' as const, intensity: 'moderate' as const, audience: 'owner_alone' as const, order: false, violation: false, region: 'devoted' as const };
    const guard = VoiceSentenceGuard.of(context)!;
    expect(guard.pass('飲み会なんて行くな。')).toBe(GUARD_SAFE_REPLY);
    expect(GUARD_FLAGS).toContain('controlling');
  });
});

describe('her character space in a voice turn (one head)', () => {
  const TODAY = '2026-10-25T11:00:00.000Z';
  const snapshot = () => ({ ...createInitialCompanionState('owner', '2026-10-20T03:00:00.000Z'),
    sharedDays: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'] });
  const composed = () => composedFeeling({ database: new DatabaseSync(':memory:'), now: () => TODAY, timeZone: 'Asia/Tokyo',
    chooser: fakeFeelingJev(() => ({ stance: 'neutral', intensity: 'subtle', drawer: 'none' })).chooser, turn: true, singleFace: true, check: true,
    strong: { cap: 10, model: {} as never }, talk: () => [], days: { relationship: false, episodes: false, boundaries: false, space: { max: true } } }).port;
  const start = (port: ReturnType<typeof composed>) => feelingVoice.start(port, { scopeKey: 'owner', alone: true, guest: false, threadId: 'v1',
    transcript: '何してた？', at: TODAY, snapshot: snapshot() });

  it('is computed for a voice turn only with one head, leans the router\'s decision, swaps the core and makes a guard', () => {
    expect(start(composed())?.lines?.space).toBeUndefined();
    vi.stubEnv('SHANNON_ONE_HEAD', 'on');
    const handle = start(composed());
    const region = handle?.lines?.space?.selection.primary;
    expect(region).toBeDefined();
    const block = feelingVoice.block(handle, undefined);
    expect(block).toContain('いまのボク: ');
    expect(handle?.decision).not.toBeNull();
    const identity = shannonIdentityPrompt('owner', { characterCore: characterCoreBlock(CHARACTER_CORE) });
    expect(feelingVoice.identity(handle, identity)).toMatch(/\[ボクの性格の核 v3-space #[0-9a-f]{8}\]/u);
    expect(feelingVoice.guard(handle)).toMatchObject({ region });
  });
});

describe('the apps\' voice turn', () => {
  it('asks the model exactly what it asked before when one head is on and nothing of her space is there', async () => {
    const ask = async () => {
      const { api, model, close } = harness();
      await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: 'ねえ、今日なにしてた？' } });
      const request = model.requests.at(-1)!;
      await close();
      return { prompt: promptOf(request), message: request.message, kinds: model.kinds };
    };
    const before = await ask();
    vi.stubEnv('SHANNON_ONE_HEAD', 'on');
    const after = await ask();
    expect(after).toEqual(before);
  });
});

describe('expression, her face as an event', () => {
  it('is read from a voice plan, and nothing without a face', () => {
    expect(expressionOf({ affect: 'joy', affectIntensity: 0.6, delivery: 'bright' })).toEqual({ type: 'expression', affect: 'joy', intensity: 0.6, delivery: 'bright' });
    expect(expressionOf({ shouldRespond: false })).toBeNull();
    expect(expressionOf(undefined)).toBeNull();
  });
});
