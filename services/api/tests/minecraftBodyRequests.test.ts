import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { createInMemoryAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/chatModel.js';
import { MINECRAFT_TOOL_INSTRUCTIONS, toolInstructions } from '../src/chatModelTools.js';
import { BODY_GAME_SOURCE, SQLiteGameExperiences } from '../src/surfaces/minecraft/store/gameBodyMemory.js';
import { MinecraftBody } from '../src/surfaces/minecraft/minecraftBody.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { MINECRAFT_REQUEST_LIMITS, MINECRAFT_REQUEST_PATHS, validClaim, validProgress, validReport } from '../src/contracts/minecraftBodyRequestContract.js';
import { MinecraftBodyRequests, requestExperienceSummary } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import type { MinecraftIntent } from '../src/surfaces/minecraft/minecraftIntent.js';
import { SQLiteMinecraftTurnLog } from '../src/surfaces/minecraft/store/minecraftTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { minecraftBodyRoute } from '../src/surfaces/minecraft/serverMinecraftBodyRoute.js';
import { asksAboutMinecraftBody } from '../src/shannonToolSession.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
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

function queue() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-minecraft-requests-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse(START);
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const experiences = new SQLiteGameExperiences(path);
  const requests = new MinecraftBodyRequests(path, { deviceId: DEVICE, ownerScopeKey: 'owner' }, now, experiences);
  const memories = () => store.experienceCandidates('owner').filter(item => item.userMessage.startsWith('body-game-'));
  const claim = async (holding: string[] = [], waitSeconds = 0) => {
    const answer = await requests.claim('owner', DEVICE, { waitSeconds, holding });
    if (typeof answer === 'string') throw new Error(answer);
    return answer;
  };
  const ask = (goal = 'オークの原木を16個集める', dedupeKey = `k-${Math.random()}`) =>
    requests.enqueue('owner', { goal, dedupeKey, origin: { surface: 'text', threadId: 'talk-1' } });
  const close = () => { requests.close(); experiences.close(); store.close(); };
  return { path, store, requests, memories, claim, ask, close, now, advance: (milliseconds: number) => { clock += milliseconds; } };
}

describe('the request queue of her Minecraft body (phase 4)', () => {
  it('is empty while the body is not claiming, and goes queued → claimed → running → done with the body\'s counts', async () => {
    const { requests, claim, ask, memories, close, advance } = queue();
    // Nobody claimed: nothing is queued to run later by surprise.
    expect(requests.present('owner')).toBe(false);
    expect(ask()).toEqual({ kind: 'absent' });
    expect(await claim()).toEqual({ request: null, cancel: [] });
    expect(requests.present('owner')).toBe(true);
    const queued = ask();
    if (queued.kind !== 'queued') throw new Error('not queued');
    expect(queued.request).toMatchObject({ state: 'queued', goal: 'オークの原木を16個集める', origin: { surface: 'text', threadId: 'talk-1' } });
    // The body is handed the goal and the surface, never the Talk.
    const handed = await claim();
    expect(handed.request).toMatchObject({ id: queued.request.id, goal: 'オークの原木を16個集める', surface: 'text' });
    expect(Object.keys(handed.request!).sort()).toEqual(['createdAt', 'goal', 'id', 'leaseExpiresAt', 'surface']);
    // While it holds one, nothing new is handed out; the lease is renewed.
    const second = ask('パンを3個作る');
    expect((await claim([queued.request.id])).request).toBeNull();
    expect(requests.progress('owner', DEVICE, queued.request.id, { phase: 'started', step: 'オークの木を探す' })).toEqual({ id: queued.request.id, state: 'running', cancel: false });
    advance(60_000);
    expect(requests.promptBlock('owner')).toContain('体が取り組んでいる（いま: オークの木を探す、1分前の報告）');
    expect(requests.report('owner', DEVICE, queued.request.id, { outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] }))
      .toEqual({ id: queued.request.id, state: 'done', recorded: true });
    // A repeated report changes nothing.
    expect(requests.report('owner', DEVICE, queued.request.id, { outcome: 'failed', code: 'error', gained: [] })).toEqual({ id: queued.request.id, state: 'done', recorded: false });
    const block = requests.promptBlock('owner');
    expect(block).toContain('[マイクラの体で起きたこと]');
    expect(block).toContain('「オークの原木を16個集める」: たったいまやり終えた（手に入れたもの: オークの原木 16個）');
    expect(block).toContain('体が受け取るのを待っている');
    // One experience in the server's words, the owner's, with no words of his.
    const stored = memories();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.summary).toBe('ゲームの記憶: 10月5日の夜、ライ氏に頼まれた「オークの原木を16個集める」をマイクラの体でやり終えた（オークの原木 16個）。');
    expect(stored[0]!.disclosure).toMatchObject({ audience: { kind: 'owner' }, speaker: 'unknown' });
    // The next one goes out once the first is closed.
    if (second.kind !== 'queued') throw new Error('not queued');
    expect((await claim()).request?.id).toBe(second.request.id);
    close();
  });

  it('closes a lease that ran out, and a request the body no longer holds, as expired; a queued one nobody took too', async () => {
    const { requests, claim, ask, memories, close, advance } = queue();
    await claim();
    const first = ask();
    if (first.kind !== 'queued') throw new Error('not queued');
    await claim();
    advance((MINECRAFT_REQUEST_LIMITS.leaseSeconds + 1) * 1_000);
    expect(requests.recent('owner')[0]).toMatchObject({ id: first.request.id, state: 'expired' });
    expect(memories()[0]!.summary).toContain('結果が届かなかった');
    // A late report is answered and changes nothing.
    expect(requests.report('owner', DEVICE, first.request.id, { outcome: 'done', gained: [] })).toEqual({ id: first.request.id, state: 'expired', recorded: false });

    await claim();
    const second = ask('丸石を32個集める');
    if (second.kind !== 'queued') throw new Error('not queued');
    await claim();
    // The body restarted and holds nothing: it is never handed out again.
    expect(await claim([])).toEqual({ request: null, cancel: [] });
    expect(requests.recent('owner')[0]).toMatchObject({ id: second.request.id, state: 'expired' });

    // Queued, and the body went away: closed after its time, without an experience (it never reached the body).
    const third = ask('パンを3個作る');
    if (third.kind !== 'queued') throw new Error('not queued');
    advance(MINECRAFT_REQUEST_LIMITS.queuedMinutes * 60_000 + 1_000);
    expect(requests.recent('owner')[0]).toMatchObject({ id: third.request.id, state: 'expired' });
    expect(requests.present('owner')).toBe(false);
    expect(memories()).toHaveLength(2);
    close();
  });

  it('cancels a queued request at once, and asks the body to stop one it holds; the stop it reports closes it as cancelled', async () => {
    const { requests, claim, ask, memories, close } = queue();
    await claim();
    const queued = ask('木を切る');
    if (queued.kind !== 'queued') throw new Error('not queued');
    expect(requests.cancel('owner', queued.request.id)).toMatchObject({ state: 'cancelled' });
    expect(requests.cancel('owner', queued.request.id)).toBe('FINISHED');
    const held = ask('鉄を掘る');
    if (held.kind !== 'queued') throw new Error('not queued');
    await claim();
    expect(requests.cancel('owner')).toMatchObject({ id: held.request.id, state: 'claimed', cancelRequested: true });
    // The next claim answers at once with the cancel; progress says it too.
    expect(await claim([held.request.id], 20)).toEqual({ request: null, cancel: [held.request.id] });
    expect(requests.progress('owner', DEVICE, held.request.id, { phase: 'working' })).toMatchObject({ cancel: true });
    expect(requests.report('owner', DEVICE, held.request.id, { outcome: 'stopped', code: 'cancelled', gained: [{ item: 'raw_iron', count: 2 }] }))
      .toEqual({ id: held.request.id, state: 'cancelled', recorded: true });
    expect(memories().map(item => item.summary)).toEqual(['ゲームの記憶: 10月5日の夜、ライ氏に頼まれた「鉄を掘る」をマイクラの体でしていたが、途中でやめた（鉄の原石 2個）。']);
    expect(requests.cancel('owner')).toBe('NOT_FOUND');
    // 「止まって」 in game chat asks every open request to stop.
    ask('a'); ask('b');
    expect(requests.cancelOpen('owner')).toBe(2);
    close();
  });

  it('takes only the configured device in the owner\'s scope, and its own requests only', async () => {
    const { requests, claim, ask, close } = queue();
    expect(await requests.claim('owner', 'body-pc', { waitSeconds: 0, holding: [] })).toBe('DEVICE_DENIED');
    expect(await requests.claim('friend', DEVICE, { waitSeconds: 0, holding: [] })).toBe('SCOPE_DENIED');
    expect(requests.enqueue('friend', { goal: 'x', dedupeKey: 'k', origin: { surface: 'text' } })).toEqual({ kind: 'not_configured' });
    expect(requests.recent('friend')).toEqual([]);
    expect(requests.promptBlock('friend')).toBe('');
    await claim();
    const queued = ask();
    if (queued.kind !== 'queued') throw new Error('not queued');
    // Not handed out yet: nobody may report it.
    expect(requests.progress('owner', DEVICE, queued.request.id, { phase: 'started' })).toBe('NOT_FOUND');
    await claim();
    expect(requests.report('owner', 'body-pc', queued.request.id, { outcome: 'done', gained: [] })).toBe('NOT_FOUND');
    // The same turn asking twice is one request; the limit of open requests holds.
    const again = requests.enqueue('owner', { goal: 'x', dedupeKey: 'same', origin: { surface: 'text' } });
    expect(requests.enqueue('owner', { goal: 'x', dedupeKey: 'same', origin: { surface: 'text' } })).toMatchObject({ kind: 'queued', duplicate: true });
    for (let index = 0; index < MINECRAFT_REQUEST_LIMITS.open; index += 1) ask(`goal ${index}`);
    expect(ask('one more')).toEqual({ kind: 'limit' });
    expect(again.kind).toBe('queued');
    close();
  });

  it('reads the body\'s messages strictly: closed phases, outcomes, codes and item counts, and nothing else', () => {
    expect(validClaim({ scopeKey: 'owner', waitSeconds: 25, holding: [] })).toEqual({ waitSeconds: 25, holding: [] });
    expect(validClaim({ waitSeconds: 26 })).toBe('waitSeconds is invalid');
    expect(validClaim({ holding: ['nope'] })).toBe('holding is invalid');
    expect(validClaim({ text: 'hi' })).toBe('text is not allowed');
    expect(validProgress({ phase: 'started', step: ' 木を\n探す ' })).toEqual({ phase: 'started', step: '木を 探す' });
    expect(validProgress({ phase: 'chatting' })).toBe('phase is invalid');
    expect(validProgress({ phase: 'working', narrative: 'x' })).toBe('narrative is not allowed');
    expect(validReport({ outcome: 'done', gained: [{ item: 'minecraft:oak_log', count: 16 }] })).toEqual({ outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
    expect(validReport({ outcome: 'failed' })).toEqual({ outcome: 'failed', code: 'unknown', gained: [] });
    expect(validReport({ outcome: 'stopped' })).toEqual({ outcome: 'stopped', code: 'cancelled', gained: [] });
    expect(validReport({ outcome: 'failed', code: 'bored' })).toBe('code is invalid');
    expect(validReport({ outcome: 'done', gained: [{ item: 'Oak Log', count: 1 }] })).toBe('gained is invalid');
    expect(validReport({ outcome: 'done', gained: [{ item: 'oak_log', count: 0 }] })).toBe('gained is invalid');
    expect(validReport({ outcome: 'done', summary: '全部集めた' })).toBe('summary is not allowed');
    expect(requestExperienceSummary({ id: 'x', goal: 'パンを3個作る', state: 'failed', origin: { surface: 'minecraft' }, createdAt: START, updatedAt: START, finishedAt: START,
      cancelRequested: false, result: { outcome: 'failed', code: 'died', gained: [] } })).toBe('ゲームの記憶: 10月5日の夜、ライ氏に頼まれた「パンを3個作る」をマイクラの体でやろうとしたが、できなかった（途中で体が死んだ）。');
  });

  it('the routes: the body claims, reports progress and a result; the owner\'s apps list and cancel; others are refused', async () => {
    const { requests, ask, close } = queue();
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify(CONFIGURATION) });
    const route = minecraftBodyRoute(null, configuration, () => {}, requests);
    const call = async (method: string, path: string, body: unknown, deviceId: string | null, scopeKey = 'owner') => {
      const sent: { status?: number; body?: string } = {};
      const response = { writeHead: (status: number) => { sent.status = status; }, end: (text: string) => { sent.body = text; }, once: () => response,
        writableEnded: false, destroyed: false } as unknown as ServerResponse;
      const handled = await route.handle({ method } as IncomingMessage, response, path, body, deviceId ? { deviceId, scopeKey, displayName: 'x' } : null);
      return { handled, status: sent.status, body: sent.body ? JSON.parse(sent.body) as Record<string, unknown> : undefined };
    };
    expect((await call('POST', MINECRAFT_REQUEST_PATHS.claim, {}, null)).status).toBe(403);
    expect((await call('POST', MINECRAFT_REQUEST_PATHS.claim, {}, 'iphone')).body?.error).toBe('MINECRAFT_BODY_DEVICE_DENIED');
    expect((await call('POST', MINECRAFT_REQUEST_PATHS.claim, {}, DEVICE, 'friend')).body?.error).toBe('MINECRAFT_BODY_SCOPE_DENIED');
    expect(await call('POST', MINECRAFT_REQUEST_PATHS.claim, { scopeKey: 'owner', waitSeconds: 0 }, DEVICE)).toEqual({ handled: true, status: 200, body: { request: null, cancel: [] } });
    const queued = ask();
    if (queued.kind !== 'queued') throw new Error('not queued');
    const claimed = await call('POST', MINECRAFT_REQUEST_PATHS.claim, { scopeKey: 'owner', holding: [] }, DEVICE);
    expect((claimed.body?.request as { id: string }).id).toBe(queued.request.id);
    const id = queued.request.id;
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/progress`, { phase: 'started', step: '木を探す' }, DEVICE)).body).toEqual({ id, state: 'running', cancel: false });
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/progress`, { phase: 'started' }, 'iphone')).body?.error).toBe('MINECRAFT_BODY_DEVICE_DENIED');
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/report`, { outcome: 'done', text: '集めたよ' }, DEVICE)).status).toBe(400);
    // The owner's app reads the list without the Talk; the body does not read it.
    const listed = await call('GET', MINECRAFT_REQUEST_PATHS.list, undefined, 'iphone');
    expect(listed.body).toMatchObject({ present: true, requests: [{ id, state: 'running', origin: { surface: 'text' } }] });
    expect(JSON.stringify(listed.body)).not.toContain('talk-1');
    expect((await call('GET', MINECRAFT_REQUEST_PATHS.list, undefined, DEVICE)).status).toBe(403);
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/report`, { outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] }, DEVICE)).body)
      .toEqual({ id, state: 'done', recorded: true });
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/cancel`, {}, 'iphone')).body?.error).toBe('MINECRAFT_REQUEST_FINISHED');
    expect((await call('POST', `/v1/body/minecraft/requests/${id}/cancel`, {}, DEVICE)).status).toBe(403);
    // Without a configured body the routes answer 503.
    expect((await minecraftBodyRoute(null, null).handle({ method: 'POST' } as IncomingMessage,
      { writeHead: () => {}, end: () => {} } as unknown as ServerResponse, MINECRAFT_REQUEST_PATHS.claim, {}, { deviceId: DEVICE, scopeKey: 'owner', displayName: 'x' }))).toBe(true);
    close();
  });
});

describe('her minecraft.* tools', () => {
  function runner() {
    const harness = queue();
    const autonomyStore = new SQLiteAutonomyStore(':memory:');
    const autonomy = createInMemoryAutonomyService(harness.now, { store: autonomyStore, minecraftBody: harness.requests });
    const context = (scopeKey = 'owner') => ({ scopeKey, surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory('turn-1'), threadId: 'talk-1' });
    return { ...harness, autonomy, context, done: () => { autonomyStore.close(); harness.close(); } };
  }
  const names = (tools: readonly { name: string }[]) => tools.map(tool => tool.name).filter(name => name.startsWith('minecraft.'));

  it('are offered only with the owner alone, in a conversation, in the owner\'s scope, and the request only while the body is present', async () => {
    const { autonomy, claim, done } = runner();
    expect(names(autonomy.tools.offered('text', 'owner_alone', 'owner'))).toEqual(['minecraft.status', 'minecraft.cancel']);
    await claim();
    expect(names(autonomy.tools.offered('text', 'owner_alone', 'owner'))).toEqual(['minecraft.request', 'minecraft.status', 'minecraft.cancel']);
    expect(names(autonomy.tools.offered('voice', 'owner_alone', 'owner'))).toEqual(['minecraft.request', 'minecraft.status', 'minecraft.cancel']);
    expect(names(autonomy.tools.offered('text', 'others', 'owner'))).toEqual([]);
    expect(names(autonomy.tools.offered('autonomy', 'owner_alone', 'owner'))).toEqual([]);
    expect(names(autonomy.tools.offered('text', 'owner_alone', 'friend'))).toEqual([]);
    expect(names(autonomy.tools.offered('text', 'owner_alone'))).toEqual([]);
    // The gate refuses a call with anyone else present, whatever the model writes.
    const refused = await autonomy.tools.call('minecraft.request', '{"goal":"木を集める"}', { scopeKey: 'owner', surface: 'text', audience: 'others', memory: toolSessionMemory('t') });
    expect(refused).toMatchObject({ ok: false, failure: 'not_offered' });
    done();
  });

  it('a request is accepted once queued, fails at once while the body is absent, and a retry of the turn asks once', async () => {
    const { autonomy, context, claim, requests, advance, done } = runner();
    const absent = await autonomy.tools.call('minecraft.request', '{"goal":"オークの原木を16個集める"}', context());
    expect(absent).toMatchObject({ ok: false, failure: 'unavailable', retryable: false });
    expect(requests.recent('owner')).toEqual([]);
    await claim();
    const accepted = await autonomy.tools.call('minecraft.request', '{"goal":"オークの原木を16個集める"}', context());
    expect(accepted.ok).toBe(true);
    expect(accepted.text).toContain('マイクラの体に頼んだ');
    expect(accepted.text).toContain('終わった・集めたとは言わない');
    expect(await autonomy.tools.call('minecraft.request', '{"goal":"オークの原木を16個集める"}', context())).toMatchObject({ ok: true });
    expect(requests.recent('owner')).toHaveLength(1);
    expect(requests.recent('owner')[0]).toMatchObject({ origin: { surface: 'text', threadId: 'talk-1' } });
    const status = await autonomy.tools.call('minecraft.status', '{}', context());
    expect(status.text).toContain('マイクラの体はいまゲームに入っている。');
    expect(status.text).toContain('「オークの原木を16個集める」: 体が受け取るのを待っている');
    const cancelled = await autonomy.tools.call('minecraft.cancel', '{}', context());
    expect(cancelled.text).toContain('取り消した');
    // The activity record has one line per call and never the goal.
    const record = JSON.stringify(autonomy.activityDays('owner', 1));
    expect(record).toContain('マイクラの体に頼みごとを渡しました');
    expect(record).not.toContain('オークの原木');
    advance(MINECRAFT_REQUEST_LIMITS.presenceMilliseconds + 1);
    expect(names(autonomy.tools.offered('text', 'owner_alone', 'owner'))).not.toContain('minecraft.request');
    done();
  });

  it('come with one line of instructions only while they are offered', () => {
    expect(toolInstructions({ definitions: [{ name: 'minecraft.request', domain: 'minecraft_body' }] } as never, false)).toContain(MINECRAFT_TOOL_INSTRUCTIONS);
    expect(toolInstructions({ definitions: [{ name: 'study.list', domain: 'aether_study' }] } as never, false)).not.toContain(MINECRAFT_TOOL_INSTRUCTIONS);
    expect(asksAboutMinecraftBody('マイクラで木材集めといて')).toBe(true);
    expect(asksAboutMinecraftBody('木材を買っておいて')).toBe(false);
  });
});

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  intent: MinecraftIntent | undefined;
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい。', ...(request.offerMinecraftIntent && this.intent ? { minecraftIntent: this.intent } : {}) };
  }
}

describe('one mind: the phone, the game chat and the result', () => {
  function world() {
    const harness = queue();
    const autonomyStore = new SQLiteAutonomyStore(':memory:');
    const autonomy = createInMemoryAutonomyService(harness.now, { store: autonomyStore, minecraftBody: harness.requests });
    const model = new Model();
    const background = new BackgroundUpdateCoordinator(harness.store, harness.store);
    const peopleStore = new SQLitePeopleMemoryStore(harness.path);
    const api = createLocalApiKernel(harness.now, { chatModel: model, stateStore: harness.store, conversationStore: harness.store, background,
      autonomy, minecraftRequests: harness.requests, peopleMemory: peopleStore });
    const turns = new SQLiteMinecraftTurnLog(harness.path);
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify(CONFIGURATION) })!;
    const body = new MinecraftBody({ configuration, stateStore: harness.store, conversationStore: harness.store, background, now: harness.now, chatModel: model,
      turns, conversation: api, peopleStore, peopleEnabled: () => true, requests: harness.requests });
    const chat = async (message: string, extra: Record<string, unknown> = {}) => {
      const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'talk-1', message, ...extra } });
      expect(response.status).toBe(200);
      return model.requests.at(-1)!;
    };
    const turn = (fields: Record<string, unknown>) => body.turn('owner', DEVICE, {
      requestId: `req-${Math.random().toString(36).slice(2)}`, serverId: 'lab-qywEbW', conversation: { kind: 'channel' },
      speaker: { uuid: OWNER_UUID, name: 'Rai1241' }, message: 'シャノン、木材集めといて', observedAt: harness.now(), ...fields,
    });
    const done = async () => {
      await background.waitForIdle('owner');
      await new Promise(resolve => setImmediate(resolve));
      await background.waitForIdle('owner');
      turns.close(); peopleStore.close(); autonomyStore.close(); harness.close();
    };
    return { ...harness, model, chat, turn, done };
  }

  it('an app turn with the owner alone is offered the request while the body claims, and learns the result in the next turn', async () => {
    const { chat, claim, requests, done } = world();
    expect((await chat('マイクラで木材集めといて')).tools?.definitions.map(tool => tool.name)).not.toContain('minecraft.request');
    await claim();
    const offered = await chat('マイクラで木材集めといて');
    expect(offered.tools?.definitions.map(tool => tool.name)).toContain('minecraft.request');
    const queued = requests.enqueue('owner', { goal: 'オークの原木を16個集める', dedupeKey: 'phone-1', origin: { surface: 'text', threadId: 'talk-1' } });
    if (queued.kind !== 'queued') throw new Error('not queued');
    await claim();
    requests.progress('owner', DEVICE, queued.request.id, { phase: 'started' });
    requests.report('owner', DEVICE, queued.request.id, { outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
    const asked = await chat('木材集まった？');
    expect(promptOf(asked)).toContain('[マイクラの体で起きたこと]');
    expect(promptOf(asked)).toContain('やり終えた（手に入れたもの: オークの原木 16個）');
    // With anyone else present it is not given, and no tool is.
    const shared = await chat('木材集まった？', { audience: 'others' });
    expect(promptOf(shared)).not.toContain('[マイクラの体で起きたこと]');
    expect(shared.tools).toBeUndefined();
    await done();
  });

  it('the owner\'s game-chat task becomes a request while the body claims; a friend\'s never does; 「止まって」 stops what is open', async () => {
    const { turn, model, requests, claim, done } = world();
    model.intent = { kind: 'task', goal: 'オークの原木を16個集める' };
    // No claiming body: the intent is answered as before, and nothing is queued.
    expect((await turn({})).intent).toEqual({ kind: 'task', goal: 'オークの原木を16個集める' });
    expect(requests.recent('owner')).toEqual([]);
    await claim();
    const queued = await turn({ requestId: 'chat-1' });
    expect(queued.intent).toMatchObject({ kind: 'task', goal: 'オークの原木を16個集める', request: { id: expect.any(String) } });
    expect(requests.recent('owner')[0]).toMatchObject({ id: queued.intent!.request!.id, origin: { surface: 'minecraft', messageId: 'mc:chat-1' } });
    // The retry of the same turn is the stored answer: one request.
    expect((await turn({ requestId: 'chat-1', observedAt: requests.recent('owner')[0]!.createdAt })).intent?.request?.id).toBe(queued.intent!.request!.id);
    expect(requests.recent('owner')).toHaveLength(1);
    // Game chat asks through the intent: her minecraft tools are not offered there (also in his whisper).
    await turn({ requestId: 'whisper-1', conversation: { kind: 'dm' } });
    expect(model.requests.at(-1)!.tools?.definitions.some(tool => tool.domain === 'minecraft_body') ?? false).toBe(false);
    expect(requests.recent('owner')).toHaveLength(2);
    // A friend's words are never instructions to her body.
    const friend = await turn({ requestId: 'friend-1', speaker: { uuid: FRIEND_UUID, name: 'Miki_01' }, message: 'シャノン、ダイヤちょうだい' });
    expect(friend.intent).toBeUndefined();
    await turn({ requestId: 'offline-1', serverId: 'lan-offline' });
    expect(requests.recent('owner')).toHaveLength(2);
    model.intent = { kind: 'stop', goal: '' };
    await turn({ requestId: 'stop-1', message: '止まって' });
    expect(requests.recent('owner').every(item => item.state === 'cancelled' || item.cancelRequested)).toBe(true);
    await done();
  });
});

describe('docs/minecraft-body-contract.md (phase 4)', () => {
  it('names the request routes, states, phases, outcomes and codes', () => {
    const document = readFileSync(join(import.meta.dirname, '../../../docs/minecraft-body-contract.md'), 'utf8');
    for (const word of [MINECRAFT_REQUEST_PATHS.claim, MINECRAFT_REQUEST_PATHS.list, '/progress', '/report', '/cancel', 'minecraft.request', 'minecraft.status',
      'minecraft.cancel', '[マイクラの体で起きたこと]', '`holding`', '`gained`', '`leaseExpiresAt`', 'MINECRAFT_REQUEST_NOT_FOUND', 'MINECRAFT_REQUEST_FINISHED',
      'MINECRAFT_OWNER_ONLY', BODY_GAME_SOURCE,
      'queued', 'claimed', 'running', 'done', 'failed', 'cancelled', 'expired', 'accepted', 'started', 'working', 'stopped',
      'gave_up', 'died', 'error', 'timeout', 'queue_full', 'run_over', 'unsupported', 'unknown']) {
      expect(document).toContain(word);
    }
  });
});
