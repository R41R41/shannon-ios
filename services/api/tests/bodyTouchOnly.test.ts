import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BODY_LIMITS } from '../src/bodyContract.js';
import { configuredBodyLook } from '../src/bodyLookContract.js';
import { SQLiteBodyLookStore } from '../src/bodyLookStore.js';
import type { RoomLookViewer } from '../src/bodyLookVision.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { BODY_TOUCH_ONLY_FLAG, isFullBody, isTouchOnlyBody } from '../src/bodyTouchOnly.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import type { BodyPresence } from '../src/shannonBody.js';

const scope = 'owner';
const START = '2026-10-03T01:00:00.000Z';
const PHONE = 'iphone-1';
const PC = 'body-pc';

/** The owner's phone registered as a body that only feels touch, next to (or without) the desktop body. */
function harness() {
  const clock = { at: START };
  const now = () => clock.at;
  const store = new SQLiteBodyStore(':memory:');
  const viewer = { view: async () => { throw new Error('no look is expected'); } } as unknown as RoomLookViewer;
  const api = createLocalApiKernel(now, {
    stateStore: new InMemoryCompanionStateStore(now), conversationStore: new InMemoryConversationStore(),
    body: { store, ingestEnabled: true, look: { store: new SQLiteBodyLookStore(':memory:'), config: configuredBodyLook({}), viewer, timers: false } },
  });
  const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId: string) =>
    api.dispatch({ method, path, body: { scopeKey: scope, ...body }, deviceId });
  const presence = async (deviceId: string, query: Record<string, string> = {}) => (await api.dispatch({
    method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope, ...query }), deviceId,
  })).body as BodyPresence;
  const register = (deviceId: string, flags: Record<string, boolean>) =>
    send('PUT', '/v1/body/capabilities', { expressions: [], gestures: [], flags }, deviceId);
  const touch = (id: string, audience: 'owner' | 'others', deviceId: string) =>
    send('POST', '/v1/body/events', { events: [{ id, type: 'pet', audience, occurredAt: clock.at, durationMs: 900, strength: 0.4 }] }, deviceId);
  const prompt = async (message: string) =>
    ((await send('POST', '/v1/chat', { message }, PHONE)).body as { systemPrompt: string }).systemPrompt;
  const othersPresent = () => store.othersPresent(scope, clock.at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds);
  return { clock, store, send, presence, register, touch, prompt, othersPresent };
}

describe('a body that only feels touch', () => {
  it('is told apart by one flag', () => {
    expect(BODY_TOUCH_ONLY_FLAG).toBe('touchOnly');
    expect(isTouchOnlyBody({ flags: { touchOnly: true } })).toBe(true);
    expect(isTouchOnlyBody({ flags: { touchOnly: false } })).toBe(false);
    expect(isTouchOnlyBody(null)).toBe(false);
    expect(isFullBody({ flags: {} })).toBe(true);
    expect(isFullBody({ flags: { touchOnly: true, camera: true } })).toBe(false);
    expect(isFullBody(null)).toBe(false);
  });

  it('may ask for a reaction to a touch, and its touch is stored', async () => {
    const h = harness();
    const request = { id: 'touch-1', touch: { type: 'pet', durationMs: 1500, strength: 0.3, ongoing: true }, audience: 'owner', occurredAt: START };
    expect(await h.send('POST', '/v1/body/reactions', request, PHONE)).toMatchObject({ status: 403, body: { error: 'BODY_REACTION_NOT_A_BODY' } });
    expect((await h.register(PHONE, { touchOnly: true })).status).toBe(200);
    // No model is configured here, so she stays quiet; the point is that the request is taken.
    expect(await h.send('POST', '/v1/body/reactions', request, PHONE)).toMatchObject({ status: 200, body: { id: 'touch-1', status: 'quiet' } });
    expect(await h.touch('touch-1', 'owner', PHONE)).toMatchObject({ status: 200, body: { stored: 1 } });
  });

  it('is not a body a look can go through, even with a camera flag', async () => {
    const h = harness();
    await h.register(PHONE, { touchOnly: true, camera: true });
    expect(h.store.devicesWithFlag(scope, 'camera')).toEqual([]);
    expect(h.store.devicesWithFlag(scope, BODY_TOUCH_ONLY_FLAG)).toEqual([PHONE]);
    // The phone reading presence (it never does) opens nothing and is handed no look.
    expect((await h.presence(PHONE)).look ?? null).toBeNull();
    // Asked to look with only the phone registered, the reason is still that her body is not connected.
    expect(await h.prompt('ねえ、部屋を見てみて')).toContain('いまは見られない: 体（PCのアプリ）がつながっていない。');
    // The desktop body is unchanged: registered without a camera, the reason is its camera.
    await h.register(PC, { camera: false });
    expect(await h.prompt('部屋を見て')).toContain('いまは見られない: 体のカメラが入っていない。');
    await h.register(PC, { camera: true });
    expect(h.store.devicesWithFlag(scope, 'camera')).toEqual([PC]);
  });

  it('does not say who can see or hear her body', async () => {
    const h = harness();
    await h.register(PHONE, { touchOnly: true });
    // A touch on the phone with a friend beside the owner is stored with its audience and stands in for nothing.
    expect((await h.touch('phone-1', 'others', PHONE)).status).toBe(200);
    expect(h.othersPresent()).toBe(false);
    // Nor does an audience it sends on a presence read.
    await h.presence(PHONE, { audience: 'others' });
    expect(h.othersPresent()).toBe(false);
    // The desktop body's event does, as before, and a later touch on the phone alone does not undo it.
    expect((await h.touch('pc-1', 'others', PC)).status).toBe(200);
    expect(h.othersPresent()).toBe(true);
    h.clock.at = new Date(Date.parse(START) + 60_000).toISOString();
    expect((await h.touch('phone-2', 'owner', PHONE)).status).toBe(200);
    expect(h.othersPresent()).toBe(true);
  });
});
