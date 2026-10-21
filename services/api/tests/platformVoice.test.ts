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
  calls: VoiceMinecraftIntentInput[] = [];
  outcome: Awaited<ReturnType<VoiceMinecraftPort['intent']>> = { delivered: true, as: 'message', taskId: 'task-1' };
  state() { return { connected: this.connected, running: this.running }; }
  async intent(input: VoiceMinecraftIntentInput) { this.calls.push(input); return this.outcome; }
}

interface LiveReader { block(options: { alone: boolean }): string; replying?(on: boolean): void; heard?(): void }

function harness(environment: Record<string, string> = { SHANNON_DC_VOICE: 'on' }, live?: LiveReader, addressed?: AddressedJudge) {
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
    environment: () => environment, log: () => undefined, ...(addressed ? { addressed } : {}),
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
    expect(prompt).toContain('体や道具を動かす頼みごとは引き受けない');
    expect(request.offerMinecraftIntent).toBeUndefined();
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

  it('adds what the body is doing to every reply, and what the owner asked of it only to the owner', async () => {
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
    expect(prompt).not.toContain('エンダードラゴンを倒す');
    await say('シャノン、今の様子は？', { participants: [OWNER, FRIEND], situation: '鉄の鉱石の前にいる。' });
    expect(promptOf(model.requests[2]!)).toContain('鉄の鉱石の前にいる。');
    expect(promptOf(model.requests[2]!)).not.toContain('洞窟を下りている');
    await close();
  });
});
describe('the owner\'s spoken request for her Minecraft body', () => {
  it('is offered the intent field only to the owner with the body connected and others in the channel, and a friend never moves it', async () => {
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
    expect(body.calls[0]).toMatchObject({ scopeKey: 'owner', allowNew: false, intent: { kind: 'task', goal: 'まず鉄の剣を作ってから向かって' } });
    expect(body.calls[0]!.experienceId).toBeTruthy();
    expect(lines.find(line => line.type === 'intent')).toMatchObject({ kind: 'task_message', delivered: true, taskId: 'task-1' });
    // A friend asks for the same: no field, no delivery.
    model.requests.length = 0; body.calls.length = 0;
    await say('シャノン、体を動かしてダイヤを掘ってきて', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ' });
    expect(model.requests[0]!.offerMinecraftIntent).toBeUndefined();
    expect(body.calls).toHaveLength(0);
    await close();
  });

  it('says the fixed words of a refusal after a reply that promised, keeps them, and offers nothing when the body is not there', async () => {
    const { say, model, body, store, background, close } = harness();
    model.reply = 'うん、やっておくね。';
    model.intent = { kind: 'task', goal: '鉄を16個集める' };
    body.outcome = { delivered: false, reason: 'others_present' };
    const lines = await say('シャノン、鉄を16個集めておいて', { participants: [OWNER, FRIEND] });
    const last = sentences(lines).at(-1)!;
    expect(last).toMatchObject({ correction: true, text: VOICE_MINECRAFT_REFUSALS.others_present });
    expect(lines.find(line => line.type === 'intent')).toMatchObject({ delivered: false, reason: 'others_present' });
    await background.waitForIdle('owner');
    expect(store.conversationHistory('owner', roomThread).map(message => message.content)).toContain(VOICE_MINECRAFT_REFUSALS.others_present);
    body.connected = false; body.calls.length = 0; model.requests.length = 0;
    await say('シャノン、もう一回お願い', { participants: [OWNER, FRIEND] });
    expect(model.requests[0]!.offerMinecraftIntent).toBeUndefined();
    expect(promptOf(model.requests[0]!)).toContain('マイクラの体がいまつながっていない');
    expect(body.calls).toHaveLength(0);
    await close();
  });

  it('allows a new task only when the owner is alone, and leaves the owner alone in his own room to her ordinary tools', async () => {
    const { say, model, body, close } = harness();
    model.reply = 'わかった、行ってくるね。';
    model.intent = { kind: 'task', goal: 'パンを3個作る' };
    // Alone in a shared server channel: the field is offered, and a new task may be made.
    await say('パンを3個作って', { conversationId: SERVER_ROOM, participants: [OWNER] });
    expect(body.calls[0]).toMatchObject({ allowNew: true });
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
    block: ({ alone }) => `[マイクラの体の今]\n${alone ? 'エンドラを倒す作業の最中' : '頼まれた作業の最中'}`,
    replying: on => { marks.push(on ? 'on' : 'off'); },
    heard: () => { marks.push('heard'); },
  });

  it('is in the prompt of a channel turn with the request left out while others are there, and in the owner\'s own room with it', async () => {
    const marks: string[] = [];
    const { say, model, close } = harness({ SHANNON_DC_VOICE: 'on' }, reader(marks));
    await say('シャノン、いま何してる？', { participants: [OWNER, FRIEND] });
    expect(promptOf(model.requests[0]!)).toContain('頼まれた作業の最中');
    expect(promptOf(model.requests[0]!)).not.toContain('エンドラを倒す作業');
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

  /** A Jev that says "not to her" for talk about her (「ってさ」) and "to her" for everything else it is asked. */
  function judge() {
    const asked: string[] = [];
    const chooser = {
      decide: async (request: { state: unknown }) => {
        const state = request.state as { utterance: string };
        asked.push(state.utterance);
        const about = /ってさ|だって/u.test(state.utterance);
        return { value: { addressed: !about, target: about ? 'about_shannon' : 'shannon', noul: about ? 0.05 : 0.95, reason: about ? 'about_her' : /シャノン/u.test(state.utterance) ? 'named' : 'continuation' }, source: 'jev' as const };
      },
    } as unknown as Pick<JevChooser, 'decide'>;
    return { asked, judge: new AddressedJudge({ chooser }) };
  }

  it('stays quiet for words that do not call her, also with the owner alone, and asks nobody', async () => {
    const { asked, judge: j } = judge();
    const { say, model, close } = harness(ADDRESSED, undefined, j);
    const lines = await say('あー疲れた、今日は早く寝よう');
    expect(typeOf(lines)).toEqual(['decision', 'done']);
    expect(lines[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(lines[1]).toMatchObject({ silent: true, reason: 'no_name' });
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
    const late = await say('それってどういう意味？');
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

  it('reads how long ago the body says she spoke, and falls back on the local rules when there is no Jev', async () => {
    const { asked, judge: j } = judge();
    const { say, close } = harness(ADDRESSED, undefined, j);
    expect((await say('それってどういう意味？', { shannonSpokeMsAgo: 3_000 }))[0]).toMatchObject({ respond: true, reason: 'continuation' });
    expect((await say('それってどういう意味？', { shannonSpokeMsAgo: 30_000 }))[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect(asked).toHaveLength(1);
    await close();
    const silent = harness(ADDRESSED, undefined, new AddressedJudge({ chooser: null }));
    expect((await silent.say('シャノン、今日の予定を教えて'))[0]).toMatchObject({ respond: true, reason: 'named' });
    expect((await silent.say('昨日シャノンがさ、変なこと言っててさ', { participants: [OWNER, FRIEND] }))[0]).toMatchObject({ respond: false, reason: 'about_her' });
    await silent.close();
  });

  it('hears 止めて without her name from the owner while she speaks or her body works, and from nobody else', async () => {
    const { asked, judge: j } = judge();
    const { say, body, model, close } = harness(ADDRESSED, undefined, j);
    expect((await say('止めて'))[0]).toMatchObject({ respond: false, reason: 'no_name' });
    expect((await say('止めて', { speakingNow: true }))[0]).toMatchObject({ respond: true, reason: 'stop' });
    expect((await say('止めて', { shannonSpokeMsAgo: 0 }))[0]).toMatchObject({ respond: true, reason: 'stop' });
    body.running = { id: 'task-1', goal: '鉄を掘る' };
    expect((await say('ちょっと待って'))[0]).toMatchObject({ respond: true, reason: 'stop' });
    const friend = await say('止めて', { conversationId: SERVER_ROOM, participants: [OWNER, FRIEND], sourceUserId: FRIEND, sourceDisplayName: 'ユウ', speakingNow: true });
    // A friend's 止めて is no stop word for her: it is judged like any other words (here she was speaking, so Jev is asked).
    expect(friend[0]).not.toMatchObject({ reason: 'stop' });
    expect(asked).toEqual(['止めて']);
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
