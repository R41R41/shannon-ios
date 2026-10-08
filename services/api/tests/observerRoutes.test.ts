import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';
import { createObserverRoute, serveObserverAsset } from '../src/infra/observer/observerRoutes.js';
import { SQLiteObserverStore } from '../src/infra/observer/store/observerStore.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { alone?: () => boolean; disabled?: boolean } = {}) {
  const store = new SQLiteObserverStore(':memory:'); cleanups.push(() => store.close());
  const route = createObserverRoute({ store: options.disabled ? null : store, ownerScope: 'owner', ownerAlone: options.alone ?? (() => true), isGame: principal => principal.deviceId === 'game' });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (serveObserverAsset(request, response, url.pathname)) return;
    const scope = request.headers['x-test-scope'];
    const principal: ShannonDevicePrincipal | null = typeof scope === 'string' && scope ? { scopeKey: scope, deviceId: String(request.headers['x-test-device'] ?? 'phone'), displayName: 'Test' } : null;
    void route(request, response, url.pathname, principal, url).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, init: RequestInit = {}, scope: string | null = 'owner', device = 'phone') => fetch(base + path, {
    ...init, headers: { ...(scope ? { 'x-test-scope': scope } : {}), 'x-test-device': device, ...init.headers },
  });
  return { store, base, call };
}
function nativeEvent(extra: Record<string, unknown> = {}) {
  return { runId: randomUUID(), spanId: randomUUID(), parentSpanId: null, node: 'stt', kind: 'span.completed', at: new Date().toISOString(),
    input: { provider: 'openai', mode: 'transcription' }, output: { transcript: '聞こえています。' }, elapsedMs: 40, ...extra };
}
const post = (events: unknown[]) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
function publish(store: SQLiteObserverStore, scope = 'owner') {
  store.publish({ scopeKey: scope, runId: randomUUID(), spanId: randomUUID(), parentSpanId: null, node: 'llm', kind: 'span.completed', at: new Date().toISOString(), output: { reply: `PRIVATE_${scope}` } }); store.flush();
}

describe('observer HTTP authorization and privacy', () => {
  it.each([null, 'guest', 'OWNER', 'owner-other'])('refuses a missing or nonexact owner principal (%s)', async scope => {
    const h = await fixture(); publish(h.store);
    const response = await h.call('/v1/observer/events?scopeKey=owner', {}, scope);
    expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'OBSERVER_OWNER_ONLY' });
  });
  it('refuses game devices and binds a legitimate owner read to the principal rather than query scope', async () => {
    const h = await fixture(); publish(h.store); publish(h.store, 'guest');
    expect((await h.call('/v1/observer/events', {}, 'owner', 'game')).status).toBe(403);
    const response = await h.call('/v1/observer/events?scopeKey=guest');
    expect(response.status).toBe(200); const body = await response.json() as { events: unknown[] };
    expect(body.events).toHaveLength(1); expect(JSON.stringify(body)).toContain('PRIVATE_owner'); expect(JSON.stringify(body)).not.toContain('PRIVATE_guest');
  });
  it.each(['others', 'unavailable', 'unknown'] as const)('holds all values when audience is %s', async audience => {
    const h = await fixture({ alone: () => { if (audience === 'unavailable') throw new Error('no audience'); return audience === 'unknown' ? undefined as unknown as boolean : false; } });
    publish(h.store);
    for (const path of ['/v1/observer/events?audience=owner', '/v1/observer/catalog']) {
      const response = await h.call(path); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ events: [], availability: 'held' });
    }
  });
  it('honors an explicit others audience and rechecks privacy immediately before returning a read', async () => {
    let alone = true; const h = await fixture({ alone: () => alone }); publish(h.store);
    expect(await (await h.call('/v1/observer/events?audience=others')).json()).toMatchObject({ events: [], availability: 'held' });
    const read = h.store.read.bind(h.store);
    vi.spyOn(h.store, 'read').mockImplementation((...args) => { const result = read(...args); alone = false; return result; });
    const response = await h.call('/v1/observer/events?audience=owner');
    const body = await response.json(); expect(body).toMatchObject({ events: [], availability: 'held' }); expect(JSON.stringify(body)).not.toContain('PRIVATE');
  });
  it('rechecks audience for the catalog and reports a disabled store without details', async () => {
    let calls = 0; const h = await fixture({ alone: () => ++calls === 1 });
    expect(await (await h.call('/v1/observer/catalog')).json()).toMatchObject({ events: [], availability: 'held' });
    const disabled = await fixture({ disabled: true }); expect((await disabled.call('/v1/observer/events')).status).toBe(503);
  });
});

describe('bounded native event collection', () => {
  it('accepts native events, labels them client-origin, rebinds scope, and redacts bounded content', async () => {
    const h = await fixture();
    const event = nativeEvent({ scopeKey: 'guest', origin: 'server', model: 'spoofed-model', output: {
      transcript: 'Bearer never-store-this sk-ant-private-credential', signature: 'PRIVATE_SIGNATURE', systemPrompt: 'PRIVATE_PROMPT', long: 'x'.repeat(5000),
    } });
    const response = await h.call('/v1/observer/client-events', post([event])); expect(response.status).toBe(202); expect(await response.json()).toEqual({ schemaVersion: 1, accepted: 1 });
    h.store.flush(); const batch = h.store.read('owner', 0, 200); expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ origin: 'client', node: 'stt', runId: event.runId, spanId: event.spanId, elapsedMs: 40 });
    expect(batch.events[0]).not.toHaveProperty('model'); expect(h.store.read('guest', 0, 200).events).toEqual([]);
    const serialized = JSON.stringify(batch); expect(serialized).not.toMatch(/PRIVATE_SIGNATURE|PRIVATE_PROMPT|never-store-this|sk-ant-private-credential/u);
    expect((batch.events[0]?.output as { long: string }).long.length).toBeLessThanOrEqual(2000);
  });
  it('accepts the native Swift DTO shapes for capture, transcription, join, delegation and playback', async () => {
    const h = await fixture(), capture = randomUUID().toUpperCase(), turn = randomUUID().toUpperCase();
    const pcm = randomUUID().toUpperCase(), stt = randomUUID().toUpperCase(), joined = randomUUID().toUpperCase(), play = randomUUID().toUpperCase();
    const at = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    // JSONEncoder omits nil properties and UUID.uuidString is uppercase; at is Date.ISO8601Format().
    const events = [
      { runId: capture, spanId: pcm, node: 'pcm', kind: 'span.started', at, input: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 } },
      { runId: capture, spanId: pcm, node: 'pcm', kind: 'span.completed', at, output: { byteCount: 4_800, sampleCount: 2_400, destination: 'transcription-socket' } },
      { runId: capture, spanId: randomUUID(), node: 'stt', kind: 'handoff', at, fromNode: 'pcm', toNode: 'stt', sourceSpanId: pcm, output: { byteCount: 4_800 } },
      { runId: capture, spanId: stt, node: 'stt', kind: 'span.completed', at, output: { characterCount: 12, model: 'gpt-4o-mini-transcribe', provider: 'openai' } },
      { runId: turn, spanId: joined, parentSpanId: stt, node: 'join', kind: 'span.completed', at, input: { captureRunId: capture, segmentCount: 1 }, output: { characterCount: 12, utteranceId: turn } },
      { runId: turn, spanId: randomUUID(), node: 'join', kind: 'handoff', at, fromNode: 'stt', toNode: 'join', sourceSpanId: stt, output: { captureRunId: capture } },
      { runId: turn, spanId: randomUUID(), node: 'join', kind: 'handoff', at, fromNode: 'join', toNode: 'perception', sourceSpanId: joined, output: { utteranceRunId: turn } },
      { runId: turn, spanId: play, node: 'play', kind: 'span.started', at, input: { model: 'gemini-3.8-flash-tts' } },
      { runId: turn, spanId: play, node: 'play', kind: 'span.completed', at, output: { byteCount: 4_800, sampleCount: 2_400 } },
    ];
    const response = await h.call('/v1/observer/client-events', post(events)); expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ schemaVersion: 1, accepted: events.length }); h.store.flush();
    const saved = h.store.read('owner', 0, 200).events; expect(saved).toHaveLength(events.length); expect(saved.every(event => event.origin === 'client')).toBe(true);
    expect(saved.map(event => event.runId)).toEqual(events.map(event => event.runId));
    expect(saved[6]).toMatchObject({ node: 'join', fromNode: 'join', toNode: 'perception', sourceSpanId: joined });
  });

  it('accepts a native handoff only between client-reachable endpoints', async () => {
    const h = await fixture(); const source = randomUUID();
    const response = await h.call('/v1/observer/client-events', post([nativeEvent({ node: 'join', kind: 'handoff', fromNode: 'stt', toNode: 'join', sourceSpanId: source })]));
    expect(response.status).toBe(202); h.store.flush(); expect(h.store.read('owner', 0, 200).events[0]).toMatchObject({ fromNode: 'stt', toNode: 'join', sourceSpanId: source, origin: 'client' });
  });
  it.each(['run.started', 'run.completed'])('rejects a forged client %s without accepting part of its batch', async kind => {
    const h = await fixture();
    const response = await h.call('/v1/observer/client-events', { method: 'POST', body: JSON.stringify({ events: [nativeEvent(), nativeEvent({ kind, origin: 'server' })], droppedEvents: 12 }) });
    expect(response.status).toBe(400); h.store.flush();
    expect(h.store.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 0 });
  });
  it('accepts a loss-only native report without inventing events', async () => {
    const h = await fixture();
    const response = await h.call('/v1/observer/client-events', { method: 'POST', body: JSON.stringify({ events: [], droppedEvents: 3 }) });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ schemaVersion: 1, accepted: 0 });
    h.store.flush(); expect(h.store.read('owner', 0, 200)).toMatchObject({ dropped: 3, events: [] });
  });
  it.each([0, 1, 4096])('accepts a bounded native loss count of %s alongside its events', async droppedEvents => {
    const h = await fixture();
    const response = await h.call('/v1/observer/client-events', { method: 'POST', body: JSON.stringify({ events: [nativeEvent()], droppedEvents }) });
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ accepted: 1 }); h.store.flush();
    expect(h.store.read('owner', 0, 200)).toMatchObject({ dropped: droppedEvents, events: [{ origin: 'client', node: 'stt' }] });
    const batch = await (await h.call('/v1/observer/events')).json(); expect(batch).toMatchObject({ dropped: droppedEvents });
  });
  it.each([-1, 1.5, 4097, Number.MAX_SAFE_INTEGER + 1, '1', null, {}, []].map(value => [value]))('rejects invalid native loss count %j atomically', async droppedEvents => {
    const h = await fixture();
    const response = await h.call('/v1/observer/client-events', { method: 'POST', body: JSON.stringify({ events: [nativeEvent()], droppedEvents }) });
    expect(response.status).toBe(400); h.store.flush();
    expect(h.store.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 0 });
  });
  it('does not accept client loss counters from other scopes, a game device, or an unpaired credential', async () => {
    const h = await fixture();
    const body = { method: 'POST', body: JSON.stringify({ events: [nativeEvent()], droppedEvents: 7 }) };
    for (const [scope, device] of [['guest', 'phone'], ['owner', 'game'], [null, 'phone']] as const) {
      expect((await h.call('/v1/observer/client-events', body, scope, device)).status).toBe(403);
    }
    h.store.flush(); expect(h.store.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 0 });
  });
  it.each(['llm', 'tools', 'gate', 'memory', 'native', 'unknown'])('rejects client impersonation of node %s atomically', async node => {
    const h = await fixture(); const response = await h.call('/v1/observer/client-events', post([nativeEvent(), nativeEvent({ node })]));
    expect(response.status).toBe(400); h.store.flush(); expect(h.store.read('owner', 0, 200).events).toEqual([]);
  });
  it.each([
    { runId: 'bad' }, { spanId: 'bad' }, { parentSpanId: 'bad' }, { at: 'invalid' }, { at: new Date(0).toISOString() }, { kind: 'made.up' },
    { kind: 'handoff', fromNode: 'llm', toNode: 'join' }, { kind: 'handoff', fromNode: 'stt', toNode: 'join', sourceSpanId: 'bad' },
  ])('rejects malformed client metadata %j', async invalid => {
    const h = await fixture(); expect((await h.call('/v1/observer/client-events', post([nativeEvent(invalid)]))).status).toBe(400);
    h.store.flush(); expect(h.store.read('owner', 0, 200).events).toEqual([]);
  });
  it('bounds batch size and malformed request bodies with client errors', async () => {
    const h = await fixture();
    for (const events of [[], Array.from({ length: 17 }, () => nativeEvent())]) expect((await h.call('/v1/observer/client-events', post(events))).status).toBe(400);
    expect((await h.call('/v1/observer/client-events', { method: 'POST', body: '{broken' })).status).toBe(400);
    expect((await h.call('/v1/observer/client-events', { method: 'POST', body: 'x'.repeat(33 * 1024) })).status).toBe(413);
  });
  it('rechecks the current audience after awaiting a streamed request body and stores none', async () => {
    let alone = true; const entered = deferred(); const h = await fixture({ alone: () => { entered.resolve(); return alone; } });
    const payload = JSON.stringify({ events: [nativeEvent()], droppedEvents: 9 });
    const result = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest(h.base + '/v1/observer/client-events', { method: 'POST', headers: { 'x-test-scope': 'owner', 'content-type': 'application/json' } }, response => {
        let raw = ''; response.on('data', part => { raw += part; }); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(raw) }));
      });
      request.on('error', reject); request.write(payload.slice(0, 10));
      void entered.promise.then(() => { alone = false; request.end(payload.slice(10)); });
    });
    expect(await result).toMatchObject({ status: 200, body: { events: [], availability: 'held' } }); h.store.flush(); expect(h.store.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 0 });
  });
});

describe('observer HTTP request and asset limits', () => {
  it.each(['after=-1', 'after=1.5', 'after=NaN', 'after=9007199254740992', 'limit=0', 'limit=201', 'limit=1.5'])('rejects invalid cursor/limit %s', async query => {
    const h = await fixture(); expect((await h.call(`/v1/observer/events?${query}`)).status).toBe(400);
  });
  it('caps requests per device independently and resets after the minute window', async () => {
    const h = await fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 300; i++) expect((await h.call('/v1/observer/events')).status).toBe(200);
    expect((await h.call('/v1/observer/events')).status).toBe(429);
    expect((await h.call('/v1/observer/events', {}, 'owner', 'second-phone')).status).toBe(200);
    now += 60_001; expect((await h.call('/v1/observer/events')).status).toBe(200);
  });
  it('serves only allowlisted GET assets with no-store and a restrictive CSP', async () => {
    const h = await fixture();
    for (const path of ['/observer', '/observer/observer.js', '/observer/observer.css']) {
      const response = await h.call(path); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await h.call(path, { method: 'POST' })).status).toBe(405);
    }
    expect((await h.call('/observer/', { method: 'POST', redirect: 'manual' })).status).toBe(405);
    const redirect = await h.call('/observer/', { redirect: 'manual' }); expect(redirect.status).toBe(308); expect(redirect.headers.get('cache-control')).toBe('no-store');
    for (const path of ['/observer/%2e%2e/observerContext.ts', '/observer/unknown.js', '/observer/%2f..%2fstore/observerStore.ts']) expect((await h.call(path)).status).toBe(404);
    expect((await h.call('/v1/observer/events', { method: 'DELETE' })).status).toBe(405);
  });
});
