import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disclosureDecision, groupAudience } from '@shannon/cognition';
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
    }
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
});
