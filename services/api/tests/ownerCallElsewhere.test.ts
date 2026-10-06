import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BODY_LIMITS } from '../src/contracts/bodyContract.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import type { ShannonDevicePrincipal } from '../src/deviceAuth.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { OWNER_CALL_LIMITS, OWNER_IN_CALL_ELSEWHERE, SQLiteOwnerCallFacts, ownerCallElsewhereEnabled } from '../src/ownerCallElsewhere.js';
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

function harness(options: { enabled?: boolean; answered?: Array<{ deviceId: string; answeredAt: string }> } = {}) {
  const clock = { at: START };
  const now = () => clock.at;
  const stateStore = new InMemoryCompanionStateStore(now);
  const conversationStore = new InMemoryConversationStore();
  const store = new SQLiteBodyStore(':memory:');
  const answered = options.answered ?? [];
  const api = createLocalApiKernel(now, { stateStore, conversationStore, body: { store, ownerCalls: {
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}), answered: () => answered } } });
  /** A session from this device: refused (409), or created and noted, as the session route does. */
  const session = (deviceId: string | undefined, mode: 'owner' | 'guest' = 'owner') => {
    if (api.voiceSessions.refused(scope, deviceId, mode)) return 'refused';
    if (deviceId) api.voiceSessions.created(scope, deviceId);
    return 'created';
  };
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
  return { clock, api, store, conversationStore, send, presence, call, voice, advance, session, answered };
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
    expect(h.session(PHONE)).toBe('created');
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
    h.session(PHONE);
    h.advance(MINUTE);
    await h.call(PHONE, 'callEnded');
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
  });

  it('stops counting a callStarted whose callEnded never came: after two hours, or after thirty minutes without its voice', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    // Turns every twenty minutes keep a long call going, up to two hours after its start.
    for (let minutes = 20; minutes < 120; minutes += 20) {
      h.advance(20 * MINUTE);
      expect((await h.voice(PHONE)).status).toBe(200);
    }
    h.advance(19 * MINUTE);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    h.advance(2 * MINUTE);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    // The app killed mid-call: nothing of its voice for thirty minutes ends it.
    const quiet = await registered(harness());
    await quiet.call(PHONE, 'callStarted');
    quiet.advance(OWNER_CALL_LIMITS.reportedCallQuietMilliseconds - MINUTE);
    expect((await quiet.presence()).ownerCallElsewhere?.active).toBe(true);
    quiet.advance(2 * MINUTE);
    expect((await quiet.presence()).ownerCallElsewhere).toEqual({ active: false });
  });

  it('ends a reporting device\'s call at its callEnded, not three minutes later; a later turn does not revive it, a new session does', async () => {
    const h = await registered(harness());
    expect(h.session(PHONE)).toBe('created');
    await h.call(PHONE, 'callStarted');
    h.advance(MINUTE);
    expect((await h.voice(PHONE)).status).toBe(200);
    h.advance(10_000);
    await h.call(PHONE, 'callEnded');
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    expect((await h.voice(PC)).status).toBe(200);
    // A turn still under way when he hung up is not a new call.
    expect((await h.voice(PHONE)).status).toBe(200);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    // A new session counts at once, before its callStarted arrives.
    h.advance(MINUTE);
    expect(h.session(PHONE)).toBe('created');
    expect((await h.presence()).ownerCallElsewhere?.active).toBe(true);
  });

  it('compares the end with the server\'s clock, so a phone clock ten minutes slow does not hide a new call', async () => {
    const h = await registered(harness());
    const slow = (milliseconds = 0) => new Date(Date.parse(h.clock.at) - 10 * MINUTE + milliseconds).toISOString();
    expect(h.session(PHONE)).toBe('created');
    await h.call(PHONE, 'callStarted', slow());
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: slow(), surface: 'ios' });
    h.advance(MINUTE);
    await h.call(PHONE, 'callEnded', slow());
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    h.advance(MINUTE);
    expect(h.session(PHONE)).toBe('created');
    expect((await h.presence()).ownerCallElsewhere?.active).toBe(true);
  });

  it('reads a callStarted stamped by a phone clock a few minutes fast, as the store keeps it', async () => {
    const h = await registered(harness());
    const fast = new Date(Date.parse(START) + 3 * MINUTE).toISOString();
    expect((await h.call(PHONE, 'callStarted', fast)).body).toMatchObject({ stored: 1 });
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: fast, surface: 'ios' });
  });

  it('counts her call he answered on the iPhone from the moment of the answer', async () => {
    const h = await registered(harness());
    h.answered.push({ deviceId: PHONE, answeredAt: START });
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    expect((await h.voice(PC)).status).toBe(409);
    h.advance(2 * MINUTE);
    expect((await h.voice(PHONE)).status).toBe(200);
    h.advance(2 * MINUTE);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'ios' });
    h.advance(OWNER_CALL_LIMITS.voiceIdleMilliseconds);
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
    h.session(PC);
    expect((await h.presence(MAC)).ownerCallElsewhere).toEqual({ active: false });
  });

  it('names no surface for a device the server cannot place, and the earliest of two calls', async () => {
    const h = await registered(harness());
    h.session('unknown-device');
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
    expect(h.session(PC)).toBe('created');
  });
});

describe('409 OWNER_IN_CALL_ELSEWHERE', () => {
  it('refuses a delegation from her body while the owner is in a call on his iPhone, and records nothing', async () => {
    const h = await registered(harness());
    expect(h.session(PHONE)).toBe('created');
    h.advance(34_000);
    const threads = h.conversationStore.listThreads(scope).length;
    const refused = await h.voice(PC, '元気です。');
    expect(refused).toEqual({ status: 409, body: { error: OWNER_IN_CALL_ELSEWHERE, message: expect.any(String) } });
    expect(h.conversationStore.listThreads(scope)).toHaveLength(threads);
    expect(h.conversationStore.history(scope, 'desktop')).toHaveLength(0);
    // Her body's session start is refused the same way.
    expect(h.session(PC)).toBe('refused');
    // Once his call is over, the body may talk again.
    h.advance(OWNER_CALL_LIMITS.voiceIdleMilliseconds + 1_000);
    expect((await h.voice(PC)).status).toBe(200);
  });

  it('never refuses the iPhone: not for its own callStarted, not for a call on the desktop', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    expect((await h.voice(PHONE)).status).toBe(200);
    expect(h.session(PHONE)).toBe('created');
    await h.call(PC, 'callStarted');
    expect((await h.voice(PHONE)).status).toBe(200);
    // An unregistered app (the Mac) is not refused either.
    expect((await h.voice(MAC)).status).toBe(200);
  });

  it('never refuses a guest call, nor a request without a device (fail open)', async () => {
    const h = await registered(harness());
    await h.call(PHONE, 'callStarted');
    expect((await h.voice(PC, 'シャノン、こんにちは', 'guest')).status).toBe(200);
    expect(h.session(PC, 'guest')).toBe('created');
    expect((await h.voice(undefined)).status).toBe(200);
    expect(h.session(undefined)).toBe('created');
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

  it('notes the iPhone\'s session only once it was made', async () => {
    const h = await registered(harness());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let upstream = 500;
    vi.stubGlobal('fetch', vi.fn(async () => upstream === 200
      ? new Response(JSON.stringify({ value: 'ek_synthetic_client_secret_value', expires_at: 1_790_816_000 }))
      : new Response('{"error":{"code":"server_error"}}', { status: upstream })));
    const route = createGeminiLiveRoute({ OPENAI_API_KEY: 'k' }, h.api, () => true);
    const call = async (status: number) => {
      upstream = status;
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ transcriptionProvider: 'openai' }))]), { method: 'POST' }) as unknown as IncomingMessage;
      let code = 0;
      const response = { setHeader: () => undefined, writeHead: (value: number) => { code = value; }, end: () => undefined } as unknown as ServerResponse;
      await route(request, response, { deviceId: PHONE, scopeKey: scope } as ShannonDevicePrincipal);
      return code;
    };
    expect(await call(500)).toBe(502);
    expect((await h.presence()).ownerCallElsewhere).toEqual({ active: false });
    expect(await call(200)).toBe(200);
    expect((await h.presence()).ownerCallElsewhere?.active).toBe(true);
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

describe('SQLiteOwnerCallFacts', () => {
  it('reads her answered calls, and the body registration, then private listening, then a VoIP registration', () => {
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
    const surfaces = new SQLiteOwnerCallFacts(path);
    expect(surfaces.surface(scope, 'mac-body')).toBe('mac');
    expect(surfaces.surface(scope, PC)).toBeUndefined();
    expect(surfaces.surface(scope, 'mac-listening')).toBe('mac');
    expect(surfaces.surface(scope, 'voip-phone')).toBe('ios');
    expect(surfaces.surface(scope, 'nobody')).toBeUndefined();
    calls.begin(scope, { callId: 'c1', initiativeId: 'i1', deviceId: 'voip-phone', threadId: 't', expiresAt: START }, START);
    calls.end('c1', ['pending'], 'answered', 'app', '2026-10-05T10:35:00.000Z');
    expect(surfaces.answered(scope, START)).toEqual([{ deviceId: 'voip-phone', answeredAt: '2026-10-05T10:35:00.000Z' }]);
    expect(surfaces.answered(scope, '2026-10-05T10:36:00.000Z')).toEqual([]);
    surfaces.close(); body.close(); listening.close(); calls.close();
  });
});
