import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BODY_LIMITS } from '../src/bodyContract.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import type { ShannonDevicePrincipal } from '../src/deviceAuth.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { OWNER_CALL_LIMITS, OWNER_IN_CALL_ELSEWHERE, SQLiteDeviceSurfaces, ownerCallElsewhereEnabled } from '../src/ownerCallElsewhere.js';
import { SQLitePrivateListeningStore } from '../src/privateListeningStore.js';
import { createGeminiLiveRoute } from '../src/serverGeminiLiveRoute.js';
import { createLiveVoiceStreamRoute } from '../src/serverLiveVoiceStreamRoute.js';
import type { BodyPresence } from '../src/shannonBody.js';

/**
 * Production, 2026-10-05 10:34Z: the owner was in a voice call with her on his iPhone; the desktop body's wake listener
 * heard her name from the phone's speaker and sent her iPhone voice as his turns. The desktop now reads whether he is in a
 * call on another of his apps (`presence.ownerCallElsewhere`), and its voice requests are refused while he is.
 */
const MINUTE = 60_000;
const START = '2026-10-05T10:34:00.000Z';
const scope = 'owner';
const PC = 'body-pc';
const PHONE = 'iphone-c710';
const MAC = 'mac-app';
const delegations = '/v1/voice/gemini/cascade/delegations';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(options: { enabled?: boolean } = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const stateStore = new InMemoryCompanionStateStore(now);
  const conversationStore = new InMemoryConversationStore();
  const store = new SQLiteBodyStore(':memory:');
  const api = createLocalApiKernel(now, { stateStore, conversationStore, body: { store, ...(options.enabled !== undefined ? { ownerCalls: { enabled: options.enabled } } : {}) } });
  const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId?: string) =>
    api.dispatch({ method, path, body: { scopeKey: scope, ...body }, ...(deviceId ? { deviceId } : {}) });
  const presence = async (deviceId = PC) =>
    (await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId })).body as BodyPresence;
  const call = (deviceId: string, type: 'callStarted' | 'callEnded', occurredAt = clock.at, id = `${deviceId}-${type}-${occurredAt}`) =>
    send('POST', '/v1/body/events', { events: [{ id, type, audience: 'owner', occurredAt }] }, deviceId);
  const voice = (deviceId: string | undefined, transcript = 'お、シャノン、元気？', participantMode?: 'guest') => send('POST', delegations, {
    threadId: 'desktop', transcript, ...(participantMode ? { participantMode } : {}),
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: `u-${clock.at}-${deviceId}`, text: transcript, source: 'speech', rawText: transcript,
        ...(participantMode ? { callContext: { callId: 'call-guest-0001', turns: [], introductionStart: true } } : {}) } },
  }, deviceId);
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { clock, api, store, conversationStore, send, presence, call, voice, advance };
}

/** The desktop body, and the owner's iPhone as a body that only feels touch (the app's Live2D figure). */
async function registered(h: ReturnType<typeof harness>) {
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { camera: true }, surface: 'windows' }, PC);
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'iphone' }, PHONE);
  return h;
}

describe('presence.ownerCallElsewhere', () => {
  it('is inactive while nobody is in a call, and the poll keeps its pace', async () => {
    const h = await registered(harness());
    const presence = await h.presence();
    expect(presence.ownerCallElsewhere).toEqual({ active: false });
    expect(presence.pollAfterSeconds).toBe(BODY_LIMITS.presencePollSeconds);
  });

  it('is active from the iPhone\'s voice session, with since and surface, and polls faster; then idles out', async () => {
    const h = await registered(harness());
    const before = await h.presence();
    expect(h.api.voiceSessionRefused(scope, PHONE, 'owner')).toBe(false);
    h.advance(20_000);
    const during = await h.presence();
    expect(during.ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    expect(during.pollAfterSeconds).toBe(OWNER_CALL_LIMITS.pollSeconds);
    expect(during.etag).not.toBe(before.etag);
    // Each delegated turn keeps the call going; three minutes without one, it is over.
    h.advance(2 * MINUTE);
    expect((await h.voice(PHONE)).status).toBe(200);
    h.advance(OWNER_CALL_LIMITS.voiceIdleMilliseconds - 1_000);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    h.advance(2_000);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    expect((await h.presence()).pollAfterSeconds).toBe(BODY_LIMITS.presencePollSeconds);
  });

  it('follows a device\'s callStarted to its callEnded, also from a touch-only phone', async () => {
    const h = await registered(harness());
    const receipt = await h.call(PHONE, 'callStarted');
    expect(receipt.body).toMatchObject({ stored: 1 });
    h.advance(30 * MINUTE);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    await h.call(PHONE, 'callEnded');
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
  });

  it('a callEnded also closes the voice session the server saw from that device', async () => {
    const h = await registered(harness());
    h.api.voiceSessionRefused(scope, PHONE, 'owner');
    h.advance(MINUTE);
    await h.call(PHONE, 'callEnded');
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
  });

  it('stops counting a callStarted whose callEnded never came after two hours', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    h.advance(OWNER_CALL_LIMITS.reportedCallMaximumMilliseconds - MINUTE);
    expect((await h.presence()).ownerCallElsewhere?.active).toBe(true);
    h.advance(2 * MINUTE);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
  });

  it('excludes the device that asks, and never counts her full body\'s own call for anyone', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    // The phone asking about itself: its own call is not elsewhere.
    expect((await h.presence(PHONE)).ownerCallElsewhere).toEqual({ active: false });
    await h.call(PHONE, 'callEnded', new Date(Date.parse(START) + 1_000).toISOString());
    h.advance(2_000);
    // The desktop's own call (a wake) is not the owner's call elsewhere: not for itself, not for another device.
    await h.call(PC, 'callStarted');
    expect((await h.presence(PC)).ownerCallElsewhere).toEqual({ active: false });
    expect((await h.presence(MAC)).ownerCallElsewhere).toEqual({ active: false });
    h.api.voiceSessionRefused(scope, PC, 'owner');
    expect((await h.presence(MAC)).ownerCallElsewhere).toEqual({ active: false });
  });

  it('names no surface for a device the server cannot place, and the earliest of two calls', async () => {
    const h = await registered(harness());
    h.api.voiceSessionRefused(scope, 'unknown-device', 'owner');
    h.advance(10_000);
    await h.call(PHONE, 'callStarted');
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START });
  });

  it('is absent, and nothing is refused, with SHANNON_OWNER_CALL_ELSEWHERE=off', async () => {
    expect(ownerCallElsewhereEnabled({})).toBe(true);
    for (const value of ['off', 'false', '0', 'disabled', ' OFF ']) expect(ownerCallElsewhereEnabled({ SHANNON_OWNER_CALL_ELSEWHERE: value })).toBe(false);
    const h = await registered(harness({ enabled: false }));
    await h.call(PHONE, 'callStarted');
    expect(await h.presence()).not.toHaveProperty('ownerCallElsewhere');
    expect((await h.voice(PC)).status).toBe(200);
    expect(h.api.voiceSessionRefused(scope, PC, 'owner')).toBe(false);
  });
});

describe('409 OWNER_IN_CALL_ELSEWHERE', () => {
  it('refuses a delegation from her body while the owner is in a call on his iPhone, and records nothing', async () => {
    const h = await registered(harness());
    expect(h.api.voiceSessionRefused(scope, PHONE, 'owner')).toBe(false);
    h.advance(34_000);
    const threads = h.conversationStore.listThreads(scope).length;
    const refused = await h.voice(PC, '元気です。');
    expect(refused).toEqual({ status: 409, body: { error: OWNER_IN_CALL_ELSEWHERE, message: expect.any(String) } });
    expect(h.conversationStore.listThreads(scope)).toHaveLength(threads);
    expect(h.conversationStore.history(scope, 'desktop')).toHaveLength(0);
    // Her body's session start is refused the same way.
    expect(h.api.voiceSessionRefused(scope, PC, 'owner')).toBe(true);
    // Once his call is over, the body may talk again.
    h.advance(OWNER_CALL_LIMITS.voiceIdleMilliseconds + 1_000);
    expect((await h.voice(PC)).status).toBe(200);
  });

  it('never refuses the iPhone: not for its own callStarted, not for a call on the desktop', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    expect((await h.voice(PHONE)).status).toBe(200);
    expect(h.api.voiceSessionRefused(scope, PHONE, 'owner')).toBe(false);
    await h.call(PC, 'callStarted');
    expect((await h.voice(PHONE)).status).toBe(200);
    // An unregistered app (the Mac) is not refused either.
    expect((await h.voice(MAC)).status).toBe(200);
  });

  it('never refuses a guest call, nor a request without a device (fail open)', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    expect((await h.voice(PC, 'シャノン、こんにちは', 'guest')).status).toBe(200);
    expect(h.api.voiceSessionRefused(scope, PC, 'guest')).toBe(false);
    expect((await h.voice(undefined)).status).toBe(200);
    expect(h.api.voiceSessionRefused(scope, undefined, 'owner')).toBe(false);
  });

  it('answers the session route with 409 before any session is made', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_synthetic_client_secret_value', expires_at: 1_790_816_000 })));
    vi.stubGlobal('fetch', fetcher);
    const route = createGeminiLiveRoute({ OPENAI_API_KEY: 'k' }, h.api, () => true);
    const call = async (deviceId: string, body: Record<string, unknown>) => {
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST' }) as unknown as IncomingMessage;
      let status = 0;
      let payload = '';
      const response = { setHeader: () => undefined, writeHead: (code: number) => { status = code; }, end: (text: string) => { payload = text; } } as unknown as ServerResponse;
      await route(request, response, { deviceId, scopeKey: scope } as ShannonDevicePrincipal);
      return { status, body: JSON.parse(payload) as Record<string, unknown> };
    };
    expect(await call(PC, { transcriptionProvider: 'openai', participantMode: 'owner' }))
      .toEqual({ status: 409, body: { error: OWNER_IN_CALL_ELSEWHERE, message: expect.any(String) } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await call(PC, { transcriptionProvider: 'openai', participantMode: 'guest' })).status).toBe(200);
    expect((await call(PHONE, { transcriptionProvider: 'openai' })).status).toBe(200);
  });

  it('answers the streamed delegation route with a plain 409 before any line is streamed', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    const request = Readable.from([JSON.stringify({ transcript: '元気です。', threadId: 'desktop' })]) as IncomingMessage;
    request.method = 'POST';
    let status = 0;
    let output = '';
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead(code: number) { status = code; this.headersSent = true; return this; },
      write(value: string) { output += value; return true; },
      end(value?: string) { if (value) output += value; },
    }) as unknown as ServerResponse;
    await createLiveVoiceStreamRoute(h.api, () => true)(request, response, { deviceId: PC, scopeKey: scope } as ShannonDevicePrincipal);
    expect(status).toBe(409);
    expect(JSON.parse(output)).toEqual({ error: OWNER_IN_CALL_ELSEWHERE, message: expect.any(String) });
  });
});

describe('SQLiteDeviceSurfaces', () => {
  it('reads the body registration, then private listening, then a VoIP registration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-device-surfaces-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const body = new SQLiteBodyStore(path);
    const listening = new SQLitePrivateListeningStore(path);
    const calls = new SQLiteIncomingCallStore(path);
    body.saveCapabilities(scope, 'mac-body', { expressions: [], gestures: [], flags: {}, surface: 'mac' }, START);
    body.saveCapabilities(scope, PC, { expressions: [], gestures: [], flags: {}, surface: 'windows' }, START);
    listening.report(scope, 'mac-listening', { kind: 'mac' }, START);
    calls.register(scope, 'voip-phone', { deviceToken: 'a'.repeat(64), environment: 'production', bundleId: 'app', enabled: true }, START);
    const surfaces = new SQLiteDeviceSurfaces(path);
    expect(surfaces.surface(scope, 'mac-body')).toBe('mac');
    expect(surfaces.surface(scope, PC)).toBeUndefined();
    expect(surfaces.surface(scope, 'mac-listening')).toBe('mac');
    expect(surfaces.surface(scope, 'voip-phone')).toBe('ios');
    expect(surfaces.surface(scope, 'nobody')).toBeUndefined();
    surfaces.close(); body.close(); listening.close(); calls.close();
  });
});
