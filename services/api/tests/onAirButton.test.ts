import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validatedOnAirControlRequest } from '../src/contracts/onAirContract.js';
import { SQLiteOnAirStore, onAirControlOf } from '../src/infra/onAir/onAirStore.js';
import { handlePlatformVoiceRequest } from '../src/surfaces/platform/platformVoiceRoute.js';

const START = '2026-10-20T12:00:00.000Z';

describe('the owner button for 「収録中」 (onAirControlOf, POST /v1/platform/voice/on-air)', () => {
  const clock = { at: START };
  const advance = (minutes: number): void => { clock.at = new Date(Date.parse(clock.at) + minutes * 60_000).toISOString(); };
  let server: Server | null = null;
  afterEach(() => new Promise<void>(resolve => { clock.at = START; return server ? server.close(() => resolve()) : resolve(); }));

  it('asks for exactly one of read, off and minutes', () => {
    expect(validatedOnAirControlRequest({ read: true })).toEqual({ read: true });
    expect(validatedOnAirControlRequest({ off: true })).toEqual({ off: true });
    expect(validatedOnAirControlRequest({ minutes: 180 })).toEqual({ minutes: 180 });
    for (const bad of [{}, { minutes: 0 }, { minutes: 721 }, { minutes: 1.5 }, { minutes: '60' }, { read: true, off: true }, { note: 'x' }, [], null, 'x']) {
      expect(validatedOnAirControlRequest(bad), JSON.stringify(bad)).toMatchObject({ status: 400 });
    }
  });

  it('turns on for a time, ends by itself, and keeps the note the owner wrote across off and on', () => {
    const store = new SQLiteOnAirStore(':memory:');
    store.set('owner', { until: new Date(Date.parse(START) + 5 * 60_000).toISOString(), note: 'メモ' }, START);
    const control = onAirControlOf(store, 'owner', () => clock.at);
    control.start(60);
    expect(control.until()).toBe('2026-10-20T13:00:00.000Z');
    expect(store.active('owner', START)).toMatchObject({ note: 'メモ' });
    control.stop();
    expect(control.until()).toBeNull();
    expect(store.lastNote('owner')).toBe('メモ');
    control.start(30);
    expect(store.active('owner', START)).toMatchObject({ note: 'メモ' });
    advance(31);
    expect(control.until()).toBeNull();
    store.close();
  });

  it('starts with an empty note when none was ever written, and never for another scope', () => {
    const store = new SQLiteOnAirStore(':memory:');
    onAirControlOf(store, 'owner', () => clock.at).start(10);
    expect(store.active('owner', START)).toMatchObject({ note: '' });
    expect(store.active('other', START)).toBeNull();
    store.close();
  });

  async function post(body: unknown, routes: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    server = createServer((request, response) => {
      void handlePlatformVoiceRequest('/v1/platform/voice/on-air', request, response, { token: 't' }, {
        service: {} as never, mouth: {} as never, scopeKey: 'owner', environment: () => ({ SHANNON_DC_VOICE: 'on' }), ...routes,
      } as never);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const realFetch = (globalThis as { realFetch?: typeof fetch }).realFetch ?? fetch;
    const response = await realFetch(`http://127.0.0.1:${port}/v1/platform/voice/on-air`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it('answers with the end only, never the note, and refuses a wrong body or a missing port', async () => {
    const store = new SQLiteOnAirStore(':memory:');
    const onAir = onAirControlOf(store, 'owner', () => clock.at);
    store.set('owner', { until: START, note: 'ひみつのメモ' }, START);
    expect(await post({ read: true }, { onAir })).toEqual({ status: 200, body: { onAir: null } });
    server!.close(); server = null;
    expect(await post({ minutes: 90 }, { onAir })).toEqual({ status: 200, body: { onAir: { until: '2026-10-20T13:30:00.000Z' } } });
    server!.close(); server = null;
    expect(await post({ off: true }, { onAir })).toEqual({ status: 200, body: { onAir: null } });
    server!.close(); server = null;
    expect((await post({ minutes: 0 }, { onAir })).status).toBe(400);
    server!.close(); server = null;
    expect((await post({ read: true }, {})).status).toBe(503);
    store.close();
  });
});
