import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRIVATE_LISTENING_LIMITS, privateListeningEnabled, validatedPrivateListeningReport } from '../src/contracts/privateListeningContract.js';
import { dispatchPrivateListeningRequest } from '../src/surfaces/body/privateListeningRoutes.js';
import { SQLitePrivateListeningStore } from '../src/surfaces/body/store/privateListeningStore.js';

const scope = 'owner';
const START = '2026-10-02T03:00:00.000Z';
const at = (milliseconds: number) => new Date(Date.parse(START) + milliseconds).toISOString();

const directory = mkdtempSync(join(tmpdir(), 'shannon-private-listening-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function harness(options: { enabled?: boolean; path?: string } = {}) {
  const clock = { at: START };
  const store = new SQLitePrivateListeningStore(options.path ?? ':memory:');
  const dependencies = { store, enabled: options.enabled ?? true, ownerScopeKey: scope, now: () => clock.at };
  const post = (body: Record<string, unknown>, deviceId: string | null = 'mac-1', scopeKey: string = scope) =>
    dispatchPrivateListeningRequest({ method: 'POST', path: '/v1/private-listening', body: { scopeKey, ...body }, ...(deviceId ? { deviceId } : {}) }, dependencies);
  return { clock, store, post, dependencies };
}

describe('POST /v1/private-listening', () => {
  it('stores that a device is privately listening, with its kind and since when', () => {
    const { post, store, clock } = harness();
    expect(post({ kind: 'mac', listening: true })).toEqual({
      status: 200,
      body: { schemaVersion: 1, listening: true, kind: 'mac', since: START, expiresAt: at(45_000), pollAfterSeconds: 15 },
    });
    clock.at = at(15_000);
    // The run goes on: `since` stays, the report is renewed.
    expect((post({ kind: 'mac', listening: true }).body as { since: string; expiresAt: string })).toMatchObject({ since: START, expiresAt: at(60_000) });
    expect(store.listeners(scope, clock.at)).toEqual([{ deviceId: 'mac-1', kind: 'mac', since: START, seenAt: at(15_000), ownerActiveAt: null, speaks: false }]);
  });

  it('lapses by itself when the reports stop, and a later report starts a new run', () => {
    const { post, store, clock } = harness();
    post({ kind: 'iphone', listening: true }, 'phone-1');
    expect(store.listeners(scope, at(PRIVATE_LISTENING_LIMITS.freshMilliseconds))).toHaveLength(1);
    expect(store.listeners(scope, at(PRIVATE_LISTENING_LIMITS.freshMilliseconds + 1))).toEqual([]);
    clock.at = at(10 * 60_000);
    expect((post({ kind: 'iphone', listening: true }, 'phone-1').body as { since: string }).since).toBe(at(10 * 60_000));
  });

  it('is cleared at once when the device says it is no longer privately listening', () => {
    const { post, store, clock } = harness();
    post({ kind: 'mac', listening: true });
    expect(post({ kind: 'mac', listening: false })).toEqual({ status: 200, body: { schemaVersion: 1, listening: false, pollAfterSeconds: 15 } });
    expect(store.listeners(scope, clock.at)).toEqual([]);
    // Saying it twice is harmless.
    expect(post({ kind: 'mac', listening: false }).status).toBe(200);
  });

  it('keeps each device apart and records when the owner last used each', () => {
    const { post, store, clock } = harness();
    post({ kind: 'mac', listening: true, ownerActiveAt: at(-60_000) }, 'mac-1');
    post({ kind: 'iphone', listening: true, ownerActiveAt: '2026-10-02T12:00:10+09:00' }, 'phone-1');
    const listeners = store.listeners(scope, clock.at);
    expect(listeners.map(item => [item.deviceId, item.kind, item.ownerActiveAt])).toEqual([
      ['mac-1', 'mac', at(-60_000)], ['phone-1', 'iphone', START],
    ]);
    post({ kind: 'mac', listening: false }, 'mac-1');
    expect(store.listeners(scope, clock.at).map(item => item.deviceId)).toEqual(['phone-1']);
  });

  it('never takes the owner\'s last use from the future, and never moves it backwards within a run', () => {
    const { post, store, clock } = harness();
    post({ kind: 'mac', listening: true, ownerActiveAt: at(3_600_000) });
    expect(store.listeners(scope, clock.at)[0]?.ownerActiveAt).toBe(START);
    clock.at = at(10_000);
    post({ kind: 'mac', listening: true, ownerActiveAt: at(-3_600_000) });
    expect(store.listeners(scope, clock.at)[0]?.ownerActiveAt).toBe(START);
    post({ kind: 'mac', listening: true });
    expect(store.listeners(scope, clock.at)[0]?.ownerActiveAt).toBe(START);
  });

  it('refuses a caller without a paired device: a fixed token cannot set the state', () => {
    const { post, store } = harness();
    const refused = post({ kind: 'mac', listening: true }, null);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('PAIRED_DEVICE_REQUIRED');
    expect(store.listeners(scope, START)).toEqual([]);
  });

  it('refuses a device paired into another scope: a guest cannot set or clear the owner\'s state', () => {
    const { post, store } = harness();
    post({ kind: 'mac', listening: true }, 'mac-1');
    for (const listening of [true, false]) {
      const refused = post({ kind: 'iphone', listening }, 'guest-phone', 'guest');
      expect(refused.status).toBe(403);
      expect((refused.body as { error: string }).error).toBe('PRIVATE_LISTENING_OWNER_ONLY');
    }
    expect(store.listeners('guest', START)).toEqual([]);
    expect(store.listeners(scope, START).map(item => item.deviceId)).toEqual(['mac-1']);
  });

  it('accepts a closed kind, a boolean and a timestamp, and nothing else', () => {
    const { post } = harness();
    for (const body of [
      { kind: 'windows', listening: true }, { kind: 'mac' }, { kind: 'mac', listening: 'yes' }, { listening: true },
      { kind: 'mac', listening: true, device: 'AirPods Pro' }, { kind: 'mac', listening: true, ownerActiveAt: 'now' },
      { kind: 'mac', listening: true, ownerActiveAt: 12 }, { kind: 'mac', listening: true, since: START },
    ]) {
      expect(post(body).status, JSON.stringify(body)).toBe(400);
    }
    expect(validatedPrivateListeningReport({ scopeKey: scope, kind: 'mac', listening: true, note: 'x'.repeat(100) })).toBe(`${'note'} is not allowed`);
  });

  it('answers only POST on its own path', () => {
    const { dependencies } = harness();
    expect(dispatchPrivateListeningRequest({ method: 'GET', path: '/v1/private-listening', query: new URLSearchParams({ scopeKey: scope }), deviceId: 'mac-1' }, dependencies).status).toBe(405);
    expect(dispatchPrivateListeningRequest({ method: 'POST', path: '/v1/private-listening/else', body: {}, deviceId: 'mac-1' }, dependencies).status).toBe(404);
  });
});

describe('SHANNON_PRIVATE_LISTENING', () => {
  it('is on unless switched off', () => {
    expect(privateListeningEnabled({})).toBe(true);
    for (const value of ['off', 'OFF', 'false', '0', 'disabled']) expect(privateListeningEnabled({ SHANNON_PRIVATE_LISTENING: value })).toBe(false);
  });

  it('switched off, refuses every report and still lets a device clear its row', () => {
    const on = harness();
    on.post({ kind: 'mac', listening: true });
    const off = { ...on.dependencies, enabled: false };
    const refused = dispatchPrivateListeningRequest({ method: 'POST', path: '/v1/private-listening', body: { scopeKey: scope, kind: 'mac', listening: true }, deviceId: 'mac-1' }, off);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('PRIVATE_LISTENING_DISABLED');
    expect(dispatchPrivateListeningRequest({ method: 'POST', path: '/v1/private-listening', body: { scopeKey: scope, kind: 'mac', listening: false }, deviceId: 'mac-1' }, off).status).toBe(200);
    expect(on.store.listeners(scope, START)).toEqual([]);
  });
});

describe('documents', () => {
  it('describes the route, its refusals and the switch, and both environment examples carry the switch', () => {
    const document = readFileSync(new URL('../../../docs/private-listening-contract.md', import.meta.url), 'utf8');
    for (const word of [
      'POST /v1/private-listening', 'ownerActiveAt', 'pollAfterSeconds', 'expiresAt', 'PAIRED_DEVICE_REQUIRED', 'PRIVATE_LISTENING_OWNER_ONLY',
      'PRIVATE_LISTENING_DISABLED', 'private_listening', 'SHANNON_PRIVATE_LISTENING',
    ]) expect(document, word).toContain(word);
    expect(PRIVATE_LISTENING_LIMITS).toMatchObject({ pollSeconds: 15, freshMilliseconds: 45_000, requestsPerMinute: 60 });
    for (const path of ['../../../deploy/azure/api.env.example', '../../../.env.example']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toMatch(/^SHANNON_PRIVATE_LISTENING=on$/mu);
    }
  });
});

describe('restart', () => {
  it('keeps the state in the database, and it still lapses by the clock after a restart', () => {
    const path = join(directory, 'restart.sqlite');
    const first = harness({ path });
    first.post({ kind: 'mac', listening: true });
    first.store.close();
    const second = new SQLitePrivateListeningStore(path);
    expect(second.listeners(scope, at(30_000)).map(item => item.deviceId)).toEqual(['mac-1']);
    expect(second.listeners(scope, at(60_000))).toEqual([]);
    second.close();
  });
});
