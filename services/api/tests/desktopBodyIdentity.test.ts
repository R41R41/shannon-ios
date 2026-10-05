import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BODY_LIMITS } from '../src/bodyContract.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { isFullBody } from '../src/bodyTouchOnly.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { SQLiteOwnerCallFacts } from '../src/ownerCallElsewhere.js';
import {
  DESKTOP_BODY_HEADER, DESKTOP_BODY_HEADER_VALUE, desktopBodyDeviceId, desktopBodyMaySpeakOn, mayHaveDesktopBody, namesDesktopBody, requestDeviceId,
} from '../src/desktopBodyIdentity.js';
import type { BodyPresence } from '../src/shannonBody.js';

/**
 * Roadmap A17: the Mac app shows her standing on the desktop. Its desktop window is her full body (who can see her,
 * looks, her messages, who is at the Mac), while the app itself keeps its voice calls (A16): a Mac call must quiet the
 * Windows desktop and must never be refused. The body part therefore speaks for a device derived from the app's.
 */
const START = '2026-10-06T09:00:00.000Z';
const scope = 'owner';
const PC = 'body-pc';
const PHONE = 'iphone-c710';
const MAC = '0123456789abcdef';
const MAC_BODY = desktopBodyDeviceId(MAC);
const delegations = '/v1/voice/gemini/cascade/delegations';

describe('the request identity', () => {
  it('names the header and its one value', () => {
    expect(DESKTOP_BODY_HEADER).toBe('x-shannon-body');
    expect(DESKTOP_BODY_HEADER_VALUE).toBe('desktop');
    expect(MAC_BODY).toBe('0123456789abcdef.desktop-body');
    expect(namesDesktopBody('desktop')).toBe(true);
    expect(namesDesktopBody(' Desktop ')).toBe(true);
    expect(namesDesktopBody(['desktop', 'other'])).toBe(true);
    for (const value of [undefined, '', 'app', 'desktop-body', 'windows']) expect(namesDesktopBody(value)).toBe(false);
  });

  it('gives the body identity only on her body routes and the read of her messages', () => {
    expect(requestDeviceId(MAC, 'desktop', 'GET', '/v1/body/presence')).toBe(MAC_BODY);
    expect(requestDeviceId(MAC, 'desktop', 'PUT', '/v1/body/capabilities')).toBe(MAC_BODY);
    expect(requestDeviceId(MAC, 'desktop', 'POST', '/v1/body/events')).toBe(MAC_BODY);
    expect(requestDeviceId(MAC, 'desktop', 'POST', '/v1/body/looks/0b6c1f0e')).toBe(MAC_BODY);
    expect(requestDeviceId(MAC, 'desktop', 'GET', '/v1/initiatives')).toBe(MAC_BODY);
    // The app's own routes stay the app's, header or not: its calls, its look, marking messages read.
    for (const [method, path] of [['POST', delegations], ['POST', '/v1/voice/gemini/cascade/sessions'], ['POST', '/v1/app/looks/x'],
      ['POST', '/v1/initiatives/read'], ['POST', '/v1/chat'], ['GET', '/v1/state']] as const) {
      expect(desktopBodyMaySpeakOn(method, path)).toBe(false);
      expect(requestDeviceId(MAC, 'desktop', method, path)).toBe(MAC);
    }
    // Without the header nothing changes, and a device that may not derive one never does (her Minecraft body).
    expect(requestDeviceId(MAC, undefined, 'GET', '/v1/body/presence')).toBe(MAC);
    expect(requestDeviceId(MAC, 'desktop', 'GET', '/v1/body/presence', () => false)).toBe(MAC);
    // Asked only when the header and the route call for a body.
    expect(requestDeviceId(MAC, undefined, 'GET', '/v1/body/presence', () => { throw new Error('not asked'); })).toBe(MAC);
  });
});

function harness() {
  const clock = { at: START };
  const now = () => clock.at;
  const store = new SQLiteBodyStore(':memory:');
  const api = createLocalApiKernel(now, {
    stateStore: new InMemoryCompanionStateStore(now), conversationStore: new InMemoryConversationStore(), body: { store },
  });
  const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId: string) =>
    api.dispatch({ method, path, body: { scopeKey: scope, ...body }, deviceId });
  const presence = async (deviceId: string, audience?: 'owner' | 'others') => (await api.dispatch({
    method: 'GET', path: '/v1/body/presence', deviceId, query: new URLSearchParams({ scopeKey: scope, ...(audience ? { audience } : {}) }),
  })).body as BodyPresence;
  const call = (deviceId: string, type: 'callStarted' | 'callEnded', audience: 'owner' | 'others' = 'owner') =>
    send('POST', '/v1/body/events', { events: [{ id: `${deviceId}-${type}-${clock.at}`, type, audience, occurredAt: clock.at }] }, deviceId);
  const session = (deviceId: string) => {
    if (api.voiceSessions.refused(scope, deviceId, 'owner')) return 'refused';
    api.voiceSessions.created(scope, deviceId);
    return 'created';
  };
  const voice = (deviceId: string) => send('POST', delegations, {
    threadId: 'mac', transcript: 'ねえシャノン',
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: `u-${clock.at}-${deviceId}`, text: 'ねえシャノン', source: 'speech', rawText: 'ねえシャノン' } },
  }, deviceId);
  const othersPresent = () => store.othersPresent(scope, clock.at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds);
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  return { store, send, presence, call, session, voice, othersPresent, advance };
}

/** The Windows desktop, the iPhone's figure, the Mac app's figure in Talk, and the Mac's desktop body. */
async function registered() {
  const h = harness();
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { camera: true }, surface: 'windows' }, PC);
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'iphone' }, PHONE);
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'mac' }, MAC);
  await h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { camera: false }, surface: 'mac' }, MAC_BODY);
  return h;
}

describe('the Mac app and its desktop body', () => {
  it('are two registrations: the body is a full body, the app stays an app', async () => {
    const h = await registered();
    expect(isFullBody(h.store.capabilities(scope, MAC_BODY))).toBe(true);
    expect(isFullBody(h.store.capabilities(scope, MAC))).toBe(false);
  });

  it('a desktop body registers on the Mac as a full body, nothing else; only a device on the Mac (or unregistered) has one', async () => {
    const h = harness();
    const put = (body: Record<string, unknown>) => h.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: {}, ...body }, MAC_BODY);
    expect((await put({ surface: 'windows' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ surface: 'mac', flags: { touchOnly: true } })).status).toBe(400);
    expect(h.store.capabilities(scope, MAC_BODY)).toBeNull();
    expect((await put({ surface: 'mac', flags: { camera: true } })).status).toBe(200);
  });

  it('is derived only for a device that has said it is the Mac app (review SF1), as server.ts asks the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-desktop-body-'));
    try {
      const path = join(directory, 'shannon.sqlite');
      const store = new SQLiteBodyStore(path);
      const at = START;
      store.saveCapabilities(scope, 'mac-app', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'mac' }, at);
      store.saveCapabilities(scope, 'windows-no-surface', { expressions: [], gestures: [], flags: { camera: true } }, at);
      store.saveCapabilities(scope, 'windows-body', { expressions: [], gestures: [], flags: {}, surface: 'windows' }, at);
      store.saveCapabilities(scope, 'iphone-figure', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'iphone' }, at);
      const facts = new SQLiteOwnerCallFacts(path);
      const may = (deviceId: string, isGame = false) => mayHaveDesktopBody({
        isGame, registration: store.capabilities(scope, deviceId), appSurface: () => facts.surface(scope, deviceId),
      });
      expect(may('mac-app')).toBe(true);
      // An iPhone that registered nothing and said nothing of itself: unknown is refused.
      expect(may('unregistered-iphone')).toBe(false);
      // A Windows body without a surface, one with one, and the phone's figure.
      expect(may('windows-no-surface')).toBe(false);
      expect(may('windows-body')).toBe(false);
      expect(may('iphone-figure')).toBe(false);
      expect(may('mac-app', true)).toBe(false);
      expect(mayHaveDesktopBody({ isGame: false, registration: null, appSurface: () => { throw new Error('database'); } })).toBe(false);
      expect(mayHaveDesktopBody({ isGame: false, registration: null, appSurface: () => 'mac' })).toBe(true);
      expect(mayHaveDesktopBody({ isGame: false, registration: { surface: 'mac' }, appSurface: () => 'ios' })).toBe(false);
      facts.close();
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('(a) a Mac voice call quiets the Windows desktop, and the Mac body sees it as the owner in a call', async () => {
    const h = await registered();
    await h.call(MAC, 'callStarted');
    h.advance(10_000);
    expect((await h.presence(PC)).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'mac' });
    expect((await h.presence(MAC_BODY)).ownerCallElsewhere).toEqual({ active: true, since: START, surface: 'mac' });
    // The desktop's own wake would be refused meanwhile.
    expect((await h.voice(PC)).status).toBe(409);
    await h.call(MAC, 'callEnded');
    expect((await h.presence(PC)).ownerCallElsewhere).toEqual({ active: false });
  });

  it('(b) the Mac app is never refused, also while the iPhone is in a call', async () => {
    const h = await registered();
    expect(h.session(PHONE)).toBe('created');
    h.advance(5_000);
    expect(h.session(MAC)).toBe('created');
    expect((await h.voice(MAC)).status).toBe(200);
    // Her full bodies are: the Windows desktop is refused while the iPhone call runs.
    expect(h.session(PC)).toBe('refused');
  });

  it('(c) what the Mac body says about who can see her is who is present; the app figure\'s touches are not', async () => {
    const h = await registered();
    await h.presence(MAC_BODY, 'owner');
    expect(h.othersPresent()).toBe(false);
    h.advance(1_000);
    await h.presence(MAC_BODY, 'others');
    expect(h.othersPresent()).toBe(true);
    // A presence read by the app's own device is not a body's read: its audience is not kept.
    const app = harness();
    await app.send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'mac' }, MAC);
    await app.presence(MAC, 'others');
    expect(app.othersPresent()).toBe(false);
  });

  it('a Mac call in 「友人も一緒」 stands in for nobody: only the body\'s own report says who can see her', async () => {
    const h = await registered();
    await h.call(MAC, 'callStarted', 'others');
    expect(h.othersPresent()).toBe(false);
  });

  it('the Mac body\'s own presence never counts its app\'s call as its own', async () => {
    const h = await registered();
    h.session(MAC);
    h.advance(5_000);
    // The Mac app reads no presence; for the Windows desktop and the Mac body alike the Mac call is elsewhere.
    expect((await h.presence(PC)).ownerCallElsewhere?.active).toBe(true);
    expect((await h.presence(MAC_BODY)).ownerCallElsewhere?.active).toBe(true);
  });
});

describe('her Minecraft body and the header (review of A17, B1)', () => {
  const GAME = 'minebot-dev';
  it('stays the game body under a derived identity: nothing but game_only, no audience noted, no call, no feeling', async () => {
    const clock = { at: START };
    const now = () => clock.at;
    const store = new SQLiteBodyStore(':memory:');
    const stateStore = new InMemoryCompanionStateStore(now);
    const api = createLocalApiKernel(now, { stateStore, conversationStore: new InMemoryConversationStore(), body: { store, game: { deviceId: GAME, ownerScopeKey: scope } } });
    await api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', deviceId: PC, body: { scopeKey: scope, expressions: [], gestures: [], flags: {}, surface: 'windows' } });
    const derived = desktopBodyDeviceId(GAME);
    const before = stateStore.snapshot(scope).emotion;
    const put = await api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', deviceId: derived, body: { scopeKey: scope, expressions: [], gestures: [], flags: {}, surface: 'mac' } });
    expect(put.status).toBe(403);
    const sent = await api.dispatch({ method: 'POST', path: '/v1/body/events', deviceId: derived, body: { scopeKey: scope, events: [
      { id: 'g-call', type: 'callStarted', audience: 'owner', occurredAt: START },
      { id: 'g-pet', type: 'pet', audience: 'owner', occurredAt: START },
      { id: 'g-death', type: 'game.died', audience: 'others', occurredAt: START, cause: 'minecraft:lava' },
    ] } });
    expect((sent.body as { results: unknown[] }).results).toEqual([
      { id: 'g-call', status: 'ignored', reason: 'game_only' }, { id: 'g-pet', status: 'ignored', reason: 'game_only' },
      { id: 'g-death', status: 'ignored', reason: 'not_game_body' },
    ]);
    await api.dispatch({ method: 'GET', path: '/v1/body/presence', deviceId: derived, query: new URLSearchParams({ scopeKey: scope, audience: 'others' }) });
    expect(store.othersPresent(scope, clock.at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds)).toBe(false);
    const presence = (await api.dispatch({ method: 'GET', path: '/v1/body/presence', deviceId: PC, query: new URLSearchParams({ scopeKey: scope }) })).body as BodyPresence;
    expect(presence.ownerCallElsewhere).toEqual({ active: false });
    expect(stateStore.snapshot(scope).emotion).toEqual(before);
  });
});
