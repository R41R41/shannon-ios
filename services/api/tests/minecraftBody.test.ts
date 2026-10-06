import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, SHANNON_MINECRAFT_BODY_CAPABILITY, groupAudience, type MemoryDisclosure } from '@shannon/cognition';
import { createLocalApiKernel, type ShannonApiKernelOptions, type TextTurnInput } from '../src/apiKernel.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import { BODY_EVENT_TYPES, BODY_GAME_EVENT_TYPES } from '../src/contracts/bodyContract.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/chatModel.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import { parseStructuredTurn } from '../src/chatModelSupport.js';
import { BODY_GAME_SOURCE, GAME_REQUEST_DISCLOSURE, SQLiteGameExperiences, gameDeathSummary, gameExperienceId } from '../src/surfaces/minecraft/store/gameBodyMemory.js';
import { MinecraftBody } from '../src/surfaces/minecraft/minecraftBody.js';
import {
  MINECRAFT_BODY_TURN_PATH, MinecraftBodyError, configuredMinecraftBody, minecraftConversationId,
} from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftIntent } from '../src/surfaces/minecraft/minecraftIntent.js';
import { SQLiteMinecraftTurnLog } from '../src/surfaces/minecraft/store/minecraftTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { configuredPlatformBridge, platformBridgeThreadId } from '../src/surfaces/platform/platformBridge.js';
import { minecraftBodyRoute } from '../src/surfaces/minecraft/serverMinecraftBodyRoute.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { createInMemoryAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import type { HostFolderOperations } from '../src/hostFolderOperations.js';
import { ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import { withMinecraftToolLine, type MinecraftRequestPort } from '../src/mind/tools/shannonMinecraftTools.js';
import type { BodyIngestReceipt, BodyPresence } from '../src/surfaces/body/shannonBody.js';
import type { OwnOutreachReader } from '../src/surfaces/outreach/ownOutreach.js';
import { promptOf } from './modelPrompt.js';

const DEVICE = 'minebot-dev';
const OWNER_UUID = 'b9191317-c52d-4d67-85fe-ab831e6db146';
const FRIEND_UUID = '0f6a8c52-1b2d-4e3f-9a8b-7c6d5e4f3a2b';
const START = '2026-10-05T12:00:00.000Z';
const CONFIGURATION = {
  deviceId: DEVICE,
  servers: [
    { serverId: 'lab-qywEbW', ownerUuid: OWNER_UUID, title: 'マイクラ実験ワールド', onlineMode: true },
    { serverId: 'lan-offline', ownerUuid: OWNER_UUID, title: 'LANワールド', onlineMode: false },
  ],
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class GameModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  intent: MinecraftIntent | undefined;
  /** The rolling summary the model writes for its thread, when set. */
  threadSummary: string | undefined;
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `はい、${this.requests.length}回目です。`,
      ...(this.threadSummary ? { threadSummary: this.threadSummary } : {}),
      ...(request.offerMinecraftIntent && this.intent ? { minecraftIntent: this.intent } : {}) };
  }
  async generateVoice(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい。' };
  }
}

function harness(options: { peopleEnabled?: boolean; kernel?: Partial<ShannonApiKernelOptions> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-minecraft-body-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse(START);
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify(CONFIGURATION) })!;
  const turns = new SQLiteMinecraftTurnLog(path);
  const model = new GameModel();
  // The app's own conversation kernel, as the server wires it.
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background,
    peopleMemory: peopleStore, ...options.kernel });
  // What the game chat hands the kernel, kept so a test can read the audience and the surface of each turn.
  const inputs: TextTurnInput[] = [];
  const body = new MinecraftBody({ configuration, stateStore: store, conversationStore: store, background, now, chatModel: model, turns,
    conversation: { textTurn: input => { inputs.push(input); return api.textTurn(input); } }, peopleStore, peopleEnabled: () => options.peopleEnabled ?? true });
  const turn = (fields: Record<string, unknown> = {}, deviceId = DEVICE, scopeKey = 'owner') => body.turn(scopeKey, deviceId, {
    requestId: `req-${Math.random().toString(36).slice(2)}`, serverId: 'lab-qywEbW', conversation: { kind: 'channel' },
    speaker: { uuid: OWNER_UUID, name: 'Rai1241' }, message: 'こんばんは、シャノン', observedAt: now(), ...fields,
  });
  const refusal = async (operation: Promise<unknown>) => {
    try { await operation; return 'none'; } catch (error) { return error instanceof MinecraftBodyError ? `${error.status} ${error.code}` : String(error); }
  };
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    turns.close(); peopleStore.close(); store.close();
  };
  return { path, store, peopleStore, background, body, api, model, inputs, turn, refusal, close, now, advance: (milliseconds: number) => { clock += milliseconds; } };
}

const channelThread = platformBridgeThreadId('minecraft', 'minecraft:lab-qywEbW');

describe('POST /v1/body/minecraft/turns', () => {
  it('answers the owner, offers him the intent field, and keeps the turn in his platform thread', async () => {
    const { turn, model, store, peopleStore, close, background } = harness();
    model.intent = { kind: 'task', goal: 'オークの原木を16個集める' };
    const answer = await turn({ requestId: 'owner-1', message: '木材集めといて' });
    expect(answer).toEqual({ reply: 'はい、1回目です。', intent: { kind: 'task', goal: 'オークの原木を16個集める' }, threadId: channelThread, duplicate: false });
    const request = model.requests[0]!;
    expect(request.offerMinecraftIntent).toBe(true);
    expect(request.message).toBe('木材集めといて');
    expect(request.history).toEqual([]);
    expect(promptOf(request)).toContain('[シャノンの人格]');
    expect(promptOf(request)).toContain('[マイクラの体]');
    expect(promptOf(request)).toContain('[マイクラの体への頼みごと]');
    // A shared chat: the projection is the platform bridge's, with its speak-time check.
    expect(promptOf(request)).toContain('[Shannon shared audience]');
    await background.waitForIdle('owner');
    expect(store.conversationHistory('owner', channelThread).map(message => message.content)).toEqual(['木材集めといて', 'はい、1回目です。']);
    expect(peopleStore.listPeople('owner')).toEqual([]);

    // No intent from the model is "none", on an owner turn only.
    model.intent = undefined;
    expect((await turn({ requestId: 'owner-2', message: '今日は寒いね' })).intent).toEqual({ kind: 'none', goal: '' });
    await close();
  });

  it('a whisper with the owner is his alone; a whisper with a friend is that friend\'s', async () => {
    const { turn, model, store, peopleStore, close, background } = harness();
    const ownerDm = await turn({ requestId: 'dm-owner', conversation: { kind: 'dm' } });
    expect(ownerDm.threadId).toBe(platformBridgeThreadId('minecraft', minecraftConversationId('lab-qywEbW', 'dm', OWNER_UUID)));
    // The owner-private conversation gets the owner's own state projection, not the shared header.
    expect(promptOf(model.requests[0]!)).not.toContain('[Shannon shared audience]');
    await background.waitForIdle('owner');
    expect(store.experienceCandidates('owner')[0]?.disclosure?.audience).toEqual({ kind: 'owner' });

    const friendDm = await turn({ requestId: 'dm-friend', conversation: { kind: 'dm' }, speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'ないしょの話' });
    expect(friendDm.intent).toBeUndefined();
    expect(friendDm.ignored).toBeUndefined();
    expect(store.conversationHistory('owner', friendDm.threadId)).toEqual([]);
    expect(peopleStore.listPeople('owner').map(person => person.displayName)).toEqual(['Miki_01']);
    await close();
  });

  it('a friend\'s turn is answered as a guest, stored for that person, and never in the owner\'s threads', async () => {
    const { turn, model, store, peopleStore, close } = harness();
    const answer = await turn({ requestId: 'friend-1', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: '私は辛いものが苦手' });
    expect(Object.keys(answer).sort()).toEqual(['duplicate', 'reply', 'threadId']);
    const request = model.requests[0]!;
    expect(request.offerMinecraftIntent).toBeUndefined();
    expect(request.message).toBe('Miki_01: 私は辛いものが苦手');
    expect(promptOf(request)).toContain('いまは持ち主以外の人も話す一時的な場');
    expect(promptOf(request)).not.toContain('[マイクラの体への頼みごと]');
    expect(store.listThreads('owner')).toEqual([]);
    expect(store.conversationHistory('owner', channelThread)).toEqual([]);
    expect(store.experienceCandidates('owner')).toEqual([]);
    const people = peopleStore.listPeople('owner');
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ displayName: 'Miki_01' });
    await close();
  });

  it('with people memory switched off a friend is still answered, as a stranger, and nothing is kept', async () => {
    const { turn, model, peopleStore, store, close } = harness({ peopleEnabled: false });
    const answer = await turn({ requestId: 'friend-off', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' } });
    expect(answer.ignored).toBe('people_disabled');
    expect(promptOf(model.requests[0]!)).toContain('[相手が分からない場]');
    expect(peopleStore.listPeople('owner')).toEqual([]);
    expect(store.listThreads('owner')).toEqual([]);
    await close();
  });

  it('on an offline-mode server nobody is the owner and nobody is remembered', async () => {
    const { turn, model, peopleStore, store, close } = harness();
    const owner = await turn({ requestId: 'offline-1', serverId: 'lan-offline' });
    const friend = await turn({ requestId: 'offline-2', serverId: 'lan-offline', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' } });
    for (const answer of [owner, friend]) {
      expect(answer.intent).toBeUndefined();
      expect(answer.ignored).toBe('offline_server');
    }
    for (const request of model.requests) {
      expect(request.offerMinecraftIntent).toBeUndefined();
      expect(promptOf(request)).toContain('[相手が分からない場]');
      expect(promptOf(request)).toContain('このサーバーでは相手が誰かを確かめられない');
      expect(promptOf(request)).not.toContain('[Shannon shared audience]');
    }
    expect(peopleStore.listPeople('owner')).toEqual([]);
    expect(store.listThreads('owner')).toEqual([]);
    expect(store.experienceCandidates('owner')).toEqual([]);
    await close();
  });

  it('answers a repeated requestId with the stored reply, without asking the model again, and refuses changed content', async () => {
    const { turn, model, refusal, store, close, background, advance } = harness();
    const first = await turn({ requestId: 'same-1' });
    advance(60 * 60_000);
    const again = await turn({ requestId: 'same-1', observedAt: START });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(model.requests).toHaveLength(1);
    expect(await refusal(turn({ requestId: 'same-1', observedAt: START, message: '別の言葉' }))).toBe('409 MINECRAFT_TURN_CONFLICT');
    // Two at once: one model call, one stored turn.
    const [left, right] = await Promise.all([turn({ requestId: 'same-2' }), turn({ requestId: 'same-2' })]);
    expect(left.reply).toBe(right.reply);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    expect(model.requests).toHaveLength(2);
    await background.waitForIdle('owner');
    expect(store.conversationHistory('owner', channelThread)).toHaveLength(4);
    await close();
  });

  it('refuses another device, another scope, an unknown server, and a malformed turn, before any model call', async () => {
    const { turn, model, refusal, close, now } = harness();
    expect(await refusal(turn({}, 'body-pc'))).toBe('403 MINECRAFT_BODY_DEVICE_DENIED');
    expect(await refusal(turn({}, DEVICE, 'guest-scope'))).toBe('403 MINECRAFT_BODY_SCOPE_DENIED');
    expect(await refusal(turn({ serverId: 'other-server' }))).toBe('403 MINECRAFT_SERVER_DENIED');
    for (const fields of [
      { message: 'あ'.repeat(601) }, { message: '' }, { speaker: { uuid: 'not-a-uuid', name: 'Rai1241' } },
      { speaker: { uuid: OWNER_UUID, name: 'ライ氏' } }, { conversation: { kind: 'group' } }, { attachments: [] },
      { observedAt: new Date(Date.parse(now()) - 31 * 60_000).toISOString() }, { requestId: '' },
    ]) expect(await refusal(turn(fields))).toBe('400 BAD_REQUEST');
    expect(model.requests).toEqual([]);
    await close();
  });

  it('the route takes a paired device only and answers 503 while the body is not configured', async () => {
    const call = async (route: ReturnType<typeof minecraftBodyRoute>, principal: { deviceId: string; scopeKey: string; displayName: string } | null) => {
      const sent: { status?: number; body?: string } = {};
      const response = { writeHead: (status: number) => { sent.status = status; }, end: (text: string) => { sent.body = text; } } as unknown as ServerResponse;
      const handled = await route.handle({ method: 'POST' } as IncomingMessage, response, MINECRAFT_BODY_TURN_PATH, {}, principal);
      return { handled, status: sent.status, error: sent.body ? (JSON.parse(sent.body) as { error?: string }).error : undefined };
    };
    expect(await call(minecraftBodyRoute(null, null), { deviceId: DEVICE, scopeKey: 'owner', displayName: 'x' })).toEqual({ handled: true, status: 503, error: 'MINECRAFT_BODY_NOT_CONFIGURED' });
    const { body, close } = harness();
    const route = minecraftBodyRoute(body, configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify(CONFIGURATION) }));
    expect(await call(route, null)).toEqual({ handled: true, status: 403, error: 'MINECRAFT_BODY_DEVICE_DENIED' });
    expect(await call(route, { deviceId: 'body-pc', scopeKey: 'owner', displayName: 'x' })).toEqual({ handled: true, status: 403, error: 'MINECRAFT_BODY_DEVICE_DENIED' });
    expect(await call(route, { deviceId: DEVICE, scopeKey: 'owner', displayName: 'x' })).toEqual({ handled: true, status: 400, error: 'BAD_REQUEST' });
    expect(await route.handle({ method: 'POST' } as IncomingMessage, {} as ServerResponse, '/v1/body/events', {}, null)).toBe(false);
    await close();
  });

  it('reads its configuration strictly, and leaves the platform bridge\'s own bindings as they were', () => {
    expect(configuredMinecraftBody({})).toBeNull();
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify(CONFIGURATION), SHANNON_OWNER_SCOPE_KEY: 'owner' })!;
    expect(configuration.deviceId).toBe(DEVICE);
    expect(configuration.servers.get('lab-qywEbW')).toMatchObject({ onlineMode: true, ownerUuid: OWNER_UUID });
    for (const bad of ['{', '{"servers":[]}', JSON.stringify({ ...CONFIGURATION, servers: [{ ...CONFIGURATION.servers[0], onlineMode: 'yes' }] }),
      JSON.stringify({ ...CONFIGURATION, servers: [CONFIGURATION.servers[0], CONFIGURATION.servers[0]] })]) {
      expect(() => configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: bad })).toThrow(/SHANNON_MINECRAFT_BODY_JSON/u);
    }
    // The environment's bridge still refuses a prefix other than Discord's, and overlapping bindings.
    const environment = (bindings: unknown[]) => ({ SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(bindings) });
    expect(() => configuredPlatformBridge(environment([{ platform: 'minecraft', conversationIdPrefix: 'minecraft:lab:dm:', ownerUserId: 'mc:x', title: 't' }])))
      .toThrow(/invalid binding/u);
    expect(() => configuredPlatformBridge(environment([
      { platform: 'discord', conversationIdPrefix: 'discord:1:', ownerUserId: '1', title: 't' },
      { platform: 'discord', conversationId: 'discord:1:2', ownerUserId: '1', title: 't' },
    ]))).toThrow(/overlapping bindings/u);
  });
});

const BODY_NOW = {
  task: 'エンドラを倒す → 今は鉄のツルハシ作り', dimension: 'the_nether', health: 14, food: 18, timeOfDay: 'night',
  recentAdvancements: ['minecraft:story/smelt_iron', 'somemod:unknown/thing'], busyWith: 'campaign',
};

describe('the body\'s present (`body`) on a turn', () => {
  it('reaches the model as [マイクラの体の今] in her words, for the owner and in the shared chat, and is stored nowhere', async () => {
    const { turn, model, store, background, close } = harness();
    await turn({ requestId: 'now-1', message: '今何してるとこ？', body: BODY_NOW });
    const prompt = promptOf(model.requests[0]!);
    expect(prompt).toContain('[マイクラの体の今]（');
    for (const line of ['自分の目標の冒険を進めている', 'エンドラを倒す → 今は鉄のツルハシ作り', 'いる場所: ネザー', '体力 14/20、満腹度 18/20', 'ゲーム内の時間: 夜', '最近できたこと: 鉄を精錬した']) {
      expect(prompt).toContain(line);
    }
    expect(prompt).not.toContain('somemod');
    expect(prompt).toContain('マイクラの話として受け取る');
    // A friend in the shared chat hears the same game state; a friend's whisper does not get it.
    await turn({ requestId: 'now-2', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, body: BODY_NOW });
    expect(promptOf(model.requests[1]!)).toContain('[マイクラの体の今]（');
    await turn({ requestId: 'now-3', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, conversation: { kind: 'dm' }, body: BODY_NOW });
    expect(promptOf(model.requests[2]!)).not.toContain('[マイクラの体の今]（');
    // An empty body adds no block.
    await turn({ requestId: 'now-4', body: {} });
    expect(promptOf(model.requests[3]!)).not.toContain('[マイクラの体の今]（');
    await background.waitForIdle('owner');
    const kept = JSON.stringify([store.conversationHistory('owner', channelThread), store.experienceCandidates('owner')]);
    expect(kept).not.toContain('鉄のツルハシ作り');
    expect(kept).not.toContain('ネザー');
    await close();
  });

  it('is not part of the idempotency key: a retry with a newer body gets the answer already given', async () => {
    const { turn, model, close } = harness();
    const first = await turn({ requestId: 'now-retry', body: BODY_NOW });
    const again = await turn({ requestId: 'now-retry', observedAt: START, body: { ...BODY_NOW, health: 3 } });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('refuses a body with an unknown field or a value outside its closed set', async () => {
    const { turn, refusal, model, close } = harness();
    for (const body of [
      { mood: 'happy' }, { task: 'あ'.repeat(121) }, { task: 3 }, { dimension: 'moon' }, { health: 21 }, { health: -1 }, { food: 3.5 },
      { timeOfDay: 'noon' }, { recentAdvancements: ['a:b', 'a:c', 'a:d', 'a:e', 'a:f', 'a:g'] }, { recentAdvancements: ['Smelt Iron'] },
      { busyWith: 'sleeping' }, [], 'busy',
    ]) expect(await refusal(turn({ body })), JSON.stringify(body)).toBe('400 BAD_REQUEST');
    expect(model.requests).toEqual([]);
    await close();
  });
});

describe('through the app\'s conversation kernel', () => {
  it('replays the recent turns of the same chat, so a follow-up keeps its subject', async () => {
    const { turn, model, close, advance, background } = harness();
    model.intent = undefined;
    await turn({ requestId: 'k-1', message: 'パンを作って' });
    await background.waitForIdle('owner');
    advance(20_000);
    model.intent = { kind: 'task', goal: 'パンを3個作る' };
    const second = await turn({ requestId: 'k-2', message: 'マイクラで' });
    expect(second.intent).toEqual({ kind: 'task', goal: 'パンを3個作る' });
    expect(model.requests[1]!.history).toEqual([{ role: 'user', content: 'パンを作って' }, { role: 'assistant', content: 'はい、1回目です。' }]);
    expect(model.requests[1]!.offerMinecraftIntent).toBe(true);
    // A whisper is another conversation: nothing of the chat is replayed there.
    advance(20_000);
    await turn({ requestId: 'k-3', conversation: { kind: 'dm' }, message: 'さっき何頼んだっけ？' });
    expect(model.requests[2]!.history).toEqual([]);
    await close();
  });

  it('keeps the owner\'s chat turn in his platform thread with the world\'s title, as heard by everyone there, without becoming the app\'s default Talk', async () => {
    const { turn, api, store, close, background, path: harnessPath } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'おはよう' } });
    await api.waitForBackground('owner');
    const answer = await turn({ requestId: 'k-title', message: 'こんばんは' });
    await background.waitForIdle('owner');
    const thread = store.listThreads('owner').find(item => item.threadId === answer.threadId);
    expect(thread?.title).toBe('マイクラ実験ワールド');
    expect(store.experienceCandidates('owner').at(-1)?.disclosure).toMatchObject({ audience: { kind: 'group' }, speaker: 'owner' });
    // The app's default Talk is still the app's, also for a store opened afresh (a restart), where the platform thread is the newest.
    expect(store.threadId('owner')).toBe('app-talk');
    const reopened = new SQLiteShannonStore({ path: harnessPath, now: () => new Date().toISOString() });
    expect(reopened.threadId('owner')).toBe('app-talk');
    reopened.close();
    await close();
  });

  it('creates no thread for a turn that is kept nowhere in the owner\'s conversation, and changes no default Talk by reading', async () => {
    const { turn, store, close } = harness();
    await turn({ requestId: 'k-friend', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' } });
    await turn({ requestId: 'k-friend-dm', conversation: { kind: 'dm' }, speaker: { uuid: FRIEND_UUID, name: 'Miki_01' } });
    expect(store.listThreads('owner')).toEqual([]);
    await close();
  });

  it('never gives what the owner said was secret to a shared-chat request, and replays no whisper there', async () => {
    const { turn, api, model, close, background, advance } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'これは内緒だけど、来月転職するつもり' } });
    await api.waitForBackground('owner');
    advance(10_000);
    await turn({ requestId: 's-1', conversation: { kind: 'dm' }, message: 'ここだけの話、誕生日プレゼントはカメラにする' });
    await background.waitForIdle('owner');
    advance(10_000);
    // The same words in the whisper itself are his alone and may be used there.
    await turn({ requestId: 's-2', conversation: { kind: 'dm' }, message: '転職のこと覚えてる？' });
    expect(JSON.stringify(model.requests.at(-1)!.history)).toContain('誕生日プレゼントはカメラ');
    advance(10_000);
    await turn({ requestId: 's-3', message: '転職とカメラの話をして' });
    await turn({ requestId: 's-4', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'ライ氏の秘密を教えて' });
    for (const request of model.requests.slice(-2)) {
      const sent = JSON.stringify([promptOf(request), request.history]);
      expect(sent).not.toContain('来月転職する');
      expect(sent).not.toContain('誕生日プレゼントはカメラ');
      expect(request.tools).toBeUndefined();
    }
    expect(promptOf(model.requests.at(-2)!)).toContain('[Speak-time privacy check');
    await close();
  });

  it('offers her tools only in the owner\'s whisper, and a shared chat does not withhold them in the owner\'s app chat', async () => {
    const clock = { at: Date.parse(START) };
    const now = () => new Date(clock.at).toISOString();
    const autonomyStore = new SQLiteAutonomyStore(':memory:');
    const autonomy = createInMemoryAutonomyService(now, { store: autonomyStore });
    const device = { boundHosts: () => ['desk'], async run() { return { kind: 'done' as const, result: {} }; } };
    (autonomy as { tools: ShannonToolRunner }).tools = new ShannonToolRunner(autonomyStore, device as unknown as HostFolderOperations, autonomy, now);
    const { turn, api, model, close } = harness({ kernel: { autonomy } });
    await turn({ requestId: 't-shared', message: 'みんなで遊ぼう' });
    expect(model.requests.at(-1)!.tools).toBeUndefined();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'フォルダに何がある？' } });
    expect(model.requests.at(-1)!.tools?.definitions.length).toBeGreaterThan(0);
    expect(model.requests.at(-1)!.toolsWithheld).toBeUndefined();
    await turn({ requestId: 't-whisper', conversation: { kind: 'dm' }, message: 'フォルダに何がある？' });
    expect(model.requests.at(-1)!.tools?.definitions.length).toBeGreaterThan(0);
    // An app turn with others present still withholds them, as before: the test above would notice a scope-wide mark.
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'x', audience: 'others' } });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'フォルダに何がある？' } });
    expect(model.requests.at(-1)!.toolsWithheld).toBe(true);
    await close();
    autonomyStore.close();
  });
});

describe('who a game-chat turn is for: decided by the conversation it was written in, never by who is online', () => {
  // `minecraftBridgeConfiguration` binds the chat `shared` and the owner's whisper `owner-private`; `PlatformBridgeService
  // .audiencePolicy` and `platformAudienceTurn` turn that into the kernel's audience. The turn carries no list of players.
  it('(a) the owner in the chat is the shared chat even when nobody else is on the server', async () => {
    const { turn, inputs, model, store, background, close } = harness();
    await turn({ requestId: 'aud-a', message: 'だれもいないね' });
    const input = inputs.at(-1)!;
    expect(input.audience).toMatchObject({ audience: 'others', alone: false, present: groupAudience(channelThread) });
    expect(input.surface?.openOnly).toBe(false);
    expect(promptOf(model.requests.at(-1)!)).toContain('[Shannon shared audience]');
    expect(model.requests.at(-1)!.tools).toBeUndefined();
    await background.waitForIdle('owner');
    expect(store.experienceCandidates('owner').at(-1)?.disclosure).toMatchObject({ audience: { kind: 'group' }, speaker: 'owner' });
    await close();
  });

  it('(b) with other players on the server the chat is the same shared chat, and nothing in a turn can say who is online', async () => {
    const { turn, inputs, refusal, model, close } = harness();
    await turn({ requestId: 'aud-b1', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'こんにちは', body: BODY_NOW });
    await turn({ requestId: 'aud-b2', message: 'みんな来たね', body: BODY_NOW });
    for (const input of inputs) expect(input.audience).toMatchObject({ audience: 'others', alone: false, present: groupAudience(channelThread) });
    for (const fields of [{ players: [FRIEND_UUID] }, { participants: [FRIEND_UUID] }, { body: { ...BODY_NOW, players: 2 } }]) {
      expect(await refusal(turn({ requestId: 'aud-b3', ...fields }))).toBe('400 BAD_REQUEST');
    }
    expect(model.requests).toHaveLength(2);
    await close();
  });

  it('(c) the owner\'s whisper is the owner alone', async () => {
    const { turn, inputs, model, close } = harness();
    await turn({ requestId: 'aud-c', conversation: { kind: 'dm' }, message: 'ここだけの話' });
    expect(inputs.at(-1)!.audience).toMatchObject({ audience: 'owner', alone: true, present: OWNER_AUDIENCE });
    expect(promptOf(model.requests.at(-1)!)).not.toContain('[Shannon shared audience]');
    await close();
  });

  it('(d) another player\'s whisper is that player\'s alone, without the owner', async () => {
    const { turn, inputs, model, peopleStore, close } = harness();
    await turn({ requestId: 'aud-d1', conversation: { kind: 'dm' }, speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'はじめまして' });
    await turn({ requestId: 'aud-d2', conversation: { kind: 'dm' }, speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'また来たよ' });
    const person = peopleStore.listPeople('owner')[0]!;
    expect(inputs[0]!.audience).toMatchObject({ audience: 'others', alone: false, present: { kind: 'people', personIds: [], unknownGuest: true } });
    expect(inputs[1]!.audience).toMatchObject({ audience: 'others', alone: false, present: { kind: 'people', personIds: [person.id] } });
    for (const input of inputs) expect(input.surface?.openOnly).toBe(true);
    expect(promptOf(model.requests.at(-1)!)).toContain('いまは持ち主以外の人も話す一時的な場');
    await close();
  });
});

describe('what she did on her own, in game chat (owner decision 2026-10-06)', () => {
  const HEADER = '[ボクが自分からしたこと]（記録された事実';
  const TEXT = 'ライ氏、お昼はもう食べましたか。';
  const ASKED = 'さっき電話した？';
  const reader: OwnOutreachReader = { recent: () => ({ messages: [{ createdAt: '2026-10-05T11:30:00.000Z', content: TEXT, read: true }], calls: [] }) };

  it('is told in full in the owner\'s whisper, by times only in the shared chat, and never on anyone else\'s turn', async () => {
    const { turn, model, api, close } = harness({ kernel: { ownOutreach: reader } });
    await turn({ requestId: 'own-c', conversation: { kind: 'dm' }, message: ASKED });
    expect(promptOf(model.requests.at(-1)!)).toContain(HEADER);
    expect(promptOf(model.requests.at(-1)!)).toContain(`ボクから送った「${TEXT}」（既読）`);
    for (const requestId of ['own-a', 'own-b']) {
      await turn({ requestId, message: ASKED });
      const prompt = promptOf(model.requests.at(-1)!);
      expect(prompt).toContain(HEADER);
      expect(prompt).toContain('ボクから送った（中身はこの場では話さない）');
      expect(prompt).not.toContain(TEXT);
    }
    // Another player, in the chat or in a whisper: nothing of it at all (guest identity).
    await turn({ requestId: 'own-d1', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: ASKED });
    await turn({ requestId: 'own-d2', conversation: { kind: 'dm' }, speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: ASKED });
    for (const request of model.requests.slice(-2)) expect(promptOf(request)).not.toContain(HEADER);
    // The app's own chat is as it was.
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: ASKED } });
    expect(promptOf(model.requests.at(-1)!)).toContain(`ボクから送った「${TEXT}」（既読）`);
    await close();
  });
});

/** Her Minecraft body's request queue as her tools see it: configured for the owner, in the game while `present.value`. */
function bodyPort(present: { value: boolean }): MinecraftRequestPort {
  return { configuredFor: (scopeKey: string) => scopeKey === 'owner', present: (scopeKey: string) => scopeKey === 'owner' && present.value,
    enqueue: () => ({ kind: 'absent' }), cancel: () => 'NOT_FOUND', statusText: () => '' } as unknown as MinecraftRequestPort;
}

const voiceTurn = (transcript: string, extra: { companionPresent?: boolean } = {}) => ({
  method: 'POST' as const, path: '/v1/voice/gemini/cascade/delegations', body: {
    scopeKey: 'owner', threadId: 'desktop', transcript,
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...(extra.companionPresent ? { companionPresent: true } : {}),
      userUtterance: { id: `u-${Math.random().toString(36).slice(2)}`, text: transcript, source: 'speech', rawText: transcript } },
  },
});

describe('her Minecraft body\'s capability line (review N1 and N-1, 2026-10-06)', () => {
  it('is in the owner\'s description only where minecraft.request is offered: alone, the body in the game, never game chat', async () => {
    const present = { value: false };
    const autonomy = createInMemoryAutonomyService(() => START, { store: new SQLiteAutonomyStore(':memory:'), minecraftBody: bodyPort(present) });
    const { turn, model, api, close } = harness({ kernel: { autonomy } });
    const line = SHANNON_MINECRAFT_BODY_CAPABILITY.text;
    const chat = (extra: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'おはよう', ...extra } });
    await chat();
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    present.value = true;
    await chat();
    expect(promptOf(model.requests.at(-1)!)).toContain(line);
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name)).toContain('minecraft.request');
    // Voice: only a turn whose own tools include minecraft.request (N-1). Words that name Minecraft offer her tools, but a
    // transcript without a reliability score gets the reading ones only (no minecraft.request), so no line either.
    await api.dispatch(voiceTurn('マイクラの木材集め、どうなった？'));
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name)).toContain('minecraft.status');
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name)).not.toContain('minecraft.request');
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    for (const words of ['おはよう', '木を集めてきて']) {
      await api.dispatch(voiceTurn(words));
      expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name) ?? []).not.toContain('minecraft.request');
      expect(promptOf(model.requests.at(-1)!), words).not.toContain(line);
    }
    // The rule itself, as text and voice apply it to their model request.
    const prompt = promptOf(model.requests.at(-1)!);
    expect(promptOf(withMinecraftToolLine({ systemPrompt: prompt, tools: { definitions: [{ name: 'minecraft.request' }] } }))).toContain(line);
    expect(promptOf(withMinecraftToolLine({ systemPrompt: prompt, tools: { definitions: [{ name: 'minecraft.status' }] } }))).toBe(prompt);
    expect(promptOf(withMinecraftToolLine({ systemPrompt: prompt }))).toBe(prompt);
    // A realtime session before anyone spoke offers no tools, so it has no line.
    expect(api.realtimeVoiceSession('owner').instructions).not.toContain(line);
    // Game chat asks the body through its intent, not her tools: no line there, in the whisper or the chat.
    await turn({ requestId: 'cap-dm', conversation: { kind: 'dm' } });
    await turn({ requestId: 'cap-chat' });
    for (const request of model.requests.slice(-2)) expect(promptOf(request)).not.toContain(line);
    // With others present no tool is offered, so neither is the line (text marked others, then the ten minutes after it).
    await chat({ audience: 'others' });
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    await chat();
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    await close();
  });
});

describe('Minecraft words in a voice turn (review B2, 2026-10-06)', () => {
  const said = '昨日マイクラで遊んだよ';
  it('change nothing without a body, or while it is away: no tools offered, as before her Minecraft body existed', async () => {
    for (const minecraftBody of [undefined, bodyPort({ value: false })]) {
      const autonomy = createInMemoryAutonomyService(() => START, { store: new SQLiteAutonomyStore(':memory:'), ...(minecraftBody ? { minecraftBody } : {}) });
      const { model, api, close } = harness({ kernel: { autonomy } });
      expect((await api.dispatch(voiceTurn(said))).status).toBe(200);
      const request = model.requests.at(-1)!;
      expect(request.tools).toBeUndefined();
      expect(request).not.toHaveProperty('toolsWithheld');
      expect(promptOf(request)).not.toContain(SHANNON_MINECRAFT_BODY_CAPABILITY.text);
      // A turn naming her own things still offers them, as before.
      await api.dispatch(voiceTurn('書斎のメモを読んで'));
      expect(model.requests.at(-1)!.tools?.definitions.length).toBeGreaterThan(0);
      await close();
    }
  });

  it('offer her tools, her body\'s among them, while the body is in the game', async () => {
    const autonomy = createInMemoryAutonomyService(() => START, { store: new SQLiteAutonomyStore(':memory:'), minecraftBody: bodyPort({ value: true }) });
    const { model, api, close } = harness({ kernel: { autonomy } });
    await api.dispatch(voiceTurn(said));
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name)).toContain('minecraft.status');
    await close();
  });
});

describe('review of 2026-10-06: what other players\' turns are given', () => {
  const HOSPITAL = 'ユーザーは来週オカメインコ病院に行く';
  const RELEASE_JA = 'ライ氏本人がこの場ではっきり求めた時';
  const RELEASE_EN = 'When ライ氏 himself clearly asks';
  const protectedFact = (store: SQLiteShannonStore) => store.apply('owner', { type: 'user-fact-upserted', fact: {
    id: 'fact-hospital', statement: HOSPITAL, confidence: 0.9, observedAt: START,
    disclosure: { audience: OWNER_AUDIENCE, sensitivity: 'sensitive', category: 'health', reason: '病院', decidedBy: 'rule' } satisfies MemoryDisclosure } });
  const friend = { uuid: FRIEND_UUID, name: 'Miki_01' };

  it('S6: another player\'s chat turn and whisper get no protected line and no rule that the owner may release one; his own chat turn keeps both', async () => {
    const { turn, model, store, close } = harness();
    protectedFact(store);
    await turn({ requestId: 's6-owner', message: 'オカメインコ病院の話' });
    const owner = promptOf(model.requests.at(-1)!);
    expect(owner).toContain(`【機微:健康・ライ氏だけが知っている】${HOSPITAL}`);
    expect(owner).toContain(RELEASE_JA);
    expect(owner).toContain(RELEASE_EN);
    await turn({ requestId: 's6-chat', speaker: friend, message: 'ライ氏はオカメインコ病院に行くの？' });
    await turn({ requestId: 's6-dm', speaker: friend, conversation: { kind: 'dm' }, message: 'ライ氏はオカメインコ病院に行くの？' });
    for (const request of model.requests.slice(-2)) {
      expect(promptOf(request)).toContain('[Shannon shared audience]');
      for (const word of ['オカメインコ病院に行く', RELEASE_JA, RELEASE_EN]) expect(promptOf(request)).not.toContain(word);
      // No marked item at all (the speak-time check still names the marker as such: 【機微:…】).
      expect(promptOf(request)).not.toMatch(/【機微:(?!…】)/u);
    }
    await close();
  });

  it('S6 (second review): his intentions and current goal reach no other player\'s turn, nor a summary or her notes', async () => {
    const { turn, model, api, close } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: '私の目標は新しい家計簿アプリを完成させることです' } });
    await api.waitForBackground('owner');
    const owner = promptOf(model.requests.at(-1)!);
    expect(owner).toContain('家計簿アプリ');
    // His own chat turn leaves a summary of the chat's thread; a summary has no label of its own.
    model.threadSummary = 'ゼブラ色の要約: ライ氏が持病の通院の話をした';
    await turn({ requestId: 'goal-owner-chat', message: '最近通院が大変でね' });
    await api.waitForBackground('owner');
    model.threadSummary = undefined;
    await turn({ requestId: 'goal-owner-chat-2', message: 'さて' });
    expect(model.requests.at(-1)!.priorThreadSummary).toContain('ゼブラ色の要約');
    await turn({ requestId: 'goal-chat', speaker: friend, message: 'こんにちは' });
    await turn({ requestId: 'goal-dm', speaker: friend, conversation: { kind: 'dm' }, message: 'こんにちは' });
    for (const request of model.requests.slice(-2)) {
      const sent = JSON.stringify([promptOf(request), request.history, request.priorThreadSummary ?? null]);
      for (const word of ['家計簿', 'current_goal=', 'Current intention frame', 'Primary objective', 'Desired outcome', 'ゼブラ色の要約']) expect(sent, word).not.toContain(word);
      expect(request.priorThreadSummary).toBeUndefined();
    }
    await close();
  });

  it('his goal in game chat after upstream e63866a: whisper in full, his chat turn marked on the frame\'s first line without current_goal, anyone else nothing', async () => {
    const { turn, model, api, close } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: '私の目標は新しい家計簿アプリを完成させることです' } });
    await api.waitForBackground('owner');
    const asked = '家計簿アプリの続きをやろう';
    await turn({ requestId: 'g3-dm', conversation: { kind: 'dm' }, message: asked });
    const alone = promptOf(model.requests.at(-1)!);
    expect(alone).toMatch(/current_goal=[^;\n]*家計簿アプリ/u);
    expect(alone).toMatch(/^\[Current intention frame/mu);
    expect(alone).not.toContain('【機微:未分類・ライ氏だけが知っている】[Current intention frame');
    await turn({ requestId: 'g3-chat', message: asked });
    const shared = promptOf(model.requests.at(-1)!);
    expect(shared).not.toContain('current_goal=');
    expect(shared).toContain('【機微:未分類・ライ氏だけが知っている】[Current intention frame');
    expect(shared).not.toMatch(/^\[Current intention frame/mu);
    await turn({ requestId: 'g3-friend', speaker: friend, message: asked });
    await turn({ requestId: 'g3-friend-dm', speaker: friend, conversation: { kind: 'dm' }, message: asked });
    for (const request of model.requests.slice(-2)) {
      // No goal, frame or objective of his. (His turn that stated it is an ordinary memory by the disclosure rule, and ordinary
      // items are open to anyone; that rule is upstream's and unchanged.)
      for (const word of ['current_goal=', 'Current intention frame', 'Primary objective', 'Desired outcome']) expect(promptOf(request), word).not.toContain(word);
    }
    await close();
  });

  it('B-1: one player\'s whisper reaches no one else\'s turn, nor the owner\'s chat turn; it reaches that player\'s own whisper', async () => {
    const { turn, model, peopleStore, close } = harness();
    const taro = { uuid: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Taro_02' };
    await turn({ requestId: 'b1-taro', speaker: taro, conversation: { kind: 'dm' }, message: 'ぼくの拠点の座標はX1200 Z-340だよ' });
    expect(peopleStore.listPeople('owner').map(person => person.displayName)).toContain('Taro_02');
    const asked = 'Taro_02の拠点の座標ってどこ？';
    await turn({ requestId: 'b1-miki-chat', speaker: friend, message: asked });
    await turn({ requestId: 'b1-miki-dm', speaker: friend, conversation: { kind: 'dm' }, message: asked });
    await turn({ requestId: 'b1-owner-chat', message: asked });
    for (const request of model.requests.slice(-3)) {
      expect(JSON.stringify([promptOf(request), request.history])).not.toContain('X1200');
    }
    await turn({ requestId: 'b1-taro-again', speaker: taro, conversation: { kind: 'dm' }, message: 'ぼくの拠点の座標、覚えてる？' });
    expect(promptOf(model.requests.at(-1)!)).toContain('X1200');
    await close();
  });

  it('S4: a finished request is the owner\'s matter: in full in his whisper, marked in his chat turn, absent from anyone else\'s', async () => {
    const { turn, model, path: databasePath, close } = harness();
    const experiences = new SQLiteGameExperiences(databasePath);
    const summary = 'ゲームの記憶: 10月5日の夜、ライ氏に頼まれた「オークの原木を16個集める」をマイクラの体でやり終えた（オークの原木 16個）。';
    expect(experiences.write('owner', { id: gameExperienceId('owner', DEVICE, 'request:r1'), observedAt: START, summary,
      disclosure: GAME_REQUEST_DISCLOSURE, game: { type: 'request', requestId: 'r1', state: 'done' } })).toBe(true);
    experiences.close();
    const asked = 'オークの原木を16個集めるのはどうなった？';
    await turn({ requestId: 's4-dm', conversation: { kind: 'dm' }, message: asked });
    expect(promptOf(model.requests.at(-1)!)).toContain('「オークの原木を16個集める」をマイクラの体でやり終えた');
    expect(promptOf(model.requests.at(-1)!)).not.toContain('【機微:未分類・ライ氏だけが知っている】ゲームの記憶');
    await turn({ requestId: 's4-chat', message: asked });
    expect(promptOf(model.requests.at(-1)!)).toContain('【機微:未分類・ライ氏だけが知っている】ゲームの記憶');
    await turn({ requestId: 's4-friend', speaker: friend, message: asked });
    await turn({ requestId: 's4-friend-dm', speaker: friend, conversation: { kind: 'dm' }, message: asked });
    for (const request of model.requests.slice(-2)) expect(promptOf(request)).not.toContain('をマイクラの体でやり終えた');
    await close();
  });

  it('S5: while the body works on a request, its task line reaches the owner\'s turns only', async () => {
    const { turn, model, close } = harness();
    const body = { busyWith: 'request', task: '頼まれた秘密の箱づくり', dimension: 'overworld' };
    await turn({ requestId: 's5-owner', body });
    expect(promptOf(model.requests.at(-1)!)).toContain('頼まれた秘密の箱づくり');
    await turn({ requestId: 's5-friend', speaker: friend, body });
    expect(promptOf(model.requests.at(-1)!)).toContain('[マイクラの体の今]（');
    expect(promptOf(model.requests.at(-1)!)).not.toContain('頼まれた秘密の箱づくり');
    // Its own goal is game state, as before.
    await turn({ requestId: 's5-campaign', speaker: friend, body: { ...body, busyWith: 'campaign', task: 'エンドラを倒す' } });
    expect(promptOf(model.requests.at(-1)!)).toContain('エンドラを倒す');
    // Without busyWith the line may be a request too (N-2): the owner only.
    await turn({ requestId: 's5-unsaid', speaker: friend, body: { task: '頼まれた秘密の箱づくり' } });
    expect(promptOf(model.requests.at(-1)!)).not.toContain('頼まれた秘密の箱づくり');
    await turn({ requestId: 's5-unsaid-owner', body: { task: '頼まれた秘密の箱づくり' } });
    expect(promptOf(model.requests.at(-1)!)).toContain('頼まれた秘密の箱づくり');
    await close();
  });

  it('N4: a turn that carries scopeKey is refused', async () => {
    const { turn, refusal, model, close } = harness();
    expect(await refusal(turn({ requestId: 'n4', scopeKey: 'owner' }))).toBe('400 BAD_REQUEST');
    expect(model.requests).toEqual([]);
    await close();
  });
});

describe('review of 2026-10-06: model calls per speaker (S3, N3)', () => {
  const player = (index: number) => ({ uuid: `0f6a8c52-1b2d-4e3f-9a8b-${String(index).padStart(12, '0')}`, name: `Player_${index}` });

  it('never lets other players use up the owner\'s turns; one player has his own share', async () => {
    const { turn, refusal, model, close } = harness();
    for (let index = 0; index < 6; index += 1) await turn({ requestId: `p-${index}`, speaker: player(1) });
    const calls = model.requests.length;
    expect(await refusal(turn({ requestId: 'p-6', speaker: player(1) }))).toBe('429 RATE_LIMITED');
    expect(model.requests).toHaveLength(calls);
    // Another player, and the owner, are still answered.
    expect((await turn({ requestId: 'p2-0', speaker: player(2) })).reply).toBeTruthy();
    expect((await turn({ requestId: 'owner-after-spam' })).reply).toBeTruthy();
    await close();
  });

  it('caps all other players together below the bridge\'s person-turn limit, and still answers the owner', async () => {
    const { turn, refusal, close } = harness();
    for (let index = 0; index < 20; index += 1) await turn({ requestId: `many-${index}`, speaker: player(100 + index) });
    expect(await refusal(turn({ requestId: 'many-20', speaker: player(200) }))).toBe('429 RATE_LIMITED');
    expect((await turn({ requestId: 'owner-many' })).reply).toBeTruthy();
    await close();
  });

  it('counts only turns that reach the model: a refused device, a malformed turn and a replay cost nothing', async () => {
    const { turn, refusal, model, close, advance } = harness();
    for (let index = 0; index < 25; index += 1) {
      expect(await refusal(turn({ requestId: `x-${index}` }, 'body-pc'))).toBe('403 MINECRAFT_BODY_DEVICE_DENIED');
      expect(await refusal(turn({ requestId: `y-${index}`, message: '' }))).toBe('400 BAD_REQUEST');
    }
    await turn({ requestId: 'once' });
    for (let index = 0; index < 25; index += 1) expect((await turn({ requestId: 'once', observedAt: START })).duplicate).toBe(true);
    for (let index = 1; index < 20; index += 1) await turn({ requestId: `owner-${index}` });
    expect(model.requests).toHaveLength(20);
    expect(await refusal(turn({ requestId: 'owner-21' }))).toBe('429 RATE_LIMITED');
    advance(61_000);
    expect((await turn({ requestId: 'owner-22' })).reply).toBeTruthy();
    await close();
  });
});

describe('the intent field of the structured reply', () => {
  it('is in the schema only when offered, and is read back bounded', () => {
    const plain = chatTurnRequestBody('m', { scopeKey: 'owner', systemPrompt: 's', history: [], message: 'x' }, undefined);
    expect(JSON.stringify(plain)).not.toContain('minecraftIntent');
    const offered = chatTurnRequestBody('m', { scopeKey: 'owner', systemPrompt: 's', history: [], message: 'x', offerMinecraftIntent: true }, undefined) as {
      text: { format: { schema: { properties: Record<string, unknown>; required: string[] } } } };
    expect(offered.text.format.schema.properties.minecraftIntent).toBeDefined();
    expect(offered.text.format.schema.required).toContain('minecraftIntent');
    const turn = (minecraftIntent: unknown) => parseStructuredTurn(JSON.stringify({
      reply: 'はい', threadSummary: null, taskDecision: { disposition: 'none', reason: 'r' }, taskProposal: null, intentPlan: null, artifacts: null, minecraftIntent,
    }));
    expect(turn({ kind: 'task', goal: '  丸石を64個\n集める ' }).minecraftIntent).toEqual({ kind: 'task', goal: '丸石を64個 集める' });
    expect(turn({ kind: 'task', goal: 'あ'.repeat(200) }).minecraftIntent?.goal).toHaveLength(120);
    expect(turn({ kind: 'task', goal: '' }).minecraftIntent).toBeUndefined();
    expect(turn({ kind: 'stop', goal: 'x' }).minecraftIntent).toEqual({ kind: 'stop', goal: '' });
    expect(turn({ kind: 'fly' }).minecraftIntent).toBeUndefined();
    expect(turn(undefined).minecraftIntent).toBeUndefined();
  });
});

describe('game.died through POST /v1/body/events', () => {
  function bodyHarness() {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-game-body-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const clock = { at: START };
    const now = () => clock.at;
    const store = new SQLiteShannonStore({ path, now });
    const bodyStore = new SQLiteBodyStore(path);
    const experiences = new SQLiteGameExperiences(path);
    const api = createLocalApiKernel(now, { stateStore: store, conversationStore: store,
      body: { store: bodyStore, game: { deviceId: DEVICE, ownerScopeKey: 'owner', experiences } } });
    const events = async (deviceId: string, ...items: Record<string, unknown>[]) =>
      api.dispatch({ method: 'POST', path: '/v1/body/events', body: { scopeKey: 'owner', events: items }, deviceId });
    const memories = () => store.experienceCandidates('owner');
    const close = () => { experiences.close(); bodyStore.close(); store.close(); };
    return { api, store, bodyStore, events, memories, close, clock, path };
  }
  const died = (id: string, cause = 'minecraft:lava') => ({ id, type: 'game.died', audience: 'others', occurredAt: START, cause });

  it('is part of the closed vocabulary, with its own closed field', () => {
    expect(BODY_EVENT_TYPES).toEqual(expect.arrayContaining([...BODY_GAME_EVENT_TYPES]));
    expect(BODY_GAME_EVENT_TYPES).toEqual(['game.died']);
  });

  it('from her Minecraft body becomes one experience in the server\'s words, and moves no feeling', async () => {
    const { events, memories, store, close, path } = bodyHarness();
    const before = store.snapshot('owner');
    const first = await events(DEVICE, died('death-1'));
    expect(first.status).toBe(200);
    expect((first.body as BodyIngestReceipt).results).toEqual([{ id: 'death-1', status: 'stored' }]);
    const stored = memories();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.summary).toBe(gameDeathSummary('minecraft:lava', START));
    expect(stored[0]!.summary).toContain('マイクラで死んだ（溶岩）');
    expect(stored[0]!.disclosure).toMatchObject({ audience: { kind: 'owner' }, speaker: 'unknown' });
    expect(stored[0]!.userMessage).toMatch(/^body-game-[a-p]+$/u);
    expect(stored[0]!.shannonReply).toBe('');
    const reader = new DatabaseSync(path, { readOnly: true });
    const raw = JSON.parse((reader.prepare("SELECT payload_json FROM experience_events WHERE json_extract(payload_json, '$.source') = 'body.game'")
      .get() as { payload_json: string }).payload_json) as Record<string, unknown>;
    reader.close();
    expect(raw).toMatchObject({ source: BODY_GAME_SOURCE, game: { type: 'died', cause: 'minecraft:lava' } });

    // The retry stores nothing again; an unknown cause is remembered without one.
    expect(((await events(DEVICE, died('death-1'))).body as BodyIngestReceipt).results).toEqual([{ id: 'death-1', status: 'duplicate' }]);
    await events(DEVICE, died('death-2', 'somemod:cursed_pie'));
    expect(memories().map(memory => memory.summary)).toContain(gameDeathSummary('somemod:cursed_pie', START));
    expect(gameDeathSummary('somemod:cursed_pie', START)).toMatch(/マイクラで死んだ。$/u);
    expect(memories()).toHaveLength(2);
    expect(store.snapshot('owner').emotion).toEqual(before.emotion);
    close();
  });

  it('is ignored from any other device, and her Minecraft body reports nothing else', async () => {
    const { events, memories, bodyStore, close } = bodyHarness();
    expect(((await events('body-pc', died('death-x'))).body as BodyIngestReceipt).results)
      .toEqual([{ id: 'death-x', status: 'ignored', reason: 'not_game_body' }]);
    expect(((await events(DEVICE, { id: 'pet-1', type: 'pet', audience: 'owner', occurredAt: START })).body as BodyIngestReceipt).results)
      .toEqual([{ id: 'pet-1', status: 'ignored', reason: 'game_only' }]);
    expect(memories()).toEqual([]);
    // A death in the game says nothing about who is at the PC.
    await events(DEVICE, died('death-3'));
    expect(bodyStore.othersPresent('owner', START, 90_000, 30 * 60_000)).toBe(false);
    close();
  });

  it('is never a body that shows her or is touched: it cannot register, its reads say nothing of who is at the PC', async () => {
    const { api, events, bodyStore, close } = bodyHarness();
    const put = (deviceId: string, flags: Record<string, boolean> = {}) => api.dispatch({ method: 'PUT', path: '/v1/body/capabilities',
      body: { scopeKey: 'owner', expressions: [], gestures: [], flags, surface: 'windows' }, deviceId });
    const refused = await put(DEVICE);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('GAME_BODY_CAPABILITIES_DENIED');
    expect((await put(DEVICE, { touchOnly: true })).status).toBe(403);
    expect(bodyStore.capabilities('owner', DEVICE)).toBeNull();
    expect((await put('body-pc')).status).toBe(200);
    // Every event other than a game event from it is refused, a touch too.
    for (const item of [{ id: 'g-away', type: 'ownerAway', audience: 'others', occurredAt: START }, { id: 'g-call', type: 'callStarted', audience: 'owner', occurredAt: START },
      { id: 'g-pet', type: 'pet', audience: 'others', occurredAt: START }]) {
      expect(((await events(DEVICE, item)).body as BodyIngestReceipt).results).toEqual([{ id: item.id, status: 'ignored', reason: 'game_only' }]);
    }
    // Its game events and a presence read that says others are there change nothing of who is present.
    await events(DEVICE, died('g-death'));
    const presence = await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: 'owner', audience: 'others' }), deviceId: DEVICE });
    expect(presence.status).toBe(200);
    expect((presence.body as BodyPresence).capabilities).toBeNull();
    expect(bodyStore.othersPresent('owner', START, 90_000, 30 * 60_000)).toBe(false);
    close();
  });

  it('is never refused as a full body while the owner is in a call elsewhere, even with a registration from before', async () => {
    const { api, events, bodyStore, close } = bodyHarness();
    // A registration stored before this rule (the route refuses it now): the device is still not her full body.
    bodyStore.saveCapabilities('owner', DEVICE, { expressions: [], gestures: [], flags: {}, surface: 'windows' }, START);
    await api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: 'owner', expressions: [], gestures: [], flags: {}, surface: 'windows' }, deviceId: 'body-pc' });
    await events('iphone-app', { id: 'phone-call', type: 'callStarted', audience: 'owner', occurredAt: START });
    // The desktop is refused while he is in a call on his phone; her Minecraft body is not, and is never "the call elsewhere".
    expect(api.voiceSessions.refused('owner', 'body-pc', 'owner')).toBe(true);
    expect(api.voiceSessions.refused('owner', DEVICE, 'owner')).toBe(false);
    bodyStore.saveCapabilities('owner', 'body-pc', { expressions: [], gestures: [], flags: {}, surface: 'windows' }, START);
    // Its presence read notes no audience, so othersPresent stays as the desktop alone says.
    await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: 'owner', audience: 'others' }), deviceId: DEVICE });
    expect(bodyStore.othersPresent('owner', START, 90_000, 30 * 60_000)).toBe(false);
    close();
  });

  it('refuses a death without a namespaced cause, or with a field of another type', async () => {
    const { events, memories, close } = bodyHarness();
    for (const item of [{ ...died('d'), cause: undefined }, { ...died('d'), cause: 'lava' }, { ...died('d'), cause: 'Minecraft:Lava' },
      { ...died('d'), text: '溶岩で死んだ' }, { ...died('d'), minutesAway: 3 }, { id: 'p', type: 'pet', audience: 'owner', occurredAt: START, cause: 'minecraft:lava' }]) {
      expect((await events(DEVICE, item)).status).toBe(400);
    }
    expect(memories()).toEqual([]);
    close();
  });
});

describe('docs/minecraft-body-contract.md', () => {
  it('names the route, every field, error and reason the server uses', () => {
    const document = readFileSync(join(import.meta.dirname, '../../../docs/minecraft-body-contract.md'), 'utf8');
    for (const word of [MINECRAFT_BODY_TURN_PATH, 'SHANNON_MINECRAFT_BODY_JSON', '`requestId`', '`serverId`', '`conversation`', '`speaker`', '`message`',
      '`observedAt`', '`reply`', '`intent`', '`threadId`', '`duplicate`', '`ignored`', 'offline_server', 'people_disabled', 'rate_limited',
      'MINECRAFT_BODY_NOT_CONFIGURED', 'MINECRAFT_BODY_DEVICE_DENIED', 'MINECRAFT_BODY_SCOPE_DENIED', 'MINECRAFT_SERVER_DENIED',
      'MINECRAFT_TURN_CONFLICT', 'RATE_LIMITED', 'BAD_REQUEST', 'game.died', 'not_game_body', 'game_only', 'body.game',
      '`body`', '`task`', '`dimension`', '`health`', '`food`', '`timeOfDay`', '`recentAdvancements`', '`busyWith`', '[マイクラの体の今]',
      'GAME_BODY_CAPABILITIES_DENIED', 'GAME_BODY_DEVICE_DENIED', 'TextTurnSurface.ownOutreach', 'SHANNON_MINECRAFT_BODY_CAPABILITY', 'withMinecraftBodyLine']) {
      expect(document).toContain(word);
    }
  });
});
