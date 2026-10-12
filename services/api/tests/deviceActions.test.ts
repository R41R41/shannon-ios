import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt, SHANNON_DEVICE_ACTIONS_CAPABILITY } from '@shannon/cognition';
import { DeviceActions } from '../src/surfaces/device/deviceActions.js';
import { createDeviceActionRoute } from '../src/surfaces/device/deviceActionRoutes.js';
import { SQLiteDeviceActionStore } from '../src/surfaces/device/store/deviceActionStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { configuredDeviceActions } from '../src/wiring/deviceActionWiring.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { withToolCapabilityLines } from '../src/mind/tools/shannonAetherTools.js';
import { asksForDeviceAction, voiceToolOffer } from '../src/mind/tools/shannonToolSession.js';
import type { DevicePollState } from '../src/contracts/deviceActionContract.js';

const OWNER = 'owner';
const ALL_KINDS = ['reminder.create', 'timer.start', 'calendar.create_event', 'music.search', 'music.recent', 'music.play', 'music.control', 'music.playlist_create'] as const;
const phone: DevicePollState = { platform: 'ios', foreground: true, inCall: false, kinds: ALL_KINDS, wait: false };

let clock = Date.parse('2026-10-13T09:00:00.000Z');
const now = () => new Date(clock).toISOString();
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const item of opened.splice(0)) item.close(); clock = Date.parse('2026-10-13T09:00:00.000Z'); });

function outbox(enabled = true) {
  const store = new SQLiteDeviceActionStore(':memory:');
  opened.push(store);
  return { store, actions: new DeviceActions({ store, ownerScopeKey: OWNER, enabled: () => enabled, now }) };
}

/** Her tools as a conversation runs them, over one outbox. */
function conversation(environment: Record<string, string> = {}) {
  const service = createInMemoryAutonomyService(now);
  const wiring = configuredDeviceActions(environment, ':memory:', now, service.tools);
  opened.push(wiring);
  const memory = toolSessionMemory('thread\nかけて');
  const call = (name: string, input: Record<string, unknown>, surface: 'text' | 'voice' = 'text') =>
    service.tools.call(name, JSON.stringify(input), { scopeKey: OWNER, surface, audience: 'owner_alone', memory, timeMilliseconds: 30_000 });
  return { service, wiring, actions: wiring.actions!, call };
}

/** A device that answers each action it is handed with `answer`, polling every few milliseconds of real time. */
function device(actions: DeviceActions, deviceId: string, answer: (kind: string, payload: Record<string, unknown>) => { status: 'done' | 'failed' | 'denied'; code?: 'unsupported'; result?: Record<string, unknown> }) {
  let stopped = false;
  const handled: string[] = [];
  void (async () => {
    while (!stopped) {
      for (const action of await actions.poll(OWNER, deviceId, phone)) {
        handled.push(action.id);
        actions.report(OWNER, deviceId, action.id, answer(action.kind, action.payload as Record<string, unknown>));
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  opened.push({ close: () => { stopped = true; } });
  return handled;
}

describe('the device-action outbox', () => {
  it('hands an action once, takes one report, and never hands a reported action again', () => {
    const { actions } = outbox();
    const queued = actions.request(OWNER, 'reminder.create', { title: '牛乳', due: '2026-10-13T18:00' }, 'turn-1');
    expect(queued).toMatchObject({ kind: 'queued', connected: false, duplicate: false });
    // The same turn asking again is the same action.
    expect(actions.request(OWNER, 'reminder.create', { title: '牛乳', due: '2026-10-13T18:00' }, 'turn-1')).toMatchObject({ kind: 'queued', duplicate: true });
    const id = (queued as { action: { id: string } }).action.id;
    const handed = actions.poll(OWNER, 'iphone', phone);
    return handed.then(async list => {
      expect(list.map(action => action.id)).toEqual([id]);
      expect(list[0]).toMatchObject({ kind: 'reminder.create', payload: { title: '牛乳', due: '2026-10-13T18:00' } });
      // A lost answer is handed again to the device that holds it, never to another.
      expect((await actions.poll(OWNER, 'iphone', phone)).map(action => action.id)).toEqual([id]);
      expect(await actions.poll(OWNER, 'mac', { ...phone, platform: 'macos' })).toEqual([]);
      expect(actions.report(OWNER, 'mac', id, { status: 'done' })).toEqual({ kind: 'not_yours' });
      expect(actions.report(OWNER, 'iphone', id, { status: 'done' })).toMatchObject({ kind: 'accepted', action: { status: 'done' } });
      expect(actions.report(OWNER, 'iphone', id, { status: 'failed', code: 'failed' })).toMatchObject({ kind: 'already', action: { status: 'done' } });
      expect(await actions.poll(OWNER, 'iphone', phone)).toEqual([]);
    });
  });

  it('refuses music for a device that is away, expires what nobody took, and reports outcomes once to her next turn', async () => {
    const { actions } = outbox();
    expect(actions.request(OWNER, 'music.play', { query: 'jazz', reason: '雨なので' }, null)).toEqual({ kind: 'absent' });
    expect(actions.request('guest', 'reminder.create', { title: 'x' }, null)).toEqual({ kind: 'unavailable' });
    const timer = actions.request(OWNER, 'timer.start', { seconds: 180, label: 'パスタ' }, null) as { action: { id: string } };
    clock += 11 * 60_000;
    expect(await actions.poll(OWNER, 'iphone', phone)).toEqual([]);
    const block = actions.promptBlock(OWNER);
    expect(block).toContain('[端末に頼んだこと]');
    expect(block).toContain('タイマー「パスタ」: 端末が受け取らないまま期限が切れた');
    actions.told(OWNER, timer.action.id);
    expect(actions.promptBlock(OWNER)).toBe('');
  });

  it('holds a poll open until an action arrives for the device', async () => {
    const { actions } = outbox();
    await actions.poll(OWNER, 'iphone', phone);
    const held = actions.poll(OWNER, 'iphone', { ...phone, wait: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    const queued = actions.request(OWNER, 'music.control', { action: 'pause' }, null) as { action: { id: string } };
    expect((await held).map(action => action.id)).toEqual([queued.action.id]);
  });
});

describe('her device tools in a conversation', () => {
  it('waits for the device and reads what it found; without a device she is told the app is not open', async () => {
    const { call, actions } = conversation();
    const absent = (await call('music.search', { query: 'Bill Evans' }));
    expect(absent).toMatchObject({ ok: false, failure: 'unavailable' });
    device(actions, 'iphone', kind => kind === 'music.search'
      ? { status: 'done', result: { items: [{ id: 'i.123', type: 'song', title: 'Waltz for Debby', artist: 'Bill Evans', source: 'catalog' }] } }
      : { status: 'done', result: { title: 'Waltz for Debby', artist: 'Bill Evans' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const found = (await call('music.search', { query: 'Bill Evans' }));
    expect(found.ok).toBe(true);
    expect(found.text).toContain('id: i.123｜song｜「Waltz for Debby」 — Bill Evans｜catalog');
    const played = (await call('music.play', { itemId: 'i.123', reason: '静かな夜に合うから' }, 'voice'));
    expect(played).toMatchObject({ ok: true });
    expect(played.text).toContain('かけ始めた（端末で確認済み）');
    // Told in the conversation: not told again in her next turn.
    expect(actions.promptBlock(OWNER)).toBe('');
  });

  it('queues a reminder for the next time the app opens, checks its input, and reports a refusal of the device', async () => {
    const { call, actions } = conversation();
    expect((await call('reminder.create', { title: '牛乳' }))).toMatchObject({ ok: false, failure: 'invalid_input' });
    expect((await call('calendar.create_event', { title: '歯医者', start: '2026-13-01T10:00' }))).toMatchObject({ ok: false, failure: 'invalid_input' });
    const queued = (await call('reminder.create', { title: '牛乳を買う', inMinutes: 30 }));
    expect(queued.ok).toBe(true);
    expect(queued.text).toContain('済んだとは言わない');
    const [action] = await actions.poll(OWNER, 'iphone', phone);
    expect(action).toMatchObject({ kind: 'reminder.create', payload: { title: '牛乳を買う', dueAt: '2026-10-13T09:30:00.000Z' } });
    actions.report(OWNER, 'iphone', action!.id, { status: 'denied', code: 'not_authorized' });
    expect(actions.promptBlock(OWNER)).toContain('リマインダー「牛乳を買う」: 端末で許可がなくてできなかった（not_authorized）');
  });

  it('exists only for the owner alone in a conversation, and not while switched off', () => {
    const { service } = conversation();
    const names = (surface: 'text' | 'voice' | 'autonomy', audience: 'owner_alone' | 'others') => service.tools.offered(surface, audience, OWNER).map(tool => tool.name);
    expect(names('text', 'owner_alone')).toEqual(expect.arrayContaining(['music.play', 'reminder.create', 'timer.start', 'calendar.create_event']));
    expect(names('voice', 'owner_alone')).toContain('music.play');
    expect(names('autonomy', 'owner_alone')).not.toContain('music.play');
    expect(names('text', 'others')).not.toContain('music.play');
    expect(service.tools.offered('text', 'owner_alone', 'guest').some(tool => tool.domain === 'device_action')).toBe(false);
    const off = conversation({ SHANNON_DEVICE_ACTIONS: 'off' });
    expect(off.wiring.actions).toBeNull();
    expect(off.service.tools.offered('text', 'owner_alone', OWNER).some(tool => tool.domain === 'device_action')).toBe(false);
  });

  it('says what she can do with them only in a turn that offers them, and offers a spoken turn that asks for music', () => {
    const owner = shannonCapabilityPrompt('owner');
    const offered = withToolCapabilityLines({ systemPrompt: owner, tools: { definitions: [{ name: 'music.play', domain: 'device_action' }] } });
    expect(offered.systemPrompt).toContain(SHANNON_DEVICE_ACTIONS_CAPABILITY.text);
    // Appended after her identity, so the cached prefix is the same with and without it.
    expect(offered.systemPrompt.startsWith(owner)).toBe(true);
    expect(withToolCapabilityLines({ systemPrompt: owner, tools: { definitions: [{ name: 'study.read', domain: 'aether_study' }] } }).systemPrompt).toBe(owner);
    expect(asksForDeviceAction('なんか落ち着く曲かけて')).toBe(true);
    expect(asksForDeviceAction('次の角を曲がって')).toBe(false);
    const asked = ['音楽かけて', 'BGM流して', 'ジャズの曲を流して', 'この曲止めて', '曲をスキップ', '次の曲', 'プレイリストを再生して',
      '明日リマインドして', 'リマインダーお願い', '忘れないように言って', '7時に教えて', '会議のこと通知して',
      'タイマー3分', '5分後に教えて', '10分たったら呼んで', '金曜に予定を入れて', '予定に追加しといて', 'カレンダーに入れて'];
    const plain = ['話しかけて', '出かけてくるね', '電話かけて', '聞き流して', 'これは再生可能エネルギーの話', '作曲の勉強してる', '編曲が好き',
      '次の角を曲がって', 'スキップして帰った', '時間あるかな'];
    expect(asked.filter(words => !asksForDeviceAction(words))).toEqual([]);
    expect(plain.filter(words => asksForDeviceAction(words))).toEqual([]);
    expect(voiceToolOffer('3分のタイマーお願い', {}, OWNER, 'thread', false, false, true)).toBe('asked');
    expect(voiceToolOffer('3分のタイマーお願い', {}, OWNER, 'thread', false, false, false)).toBeNull();
  });
});

describe('the device routes', () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });

  async function serve(actions: DeviceActions | null) {
    const route = createDeviceActionRoute(actions, OWNER);
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const scopeKey = String(request.headers['x-scope'] ?? '');
      void route(request, response, scopeKey ? { scopeKey, deviceId: String(request.headers['x-device']) } : null, url).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return (path: string, init: { method?: string; body?: unknown; scope?: string } = {}) => fetch(`${base}${path}`, {
      method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-scope': init.scope ?? OWNER, 'x-device': 'iphone' },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }).then(async response => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
  }

  it('lets only the owner\'s device poll, report once, and record play outcomes', async () => {
    const { actions, store } = outbox();
    const fetchJson = await serve(actions);
    const kinds = ALL_KINDS.join(',');
    expect((await fetchJson(`/v1/device/actions?platform=ios&kinds=${kinds}`, { scope: 'guest' })).status).toBe(403);
    expect((await fetchJson('/v1/device/actions?platform=watch')).status).toBe(400);
    const queued = actions.request(OWNER, 'calendar.create_event', { title: '歯医者', start: '2026-10-14T10:00', allDay: false, durationMinutes: 60 }, null) as { action: { id: string } };
    const polled = await fetchJson(`/v1/device/actions?platform=ios&foreground=1&kinds=${kinds}`);
    expect(polled).toMatchObject({ status: 200, body: { schemaVersion: 1, pollSeconds: 2, actions: [{ id: queued.action.id, kind: 'calendar.create_event' }] } });
    const path = `/v1/device/actions/${queued.action.id}/result`;
    expect((await fetchJson(path, { method: 'POST', body: { status: 'maybe' } })).status).toBe(400);
    expect(await fetchJson(path, { method: 'POST', body: { status: 'done', result: { eventId: 'x' } } })).toMatchObject({ status: 200, body: { status: 'done', accepted: true } });
    expect(await fetchJson(path, { method: 'POST', body: { status: 'failed' } })).toMatchObject({ status: 200, body: { status: 'done', accepted: false } });
    expect((await fetchJson('/v1/device/actions/00000000-0000-4000-8000-000000000000/result', { method: 'POST', body: { status: 'done' } })).status).toBe(404);
    expect(await fetchJson('/v1/device/music/plays', { method: 'POST', body: { itemId: 'i.123', title: 'Waltz for Debby', outcome: 'skipped' } }))
      .toMatchObject({ status: 200, body: { recorded: true } });
    expect(store.plays(OWNER)).toEqual([expect.objectContaining({ itemId: 'i.123', outcome: 'skipped' })]);
  });

  it('answers 403 while switched off', async () => {
    const fetchJson = await serve(null);
    expect(await fetchJson('/v1/device/actions?platform=ios')).toMatchObject({ status: 403, body: { error: 'DEVICE_ACTIONS_DISABLED' } });
  });
});
