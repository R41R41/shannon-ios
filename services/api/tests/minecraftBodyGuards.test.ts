import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disclosureDecision, groupAudience } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { conversationReplay, openItems } from '../src/conversationWindow.js';
import { ShannonTurnMemoryRecall } from '../src/turnMemoryRecall.js';
import type { SemanticMemoryRecall } from '../src/semanticMemoryRecall.js';
import { extractExplicitUserIntent } from '../src/cognitiveIntent.js';
import { prepareTurnCognitiveContext } from '../src/turnCognitiveContext.js';
import { minecraftBodyRoute } from '../src/serverMinecraftBodyRoute.js';
import type { MinecraftBody } from '../src/minecraftBody.js';
import { configuredMinecraftBody } from '../src/minecraftBodyContract.js';
import { withoutGuardedEntries } from '../src/apiTextTurn.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import { LocalStubChatModel } from '../src/chatModel.js';
import { GAME_DISCLOSURE, GAME_REQUEST_DISCLOSURE } from '../src/gameBodyMemory.js';
import { MINECRAFT_BODY_LIMITS } from '../src/minecraftBodyContract.js';
import { requestExperience } from '../src/minecraftBodyRequests.js';
import { MINECRAFT_TURN_ALLOWANCE, MinecraftTurnAllowance } from '../src/minecraftTurnAllowance.js';
import { SQLiteSurfaceTurnLog } from '../src/minecraftTurnStore.js';
import { PLATFORM_REPLY_LIMITS } from '../src/platformReply.js';
import { createMinecraftBodyWiring, gameBodyMayCall } from '../src/serverMinecraftBodyWiring.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

/** The review of 2026-10-06 of the Minecraft body branch: S1, S3, S4, N2 and N5 at their units. */
const DEVICE = 'minebot-dev';
const START = '2026-10-06T12:00:00.000Z';
const CONFIGURATION = JSON.stringify({ deviceId: DEVICE, servers: [{ serverId: 'lab', ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', title: 'ラボ', onlineMode: true }] });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const databasePath = () => { const directory = mkdtempSync(join(tmpdir(), 'shannon-minecraft-guards-')); directories.push(directory); return join(directory, 'shannon.sqlite'); };

function sent() {
  const result: { status?: number; error?: string } = {};
  const response = { writeHead: (status: number) => { result.status = status; }, end: (text: string) => { result.error = (JSON.parse(text) as { error?: string }).error; } } as unknown as ServerResponse;
  return { response, result };
}
const request = (method: string, authorization = '') => ({ method, headers: { authorization } }) as unknown as IncomingMessage;
const principal = (deviceId: string) => ({ deviceId, scopeKey: 'owner', displayName: deviceId });

describe('S1: the token of her Minecraft body reaches its own routes only', () => {
  it('knows which calls the body may make', () => {
    for (const [method, path] of [['POST', '/v1/body/minecraft/turns'], ['POST', '/v1/body/minecraft/claim'], ['POST', '/v1/body/events'], ['GET', '/v1/body/presence']]) {
      expect(gameBodyMayCall(method, path!), path).toBe(true);
    }
    for (const [method, path] of [['POST', '/v1/chat'], ['PUT', '/v1/body/capabilities'], ['POST', '/v1/body/reactions'], ['GET', '/v1/memories'],
      ['POST', '/v1/agent/host/steps/claim'], ['GET', '/v1/devices'], ['POST', '/v1/voice/gemini/cascade/delegations'], ['GET', '/v1/body/events']]) {
      expect(gameBodyMayCall(method, path!), path).toBe(false);
    }
  });

  it('refuses the body everywhere else before anything is read, and leaves every other device alone', async () => {
    const path = databasePath();
    const now = () => START;
    const store = new SQLiteShannonStore({ path, now });
    const wiring = createMinecraftBodyWiring({ SHANNON_MINECRAFT_BODY_JSON: CONFIGURATION }, path, now);
    wiring.connect({ stateStore: store, conversationStore: store, background: new BackgroundUpdateCoordinator(store, store), now,
      chatModel: new LocalStubChatModel(), peopleStore: null, conversation: { textTurn: () => { throw new Error('not called'); } } });
    for (const [method, route] of [['POST', '/v1/chat'], ['PUT', '/v1/body/capabilities'], ['GET', '/v1/memories'], ['POST', '/v1/agent/host/steps/claim']]) {
      const { response, result } = sent();
      expect(await wiring.serve(request(method!), response, route!, principal(DEVICE))).toBe(true);
      expect(result).toEqual({ status: 403, error: 'GAME_BODY_DEVICE_DENIED' });
    }
    for (const [method, route] of [['POST', '/v1/body/events'], ['GET', '/v1/body/presence']]) {
      expect(await wiring.serve(request(method!), sent().response, route!, principal(DEVICE))).toBe(false);
      // Review of A17, B1: never as an app's desktop body, which would escape every rule of the game body.
      const asBody = sent();
      const withHeader = { method, headers: { authorization: '', 'x-shannon-body': 'desktop' } } as unknown as IncomingMessage;
      expect(await wiring.serve(withHeader, asBody.response, route!, principal(DEVICE))).toBe(true);
      expect(asBody.result).toEqual({ status: 403, error: 'GAME_BODY_DEVICE_DENIED' });
      expect(wiring.isGameDevice(principal(DEVICE))).toBe(true);
      expect(wiring.isGameDevice(principal('owner-mac'))).toBe(false);
    }
    // The header is an app's own business: the Mac app's body is not held back.
    const mac = { method: 'GET', headers: { authorization: '', 'x-shannon-body': 'desktop' } } as unknown as IncomingMessage;
    expect(await wiring.serve(mac, sent().response, '/v1/body/presence', principal('owner-mac'))).toBe(false);
    // The owner's apps are not held back, and the body's own routes are answered (the owner's list is his apps' only).
    expect(await wiring.serve(request('POST'), sent().response, '/v1/chat', principal('owner-iphone'))).toBe(false);
    const list = sent();
    expect(await wiring.serve(request('GET'), list.response, '/v1/body/minecraft/requests', principal(DEVICE))).toBe(true);
    expect(list.result).toEqual({ status: 403, error: 'MINECRAFT_OWNER_ONLY' });
    const owners = sent();
    expect(await wiring.serve(request('GET'), owners.response, '/v1/body/minecraft/requests', principal('owner-iphone'))).toBe(true);
    expect(owners.result.status).toBe(200);
    // The operations console authenticates on its own: the body's token is refused there too.
    const devices = { authenticate: (authorization: string | undefined) => authorization === 'Bearer body' ? principal(DEVICE) : authorization === 'Bearer app' ? principal('owner-mac') : null };
    const console = sent();
    expect(wiring.refusesConsole(request('GET', 'Bearer body'), console.response, devices)).toBe(true);
    expect(console.result).toEqual({ status: 403, error: 'GAME_BODY_DEVICE_DENIED' });
    expect(wiring.refusesConsole(request('GET', 'Bearer app'), sent().response, devices)).toBe(false);
    wiring.close();
    store.close();
  });

  it('without SHANNON_MINECRAFT_BODY_JSON holds no device back', async () => {
    const path = databasePath();
    const wiring = createMinecraftBodyWiring({}, path, () => START);
    expect(await wiring.serve(request('POST'), sent().response, '/v1/chat', principal(DEVICE))).toBe(false);
    expect(wiring.refusesConsole(request('GET', 'Bearer body'), sent().response, { authenticate: () => principal(DEVICE) })).toBe(false);
    wiring.close();
  });

  it('is applied by the server right after authentication, before every other device route, and before the operations console', () => {
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const gate = server.indexOf('await minecraft.serve(request, response, url.pathname, principal)');
    expect(gate).toBeGreaterThan(server.indexOf("error: 'PAIRING_REQUIRED'"));
    expect(gate).toBeLessThan(server.indexOf('url.pathname === SHANNON_NOW_PATH'));
    expect(server).toContain('if (!minecraft.refusesConsole(request, response, deviceAuth)) await opsRoute(');
    // Review of A17, B1: no desktop-body identity is ever derived for the game token, and it is derived after the gate.
    expect(server).toContain("url.pathname, () => mayHaveDesktopBody({ isGame: minecraft.isGameDevice(principal),");
    expect(server.indexOf('requestDeviceId(principal.deviceId')).toBeGreaterThan(gate);
  });
});

describe('S3: model calls of game chat per speaker', () => {
  it('counts the owner apart, each player and all players, by the minute and by the day, and counts nothing it refused', () => {
    const allowance = new MinecraftTurnAllowance({ ...MINECRAFT_TURN_ALLOWANCE, speakerPerDay: 8, othersPerDay: 12, ownerPerDay: 30 });
    const at = Date.parse(START);
    for (let index = 0; index < 6; index += 1) expect(allowance.take(false, 'a', at)).toBe(true);
    expect(allowance.take(false, 'a', at)).toBe(false);
    expect(allowance.take(true, 'owner', at)).toBe(true);
    expect(allowance.take(false, 'a', at + 60_000)).toBe(true);
    expect(allowance.take(false, 'a', at + 60_000)).toBe(true);
    // A day's cap for one player, and for everyone else together; the owner keeps his own.
    expect(allowance.take(false, 'a', at + 120_000)).toBe(false);
    for (let index = 0; index < 4; index += 1) expect(allowance.take(false, `b${index}`, at + 120_000)).toBe(true);
    expect(allowance.take(false, 'c', at + 120_000)).toBe(false);
    expect(allowance.take(true, 'owner', at + 120_000)).toBe(true);
    expect(allowance.take(false, 'c', at + 24 * 60 * 60_000 + 120_000)).toBe(true);
    expect(MINECRAFT_TURN_ALLOWANCE.othersPerMinute).toBeLessThanOrEqual(120);
  });
});

describe('S4: what is remembered of her Minecraft body, and who may hear it', () => {
  it('keeps a finished request the owner\'s (guarded with others) and her death open, as the game announces it', () => {
    expect(GAME_REQUEST_DISCLOSURE).toMatchObject({ sensitivity: 'sensitive', decidedBy: 'rule' });
    expect(disclosureDecision(GAME_REQUEST_DISCLOSURE, groupAudience('platform:minecraft:x'))).toBe('guarded');
    expect(disclosureDecision(GAME_DISCLOSURE, groupAudience('platform:minecraft:x'))).toBe('open');
    const experience = requestExperience('owner', DEVICE, { id: 'r1', goal: 'オークの原木を16個集める', state: 'done', origin: { surface: 'app' },
      createdAt: START, updatedAt: START, finishedAt: START, cancelRequested: false } as unknown as Parameters<typeof requestExperience>[2]);
    expect(experience.disclosure).toBe(GAME_REQUEST_DISCLOSURE);
  });
});

describe('N2: stored answers of game chat and platform replies', () => {
  it('are kept one day, longer than the 30 minutes a turn is answered, and deleted at a later answer', () => {
    expect(MINECRAFT_BODY_LIMITS.replayDays).toBe(1);
    expect(PLATFORM_REPLY_LIMITS.replayDays).toBe(1);
    const log = new SQLiteSurfaceTurnLog(databasePath(), 'minecraft_body_turns');
    log.save('owner', 'old', DEVICE, 'h', { reply: 'はい' }, START, 1);
    expect(log.find('owner', 'old')).not.toBeNull();
    log.save('owner', 'new', DEVICE, 'h', { reply: 'はい' }, new Date(Date.parse(START) + 25 * 60 * 60_000).toISOString(), 1);
    expect(log.find('owner', 'old')).toBeNull();
    expect(log.find('owner', 'new')).not.toBeNull();
    log.close();
  });
});

describe('N5: what a turn nobody but the owner may release is given', () => {
  it('leaves out every protected entry whole, also when its text runs over several lines', () => {
    const text = [
      '[記憶]',
      '- ユーザーは紅茶が好き',
      '- 【機微:健康・ライ氏だけが知っている】ユーザーは来週',
      'オカメインコ病院に行く（続きの行）',
      '  さらに続く行',
      '- ユーザーは猫を飼っている',
      '【機微:未分類・ライ氏だけが知っている】今日の関心: 転職',
      '',
      '[次の区画]',
    ].join('\n');
    expect(withoutGuardedEntries(text)).toBe(['[記憶]', '- ユーザーは紅茶が好き', '- ユーザーは猫を飼っている', '', '[次の区画]'].join('\n'));
  });

  it('leaves out a whole block marked by a marker alone on its line, up to the next blank line (second review)', () => {
    const text = ['[今日の関心]', '- 散歩', '', '【機微:未分類・ライ氏だけが知っている】', '[Current intention frame]', 'Primary objective: 家計簿アプリ',
      '- Desired outcome: 完成', '', '[次の区画]'].join('\n');
    expect(withoutGuardedEntries(text)).toBe(['[今日の関心]', '- 散歩', '', '', '[次の区画]'].join('\n'));
  });

  it('leaves out a whole block whose header line opens with the marker, as upstream places it on the intention frame', () => {
    const text = ['[Current cognitive context — use before answering]', 'Situation: channel=text', '',
      '【機微:未分類・ライ氏だけが知っている】[Current intention frame — durable, owner-visible, and evidence-backed]',
      'Primary objective: 家計簿アプリ', 'Desired outcome: 完成', 'Owner-visible plan proposal:', '1. 画面を作る', '- 箇条書きの続き', '',
      '[ライ氏についての記憶 — ほかの人がいる場]', '- ユーザーは紅茶が好き', '- 【機微:健康・ライ氏だけが知っている】ユーザーは通院している', '- ユーザーは猫を飼っている'].join('\n');
    expect(withoutGuardedEntries(text)).toBe(['[Current cognitive context — use before answering]', 'Situation: channel=text', '', '',
      '[ライ氏についての記憶 — ほかの人がいる場]', '- ユーザーは紅茶が好き', '- ユーザーは猫を飼っている'].join('\n'));
  });
});

describe('the replay of a turn that may show only open items (second review, 2026-10-06)', () => {
  it('gives no summary and no marked message, while the same replay for the owner\'s turn with others keeps both, marked', async () => {
    const at = '2026-10-02T03:00:00.000Z';
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at });
    const state = store;
    const api = createLocalApiKernel(() => at, { conversationStore: store, stateStore: store });
    // Enough open talk to pass the replay budget on its own (so a summary would be used even for open items), and among it
    // words the rule labels sensitive (health).
    const long = '。'.repeat(150);
    for (let index = 0; index < 60; index += 1) {
      const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: { scopeKey: 'owner', threadId: 'thread',
        userTranscript: index % 4 === 3 ? `持病の通院の話${index}${long}` : `今日の天気の話${index}${long}`, shannonTranscript: `ボクの返事${index}${long}` } });
      expect(response.status).toBe(201);
    }
    store.saveReplaySummary('owner', 'thread', { summary: 'ゼブラ要約', coveredThroughMessageId: 'none', chainStartedAt: at, updatedAt: at });
    const present = groupAudience('platform:minecraft:lab');
    const marked = conversationReplay('text', state.snapshot('owner'), store, 'owner', 'thread', present).request('system');
    expect(marked.turnContext).toContain('ゼブラ要約');
    expect(JSON.stringify(marked.history)).toContain('【機微:');
    const open = conversationReplay('text', state.snapshot('owner'), store, 'owner', 'thread', present, undefined, undefined, true).request('system');
    expect(open.turnContext).toBe('system');
    expect(JSON.stringify(open.history)).not.toContain('【機微:');
    expect(open.history.some(item => item.content.includes('今日の天気の話'))).toBe(true);
    expect(open.history.some(item => item.content.includes('通院'))).toBe(false);
    // The reply to a marked message is left out with it.
    for (const index of [3, 7, 11, 55, 59]) expect(open.history.some(item => item.content.startsWith(`ボクの返事${index}。`)), String(index)).toBe(false);
    expect(open.history.some(item => item.content.startsWith('ボクの返事58。'))).toBe(true);
    await api.waitForBackground('owner');
    store.close();
  });
});

describe('N-5: a cheap guard on the turn route before any validation', () => {
  it('takes at most 120 requests a minute from one device, invalid ones too', async () => {
    let calls = 0;
    const service = { turn: async () => { calls += 1; throw new (await import('../src/minecraftBodyContract.js')).MinecraftBodyError('BAD_REQUEST', 400, 'x'); } } as unknown as MinecraftBody;
    const route = minecraftBodyRoute(service, configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: CONFIGURATION }));
    const statuses: number[] = [];
    for (let index = 0; index < 121; index += 1) {
      const { response, result } = sent();
      await route.handle(request('POST'), response, '/v1/body/minecraft/turns', {}, principal(DEVICE));
      statuses.push(result.status!);
    }
    expect(statuses.slice(0, 120).every(status => status === 400)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect(calls).toBe(120);
    expect(MINECRAFT_BODY_LIMITS.deviceRequestsPerMinute).toBe(120);
  });
});

describe('his intentions in a turn that may show only open items (second review, 2026-10-06)', () => {
  it('are left out where the context is made: no current_goal and no intention frame, while the owner\'s own turn with others has them marked', () => {
    const at = '2026-10-06T12:00:00.000Z';
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at });
    const intent = extractExplicitUserIntent('私の目標は新しい家計簿アプリを完成させることです', 'app-talk', at);
    expect(intent).not.toBeNull();
    // A protected fact, and a protected promise whose words the message repeats (a goal taken from a promise).
    const sensitive = { audience: { kind: 'owner' as const }, sensitivity: 'sensitive' as const, category: 'health' as const, reason: '病院', decidedBy: 'rule' as const };
    store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'fact-h', statement: 'ユーザーは来週オカメインコ病院に行く', confidence: 0.9, observedAt: at, disclosure: sensitive } });
    store.apply('owner', { type: 'prospective-memory-upserted', memory: { id: 'promise-h', summary: 'ペンギン歯科の予約を入れる', status: 'pending', createdAt: at, updatedAt: at, disclosure: sensitive } });
    const context = (openOnly: boolean) => prepareTurnCognitiveContext(store.snapshot('owner'), store, {
      scopeKey: 'owner', message: 'こんにちは、ペンギン歯科の予約の話', occurredAt: at, channel: 'text', present: groupAudience('platform:minecraft:lab'),
      intents: [{ ...intent!, status: 'active' }], ...(openOnly ? { openOnly } : {}),
    });
    const owner = context(false).prompt;
    expect(owner).toContain('家計簿アプリ');
    expect(owner).toContain('【機微:未分類・ライ氏だけが知っている】');
    expect(owner).toContain('【機微:健康・ライ氏だけが知っている】ユーザーは来週オカメインコ病院に行く');
    const open = context(true);
    for (const word of ['家計簿', 'current_goal=', 'Current intention frame', 'Primary objective', 'オカメインコ病院', 'ペンギン歯科']) expect(open.prompt, word).not.toContain(word);
    expect(open.situation.currentGoal).toBeUndefined();
    // No marked item (the profile's header still names the marker as such: 【機微:…】).
    expect(open.prompt).not.toMatch(/【機微:(?!…】)/u);
    expect(open.frame.primaryIntent).toBeUndefined();
    expect(open.openOnly).toBe(true);
    store.close();
  });
});

describe('nits of the third review (2026-10-06)', () => {
  it('N-c: drops every reply that answered a marked message, also a second one in a row', () => {
    const items = [
      { role: 'user' as const, content: '【機微:健康・ライ氏だけが知っている】通院の話' },
      { role: 'assistant' as const, content: '返事1' }, { role: 'assistant' as const, content: '返事2' },
      { role: 'user' as const, content: '天気の話' }, { role: 'assistant' as const, content: '返事3' }, { role: 'assistant' as const, content: '返事4' },
    ];
    expect(openItems(items).map(item => item.content)).toEqual(['天気の話', '返事3', '返事4']);
  });

  it('N-a: a turn someone else wrote gets no frame saying the owner asks what she remembers', async () => {
    const semantic = { available: false, maximumModelCallsPerTurn: 0, timeoutMilliseconds: 0, modelGateway: null,
      recall: async () => ({ status: 'skipped', hits: [], modelCalls: 0, elapsedMilliseconds: 0 }) } as unknown as SemanticMemoryRecall;
    const recall = new ShannonTurnMemoryRecall(semantic, null);
    const at = '2026-10-06T12:00:00.000Z';
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at });
    const context = (openOnly: boolean) => prepareTurnCognitiveContext(store.snapshot('owner'), store, {
      scopeKey: 'owner', message: '何を覚えてる？', occurredAt: at, channel: 'text', present: groupAudience('platform:minecraft:lab'), ...(openOnly ? { openOnly } : {}) });
    const input = { scopeKey: 'owner', message: '何を覚えてる？', snapshot: store.snapshot('owner') };
    expect((await recall.enrich(context(false), input)).prompt).toContain('[Memory inquiry]');
    expect((await recall.enrich(context(true), input)).prompt).not.toContain('[Memory inquiry]');
    store.close();
  });
});
