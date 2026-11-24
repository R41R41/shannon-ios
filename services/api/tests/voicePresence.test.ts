import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lifecyclePlayerNames, validLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
import { ON_AIR_LIMITS, validatedOnAirRequest } from '../src/contracts/onAirContract.js';
import { SQLiteOnAirStore } from '../src/infra/onAir/onAirStore.js';
import { createOnAirRoute } from '../src/infra/http/serverOnAirRoute.js';
import { onAirBlock, presenceBlock, presenceFactsOf } from '../src/surfaces/platform/voicePresencePrompt.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService } from '../src/surfaces/platform/platformVoice.js';
import type { VoiceLifecyclePort } from '../src/surfaces/platform/voiceLifecyclePort.js';
import { splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { createServer } from 'node:http';

// Names here are made up for the test: the code never holds a real person's name.
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const STRANGER = '900000000000000003';
const ROOM = 'discord:111:222';
const START = '2026-10-20T12:00:00.000Z';
const BRIDGE = {
  SHANNON_PLATFORM_BRIDGE_TOKEN: 'c'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テスト' }]),
};

describe('the blocks (voicePresencePrompt.ts)', () => {
  const group = (names: string[], unnamed = 0) => ({ names, unnamed });

  it('lists who is in the call and in the server, with the reason and the way to greet, and no viewers while not on air', () => {
    const text = presenceBlock({ call: group(['ライ氏', 'アキ', 'ミナ']), server: { running: 'running', bodyIn: false, people: group(['アキ', 'ミナ'], 1) }, onAir: null });
    expect(text).toContain('Discordの通話にいる人（ボクのほか）: ライ氏、アキさん、ミナさん。');
    expect(text).toContain('同じマイクラのサーバーにいる人（ボクのほか）: アキさん、ミナさん、名前の分からない人が1人。ボクはまだサーバーに入っていない。');
    expect(text).toContain('理由: 名前を間違えて呼ぶと');
    expect(text).toContain('「挨拶して」「紹介するよ」');
    expect(text).toContain('理由: 誰がそこにいるかを分かって話すと');
    expect(text).toContain('「視聴者」「見ている人」がいる、とは言わない');
  });

  it('says nothing about the server when it is not known, and that it is stopped when it is', () => {
    expect(presenceBlock({ call: group(['ライ氏']), server: { running: 'unknown', bodyIn: null, people: null }, onAir: null })).not.toContain('マイクラ');
    expect(presenceBlock({ call: group(['ライ氏']), server: { running: 'running', bodyIn: null, people: null }, onAir: null })).not.toContain('マイクラ');
    expect(presenceBlock({ call: null, server: { running: 'stopped', bodyIn: false, people: null }, onAir: null })).toContain('サーバーは、いま止まっている');
    expect(presenceBlock({ call: null, server: { running: 'running', bodyIn: true, people: group([]) }, onAir: null })).toContain('だれもいない。ボクはいまサーバーに入っている');
    expect(presenceBlock({ call: null, server: null, onAir: null })).toBe('');
  });

  it('adds the viewers and the rules for them only while on air, with the reasons, and keeps the private-memory rule', () => {
    const on = presenceBlock({ call: group(['ライ氏', 'アキ']), server: null, onAir: { note: 'メモです' } });
    expect(on).not.toContain('とは言わない');
    const text = onAirBlock({ note: 'メモ\nです' });
    expect(text).toContain('[いま収録中]');
    expect(text).toContain('場面のメモ（持ち主が書いたもの）: メモ です');
    expect(text).toContain('視聴者に、まとめて呼びかけて挨拶する');
    expect(text).toContain('全体で50字までにしてよい');
    expect(text).toContain('私的な記憶');
    expect(text).toContain('まだ公開されていない事');
    expect(text.match(/理由:/gu)!.length).toBeGreaterThanOrEqual(4);
    expect(onAirBlock(null)).toBe('');
  });

  it('places accounts by name, takes the speaker from the platform name when her records have none, and the owner from the game key', () => {
    const records: Record<string, string> = { 'discord:1': 'アキ', 'minecraft:aki_mc': 'アキ', 'minecraft:mina_mc': 'ミナ' };
    const names = (platform: string, accounts: readonly string[]) => {
      const placed = accounts.flatMap(account => records[`${platform}:${account.toLowerCase()}`] ?? []);
      return { names: [...new Set(placed)], unnamed: accounts.length - placed.length };
    };
    const facts = presenceFactsOf({
      names, platform: 'discord', humans: ['owner', '1', '2'], ownerAccount: 'owner', modOnly: false,
      speaker: { account: '2', displayName: 'ユウ', owner: false },
      server: { running: 'running', bot: 'absent', playerNames: ['Aki_MC', 'mina_mc', 'Boss_MC', 'x'] }, onAir: null,
    });
    expect(facts.call).toEqual({ names: ['ライ氏', 'アキ', 'ユウ'], unnamed: 0 });
    expect(facts.server).toEqual({ running: 'running', bodyIn: false, people: { names: ['アキ', 'ミナ'], unnamed: 2 } });
    const viaGame = presenceFactsOf({
      names, platform: 'discord', humans: ['owner'], ownerAccount: 'owner', modOnly: true,
      speaker: { account: 'owner', displayName: 'ライ氏', owner: true, minecraftName: 'boss_mc' },
      server: { running: 'running', bot: 'joined', playerNames: ['Aki_MC', 'Boss_MC'] }, onAir: null,
    });
    expect(viaGame.call).toBeNull();
    expect(viaGame.server).toEqual({ running: 'running', bodyIn: true, people: { names: ['ライ氏', 'アキ'], unnamed: 0 } });
  });
});

describe('the player names of a lifecycle frame', () => {
  it('reads only what a player name can be, once each, and nothing from a body that sends none', () => {
    expect(lifecyclePlayerNames({})).toBeNull();
    expect(lifecyclePlayerNames({ playerNames: 'x' as never })).toBeNull();
    expect(lifecyclePlayerNames({ playerNames: ['Aki_1', 'Aki_1', 'a b', '', 'x'.repeat(17), 7 as never, 'Mina'] })).toEqual(['Aki_1', 'Mina']);
    expect(lifecyclePlayerNames({ playerNames: Array.from({ length: 80 }, (_, i) => `p${i}`) })).toHaveLength(50);
  });

  it('never makes a frame invalid for its names (an odd name must not lose the whole poll)', () => {
    const now = Date.parse(START);
    const frame = { serverId: 'home', observedAt: START, running: 'running', bot: 'absent', otherPlayers: 2 };
    expect(validLifecycleState(frame, now)).toBe(true);
    expect(validLifecycleState({ ...frame, playerNames: ['Aki', 'Mina'] }, now)).toBe(true);
    expect(validLifecycleState({ ...frame, playerNames: ['not a name', 5] }, now)).toBe(true);
  });
});

describe('on air (onAirContract.ts, onAirStore.ts)', () => {
  it('validates a write: off, or minutes and a note, nothing else', () => {
    expect(validatedOnAirRequest({ off: true })).toEqual({ off: true });
    expect(validatedOnAirRequest({})).toEqual({ off: false, minutes: ON_AIR_LIMITS.defaultMinutes, note: '' });
    expect(validatedOnAirRequest({ minutes: 30, note: ' メモ ' })).toEqual({ off: false, minutes: 30, note: 'メモ' });
    for (const bad of [null, [], { minutes: 0 }, { minutes: 1.5 }, { minutes: ON_AIR_LIMITS.maximumMinutes + 1 }, { note: 5 }, { note: 'あ'.repeat(ON_AIR_LIMITS.noteCharacters + 1) }, { off: 'yes' }, { other: 1 }]) {
      expect(validatedOnAirRequest(bad)).toMatchObject({ status: 400, error: 'INVALID_REQUEST' });
    }
  });

  it('is on only until its end, per scope, and never when the row cannot be read', () => {
    const store = new SQLiteOnAirStore(':memory:');
    expect(store.active('owner', START)).toBeNull();
    store.set('owner', { until: '2026-10-20T14:00:00.000Z', note: 'メモ' }, START);
    expect(store.active('owner', '2026-10-20T13:59:59.000Z')).toEqual({ until: '2026-10-20T14:00:00.000Z', note: 'メモ' });
    expect(store.active('owner', '2026-10-20T14:00:00.000Z')).toBeNull();
    expect(store.active('other', START)).toBeNull();
    store.clear('owner');
    expect(store.active('owner', START)).toBeNull();
    store.set('owner', { until: 'not a time', note: '' }, START);
    expect(store.active('owner', START)).toBeNull();
    store.close();
    expect(store.active('owner', START)).toBeNull();
  });
});

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reply = 'こんにちは。';
  private result(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: this.reply }; }
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { this.requests.push(request); return this.result(); }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    await onReplyText(this.reply);
    return this.result();
  }
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function harness(options: { onAir?: { note: string } | null; server?: ReturnType<VoiceLifecyclePort['state']> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-presence-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const lifecycle: VoiceLifecyclePort = { state: () => options.server ?? null, check: () => null, request: async () => ({ ok: true, lifecycleId: null, state: 'accepted' }) };
  const service = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now, chatModel: model, lifecycle: () => lifecycle,
    ...(options.onAir !== undefined ? { onAir: () => options.onAir ?? null } : {}),
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), environment: () => ({ SHANNON_DC_VOICE: 'on' }), log: () => undefined,
  });
  // Her records: two people known by a game name and one of them by a Discord account too; the third account in the call is nobody she knows.
  const aki = peopleStore.createPerson('owner', { displayName: 'アキ', howKnown: 'テスト' }, START);
  const mina = peopleStore.createPerson('owner', { displayName: 'ミナ', howKnown: 'テスト' }, START);
  peopleStore.linkPlatformPerson('owner', { platform: 'minecraft', userId: 'Aki_MC', personId: aki.id, displayName: 'Aki_MC', firstSeenAt: START, lastSeenAt: START });
  peopleStore.linkPlatformPerson('owner', { platform: 'minecraft', userId: 'mina_mc', personId: mina.id, displayName: 'mina_mc', firstSeenAt: START, lastSeenAt: START });
  peopleStore.linkPlatformPerson('owner', { platform: 'discord', userId: FRIEND, personId: aki.id, displayName: 'aki', firstSeenAt: START, lastSeenAt: START });
  let counter = 0;
  const say = async (userMessage: string, fields: Record<string, unknown> = {}) => {
    await service.turn({
      platform: 'discord', requestId: `v-${(counter += 1)}`, conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ氏',
      userMessage, observedAt: START, participants: [OWNER, FRIEND, STRANGER], ...fields,
    }, () => undefined);
    return promptOf(model.requests.at(-1));
  };
  const close = async () => { await background.waitForIdle('owner'); turns.close(); peopleStore.close(); store.close(); };
  return { say, close, model };
}

describe("the spoken reply's prompt", () => {
  const home = { running: 'running', bot: 'absent', pending: null, playerNames: ['Aki_MC', 'mina_mc', 'unknown_1'] } as const;

  it('tells who is in the call and in the server (her body not there yet), by the names her records give', async () => {
    const { say, close } = harness({ server: home });
    const prompt = await say('シャノン、挨拶して');
    expect(prompt).toContain('[いま誰がどこにいるか]');
    expect(prompt).toContain('Discordの通話にいる人（ボクのほか）: ライ氏、アキさん、名前の分からない人が1人。');
    expect(prompt).toContain('同じマイクラのサーバーにいる人（ボクのほか）: アキさん、ミナさん、名前の分からない人が1人。ボクはまだサーバーに入っていない。');
    expect(prompt).not.toContain('[いま収録中]');
    expect(prompt).toContain('「視聴者」「見ている人」がいる、とは言わない');
    expect(prompt).not.toContain('Aki_MC');
    await close();
  });

  it("adds on air and the owner's note while it is on air", async () => {
    const { say, close } = harness({ server: home, onAir: { note: 'テスト用のメモ' } });
    const prompt = await say('シャノン、挨拶して');
    expect(prompt).toContain('[いま収録中]');
    expect(prompt).toContain('場面のメモ（持ち主が書いたもの）: テスト用のメモ');
    expect(prompt).not.toContain('見ている人がいるとは書かれていない');
    await close();
  });

  it('leaves the server out while its state is not known', async () => {
    const { say, close } = harness({ server: null });
    const prompt = await say('シャノン、挨拶して');
    expect(prompt).toContain('Discordの通話にいる人');
    expect(prompt).not.toContain('同じマイクラのサーバー');
    await close();
  });
});

describe('/v1/on-air', () => {
  const OWNER_DEVICE = { scopeKey: 'owner', deviceId: 'phone' };
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done())))); });

  async function route() {
    const clock = { at: START };
    const store = new SQLiteOnAirStore(':memory:');
    const handler = createOnAirRoute({ store, ownerScopeKey: 'owner', now: () => clock.at });
    let principal: { scopeKey: string; deviceId: string } | null = OWNER_DEVICE;
    const server = createServer((request, response) => { void handler(request, response, principal); });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const call = async (method: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/on-air`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { call, store, as: (next: typeof principal) => { principal = next; }, advance: (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); } };
  }

  it("is for the owner's paired device only", async () => {
    const { call, as, store } = await route();
    as(null);
    expect((await call('GET')).status).toBe(403);
    as({ scopeKey: 'someone-else', deviceId: 'guest' });
    expect(await call('POST', { minutes: 5 })).toMatchObject({ status: 403, body: { error: 'ON_AIR_OWNER_ONLY' } });
    expect(store.active('owner', START)).toBeNull();
    as(OWNER_DEVICE);
    expect((await call('PUT', {})).status).toBe(405);
  });

  it('turns on with a note and an end, reads it back, lapses by itself and turns off', async () => {
    const { call, store, advance } = await route();
    expect(await call('GET')).toEqual({ status: 200, body: { onAir: null } });
    expect(await call('POST', { minutes: 60, note: 'メモ' })).toEqual({ status: 200, body: { onAir: { until: '2026-10-20T13:00:00.000Z', note: 'メモ' } } });
    expect(store.active('owner', START)).toMatchObject({ note: 'メモ' });
    advance(59 * 60_000);
    expect((await call('GET')).body).toMatchObject({ onAir: { note: 'メモ' } });
    advance(2 * 60_000);
    expect(await call('GET')).toEqual({ status: 200, body: { onAir: null } });
    await call('POST', {});
    expect((await call('GET')).body).toMatchObject({ onAir: { note: '' } });
    expect(await call('POST', { off: true })).toEqual({ status: 200, body: { onAir: null } });
    expect((await call('POST', { minutes: 0 })).status).toBe(400);
  });
});
