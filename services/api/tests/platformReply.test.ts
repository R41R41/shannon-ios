import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, SHANNON_MINECRAFT_BODY_CAPABILITY, groupAudience } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import { createInMemoryAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import { OwnOutreach, type OwnOutreachReader } from '../src/surfaces/outreach/ownOutreach.js';
import { conversationCapabilityContext } from '../src/mind/action/respond/conversationCapabilities.js';
import { SQLiteSurfaceTurnLog } from '../src/surfaces/minecraft/store/minecraftTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeError, PlatformBridgeService, configuredPlatformBridge, platformBridgeThreadId } from '../src/surfaces/platform/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PLATFORM_REPLY_LIMITS, PlatformReplyService, SHANNON_PLATFORM_REPLY_PATH, platformReplyEnabled } from '../src/surfaces/platform/platformReply.js';
import { createConfiguredPlatformBridgeRoute, handlePlatformBridgeReply, isPlatformBridgePath } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { readApiSource } from './support/sources.js';

const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const DM = 'discord::555';
const CHANNEL = 'discord:111:222';
const START = '2026-10-05T12:00:00.000Z';
const TOKEN = 'b'.repeat(40);
const BINDINGS = [
  { platform: 'discord', conversationId: DM, ownerUserId: OWNER, title: 'ライ氏とのDM', audience: 'owner-private' },
  { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
];
const ENVIRONMENT = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(BINDINGS) };
const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A model that may call one tool, as the real one does through its tool session. */
class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly toolResults: string[] = [];
  callTool: { name: string; input: Record<string, unknown> } | null = null;
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    if (this.callTool && request.tools) this.toolResults.push(await request.tools.call(this.callTool.name, JSON.stringify(this.callTool.input)));
    return { mode: this.mode, model: this.model, reply: `はい、${this.requests.length}回目です。` };
  }
  /** Voice turns are recorded beside text turns (the review test of /v1/chat and voice). */
  async generateVoice(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい。' };
  }
}

function harness(options: { minecraft?: boolean; ownOutreach?: OwnOutreachReader } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-platform-reply-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse(START);
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const requests = options.minecraft ? new MinecraftBodyRequests(path, { deviceId: 'minebot-dev', ownerScopeKey: 'owner' }, now, null) : null;
  const autonomyStore = new SQLiteAutonomyStore(':memory:');
  const autonomy = createInMemoryAutonomyService(now, { store: autonomyStore, ...(requests ? { minecraftBody: requests } : {}) });
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background,
    peopleMemory: peopleStore, autonomy, ...(requests ? { minecraftRequests: requests } : {}), ...(options.ownOutreach ? { ownOutreach: options.ownOutreach } : {}) });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(ENVIRONMENT)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
  const service = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now });
  const reply = (fields: Record<string, unknown> = {}) => service.reply({
    platform: 'discord', requestId: `m-${Math.random().toString(36).slice(2)}`, conversationId: DM, sourceUserId: OWNER,
    userMessage: 'こんばんは', observedAt: now(), ...fields,
  });
  const refusal = async (operation: Promise<unknown>) => {
    try { await operation; return 'none'; } catch (error) { return error instanceof PlatformBridgeError ? `${error.status} ${error.code}` : String(error); }
  };
  const claim = async () => { const answer = await requests!.claim('owner', 'minebot-dev', { waitSeconds: 0, holding: [] }); if (typeof answer === 'string') throw new Error(answer); return answer; };
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    turns.close(); requests?.close(); autonomyStore.close(); peopleStore.close(); store.close();
  };
  return { store, peopleStore, background, bridge, api, model, reply, refusal, claim, requests, close, now, advance: (milliseconds: number) => { clock += milliseconds; } };
}

const dmThread = platformBridgeThreadId('discord', DM);
const channelThread = platformBridgeThreadId('discord', CHANNEL);

describe('POST /v1/platform/reply', () => {
  it('answers the owner in his private DM as the owner alone, and keeps the turn in his platform thread', async () => {
    const { reply, model, store, background, close } = harness();
    const answer = await reply({ requestId: 'dm-1', userMessage: '今日は寒いね' });
    expect(answer).toEqual({ reply: 'はい、1回目です。', threadId: dmThread, duplicate: false });
    const request = model.requests[0]!;
    expect(request.message).toBe('今日は寒いね');
    expect(promptOf(request)).toContain('[シャノンの人格]');
    expect(promptOf(request)).toContain('[Discordでの会話]');
    expect(promptOf(request)).not.toContain('[Shannon shared audience]');
    expect(request.offerMinecraftIntent).toBeUndefined();
    await background.waitForIdle('owner');
    expect(store.conversationHistory('owner', dmThread).map(message => message.content)).toEqual(['今日は寒いね', 'はい、1回目です。']);
    expect(store.experienceCandidates('owner')[0]?.disclosure?.audience).toEqual({ kind: 'owner' });
    // The next turn replays the same DM, as the app replays a Talk.
    await reply({ requestId: 'dm-2', userMessage: 'さっき何の話をした？' });
    expect(JSON.stringify(model.requests[1]!.history)).toContain('今日は寒いね');
    await close();
  });

  it('answers the owner in a shared channel with the shared header and no tools, and never with what he said was secret', async () => {
    const { reply, api, model, store, background, close, advance } = harness({ minecraft: true });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'これは内緒だけど、来月転職するつもり' } });
    await api.waitForBackground('owner');
    advance(10_000);
    await reply({ requestId: 'dm-secret', userMessage: 'ここだけの話、誕生日プレゼントはカメラにする' });
    await background.waitForIdle('owner');
    advance(10_000);
    const answer = await reply({ requestId: 'ch-1', conversationId: CHANNEL, conversationKind: 'channel', userMessage: '転職とカメラの話をして' });
    expect(answer.threadId).toBe(channelThread);
    const request = model.requests.at(-1)!;
    const sent = JSON.stringify([promptOf(request), request.history]);
    expect(sent).not.toContain('来月転職する');
    expect(sent).not.toContain('誕生日プレゼントはカメラ');
    expect(promptOf(request)).toContain('[Shannon shared audience]');
    expect(promptOf(request)).toContain('[Speak-time privacy check');
    expect(promptOf(request)).toContain('「テストサーバー」');
    expect(request.tools).toBeUndefined();
    expect(promptOf(request)).not.toContain('[マイクラの体で起きたこと]');
    await background.waitForIdle('owner');
    const kept = store.experienceCandidates('owner').find(item => item.userMessage === '転職とカメラの話をして');
    expect(kept?.disclosure?.audience).toEqual(groupAudience(channelThread));
    await close();
  });

  it('answers a friend as a guest, keeps the turn as person memory, and never in the owner\'s threads or his private DM', async () => {
    const { reply, refusal, model, store, peopleStore, close } = harness();
    const answer = await reply({ requestId: 'f-1', conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: '私は辛いものが苦手' });
    expect(Object.keys(answer).sort()).toEqual(['duplicate', 'reply', 'threadId']);
    expect(model.requests[0]!.message).toBe('ミキ: 私は辛いものが苦手');
    expect(model.requests[0]!.tools).toBeUndefined();
    expect(promptOf(model.requests[0]!)).toContain('話している相手は「ミキ」');
    expect(store.conversationHistory('owner', channelThread)).toEqual([]);
    expect(peopleStore.listPeople('owner').map(person => person.displayName)).toEqual(['ミキ']);
    // The owner's private DM is never answered for anyone else, and a friend must say who they are.
    expect(await refusal(reply({ conversationId: DM, conversationKind: 'dm', sourceUserId: FRIEND, sourceDisplayName: 'ミキ' }))).toBe('403 PLATFORM_ACTOR_DENIED');
    expect(await refusal(reply({ conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND }))).toBe('403 PLATFORM_ACTOR_DENIED');
    expect(await refusal(reply({ conversationId: CHANNEL, sourceUserId: FRIEND, sourceDisplayName: 'ミキ' }))).toBe('403 PLATFORM_ACTOR_DENIED');
    expect(model.requests).toHaveLength(1);
    await close();
  });

  it('answers a repeated requestId with the stored reply, without a second model call, and refuses changed content', async () => {
    const { reply, refusal, model, bridge, now, close } = harness();
    const first = await reply({ requestId: 'r-1', userMessage: 'ただいま', observedAt: now() });
    const again = await reply({ requestId: 'r-1', userMessage: 'ただいま', observedAt: now() });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(model.requests).toHaveLength(1);
    expect(await refusal(reply({ requestId: 'r-1', userMessage: 'おやすみ' }))).toBe('409 PLATFORM_TURN_CONFLICT');
    // A mirrored turn of the same message is the same receipt: it cannot store the turn a second time.
    expect(() => bridge.ingest({ platform: 'discord', requestId: 'r-1', conversationId: DM, sourceUserId: OWNER, userMessage: 'ただいま', shannonReply: '別の返事', observedAt: now() }))
      .toThrow(PlatformBridgeError);
    await close();
  });

  it('refuses an unbound conversation, an unknown field, Minecraft, and a stale message, before any model call', async () => {
    const { reply, refusal, model, now, close } = harness();
    expect(await refusal(reply({ conversationId: 'discord:999:1' }))).toBe('403 PLATFORM_CONVERSATION_DENIED');
    expect(await refusal(reply({ attachments: [] }))).toBe('400 BAD_REQUEST');
    expect(await refusal(reply({ shannonReply: 'x' }))).toBe('400 BAD_REQUEST');
    expect(await refusal(reply({ scopeKey: 'owner' }))).toBe('400 BAD_REQUEST');
    expect(await refusal(reply({ platform: 'minecraft' }))).toBe('400 BAD_REQUEST');
    expect(await refusal(reply({ observedAt: new Date(Date.parse(now()) - 31 * 60_000).toISOString() }))).toBe('400 BAD_REQUEST');
    expect(await refusal(reply({ userMessage: 'x'.repeat(PLATFORM_REPLY_LIMITS.messageCharacters + 1) }))).toBe('400 BAD_REQUEST');
    expect(model.requests).toHaveLength(0);
    await close();
  });
});

describe('one mind on Discord: requests to her Minecraft body', () => {
  it('offers minecraft.request in the owner\'s private DM only while the body is present, and queues the request there', async () => {
    const { reply, model, requests, claim, close } = harness({ minecraft: true });
    model.callTool = { name: 'minecraft_request', input: { goal: 'オークの原木を16個集める' } };
    await reply({ requestId: 'mc-absent', userMessage: 'マイクラで木材集めといて' });
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name) ?? []).not.toContain('minecraft.request');
    expect(requests!.recent('owner')).toEqual([]);
    await claim();
    await reply({ requestId: 'mc-1', userMessage: 'マイクラで木材集めといて' });
    expect(model.requests.at(-1)!.tools?.definitions.map(tool => tool.name)).toContain('minecraft.request');
    expect(requests!.recent('owner')).toHaveLength(1);
    expect(requests!.recent('owner')[0]).toMatchObject({ goal: 'オークの原木を16個集める', state: 'queued', origin: { surface: 'text', threadId: dmThread } });
    // The next turn with him alone knows what it asked.
    model.callTool = null;
    await reply({ requestId: 'mc-2', userMessage: '何頼んだっけ？' });
    expect(promptOf(model.requests.at(-1)!)).toContain('[マイクラの体で起きたこと]');
    expect(promptOf(model.requests.at(-1)!)).toContain('オークの原木を16個集める');
    // Never in a shared channel, nor for a friend.
    model.callTool = { name: 'minecraft_request', input: { goal: 'ダイヤを掘る' } };
    await reply({ requestId: 'mc-3', conversationId: CHANNEL, conversationKind: 'channel', userMessage: 'マイクラで木材集めといて' });
    expect(model.requests.at(-1)!.tools).toBeUndefined();
    await reply({ requestId: 'mc-4', conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: 'マイクラでダイヤ掘って' });
    expect(model.requests.at(-1)!.tools).toBeUndefined();
    expect(promptOf(model.requests.at(-1)!)).not.toContain('[マイクラの体で起きたこと]');
    expect(requests!.recent('owner')).toHaveLength(1);
    await close();
  });
});

describe('what a platform reply is not told', () => {
  it('is never told what she did on her own, in the owner\'s DM or a channel, while the app\'s chat is', async () => {
    const TEXT = 'ライ氏、お昼はもう食べましたか。';
    const ownOutreach: OwnOutreachReader = { recent: () => ({ messages: [{ createdAt: '2026-10-05T11:30:00.000Z', content: TEXT, read: true }], calls: [] }) };
    const { reply, api, model, close } = harness({ ownOutreach });
    await reply({ requestId: 'own-dm', userMessage: 'さっき電話した？' });
    await reply({ requestId: 'own-ch', conversationId: CHANNEL, userMessage: 'さっき電話した？' });
    for (const request of model.requests) expect(promptOf(request)).not.toContain('[ボクが自分からしたこと]');
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'さっき電話した？' } });
    expect(promptOf(model.requests.at(-1)!)).toContain(`ボクから送った「${TEXT}」（既読）`);
    await close();
  });

  it('says what her Minecraft body can do only in the owner\'s DM, where her tools are, and only while the body is in the game', async () => {
    const { reply, model, claim, close } = harness({ minecraft: true });
    const line = SHANNON_MINECRAFT_BODY_CAPABILITY.text;
    await reply({ requestId: 'cap-1' });
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    await claim();
    await reply({ requestId: 'cap-2' });
    expect(promptOf(model.requests.at(-1)!)).toContain(line);
    await reply({ requestId: 'cap-3', conversationId: CHANNEL });
    expect(promptOf(model.requests.at(-1)!)).not.toContain(line);
    await close();
  });
});

describe('the ownOutreach selection of the capability context (review of 2026-10-06)', () => {
  const TEXT = 'ライ氏、お昼はもう食べましたか。';
  const own = new OwnOutreach({ recent: () => ({ messages: [{ createdAt: '2026-10-05T11:30:00.000Z', content: TEXT, read: true }], calls: [] }) }, () => START);
  const prompt = async (selection: Parameters<typeof conversationCapabilityContext>[3]) =>
    (await conversationCapabilityContext('owner', 'さっき電話した？', { ownOutreach: own }, selection)).prompt;
  const FULL = `ボクから送った「${TEXT}」（既読）`;
  const TIMES = 'ボクから送った（中身はこの場では話さない）';

  it('(1) without it, follows upcoming exactly as before: in full, by times, or not at all', async () => {
    expect(await prompt({ upcoming: true })).toContain(FULL);
    expect(await prompt(undefined)).toContain(FULL);
    expect(await prompt({})).toContain(FULL);
    const guarded = await prompt({ upcoming: 'guarded' });
    expect(guarded).toContain(TIMES);
    expect(guarded).not.toContain(TEXT);
    expect(await prompt({ upcoming: false })).not.toContain('[ボクが自分からしたこと]');
    // Set, it decides on its own: by times where no upcoming item is read (game chat), or nothing where upcoming would give all.
    expect(await prompt({ upcoming: false, ownOutreach: 'guarded' })).toContain(TIMES);
    expect(await prompt({ upcoming: true, ownOutreach: false })).not.toContain('[ボクが自分からしたこと]');
  });

  it('(2) is set only for a surface turn, by the surface\'s switch, which only game chat turns on', () => {
    const source = (name: string) => readApiSource(name);
    const kernel = source('apiTextTurn.ts');
    // The app's chat passes its audience's selection untouched; only a surface (game chat, a platform reply) sets ownOutreach.
    expect(kernel).toContain('surface ? { ...audience.capabilities, ownOutreach: surfaceOwnOutreach(surface, audience) } : audience.capabilities');
    for (const name of ['apiKernel.ts', 'apiLiveVoice.ts', 'chatAudience.ts', 'platformSurface.ts', 'platformReply.ts', 'minecraftBody.ts']) {
      expect(source(name), name).not.toMatch(/ownOutreach:\s*(?:'guarded'|surfaceOwnOutreach)/u);
    }
    expect(source('minecraftBody.ts')).toMatch(/\n\s+ownOutreach: true,\n/u);
    expect(source('platformReply.ts')).toMatch(/\n\s+ownOutreach: false,\n/u);
  });

  it('(3) leaves /v1/chat and voice as they were: in full alone, by times with others, nothing for a guest call', async () => {
    const ownOutreach: OwnOutreachReader = { recent: () => ({ messages: [{ createdAt: '2026-10-05T11:30:00.000Z', content: TEXT, read: true }], calls: [] }) };
    const { api, model, close } = harness({ ownOutreach });
    const chat = (extra: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: 'さっき電話した？', ...extra } });
    const voice = (extra: { companionPresent?: boolean; participantMode?: 'guest' } = {}) => api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'owner', threadId: 'desktop', transcript: 'さっき電話した？', ...(extra.participantMode ? { participantMode: extra.participantMode } : {}),
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...(extra.companionPresent ? { companionPresent: true } : {}),
        userUtterance: { id: `u-${model.requests.length}-${Math.random()}`, text: 'さっき電話した？', source: 'speech', rawText: 'さっき電話した？',
          ...(extra.participantMode ? { callContext: { callId: 'call-guest-0001', turns: [], introductionStart: true } } : {}) } } } });
    await chat();
    expect(promptOf(model.requests.at(-1)!)).toContain(FULL);
    await chat({ audience: 'others' });
    expect(promptOf(model.requests.at(-1)!)).toContain(TIMES);
    expect(promptOf(model.requests.at(-1)!)).not.toContain(TEXT);
    const before = model.requests.length;
    await voice();
    await voice({ companionPresent: true });
    await voice({ participantMode: 'guest' });
    const prompts = model.requests.slice(before).map(request => promptOf(request));
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(FULL);
    expect(prompts[1]).toContain(TIMES);
    expect(prompts[1]).not.toContain(TEXT);
    expect(prompts[2]).not.toContain('[ボクが自分からしたこと]');
    await close();
  });
});

describe('a Discord friend\'s turn (owner decision S6, 2026-10-06)', () => {
  const HOSPITAL = 'ユーザーは来週オカメインコ病院に行く';
  const RELEASE = 'ライ氏本人がこの場ではっきり求めた時';
  it('gets no protected line of the owner\'s and no rule that he may release one, in a reply and in the context; his own turn keeps both', async () => {
    const { reply, model, store, bridge, close } = harness();
    store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'fact-hospital', statement: HOSPITAL, confidence: 0.9, observedAt: START,
      disclosure: { audience: OWNER_AUDIENCE, sensitivity: 'sensitive', category: 'health', reason: '病院', decidedBy: 'rule' } } });
    await reply({ requestId: 'd-owner', conversationId: CHANNEL, conversationKind: 'channel', userMessage: 'オカメインコ病院の話' });
    expect(promptOf(model.requests.at(-1)!)).toContain(`【機微:健康・ライ氏だけが知っている】${HOSPITAL}`);
    expect(promptOf(model.requests.at(-1)!)).toContain(RELEASE);
    await reply({ requestId: 'd-friend', conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: 'ライ氏はオカメインコ病院に行くの？' });
    const friend = promptOf(model.requests.at(-1)!);
    expect(friend).toContain('[Shannon shared audience]');
    for (const word of ['オカメインコ病院に行く', RELEASE, 'When ライ氏 himself clearly asks']) expect(friend).not.toContain(word);
    expect(friend).not.toMatch(/【機微:(?!…】)/u);
    // `/v1/platform/context` for the same people: the friend's projection is open items only, the owner's as before.
    const context = (sourceUserId: string) => bridge.context({ platform: 'discord', conversationId: CHANNEL, sourceUserId, conversationKind: 'channel' }).projection;
    expect(context(FRIEND)).not.toContain(HOSPITAL);
    expect(context(FRIEND)).not.toContain(RELEASE);
    expect(context(OWNER)).toContain(`【機微:健康・ライ氏だけが知っている】${HOSPITAL}`);
    expect(context(OWNER)).toContain(RELEASE);
    await close();
  });
});

describe('a Discord friend\'s turn and the owner\'s intentions (second review, 2026-10-06)', () => {
  it('carries no current goal and no intention frame of his', async () => {
    const { reply, api, model, close } = harness();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'app-talk', message: '私の目標は新しい家計簿アプリを完成させることです' } });
    await api.waitForBackground('owner');
    expect(promptOf(model.requests.at(-1)!)).toContain('家計簿アプリ');
    await reply({ requestId: 'goal-friend', conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: 'こんにちは' });
    const sent = JSON.stringify([promptOf(model.requests.at(-1)!), model.requests.at(-1)!.history]);
    for (const word of ['家計簿', 'current_goal=', 'Current intention frame', 'Primary objective']) expect(sent, word).not.toContain(word);
    await close();
  });
});

describe('model calls of /v1/platform/reply per speaker (second review, 2026-10-06)', () => {
  it('never lets other people use up the owner\'s replies; each person has a share; refused and repeated turns cost nothing', async () => {
    const { reply, refusal, model, close } = harness();
    const friend = (index: number, requestId: string) => reply({ requestId, conversationId: CHANNEL, conversationKind: 'channel',
      sourceUserId: `90000000000000${String(index).padStart(4, '0')}`, sourceDisplayName: `友達${index}`, userMessage: 'やあ' });
    for (let index = 0; index < 6; index += 1) await friend(10, `a-${index}`);
    expect(await refusal(friend(10, 'a-6'))).toBe('429 RATE_LIMITED');
    expect((await friend(10, 'a-0')).duplicate).toBe(true);
    for (let index = 0; index < 14; index += 1) await friend(20 + index, `b-${index}`);
    expect(await refusal(friend(99, 'b-x'))).toBe('429 RATE_LIMITED');
    const calls = model.requests.length;
    expect(calls).toBe(20);
    // The owner, in his DM and in the channel, is still answered.
    expect((await reply({ requestId: 'owner-dm' })).reply).toBeTruthy();
    expect((await reply({ requestId: 'owner-ch', conversationId: CHANNEL, conversationKind: 'channel' })).reply).toBeTruthy();
    // A stale message is refused before it is counted.
    expect(await refusal(reply({ requestId: 'stale', observedAt: '2026-10-05T10:00:00.000Z' }))).toBe('400 BAD_REQUEST');
    await close();
  });
});

describe('B-1: a Discord friend\'s DM (second review follow-up, 2026-10-06)', () => {
  it('reaches no other friend\'s turn and not the owner\'s channel turn; it reaches that friend\'s own DM', async () => {
    const { reply, model, close } = harness();
    const taroDm = 'discord:111:777';
    const taro = { conversationId: taroDm, conversationKind: 'dm', sourceUserId: '900000000000000007', sourceDisplayName: 'タロウ' };
    await reply({ requestId: 'b1-taro', ...taro, userMessage: 'ぼくの拠点の座標はX1200 Z-340だよ' });
    const asked = 'タロウの拠点の座標ってどこ？';
    await reply({ requestId: 'b1-miki', conversationId: CHANNEL, conversationKind: 'channel', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: asked });
    await reply({ requestId: 'b1-miki-dm', conversationId: 'discord:111:888', conversationKind: 'dm', sourceUserId: FRIEND, sourceDisplayName: 'ミキ', userMessage: asked });
    await reply({ requestId: 'b1-owner', conversationId: CHANNEL, conversationKind: 'channel', userMessage: asked });
    for (const request of model.requests.slice(-3)) expect(JSON.stringify([promptOf(request), request.history])).not.toContain('X1200');
    await reply({ requestId: 'b1-taro-2', ...taro, userMessage: 'ぼくの拠点の座標、覚えてる？' });
    expect(promptOf(model.requests.at(-1)!)).toContain('X1200');
    await close();
  });
});

describe('a friend\'s DM in the platform context (final review, 2026-10-06)', () => {
  it('never reaches the owner\'s channel turn, even with that friend as a participant; it reaches the friend\'s own DM', async () => {
    const { reply, model, bridge, peopleStore, api, close } = harness();
    const taroDm = 'discord:111:777';
    const TARO = '900000000000000007';
    await reply({ requestId: 'f-taro', conversationId: taroDm, conversationKind: 'dm', sourceUserId: TARO, sourceDisplayName: 'タロウ', userMessage: '明日、X1200の拠点で釣りをする' });
    expect(peopleStore.items('owner').some(item => item.text.includes('X1200'))).toBe(true);
    const context = (sourceUserId: string, conversationId: string, conversationKind: 'channel' | 'dm') =>
      bridge.context({ platform: 'discord', conversationId, sourceUserId, conversationKind, participants: [TARO] }).projection;
    // The owner's channel turn with Taro present: his DM stays out of the context, and of the reply route's prompt.
    expect(context(OWNER, CHANNEL, 'channel')).not.toContain('X1200');
    expect(context(OWNER, CHANNEL, 'channel')).toContain('タロウさん');
    await reply({ requestId: 'f-owner', conversationId: CHANNEL, conversationKind: 'channel', participants: [TARO], userMessage: 'タロウは明日何するって？' });
    expect(JSON.stringify([promptOf(model.requests.at(-1)!), model.requests.at(-1)!.history])).not.toContain('X1200');
    // Another friend in the channel: neither.
    expect(context(FRIEND, CHANNEL, 'channel')).not.toContain('X1200');
    // Taro's own DM still has it.
    expect(context(TARO, taroDm, 'dm')).toContain('X1200');
    // An item the owner made ordinary (ふつう) himself may reach his channel turn.
    for (const item of peopleStore.items('owner').filter(candidate => candidate.kind !== 'turn' && candidate.text.includes('X1200'))) {
      expect((await api.dispatch({ method: 'POST', path: '/v1/people/memory/action', body: { scopeKey: 'owner', itemId: item.id, action: 'mark-ordinary' } })).status).toBe(200);
    }
    expect(context(OWNER, CHANNEL, 'channel')).toContain('X1200');
    await close();
  });
});

describe('the route', () => {
  it('takes the bridge token only, and answers 503 unless SHANNON_PLATFORM_REPLY is on', async () => {
    expect(platformReplyEnabled({})).toBe(false);
    expect(platformReplyEnabled({ SHANNON_PLATFORM_REPLY: 'on' })).toBe(true);
    expect(isPlatformBridgePath(SHANNON_PLATFORM_REPLY_PATH)).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), 'shannon-platform-reply-route-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const now = () => new Date().toISOString();
    const store = new SQLiteShannonStore({ path, now });
    const background = new BackgroundUpdateCoordinator(store, store);
    const model = new Model();
    const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, background });
    const replies = { conversation: api, databasePath: path };
    const off = createConfiguredPlatformBridgeRoute(ENVIRONMENT, store, store, background, now, model, null, replies)!;
    const on = createConfiguredPlatformBridgeRoute({ ...ENVIRONMENT, SHANNON_PLATFORM_REPLY: 'on' }, store, store, background, now, model, null, replies)!;
    const listen = async (dependencies: typeof on) => {
      const server = createServer((request, response) => { void handlePlatformBridgeReply(request, response, dependencies); });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test port');
      return `http://127.0.0.1:${address.port}${SHANNON_PLATFORM_REPLY_PATH}`;
    };
    const body = JSON.stringify({ platform: 'discord', requestId: 'route-1', conversationId: DM, sourceUserId: OWNER, userMessage: 'やあ', observedAt: now() });
    const post = (url: string, token?: string) => fetch(url, { method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const offUrl = await listen(off);
    expect((await post(offUrl, TOKEN)).status).toBe(503);
    const onUrl = await listen(on);
    expect((await post(onUrl)).status).toBe(401);
    expect((await post(onUrl, 'x'.repeat(40))).status).toBe(401);
    const created = await post(onUrl, TOKEN);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ reply: 'はい、1回目です。', threadId: dmThread, duplicate: false });
    expect((await post(onUrl, TOKEN)).status).toBe(200);
    expect(model.requests).toHaveLength(1);
    await background.waitForIdle('owner');
    off.close?.(); on.close?.(); store.close();
  });
});

describe('docs/platform-people-contract.md (replies)', () => {
  it('names the reply route, its switch, fields and codes', () => {
    const contract = readFileSync(new URL('../../../docs/platform-people-contract.md', import.meta.url), 'utf8');
    for (const name of [SHANNON_PLATFORM_REPLY_PATH, 'SHANNON_PLATFORM_REPLY', 'PLATFORM_REPLY_DISABLED', 'userMessage', 'sourceDisplayName', 'participants', 'duplicate', 'ignored', 'minecraft.request']) {
      expect(contract).toContain(name);
    }
  });
});
