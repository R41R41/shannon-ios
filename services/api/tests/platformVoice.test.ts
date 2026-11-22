import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeError, PlatformBridgeService, configuredPlatformBridge, platformBridgeThreadId } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { validatedConversationTurn, voiceRequestOf } from '../src/surfaces/platform/platformConverse.js';
import { voiceHash } from '../src/surfaces/platform/platformVoiceRequest.js';
import { PlatformVoiceService, PLATFORM_VOICE_ALLOWANCE, platformVoiceEnabled, validatedVoiceTurn, type VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { handlePlatformBridgeRequest, isPlatformBridgePath, type PlatformBridgeRouteDependencies } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import type { PlatformVoiceRoutes } from '../src/surfaces/platform/platformVoiceRoute.js';
import { VoiceMouthQueue } from '../src/surfaces/platform/voiceMouth.js';
import type { VoiceMinecraftIntentInput, VoiceMinecraftPort } from '../src/surfaces/platform/voiceMinecraftPort.js';
import { VOICE_MINECRAFT_REFUSALS } from '../src/surfaces/platform/platformVoicePrompt.js';
import { createConfiguredPlatformBridgeRoute } from '../src/wiring/platformBridgeWiring.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { AddressedJudge } from '../src/mind/perception/addressed.js';
import { liveBlock } from '../src/surfaces/minecraft/minecraftLiveBlock.js';
import type { JevChooser } from '../src/infra/models/jev/jevChoice.js';

const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const OTHER = '900000000000000003';
const ROOM = 'discord:222:300'; // bound owner-private (his own server)
const SERVER_ROOM = 'discord:111:222'; // the server's prefix binding: shared
const START = '2026-10-20T12:00:00.000Z';
const TOKEN = 'c'.repeat(40);
const BINDINGS = [
  { platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: 'ライ氏の部屋', audience: 'owner-private' },
  { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
];
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
const ON = { ...BRIDGE, SHANNON_DC_VOICE: 'on', SHANNON_PLATFORM_REPLY: 'on' };
const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A model that streams its reply in small pieces, as the real one does, and may name a Minecraft intent. */
class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = 'うん、いいよ。';
  intent: { kind: 'none' | 'task' | 'stop'; goal: string } | null = null;
  streams = true;
  /** Holds the model after this many characters until the promise settles (the first words are out, the rest is not written yet). */
  pause: { after: number; until: Promise<void> } | null = null;
  private result(): ShannonChatModelResult {
    return { mode: this.mode, model: this.model, reply: this.reply, ...(this.intent ? { minecraftIntent: this.intent } : {}) };
  }
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return this.result();
  }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    if (!this.streams) return this.result();
    for (let at = 0; at < this.reply.length; at += 3) {
      if (this.pause && at >= this.pause.after) await this.pause.until;
      await onReplyText(this.reply.slice(at, at + 3));
    }
    return this.result();
  }
}

class Body implements VoiceMinecraftPort {
  connected = true;
  running: { id: string; goal: string } | null = null;
  queue: string[] | undefined;
  calls: VoiceMinecraftIntentInput[] = [];
  outcome: Awaited<ReturnType<VoiceMinecraftPort['intent']>> = { delivered: true, as: 'message', taskId: 'task-1' };
  state() { return { connected: this.connected, running: this.running, ...(this.queue ? { queue: this.queue } : {}) }; }
  async intent(input: VoiceMinecraftIntentInput) { this.calls.push(input); return this.outcome; }
}

interface LiveReader { block(options: { alone: boolean; participants?: boolean }): string; replying?(on: boolean): void; heard?(): void }

function harness(environment: Record<string, string> = { SHANNON_DC_VOICE: 'on' }, live?: LiveReader, addressed?: AddressedJudge, cutShortWaitMilliseconds?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-platform-voice-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse(START);
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore, ...(live ? { minecraftLive: live } : {}) });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const body = new Body();
  const service = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now, chatModel: model, minecraft: () => body, sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT),
    environment: () => environment, log: () => undefined, ...(addressed ? { addressed } : {}), ...(cutShortWaitMilliseconds !== undefined ? { cutShortWaitMilliseconds } : {}),
  });
  let counter = 0;
  const say = async (userMessage: string, fields: Record<string, unknown> = {}) => {
    const lines: VoiceTurnLine[] = [];
    await service.turn({
      platform: 'discord', requestId: `v-${(counter += 1)}`, conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
      userMessage, observedAt: now(), participants: [OWNER], ...fields,
    }, line => lines.push(line));
    return lines;
  };
  const refusal = async (operation: Promise<unknown>) => {
    try { await operation; return 'none'; } catch (error) { return error instanceof PlatformBridgeError ? `${error.status} ${error.code}` : String(error); }
  };
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    turns.close(); peopleStore.close(); store.close();
  };
  return { path, store, peopleStore, background, bridge, api, model, body, service, say, refusal, close, now, turns, advance: (milliseconds: number) => { clock += milliseconds; } };
}

const sentences = (lines: VoiceTurnLine[]) => lines.flatMap(line => (line.type === 'sentence' ? [line] : []));
const typeOf = (lines: VoiceTurnLine[]) => lines.map(line => line.type);
const roomThread = platformBridgeThreadId('discord', ROOM);

describe('POST /v1/platform/voice/turn', () => {
  it('answers the owner alone in his room as a conversation of his own, sentence by sentence, and keeps no voice tag', async () => {
    const { say, model, store, background, close } = harness();
    model.reply = 'ねえ、[whispers] 今日はもう寝ようかな。おやすみ。';
    const lines = await say('今日はもう遅いね、そろそろ寝ようか');
    expect(typeOf(lines)).toEqual(['decision', 'sentence', 'sentence', 'done']);
    expect(lines[0]).toMatchObject({ type: 'decision', respond: true, reason: 'solo' });
    const spoken = sentences(lines);
    expect(spoken[0]!.text).not.toContain('[');
    expect(spoken[0]!.voiceText).toContain('[whispers]');
    expect(spoken[1]).toMatchObject({ index: 1, text: 'おやすみ。' });
    const done = lines.at(-1)!;
    expect(done).toMatchObject({ type: 'done', duplicate: false, threadId: roomThread });
    expect((done as { reply: string }).reply).not.toContain('[');
    const request = model.requests[0]!;
    expect(request.message).toBe('今日はもう遅いね、そろそろ寝ようか');
    const prompt = promptOf(request);
    expect(prompt).toContain('[Discordのボイスチャンネルでの会話]');
    expect(prompt).toContain('いま聞こえているのはライ氏だけ');
    expect(prompt).not.toContain('[Shannon shared audience]');
    await background.waitForIdle('owner');
    const kept = store.conversationHistory('owner', roomThread).map(message => message.content);
    expect(kept[0]).toBe('今日はもう遅いね、そろそろ寝ようか');
    expect(kept[1]).not.toContain('[whispers]');
    expect(store.experienceCandidates('owner')[0]?.disclosure?.audience).toEqual({ kind: 'owner' });
    await close();
  });

  it('speaks a first clause before the sentence is finished, and the rest when the model could not stream', async () => {
    const { say, model, close } = harness();
    model.reply = 'えっと、いまは鉄を探してるところだよ、洞窟の奥まで来たからもう少しかな。';
    const streamed = sentences(await say('マイクラで今どんな感じ？'));
    expect(streamed.length).toBeGreaterThanOrEqual(2);
    expect(streamed.map(line => line.text).join('')).toBe(model.reply);
    model.streams = false;
    const whole = sentences(await say('それでどうなった？'));
    expect(whole.map(line => line.text).join('')).toBe(model.reply);
    await close();
  });

  it('with a friend in the channel the owner\'s room is an audience of the whole channel, and what is kept is theirs to read', async () => {
    const { say, model, store, background, close } = harness();
    const lines = await say('ねえ、今日の予定を教えて', { participants: [OWNER, FRIEND] });
    expect(lines[0]).toMatchObject({ respond: true });
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[Shannon shared audience]');
    expect(prompt).toContain('2人いる');
    expect(prompt).not.toContain('いま聞こえているのはライ氏だけ');
    await background.waitForIdle('owner');
    expect(store.experienceCandidates('owner')[0]?.disclosure?.audience?.kind).not.toBe('owner');
    await close();
  });

  it('stays quiet for friends talking to each other, remembers it for context, and answers when named', async () => {
    const { say, model, peopleStore, close } = harness();
    const together = { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND, OTHER] };
    const quiet = await say('昨日のボスまじでやばかった', { ...together, sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(typeOf(quiet)).toEqual(['decision', 'done']);
    expect(quiet[1]).toMatchObject({ silent: true, reason: 'table_talk' });
    expect(model.requests).toHaveLength(0);
    const named = await say('シャノン、いまマイクラで何してるの？', { ...together, sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(named[0]).toMatchObject({ respond: true, reason: 'named' });
    const request = model.requests[0]!;
    expect(request.message).toBe('ユウ: シャノン、いまマイクラで何してるの？');
    const prompt = promptOf(request);
    expect(prompt).toContain('いま話しかけているのは「ユウ」');
    expect(prompt).toContain('- ユウ: 昨日のボスまじでやばかった');
    // A friend may ask for her body too (2026-11-21): the intent field is offered.
    expect(prompt).toContain('ユウがマイクラでしてほしいこと');
    expect(request.offerMinecraftIntent).toBe(true);
    expect(peopleStore).toBeDefined();
    await close();
  });

  it('names no filler unless the switch is turned on (owner 2026-10-21: the recorded fillers are the old voice); on, one for words that take time', async () => {
    const byDefault = harness({ SHANNON_DC_VOICE: 'on' });
    const none = await byDefault.say('マイクラのエンドラってどうやって倒すのがいいと思う？');
    expect((none[0] as Extract<VoiceTurnLine, { type: 'decision' }>).filler).toBeNull();
    await byDefault.close();
    const withFiller = harness({ SHANNON_DC_VOICE: 'on', SHANNON_DC_VOICE_FILLER: 'on' });
    const lines = await withFiller.say('マイクラのエンドラってどうやって倒すのがいいと思う？');
    const decision = lines[0] as Extract<VoiceTurnLine, { type: 'decision' }>;
    expect(decision.filler).not.toBeNull();
    expect(promptOf(withFiller.model.requests[0]!)).toContain(`「${decision.filler!.text}」と声に出している`);
    await withFiller.close();
    const short = harness({ SHANNON_DC_VOICE: 'on', SHANNON_DC_VOICE_FILLER: 'on' });
    expect(((await short.say('おはよう')) [0] as Extract<VoiceTurnLine, { type: 'decision' }>).filler).toBeNull();
    await short.close();
  });

  it('replays a retried request without a second model call, and refuses a changed one', async () => {
    const { service, model, now, refusal, close } = harness();
    const body = { platform: 'discord', requestId: 'same', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんばんは', observedAt: now(), participants: [OWNER] };
    const first: VoiceTurnLine[] = [];
    await service.turn(body, line => first.push(line));
    const again: VoiceTurnLine[] = [];
    await service.turn(body, line => again.push(line));
    expect(model.requests).toHaveLength(1);
    expect(again.at(-1)).toMatchObject({ type: 'done', duplicate: true });
    expect(sentences(again).map(line => line.text).join('')).toBe(sentences(first).map(line => line.text).join(''));
    expect(await refusal(service.turn({ ...body, userMessage: '別の言葉' }, () => undefined))).toBe('409 PLATFORM_TURN_CONFLICT');
    // Two at once with the same id: one model call.
    const racing = { ...body, requestId: 'race' };
    await Promise.all([service.turn(racing, () => undefined), service.turn(racing, () => undefined)]);
    expect(model.requests).toHaveLength(2);
    await close();
  });

  it('refuses what is not a fresh, bound, well-formed spoken turn before any line', async () => {
    const { service, refusal, now, advance, close } = harness();
    const ok = { platform: 'discord', requestId: 'r', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんにちは', observedAt: now() };
    expect(await refusal(service.turn({ ...ok, platform: 'line' }, () => undefined))).toBe('400 BAD_REQUEST');
    expect(await refusal(service.turn({ ...ok, extra: 1 }, () => undefined))).toBe('400 BAD_REQUEST');
    expect(await refusal(service.turn({ ...ok, userMessage: ' ' }, () => undefined))).toBe('400 BAD_REQUEST');
    expect(await refusal(service.turn({ ...ok, participants: 'x' }, () => undefined))).toBe('400 BAD_REQUEST');
    expect(await refusal(service.turn({ ...ok, conversationId: 'discord:999:1' }, () => undefined))).toBe('403 PLATFORM_CONVERSATION_DENIED');
    advance(3 * 60_000);
    expect(await refusal(service.turn({ ...ok, requestId: 'old' }, () => undefined))).toBe('400 BAD_REQUEST');
    expect(() => validatedVoiceTurn(null)).toThrow();
    await close();
  });

  it('counts a person\'s turns apart from the owner\'s and refuses the one past the minute', async () => {
    const { say, refusal, close } = harness();
    const named = (n: number) => say(`シャノン、${n}番目の質問だよ？`, { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    for (let n = 1; n <= PLATFORM_VOICE_ALLOWANCE.speakerPerMinute; n += 1) await named(n);
    expect(await refusal(named(99))).toBe('429 RATE_LIMITED');
    expect((await say('ライ氏からの質問だよ？')).at(-1)).toMatchObject({ type: 'done' });
    await close();
  });

  it('says a failure after the first line as an error line, and nothing before it', async () => {
    const { service, model, now, refusal, close } = harness();
    model.generateStreaming = async () => { throw new Error('boom'); };
    const lines: VoiceTurnLine[] = [];
    await service.turn({ platform: 'discord', requestId: 'f', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんにちは', observedAt: now() }, line => lines.push(line));
    expect(typeOf(lines)).toEqual(['decision', 'error']);
    expect(lines[1]).toMatchObject({ status: 502, error: 'MODEL_UNAVAILABLE' });
    expect(await refusal(service.turn({ platform: 'discord', requestId: 'g', conversationId: ROOM, sourceUserId: FRIEND, userMessage: 'こんにちは', observedAt: now() }, () => undefined))).toBe('400 BAD_REQUEST');
    await close();
  });
});

describe('what the turn is told besides the words', () => {
  it('sends her first words while the model is still writing, with others in the channel too', async () => {
    const { service, model, now, close } = harness();
    model.reply = 'えっと、いまは鉄を探してるところだよ、洞窟の奥まで来たからもう少しかな。';
    let release!: () => void;
    model.pause = { after: 30, until: new Promise<void>(resolve => { release = resolve; }) };
    const lines: VoiceTurnLine[] = [];
    const turn = service.turn({ platform: 'discord', requestId: 'early', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
      userMessage: 'いまどんな感じ？', observedAt: now(), participants: [OWNER, FRIEND] }, line => lines.push(line));
    const startedAt = Date.now();
    while (!lines.some(line => line.type === 'sentence') && Date.now() - startedAt < 2_000) await new Promise(resolve => setTimeout(resolve, 5));
    expect(lines.some(line => line.type === 'sentence')).toBe(true);
    expect(lines.some(line => line.type === 'done')).toBe(false);
    release();
    await turn;
    expect(lines.at(-1)).toMatchObject({ type: 'done' });
    expect(sentences(lines).map(line => line.text).join('')).toBe(model.reply);
    await close();
  });

  it('goes on from the filler the body began, and ignores one it does not know', async () => {
    const { say, model, close } = harness();
    const begun = await say('マイクラのエンドラってどうやって倒すのがいいと思う？', { fillerId: 'sou' });
    expect(begun[0]).toMatchObject({ type: 'decision', filler: { id: 'sou', text: 'そうだねぇ。' } });
    expect(promptOf(model.requests[0]!)).toContain('「そうだねぇ。」と声に出している');
    const unknown = await say('マイクラのエンドラってどうやって倒すのがいいと思う？', { fillerId: 'nothing-like-it' });
    expect((unknown[0] as Extract<VoiceTurnLine, { type: 'decision' }>).filler?.id).not.toBe('nothing-like-it');
    await close();
  });

  it('adds what the body is doing and the request under way to every reply', async () => {
    const { service, say, model, body, close } = harness();
    body.running = { id: 'task-1', goal: 'エンダードラゴンを倒す' };
    service.rooms.setSituation('default', '洞窟を下りている。体力 14/20。');
    await say('シャノン、いま何してる？', { participants: [OWNER, FRIEND] });
    let prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('洞窟を下りている。体力 14/20。');
    expect(prompt).toContain('「エンダードラゴンを倒す」をしている');
    await say('シャノン、いま何してるの？', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    prompt = promptOf(model.requests[1]!);
    expect(prompt).toContain('洞窟を下りている。体力 14/20。');
    // Anyone's request may be the one under way (2026-11-21), so the friend is told it too.
    expect(prompt).toContain('「エンダードラゴンを倒す」をしている');
    await say('シャノン、今の様子は？', { participants: [OWNER, FRIEND], situation: '鉄の鉱石の前にいる。' });
    expect(promptOf(model.requests[2]!)).toContain('鉄の鉱石の前にいる。');
    expect(promptOf(model.requests[2]!)).not.toContain('洞窟を下りている');
    await close();
  });
});
describe('the owner\'s spoken request for her Minecraft body', () => {
  it('is offered the intent field to anyone with the body connected, and a friend\'s request moves it as the owner\'s does', async () => {
    const { say, model, body, close } = harness();
    const together = { participants: [OWNER, FRIEND] };
    body.running = { id: 'task-1', goal: 'エンダードラゴンを倒す' };
    model.reply = 'わかった、伝えておくね。';
    model.intent = { kind: 'task', goal: 'まず鉄の剣を作ってから向かって' };
    const lines = await say('シャノン、先に鉄の剣を作ってからにして', together);
    const request = model.requests[0]!;
    expect(request.offerMinecraftIntent).toBe(true);
    const prompt = promptOf(request);
    expect(prompt).toContain('エンダードラゴンを倒す');
    expect(prompt).toContain('いまの作業への伝言');
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({ scopeKey: 'owner', speaker: { id: OWNER, name: 'ライ氏', owner: true }, intent: { kind: 'task', goal: 'まず鉄の剣を作ってから向かって' } });
    expect(body.calls[0]!.experienceId).toBeTruthy();
    expect(lines.find(line => line.type === 'intent')).toMatchObject({ kind: 'task_message', delivered: true, taskId: 'task-1' });
    // A friend asks for the same: the field is offered, and the request is delivered with their name, on a record of their own words.
    model.requests.length = 0; body.calls.length = 0;
    model.intent = { kind: 'task', goal: 'ダイヤを掘ってくる' };
    await say('シャノン、体を動かしてダイヤを掘ってきて', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(model.requests[0]!.offerMinecraftIntent).toBe(true);
    expect(promptOf(model.requests[0]!)).toContain('ユウが言うこと');
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({ scopeKey: 'owner', speaker: { id: FRIEND, name: 'ユウ', owner: false }, intent: { kind: 'task', goal: 'ダイヤを掘ってくる' } });
    expect(body.calls[0]!.experienceId).toBeTruthy();
    await close();
  });

  it('says the fixed words of a refusal after a reply that promised, keeps them, and offers nothing when the body is not there', async () => {
    const { say, model, body, store, background, close } = harness();
    model.reply = 'うん、やっておくね。';
    model.intent = { kind: 'task', goal: '鉄を16個集める' };
    body.outcome = { delivered: false, reason: 'turn_not_visible' };
    const lines = await say('シャノン、鉄を16個集めておいて', { participants: [OWNER, FRIEND] });
    const last = sentences(lines).at(-1)!;
    expect(last).toMatchObject({ correction: true, text: VOICE_MINECRAFT_REFUSALS.turn_not_visible });
    expect(lines.find(line => line.type === 'intent')).toMatchObject({ delivered: false, reason: 'turn_not_visible' });
    await background.waitForIdle('owner');
    expect(store.conversationHistory('owner', roomThread).map(message => message.content)).toContain(VOICE_MINECRAFT_REFUSALS.turn_not_visible);
    body.connected = false; body.calls.length = 0; model.requests.length = 0;
    await say('シャノン、もう一回お願い', { participants: [OWNER, FRIEND] });
    expect(model.requests[0]!.offerMinecraftIntent).toBeUndefined();
    expect(promptOf(model.requests[0]!)).toContain('マイクラの体がいまつながっていない');
    expect(body.calls).toHaveLength(0);
    await close();
  });

  it('allows a new task with others in the channel too, and leaves the owner alone in his own room to her ordinary tools', async () => {
    const { say, model, body, close } = harness();
    model.reply = 'わかった、行ってくるね。';
    model.intent = { kind: 'task', goal: 'パンを3個作る' };
    // Alone in a shared server channel: the field is offered, and a new task may be made.
    await say('パンを3個作って', { conversationId: SERVER_ROOM, participants: [OWNER] });
    expect(body.calls[0]).toMatchObject({ intent: { kind: 'task' } });
    model.requests.length = 0; body.calls.length = 0;
    await say('シャノン、パンを3個作って', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND, OTHER] });
    expect(body.calls[0]).toMatchObject({ intent: { kind: 'task' }, speaker: { owner: true } });
    // Alone in his own room: tools, not the field.
    model.requests.length = 0; body.calls.length = 0;
    await say('パンを3個作って', { participants: [OWNER] });
    expect(model.requests[0]!.offerMinecraftIntent).toBeUndefined();
    expect(body.calls).toHaveLength(0);
    await close();
  });

  it('leaves the body alone when the switch is off', async () => {
    const { say, model, body, close } = harness({ SHANNON_DC_VOICE: 'on', SHANNON_DC_VOICE_MINECRAFT: 'off' });
    model.intent = { kind: 'task', goal: 'パンを3個作る' };
    await say('パンを3個作って', { conversationId: SERVER_ROOM, participants: [OWNER] });
    expect(model.requests[0]!.offerMinecraftIntent).toBeUndefined();
    expect(body.calls).toHaveLength(0);
    await close();
  });
});

describe('what she said by herself, and what the mouth has put into words', () => {
  it('keeps her own line, and what was heard of a reply that was talked over, in the conversation her next turn replays', async () => {
    const { service, say, model, store, now, refusal, close } = harness();
    service.said({ conversationId: ROOM, text: 'ダイヤ見つけた！', source: 'mouth', at: now() });
    service.said({ conversationId: ROOM, text: 'ダイヤ見つけた！', source: 'mouth', at: now() });
    service.said({ conversationId: ROOM, text: 'さっきの長い返事', source: 'reply', at: now(), interrupted: true, spokenText: 'えっと、それはね、' });
    const notes = store.conversationHistory('owner', roomThread).map(message => message.content);
    expect(notes.filter(note => note === 'ダイヤ見つけた！')).toHaveLength(1);
    expect(notes.some(note => note.includes('「えっと、それはね、」までしか言えなかった'))).toBe(true);
    await say('今なんて言った？');
    expect(JSON.stringify(model.requests[0]!.history)).toContain('ダイヤ見つけた！');
    expect(await refusal(Promise.resolve().then(() => service.said({ conversationId: 'discord:999:1', text: 'x', source: 'mouth', at: now() })))).toBe('403 PLATFORM_CONVERSATION_DENIED');
    expect(await refusal(Promise.resolve().then(() => service.said({ conversationId: ROOM, text: 'x', source: 'other', at: now() })))).toBe('400 BAD_REQUEST');
    await close();
  });

  it('puts event facts into her words, or says nothing when there is nothing to say', async () => {
    const { service, model, refusal, close } = harness();
    model.reply = 'ダイヤ、見つけたよ！';
    const said = await service.wording({ conversationId: ROOM, facts: ['ダイヤモンドの鉱石を見つけた'], source: 'minecraft:milestone' });
    expect(said).toEqual({ say: true, text: 'ダイヤ、見つけたよ！' });
    expect(promptOf(model.requests[0]!)).toContain('その一言だけを書く');
    expect(model.requests[0]!.message).toContain('- ダイヤモンドの鉱石を見つけた');
    model.reply = '（なし）';
    expect(await service.wording({ conversationId: ROOM, facts: ['歩いている'], source: 'minecraft:walk' })).toEqual({ say: false });
    expect(await refusal(service.wording({ conversationId: ROOM, facts: [], source: 'x' }))).toBe('400 BAD_REQUEST');
    expect(await refusal(service.wording({ conversationId: 'discord:999:1', facts: ['a'], source: 'x' }))).toBe('403 PLATFORM_CONVERSATION_DENIED');
    await close();
  });
});

describe('/v1/platform/voice/*', () => {
  async function serve(environment: Record<string, string>, extra: Partial<PlatformVoiceRoutes> = {}) {
    const h = harness(environment);
    const configuration = configuredPlatformBridge(BRIDGE)!;
    const routes: PlatformVoiceRoutes = {
      service: h.service, mouth: new VoiceMouthQueue(), speech: null, scopeKey: 'owner', environment: () => environment, ...extra,
    };
    const dependencies = { configuration, chatModel: h.model, service: h.bridge, voice: routes } as unknown as PlatformBridgeRouteDependencies;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      void handlePlatformBridgeRequest(path, request, response, dependencies);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const base = `http://127.0.0.1:${address.port}/v1/platform/voice`;
    const call = (name: string, body?: unknown, token: string | null = TOKEN) => fetch(`${base}/${name}`, {
      method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { ...h, routes, call };
  }

  it('is a platform bridge path, needs the token, and answers 503 while the switch is off', async () => {
    expect(isPlatformBridgePath('/v1/platform/voice/turn')).toBe(true);
    expect(platformVoiceEnabled({})).toBe(false);
    expect(platformVoiceEnabled({ SHANNON_DC_VOICE: 'on' })).toBe(true);
    const off = await serve({});
    expect((await off.call('fillers', undefined, null)).status).toBe(401);
    expect((await off.call('fillers', undefined, 'x'.repeat(40))).status).toBe(401);
    const disabled = await off.call('fillers');
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: 'PLATFORM_VOICE_DISABLED' });
    expect((await off.call('say', { text: 'a', source: 's' })).status).toBe(503);
    await off.close();
    const on = await serve({ SHANNON_DC_VOICE: 'on' });
    expect((await on.call('unknown', {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${(servers[1]!.address() as { port: number }).port}/v1/platform/voice/turn`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    await on.close();
  });

  it('lists the fillers, streams a turn as NDJSON, and refuses a bad one with JSON', async () => {
    const h = await serve({ SHANNON_DC_VOICE: 'on' });
    const fillers = await (await h.call('fillers')).json() as { items: Array<{ id: string; text: string }> };
    expect(fillers.items.length).toBeGreaterThanOrEqual(8);
    expect(fillers.items.find(item => item.id === 'un')?.text).toBe('うん。');
    h.model.reply = 'うん、そうだね。';
    const response = await h.call('turn', { platform: 'discord', requestId: 'http-1', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんにちは', observedAt: h.now() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as VoiceTurnLine);
    expect(typeOf(lines)).toEqual(['decision', 'sentence', 'done']);
    const bad = await h.call('turn', { platform: 'discord' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'BAD_REQUEST' });
    const malformed = await fetch(`http://127.0.0.1:${(servers[0]!.address() as { port: number }).port}/v1/platform/voice/turn`, { method: 'POST', body: '{', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(malformed.status).toBe(400);
    await h.close();
  });

  it('streams her voice as raw PCM with the first-chunk time, and says 503 or 400 before any audio', async () => {
    const chunks = [new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0, 4, 0])];
    let asked: { text: string; style?: string } | null = null;
    const speech = {
      async stream(request: { text: string; style?: string }) {
        asked = request;
        return { contentType: 'audio/l16', sampleRate: 24_000, channels: 1, bitsPerSample: 16, model: 'fake', voice: 'v', outputUsdPerTenSeconds: 0,
          chunks: (async function* () { for (const chunk of chunks) yield chunk; })() };
      },
    };
    const h = await serve({ SHANNON_DC_VOICE: 'on' }, { speech: speech as never });
    const ok = await h.call('speech', { text: 'ダイヤ見つけた！', style: '[excited]' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/l16;rate=24000;channels=1');
    expect(ok.headers.get('x-shannon-first-chunk-ms')).toMatch(/^\d+$/);
    expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
    expect(asked).toMatchObject({ text: 'ダイヤ見つけた！', style: '[excited]' });
    expect((await h.call('speech', { text: '' })).status).toBe(400);
    expect((await h.call('speech', { text: 'あ'.repeat(401) })).status).toBe(400);
    expect((await h.call('speech', { text: 'a', style: 'bad' })).status).toBe(400);
    const none = await serve({ SHANNON_DC_VOICE: 'on' });
    const unavailable = await none.call('speech', { text: 'こんにちは' });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: 'ELEVEN_SPEECH_NOT_CONFIGURED' });
    await h.close();
    await none.close();
  });

  it('carries her mouth: say, a long poll that takes it, and the body\'s result', async () => {
    const h = await serve({ SHANNON_DC_VOICE: 'on' });
    const refused = await h.call('say', { text: 'だれもいない', source: 's' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ accepted: false, reason: 'body_offline' });
    const poll = h.call('mouth/poll', { waitMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    const said = await h.call('say', { text: '鉄が足りない', source: 'minecraft:inventory', priority: 'low' });
    expect(said.status).toBe(202);
    const { id } = await said.json() as { id: string };
    const taken = await (await poll).json() as { items: Array<{ id: string; text: string; priority: string }> };
    expect(taken.items).toMatchObject([{ id, text: '鉄が足りない', priority: 'low' }]);
    expect((await h.call('say', { source: 's' })).status).toBe(400);
    expect((await h.call('mouth/result', { id, status: 'spoken' })).status).toBe(204);
    expect(h.routes.mouth.status(id)).toBe('spoken');
    expect((await h.call('mouth/result', { id, status: 'nonsense' })).status).toBe(400);
    const off = await serve({ SHANNON_DC_VOICE: 'on', SHANNON_DC_VOICE_MOUTH: 'off' });
    expect((await off.call('say', { text: 'a', source: 's' })).status).toBe(503);
    expect((await off.call('fillers')).status).toBe(200);
    await h.close();
    await off.close();
  });

  it('composes the route from the environment: nothing while the switch is off at boot, the whole set when it is on', async () => {
    const h = harness();
    const replies = { conversation: h.api, databasePath: h.path };
    const off = createConfiguredPlatformBridgeRoute(BRIDGE, h.store, h.store, h.background, h.now, h.model, null, replies)!;
    expect(off.voice).toBeNull();
    const on = createConfiguredPlatformBridgeRoute(ON, h.store, h.store, h.background, h.now, h.model, null, replies, null, null)!;
    expect(on.voice?.service).toBeInstanceOf(PlatformVoiceService);
    expect(on.voice?.speech).toBeNull();
    on.close?.();
    await h.close();
  });
});

describe('her Minecraft body\'s present in a voice reply (dc-live, SHANNON_MINECRAFT_LIVE)', () => {
  const reader = (marks: string[]): LiveReader => ({
    block: ({ alone, participants }) => `[マイクラの体の今]\n${alone || participants ? 'エンドラを倒す作業の最中' : '頼まれた作業の最中'}`,
    replying: on => { marks.push(on ? 'on' : 'off'); },
    heard: () => { marks.push('heard'); },
  });

  it('is in the prompt of a channel turn with the request told to everyone on the call (they may all ask), and in the owner\'s own room', async () => {
    const marks: string[] = [];
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' }, reader(marks));
    await say('シャノン、いま何してる？', { participants: [OWNER, FRIEND] });
    expect(promptOf(model.requests[0]!)).toContain('エンドラを倒す作業の最中');
    expect(promptOf(model.requests[0]!)).not.toContain('頼まれた作業の最中');
    await say('いま何してるの？', { participants: [OWNER] });
    expect(promptOf(model.requests[1]!)).toContain('エンドラを倒す作業の最中');
    expect(marks).toEqual(['heard', 'on', 'off', 'heard', 'on', 'off']);
    await close();
  });

  it('is in the app\'s live voice reply too, marked begun and ended', async () => {
    const marks: string[] = [];
    const { api, model, close } = harness({ SHANNON_DC_VOICE: 'on' }, reader(marks));
    const result = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: 'いまマイクラどうなってる？' } });
    expect(result.status).toBe(200);
    expect(promptOf(model.requests.at(-1)!)).toContain('エンドラを倒す作業の最中');
    expect(marks).toEqual(['heard', 'on', 'off']);
    await close();
  });

  it('adds nothing without the reader', async () => {
    const { api, model, close } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: 'いまマイクラどうなってる？' } });
    expect(promptOf(model.requests.at(-1)!)).not.toContain('[マイクラの体の今]');
    await close();
  });
});

/** 「話しかけられたか」 (owner 2026-10-21, `SHANNON_ADDRESSED`): the voice channel answers words said to her by name and the same person's follow-up. */
describe('SHANNON_ADDRESSED: answering only what is said to her', () => {
  const ADDRESSED = { SHANNON_DC_VOICE: 'on', SHANNON_ADDRESSED: 'on' };

  /**
   * A Jev that says "not to her" for talk about her (「ってさ」) and "to her" for everything else it is asked; for words without her name
   * outside her window (asked only with the owner alone, since 2026-10-26), "to her" only for a question or a request.
   */
  function judge() {
    const asked: string[] = [];
    const chooser = {
      decide: async (request: { state: unknown }) => {
        const state = request.state as { utterance: string; name_in_utterance?: string; follows_her_last_words?: boolean };
        asked.push(state.utterance);
        if (state.name_in_utterance === 'none' && state.follows_her_last_words !== true) {
          const asks = /[?？]|教えて|わかる/u.test(state.utterance);
          return { value: { addressed: asks, target: asks ? 'shannon' : 'self', noul: asks ? 0.9 : 0.1, reason: asks ? 'asked_alone' : 'no_name' }, source: 'jev' as const };
        }
        const about = /ってさ|だって/u.test(state.utterance);
        return { value: { addressed: !about, target: about ? 'about_shannon' : 'shannon', noul: about ? 0.05 : 0.95, reason: about ? 'about_her' : /シャノン/u.test(state.utterance) ? 'named' : 'continuation' }, source: 'jev' as const };
      },
    } as unknown as Pick<JevChooser, 'decide'>;
    return { asked, judge: new AddressedJudge({ chooser }) };
  }

  it('with the owner alone asks Jev about words without her name and answers only a question or a request (2026-10-26)', async () => {
    const { asked, judge: j } = judge();
    const { say, model, close } = harness(ADDRESSED, undefined, j);
    const lines = await say('あー疲れた、今日は早く寝よう');
    expect(typeOf(lines)).toEqual(['decision', 'done']);
    expect(lines[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(lines[1]).toMatchObject({ silent: true, reason: 'no_name' });
    expect(model.requests).toHaveLength(0);
    const asks = await say('明日の天気わかる？');
    expect(asks[0]).toMatchObject({ respond: true, reason: 'asked_alone' });
    expect(model.requests).toHaveLength(1);
    expect(asked).toEqual(['あー疲れた、今日は早く寝よう', '明日の天気わかる？']);
    await close();
  });

  it('stays quiet for words that do not call her in a room of several, and asks nobody', async () => {
    const { asked, judge: j } = judge();
    const { say, model, close } = harness(ADDRESSED, undefined, j);
    const lines = await say('明日の天気わかる？', { participants: [OWNER, FRIEND] });
    expect(lines[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(model.requests).toHaveLength(0);
    expect(asked).toEqual([]);
    await close();
  });

  it('answers a call by name, asks Jev once, and stays quiet when the name is only talked about', async () => {
    const { asked, judge: j } = judge();
    const { say, model, close } = harness(ADDRESSED, undefined, j);
    const called = await say('シャノン、今日の予定を教えて');
    expect(called[0]).toMatchObject({ type: 'decision', respond: true, reason: 'named' });
    expect(model.requests).toHaveLength(1);
    const talked = await say('シャノンってさ、昨日エンドラの前で死んだんだって', { participants: [OWNER, FRIEND] });
    expect(talked[0]).toMatchObject({ respond: false, reason: 'about_her' });
    expect(model.requests).toHaveLength(1);
    expect(asked).toEqual(['シャノン、今日の予定を教えて', 'シャノンってさ、昨日エンドラの前で死んだんだって']);
    await close();
  });

  it('answers the same person\'s follow-up within about twenty seconds of her reply, and not after', async () => {
    const { asked, judge: j } = judge();
    const { say, model, advance, close } = harness(ADDRESSED, undefined, j);
    await say('シャノン、今日の予定を教えて');
    advance(5_000);
    const follow = await say('それってどういう意味？');
    expect(follow[0]).toMatchObject({ respond: true, reason: 'continuation' });
    expect(model.requests).toHaveLength(2);
    advance(40_000);
    // After the window, in a room of several (with the owner alone it would be asked of Jev as words without her name).
    const late = await say('それってどういう意味？', { participants: [OWNER, FRIEND] });
    expect(late[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(model.requests).toHaveLength(2);
    expect(asked).toEqual(['シャノン、今日の予定を教えて', 'それってどういう意味？']);
    await close();
  });

  it('does not take a friend\'s words after her reply to the owner as a follow-up, and answers the friend who calls her', async () => {
    const { asked, judge: j } = judge();
    const { say, model, close } = harness(ADDRESSED, undefined, j);
    const together = { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND] };
    await say('シャノン、今日の予定を教えて', together);
    const friend = await say('ところでそっちの仕事はどう？', { ...together, sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(friend[0]).toMatchObject({ respond: false, reason: 'no_name' });
    const named = await say('シャノン、俺にも教えて', { ...together, sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(named[0]).toMatchObject({ respond: true, reason: 'named' });
    expect(model.requests).toHaveLength(2);
    expect(asked).toHaveLength(2);
    await close();
  });

  it('直前の発話時刻を使い、Jevで判定できなければ応答しない', async () => {
    const { asked, judge: j } = judge();
    const { say, close } = harness(ADDRESSED, undefined, j);
    expect((await say('それってどういう意味？', { shannonSpokeMsAgo: 3_000 }))[0]).toMatchObject({ respond: true, reason: 'continuation' });
    expect((await say('それってどういう意味？', { shannonSpokeMsAgo: 30_000, participants: [OWNER, FRIEND] }))[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(asked).toHaveLength(1);
    await close();
    const silent = harness(ADDRESSED, undefined, new AddressedJudge({ chooser: null }));
    expect((await silent.say('シャノン、今日の予定を教えて'))[0]).toMatchObject({ respond: false, reason: 'unconfirmed' });
    expect((await silent.say('昨日シャノンがさ、変なこと言っててさ', { participants: [OWNER, FRIEND] }))[0]).toMatchObject({ respond: false, reason: 'unconfirmed' });
    await silent.close();
  });

  it('hears 止めて without her name from the owner while she speaks or her body works, and from anyone while her body works', async () => {
    const { asked, judge: j } = judge();
    const { say, body, model, close } = harness(ADDRESSED, undefined, j);
    expect((await say('止めて'))[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect((await say('止めて', { speakingNow: true }))[0]).toMatchObject({ respond: true, reason: 'stop' });
    expect((await say('止めて', { shannonSpokeMsAgo: 0 }))[0]).toMatchObject({ respond: true, reason: 'stop' });
    body.running = { id: 'task-1', goal: '鉄を掘る' };
    expect((await say('ちょっと待って'))[0]).toMatchObject({ respond: true, reason: 'stop' });
    // A friend's 止めて is heard too while her body works (2026-11-21), since a friend's stop reaches the body as the owner's does.
    const friend = await say('止めて', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(friend[0]).toMatchObject({ respond: true, reason: 'stop' });
    // Everyday 待って between friends is not a stop for a guest (only the plain stop words are).
    const chat = await say('ちょっと待って', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(chat[0]).not.toMatchObject({ reason: 'stop' });
    // With her body idle a friend's 止めて is judged like any other words (here she was speaking, so Jev is asked).
    body.running = null;
    const idle = await say('止めて', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ', speakingNow: true });
    expect(idle[0]).not.toMatchObject({ reason: 'stop' });
    // The first 止めて (the owner alone, she was not speaking), the guest's 待って and the idle friend's 止めて were each asked as words without her name.
    expect(asked).toEqual(['止めて', 'ちょっと待って', '止めて']);
    expect(model.requests.length).toBeGreaterThanOrEqual(3);
    await close();
  });

  it('is the shared-table rules as before with the switch off, and refuses a bad time', async () => {
    const { asked, judge: j } = judge();
    const off = harness({ SHANNON_DC_VOICE: 'on' }, undefined, j);
    expect((await off.say('あー疲れた、今日は早く寝よう'))[0]).toMatchObject({ respond: true, reason: 'solo' });
    expect(asked).toEqual([]);
    expect(await off.refusal(off.service.turn({
      platform: 'discord', requestId: 'bad-1', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんにちは', observedAt: off.now(),
      participants: [OWNER], shannonSpokeMsAgo: -1,
    }, () => undefined))).toBe('400 BAD_REQUEST');
    await off.close();
  });
});

/**
 * Talk while she works on a request in the game, and the answer to a question she asked herself (2026-11-22): the words of a call of three, through
 * the voice turn, with a Jev that says "to her" for what is about the job and "to someone else" for the people's own chat.
 */
describe('SHANNON_ADDRESSED: a call while she works, and the answer to her own question', () => {
  const ADDRESSED = { SHANNON_DC_VOICE: 'on', SHANNON_ADDRESSED: 'on' };
  const together = { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND, OTHER], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' };
  const CAKE = { id: 'task-1', goal: 'ケーキを1個作る' };

  function workJudge() {
    const asked: Array<{ utterance: string; working: unknown }> = [];
    const chooser = {
      decide: async (request: { state: unknown; parse: (answers: Record<string, unknown>) => unknown }) => {
        const state = request.state as { utterance: string; shannon_is_working_in_minecraft?: boolean; shannon_last_line_was_a_question?: boolean; name_in_utterance: string };
        asked.push({ utterance: state.utterance, working: state.shannon_is_working_in_minecraft });
        const aboutJob = /骨粉|作って|置いて|どこまで|いま何/u.test(state.utterance);
        // The answer to her own question (the first of its words that fit a place or a yes), asked only while the question waits.
        const replies = state.shannon_last_line_was_a_question === true && /置いて|そこ|ここ|うん|オーク/u.test(state.utterance);
        const answers = { addressed_to_shannon: { type: 'noul', noul: aboutJob ? 0.93 : 0.05 }, target: { type: 'choice', choice: aboutJob ? 'shannon' : 'other_person' },
          about_the_job: { type: 'noul', noul: aboutJob ? 0.93 : 0.05 }, answers_her_question: { type: 'noul', noul: replies ? 0.93 : 0.05 }, reply_needed: { type: 'noul', noul: aboutJob ? 0.95 : 0.05 } };
        return { value: request.parse(answers), source: 'jev' as const };
      },
    } as unknown as Pick<JevChooser, 'decide'>;
    return { asked, judge: new AddressedJudge({ chooser }) };
  }

  it('answers a nameless suggestion about the job in a call of three, and stays quiet for the people\'s own chat', async () => {
    const { asked, judge: j } = workJudge();
    const { say, model, body, close } = harness(ADDRESSED, undefined, j);
    body.running = CAKE;
    model.reply = 'いいね、やってみるね。';
    const suggestion = await say('小麦は骨粉で早く成長させよう', together);
    expect(suggestion[0]).toMatchObject({ type: 'decision', respond: true, reason: 'asked_while_working' });
    expect(model.requests).toHaveLength(1);
    // The reply is told what is going on and not to promise what is not settled.
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('「ケーキを1個作る」をしている');
    expect(prompt).toContain('やってみるね');
    const chat = await say('今夜のご飯なに食べる？', { ...together, sourceUserId: OTHER, sourceDisplayName: 'ミキ' });
    expect(chat[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(model.requests).toHaveLength(1);
    expect(asked).toEqual([{ utterance: '小麦は骨粉で早く成長させよう', working: true }, { utterance: '今夜のご飯なに食べる？', working: true }]);
    await close();
  });

  it('counts a request waiting on the list as work, and asks nobody when she is not at work (as before)', async () => {
    const { asked, judge: j } = workJudge();
    const { say, model, body, close } = harness(ADDRESSED, undefined, j);
    const idle = await say('ついでに松明も作って', together);
    expect(idle[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(asked).toEqual([]);
    body.queue = ['#2 待ち 「小麦を3個集める」（ユウ）'];
    const waiting = await say('先に小麦のほうを作って', together);
    expect(waiting[0]).toMatchObject({ respond: true, reason: 'asked_while_working' });
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('answers by name as before, while she works too', async () => {
    const { asked, judge: j } = workJudge();
    const { say, body, close } = harness(ADDRESSED, undefined, j);
    body.running = CAKE;
    const named = await say('シャノン、いま何してるの', together);
    expect(named[0]).toMatchObject({ respond: true, reason: 'named' });
    expect(asked).toHaveLength(1);
    await close();
  });

  it('takes the first nameless words after a question from her own mouth, from anyone, and not the ones after', async () => {
    const { asked, judge: j } = workJudge();
    const { say, service, model, body, advance, now, close } = harness(ADDRESSED, undefined, j);
    body.running = CAKE;
    // A line from her mouth (the cake is done): to the room, to nobody in particular.
    service.said({ conversationId: SERVER_ROOM, text: 'できた！どこに置けばいい？渡せばいいかな？', source: 'mouth', at: now() });
    advance(30_000);
    model.reply = 'うん、ここだね。';
    const answer = await say('このオークの木材ブロックの上に置いて', together);
    expect(answer[0]).toMatchObject({ respond: true, reason: 'answer_to_question' });
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[ボクがさっき聞いたこと]');
    expect(prompt).toContain('どこに置けばいい？');
    // Jev was asked whether the words answer her question (not a rule), and said yes. The next words are judged as ever (chat, with her reply as the last line, is not to her).
    expect(asked).toEqual([{ utterance: 'このオークの木材ブロックの上に置いて', working: true }]);
    advance(5_000);
    const chat = await say('今夜のご飯なに食べる？', { ...together, sourceUserId: OTHER, sourceDisplayName: 'ミキ' });
    expect(chat[0]).toMatchObject({ respond: false });
    await close();
  });

  it('does not take an answer that came too late', async () => {
    const { judge: j } = workJudge();
    const { say, service, model, advance, now, close } = harness(ADDRESSED, undefined, j);
    service.said({ conversationId: SERVER_ROOM, text: 'できた！どこに置けばいい？', source: 'mouth', at: now() });
    advance(60_000);
    const late = await say('このオークの木材ブロックの上に置いて', together);
    expect(late[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(model.requests).toHaveLength(0);
    await close();
  });

  it('takes the owner\'s answer to the question in her own reply to him, and not a friend\'s', async () => {
    const { judge: j } = workJudge();
    const { say, model, advance, close } = harness(ADDRESSED, undefined, j);
    model.reply = 'ケーキができたよ。どこに置けばいい？';
    await say('シャノン、ケーキはどこまで進んだ？', { ...together, sourceUserId: OWNER, sourceDisplayName: 'ライ氏' });
    advance(25_000);
    const friend = await say('ここがいいと思う', together);
    expect(friend[0]).toMatchObject({ respond: false, reason: 'no_name' });
    const owner = await say('そこの作業台の上に置いて', { ...together, sourceUserId: OWNER, sourceDisplayName: 'ライ氏' });
    expect(owner[0]).toMatchObject({ respond: true, reason: 'answer_to_question' });
    await close();
  });

  it('does not take a thought she said aloud that ends 「…か」 as a question to the room', async () => {
    const { asked, judge: j } = workJudge();
    const { say, service, model, body, advance, now, close } = harness(ADDRESSED, undefined, j);
    body.running = CAKE;
    service.said({ conversationId: SERVER_ROOM, text: 'バケツがいるから鉄が必要か', source: 'mouth', at: now() });
    advance(10_000);
    const chat = await say('ユウ、お昼ごはんなに食べる？', { ...together, sourceUserId: OTHER, sourceDisplayName: 'ミキ' });
    expect(chat[0]).toMatchObject({ respond: false });
    expect(chat[0]).not.toMatchObject({ reason: 'answer_to_question' });
    expect(model.requests).toHaveLength(0);
    // The judge was asked instead of a rule answering.
    expect(asked).toHaveLength(1);
    await close();
  });

  it('keeps her question open through a thinking sound, and takes 「うん」 as the answer', async () => {
    const { asked, judge: j } = workJudge();
    const { say, service, model, advance, now, close } = harness(ADDRESSED, undefined, j);
    service.said({ conversationId: SERVER_ROOM, text: 'できた！ここに置けばいいかな？', source: 'mouth', at: now() });
    advance(30_000);
    const thinking = await say('うーん', together);
    expect(thinking[0]).toMatchObject({ respond: false, reason: 'fragment' });
    advance(3_000);
    model.reply = 'うん、置くね。';
    const answer = await say('うん', together);
    expect(answer[0]).toMatchObject({ respond: true, reason: 'answer_to_question' });
    expect(asked).toEqual([{ utterance: 'うん', working: undefined }]);
    await close();
  });

  it('does not take chat between the people inside the window as the answer, keeps her question open for the real one, and then closes it', async () => {
    const { asked, judge: j } = workJudge();
    const { say, service, model, advance, now, close } = harness(ADDRESSED, undefined, j);
    service.said({ conversationId: SERVER_ROOM, text: 'できた！どこに置けばいい？渡せばいいかな？', source: 'mouth', at: now() });
    advance(38_000);
    const chat = await say('今夜のご飯なに食べる？', { ...together, sourceUserId: OTHER, sourceDisplayName: 'ミキ' });
    expect(chat[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(model.requests).toHaveLength(0);
    advance(4_000);
    model.reply = 'うん、そこに置くね。';
    const answer = await say('そこの板の上に置いて', together);
    expect(answer[0]).toMatchObject({ respond: true, reason: 'answer_to_question' });
    expect(asked.map(line => line.utterance)).toEqual(['今夜のご飯なに食べる？', 'そこの板の上に置いて']);
    // Taken once: a later line is not read against her question again.
    advance(2_000);
    await say('そこの板の上に置いて', { ...together, sourceUserId: OTHER, sourceDisplayName: 'ミキ' });
    expect(asked).toHaveLength(2);
    await close();
  });

  it('takes the words as the answer when Jev does not answer in time (a lost answer costs more than a late chat line)', async () => {
    const chooser = { decide: async (request: { fallback: () => unknown }) => ({ value: request.fallback(), source: 'fallback' as const }) } as unknown as Pick<JevChooser, 'decide'>;
    const { say, service, model, advance, now, close } = harness(ADDRESSED, undefined, new AddressedJudge({ chooser }));
    service.said({ conversationId: SERVER_ROOM, text: 'できた！どこに置けばいい？', source: 'mouth', at: now() });
    advance(20_000);
    model.reply = 'うん、置くね。';
    const answer = await say('そこの板の上に置いて', together);
    expect(answer[0]).toMatchObject({ respond: true, reason: 'answer_to_question' });
    await close();
  });

  it('does not tell the judge about a question of hers that no longer waits', async () => {
    const states: Array<Record<string, unknown>> = [];
    const chooser = { decide: async (request: { state: unknown; parse: (answers: Record<string, unknown>) => unknown }) => {
      states.push(request.state as Record<string, unknown>);
      return { value: request.parse({ addressed_to_shannon: { type: 'noul', noul: 0.05 }, target: { type: 'choice', choice: 'other_person' }, about_the_job: { type: 'noul', noul: 0.05 }, reply_needed: { type: 'noul', noul: 0.05 } }), source: 'jev' as const };
    } } as unknown as Pick<JevChooser, 'decide'>;
    const { say, service, body, advance, now, close } = harness(ADDRESSED, undefined, new AddressedJudge({ chooser }));
    body.running = CAKE;
    service.said({ conversationId: SERVER_ROOM, text: 'できた！どこに置けばいい？', source: 'mouth', at: now() });
    advance(120_000);
    await say('そろそろ骨粉も作って', together);
    expect(states).toHaveLength(1);
    expect(states[0]).not.toHaveProperty('shannon_last_line_was_a_question');
    await close();
  });

  it('carries the speaker\'s Minecraft name to the request, and refuses a bad one', async () => {
    const { say, model, body, close, refusal, service, now } = harness({ SHANNON_DC_VOICE: 'on' });
    model.reply = 'いいよ、置くね。';
    model.intent = { kind: 'task', goal: 'ケーキをオークの木材の上に置く' };
    await say('シャノン、そこに置いて', { ...together, speakerMinecraftName: 'Yuu_1234' });
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]!.speaker).toMatchObject({ id: FRIEND, name: 'ユウ', owner: false, minecraftName: 'Yuu_1234' });
    await say('シャノン、これもお願い', together);
    expect(body.calls[1]!.speaker).not.toHaveProperty('minecraftName');
    expect(await refusal(service.turn({
      platform: 'discord', requestId: 'bad-mc', conversationId: ROOM, sourceUserId: OWNER, sourceDisplayName: 'ライ氏', userMessage: 'こんにちは',
      observedAt: now(), participants: [OWNER], speakerMinecraftName: 'a'.repeat(100),
    }, () => undefined))).toBe('400 BAD_REQUEST');
    await close();
  });

  it('tells a call of several what was asked in the body\'s present, which the old rule kept from them', async () => {
    const blocks: Array<{ alone: boolean; participants?: boolean }> = [];
    const live: LiveReader = {
      block: options => {
        blocks.push(options);
        return liveBlock({ frameAgeSeconds: 1, goal: 'ケーキを1個作る', goalIsRequest: true, elapsedSeconds: 60, doing: '', milestone: null, dimension: null, biome: null,
          time: '', health: 20, food: 20, threats: [], carried: [], map: '', furnace: null, recent: [], stuck: null,
          plan: { section: '小麦を育てる', points: ['種を植える', '骨粉で育てる'] } }, options);
      },
    };
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' }, live);
    await say('シャノン、いま何してるの', together);
    expect(blocks.at(-1)).toMatchObject({ alone: false, participants: true });
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('取り組んでいること: ケーキを1個作る（通話の誰かに頼まれた）');
    expect(prompt).toContain('計画の今の節: 小麦を育てる');
    await close();
  });
});

/**
 * Words said with the push-to-talk key held (`directed`) are to her: answered without her name, with or without `SHANNON_ADDRESSED`, from a
 * person the head knows only by their Minecraft account. Without the mark nothing is different from before.
 */
describe('directed: words said with the push-to-talk key held', () => {
  const ADDRESSED = { SHANNON_DC_VOICE: 'on', SHANNON_ADDRESSED: 'on' };
  const GUEST = 'mc:11111111-2222-3333-4444-555555555555';
  const call = { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' };
  /** A Jev that never hears the words as said to her; it counts how many times it is asked. */
  function deaf() {
    const asked: string[] = [];
    const chooser = { decide: async (request: { state: unknown }) => {
      asked.push((request.state as { utterance: string }).utterance);
      return { value: { addressed: false, target: 'other_person', noul: 0.05, reason: 'not_to_her' }, source: 'jev' as const };
    } } as unknown as Pick<JevChooser, 'decide'>;
    return { asked, judge: new AddressedJudge({ chooser }) };
  }

  it('answers a nameless sentence in a call of three without asking Jev, and answers it as it did when the mark is not there', async () => {
    const { asked, judge } = deaf();
    const { say, model, close } = harness(ADDRESSED, undefined, judge);
    const inWindow = { ...call, shannonSpokeMsAgo: 5_000 };
    const plain = await say('ここに置いておくね', inWindow);
    expect(plain[0]).toMatchObject({ respond: false });
    expect(asked).toHaveLength(1);
    const lines = await say('ここに置いておくね', { ...inWindow, directed: true });
    expect(lines[0]).toMatchObject({ type: 'decision', respond: true, reason: 'directed' });
    expect(typeOf(lines)).toContain('sentence');
    expect(lines.at(-1)).toMatchObject({ type: 'done', duplicate: false });
    // Not asked again, and she wrote one reply.
    expect(asked).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('answers also with the judge off (the shared-table rules would keep quiet for people talking to each other)', async () => {
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' });
    expect((await say('ここに置いておくね', call))[0]).toMatchObject({ respond: false });
    expect((await say('ここに置いておくね', { ...call, directed: true }))[0]).toMatchObject({ respond: true, reason: 'directed' });
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('is still no turn for a breath or a key press, and a bare 「うん」 counts only right after she spoke', async () => {
    const { judge } = deaf();
    const { say, model, close } = harness(ADDRESSED, undefined, judge);
    expect((await say('えー', { ...call, directed: true }))[0]).toMatchObject({ respond: false, reason: 'fragment' });
    expect((await say('うん', { ...call, directed: true }))[0]).toMatchObject({ respond: false, reason: 'fragment' });
    expect((await say('うん', { ...call, directed: true, shannonSpokeMsAgo: 3_000 }))[0]).toMatchObject({ respond: true, reason: 'directed' });
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('answers someone the head knows only by a Minecraft account (no Discord id), as a guest of the call', async () => {
    const { judge } = deaf();
    for (const environment of [ADDRESSED, { SHANNON_DC_VOICE: 'on' }]) {
      const { say, model, body, close } = harness(environment, undefined, judge);
      model.reply = 'いいよ、置くね。';
      const lines = await say('ケーキできたんだね、ここにお願い', { conversationId: SERVER_ROOM, participants: [OWNER, GUEST], sourceUserId: GUEST, sourceDisplayName: 'Yuu_1234', directed: true });
      expect(lines[0]).toMatchObject({ respond: true, reason: 'directed' });
      expect(sentences(lines).map(line => line.text).join('')).toContain('置くね');
      expect(body.calls).toHaveLength(0);
      await close();
    }
  });

  it('is a field of both wire forms; a mark that is not true or false is a 400 and a field it does not know still is', () => {
    const flat = { platform: 'discord', requestId: 'r1', conversationId: 'discord:1:2', sourceUserId: 'u1', sourceDisplayName: 'ユウ', userMessage: 'そこに置いて',
      observedAt: '2026-11-22T12:00:00.000Z', participants: ['u1'] };
    expect(validatedVoiceTurn({ ...flat, directed: true })).toMatchObject({ directed: true });
    expect(validatedVoiceTurn({ ...flat, directed: false })).toMatchObject({ directed: false });
    expect(validatedVoiceTurn(flat).directed).not.toBe(true);
    expect(() => validatedVoiceTurn({ ...flat, directed: 'yes' })).toThrow();
    expect(() => validatedVoiceTurn({ ...flat, directedBy: true })).toThrow();
    const one = (presence: Record<string, unknown>) => voiceRequestOf(validatedConversationTurn({ version: 1, requestId: 'c1', observedAt: '2026-11-22T12:00:00.000Z', modality: 'voice',
      where: { platform: 'discord', conversationId: 'discord:1:2', conversationKind: 'channel' },
      who: { userId: 'u1', displayName: 'ユウ' }, presence: { participants: ['u1'], ...presence }, words: 'そこに置いて' }));
    expect(one({ directed: true })).toMatchObject({ directed: true });
    expect(one({}).directed).not.toBe(true);
    expect(() => one({ directed: 'yes' })).toThrow();
  });

  it('does not change the hash a retry is matched by', () => {
    const base = { platform: 'discord', requestId: 'r1', conversationId: 'discord:1:2', sourceUserId: 'u1', sourceDisplayName: 'ユウ', userMessage: 'そこに置いて',
      observedAt: '2026-11-22T12:00:00.000Z', participants: ['u1'] };
    expect(voiceHash(validatedVoiceTurn({ ...base, directed: true }))).toBe(voiceHash(validatedVoiceTurn(base)));
  });
});

/**
 * Words said over her reply: the answer is written once the body has reported how far she got (`said`, cut short), for at most a second;
 * without the mark, or with no report, nothing waits longer than that.
 */
describe('words said over her reply wait for the report of how far she got', () => {
  const cut = { source: 'reply', interrupted: true, spokenText: 'えっと、それはね、', text: 'さっきの長い返事を全部言う予定だった' };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it('writes the answer from the conversation as it is after the report, not before it', async () => {
    const { say, model, service, now, store, close } = harness({ SHANNON_DC_VOICE: 'on' }, undefined, undefined, 2_000);
    const running = say('待って、それより先にこっちを見て', { speakingNow: true });
    await settle();
    expect(model.requests).toHaveLength(0);
    service.said({ conversationId: ROOM, at: now(), ...cut });
    const lines = await running;
    expect(lines[0]).toMatchObject({ type: 'decision', respond: true });
    expect(model.requests).toHaveLength(1);
    const kept = store.conversationHistory('owner', roomThread).map(message => message.content).join('\n');
    expect(kept).toContain('までしか言えなかった');
    await close();
  });

  it('goes on without a report after the wait, and does not wait at all for words not said over her', async () => {
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' }, undefined, undefined, 120);
    const quick = Date.now();
    await say('今日はいい天気だね');
    expect(Date.now() - quick).toBeLessThan(100);
    const before = Date.now();
    const lines = await say('ねえ、聞いてる？', { speakingNow: true });
    expect(Date.now() - before).toBeGreaterThanOrEqual(110);
    expect(lines.at(-1)).toMatchObject({ type: 'done' });
    expect(model.requests).toHaveLength(2);
    await close();
  });

  it('a report that came before these words is not the one waited for', async () => {
    const { say, service, now, close } = harness({ SHANNON_DC_VOICE: 'on' }, undefined, undefined, 120);
    service.said({ conversationId: ROOM, at: now(), ...cut });
    const before = Date.now();
    await say('ねえ、聞いてる？', { speakingNow: true });
    expect(Date.now() - before).toBeGreaterThanOrEqual(110);
    await close();
  });

  it('a report of another room is not the one waited for', async () => {
    const { say, service, now, close } = harness({ SHANNON_DC_VOICE: 'on' }, undefined, undefined, 150);
    const running = say('ねえ、聞いてる？', { speakingNow: true });
    await settle();
    service.said({ conversationId: SERVER_ROOM, at: now(), ...cut });
    const before = Date.now();
    await running;
    expect(Date.now() - before).toBeGreaterThanOrEqual(80);
    await close();
  });
});

/**
 * A person at the game's voice with no Discord id: the body checks that the account is the owner's and says so (`speakerIsOwner`), and the
 * words are the owner's. Without the mark an id the head does not know is a guest, as before.
 */
describe('speakerIsOwner: the owner at the game voice', () => {
  const MC = 'mc:11111111-2222-3333-4444-555555555555';
  const alone = { conversationId: ROOM, participants: [MC], sourceUserId: MC, sourceDisplayName: 'ライ' };
  const inServer = { ...alone, conversationId: SERVER_ROOM };

  it('is the owner and the only one there in his own room, also when his own id is in the list of people; others there make it shared', async () => {
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' });
    await say('今日はいい天気だね', { ...alone, speakerIsOwner: true });
    expect(promptOf(model.requests[0]!)).toContain('いま聞こえているのはライ');
    await say('そうだよね', { ...alone, participants: [MC, OWNER], speakerIsOwner: true });
    expect(promptOf(model.requests[1]!)).toContain('いま聞こえているのはライ');
    await say('ねえ聞いて', { ...alone, participants: [MC, FRIEND], speakerIsOwner: true });
    expect(promptOf(model.requests[2]!)).not.toContain('いま聞こえているのはライ');
    await say('もう一回', alone);
    expect(promptOf(model.requests[3]!)).not.toContain('いま聞こえているのはライ');
    await close();
  });

  it('sends his request to the body as the owner, under the id the conversation is bound to', async () => {
    const { say, model, body, close } = harness({ SHANNON_DC_VOICE: 'on' });
    model.reply = 'いいよ、作るね。';
    model.intent = { kind: 'task', goal: 'ケーキを作る' };
    await say('シャノン、ケーキを作って', { ...inServer, speakerIsOwner: true });
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]!.speaker).toMatchObject({ id: OWNER, name: 'ライ', owner: true });
    await close();
  });

  it('is a guest without the mark, and the mark must be true or false in both wire forms', async () => {
    const { say, model, body, close } = harness({ SHANNON_DC_VOICE: 'on' });
    model.intent = { kind: 'task', goal: 'ケーキを作る' };
    await say('シャノン、ケーキを作って', inServer);
    expect(body.calls[0]!.speaker).toMatchObject({ id: MC, owner: false });
    await close();
    const flat = { platform: 'discord', requestId: 'r1', conversationId: 'discord:1:2', sourceUserId: 'u1', sourceDisplayName: 'ライ', userMessage: 'ケーキを作って',
      observedAt: '2026-11-22T12:00:00.000Z', participants: ['u1'] };
    expect(validatedVoiceTurn({ ...flat, speakerIsOwner: true })).toMatchObject({ speakerIsOwner: true });
    expect(validatedVoiceTurn({ ...flat, speakerIsOwner: false }).speakerIsOwner).toBeUndefined();
    expect(() => validatedVoiceTurn({ ...flat, speakerIsOwner: 'yes' })).toThrow();
    const one = (who: Record<string, unknown>) => voiceRequestOf(validatedConversationTurn({ version: 1, requestId: 'c1', observedAt: '2026-11-22T12:00:00.000Z', modality: 'voice',
      where: { platform: 'discord', conversationId: 'discord:1:2', conversationKind: 'channel' },
      who: { userId: 'u1', displayName: 'ライ', ...who }, presence: { participants: ['u1'] }, words: 'ケーキを作って' }));
    expect(one({ speakerIsOwner: true })).toMatchObject({ speakerIsOwner: true });
    expect(one({}).speakerIsOwner).toBeUndefined();
    expect(() => one({ speakerIsOwner: 'yes' })).toThrow();
  });
});
