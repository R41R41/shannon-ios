import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_TOUCH_GESTURES, BODY_TOUCH_INPUTS, BODY_TOUCH_REFLEXES, BODY_TOUCH_SIDES, BODY_TOUCH_VOCABULARY, isImpossibleTouch, validatedBodyEvents, type BodyEvent,
} from '../src/bodyContract.js';
import { bodyReactionContentHash, validatedBodyReactionRequest, type BodyReactionAnswer, type BodyReactionRequest } from '../src/bodyReactionContract.js';
import { BODY_REACTION_OWN_RULE } from '../src/bodyReactionPrompt.js';
import { BODY_TOUCH_PARTS } from '../src/bodyTouchWords.js';
import type { BodyIngestReceipt, BodyPresence } from '../src/shannonBody.js';
import { START, reactionHarness, scope } from './bodyReactionHarness.js';

// Stage 1b exactly, kept under SHANNON_PREDICTION=off (Syzygy ADR-0006 stage 2: `bodyTouchStage2.test.ts`).
beforeEach(() => { vi.stubEnv('SHANNON_PREDICTION', 'off'); });
afterEach(() => { vi.unstubAllEnvs(); });

/**
 * Touch vocabulary 2 (Syzygy ADR-0005, phase 1a): optional facts beside `type` and `region`. Nothing about a
 * touch in the old shape may change. Phase 1a stored the new facts only; since phase 1b the reaction prompt tells
 * her the part, the side and the flinch, and the parts where only the reflex moves her are `bodyTouchReflex.test.ts`.
 */
const touch = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'pet', audience: 'owner', occurredAt: START, durationMs: 1_500, ...extra });
const detail = { part: 'cheek', side: 'left', gesture: 'stroke', input: 'press', reflex: 'none' };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const databasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-touch-vocabulary-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
};

/** The digests exactly as they were written before vocabulary 2 (54cec9a), for a request in the old shape. */
const oldEventHash = (event: Record<string, unknown>) => createHash('sha256').update(JSON.stringify([
  event.type, event.audience, event.occurredAt, event.durationMs ?? null, event.strength ?? null, event.minutesAway ?? null,
  ...(event.region !== undefined ? [event.region] : []),
])).digest('hex').slice(0, 32);
const oldReactionHash = (request: BodyReactionRequest) => createHash('sha256').update(JSON.stringify([
  request.touch.type, request.touch.durationMs, request.touch.strength ?? null, request.touch.ongoing, request.audience, request.occurredAt,
  ...(request.touch.region !== undefined ? [request.touch.region] : []),
])).digest('hex').slice(0, 32);

describe('touch vocabulary 2: the signal', () => {
  it('is said on PUT /v1/body/capabilities and on every presence read, and is not part of the snapshot', async () => {
    const { send, api } = await reactionHarness({ unregistered: true });
    const saved = await send('PUT', '/v1/body/capabilities', { expressions: ['smile'], gestures: [] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ touchVocabulary: 2 });
    expect(BODY_TOUCH_VOCABULARY).toBe(2);
    const read = (etag?: string) => api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope, ...(etag ? { etag } : {}) }), deviceId: 'body-pc' });
    const presence = (await read()).body as BodyPresence;
    expect(presence.touchVocabulary).toBe(2);
    expect(presence.capabilities).not.toHaveProperty('touchVocabulary');
    expect((await read(presence.etag)).body).toMatchObject({ unchanged: true, touchVocabulary: 2, etag: presence.etag });
  });
});

describe('touch vocabulary 2: a touch in the old shape', () => {
  it('hashes as before, for an event and for a reaction, so a retry gets the answer it always got', async () => {
    const path = databasePath();
    const { events, send, bodyStore, reactionStore } = await reactionHarness({ path });
    const old = [touch('old-1'), touch('old-2', { region: 'head', strength: 0.4 }), { id: 'old-3', type: 'ownerReturned', audience: 'owner', occurredAt: START, minutesAway: 5 }];
    expect((await events(...old)).body).toEqual({
      schemaVersion: 1, stored: 3, duplicates: 0,
      results: [{ id: 'old-1', status: 'stored' }, { id: 'old-2', status: 'stored' }, { id: 'old-3', status: 'stored' }],
    });
    const database = new DatabaseSync(path);
    const hashes = database.prepare('SELECT event_key, content_hash FROM body_events ORDER BY event_key').all() as unknown as Array<{ event_key: string; content_hash: string }>;
    expect(hashes).toEqual(old.map(event => ({ event_key: event.id, content_hash: oldEventHash(event) })));
    expect((await events(...old)).body).toMatchObject({ stored: 0, duplicates: 3 });

    const request = { id: 'r-old', touch: { type: 'poke', durationMs: 200, ongoing: false, region: 'face', strength: 0.3 }, audience: 'owner', occurredAt: START };
    const first = await send('POST', '/v1/body/reactions', request);
    const validated = validatedBodyReactionRequest(request) as BodyReactionRequest;
    expect(bodyReactionContentHash(validated)).toBe(oldReactionHash(validated));
    const stored = database.prepare('SELECT content_hash FROM body_reactions WHERE reaction_id = ?').get('r-old') as { content_hash: string };
    expect(stored.content_hash).toBe(oldReactionHash(validated));
    expect((await send('POST', '/v1/body/reactions', request)).body).toEqual(first.body);
    expect(first.body).not.toHaveProperty('ignored');
    // Nothing of vocabulary 2 is stored for a touch that did not send it.
    for (const id of ['old-1', 'old-2', 'r-old']) expect(reactionStore.touchDetail(scope, id)).toEqual({});
    expect(bodyStore.recent(scope, 'owner', '2026-10-01T00:00:00.000Z', 10).find(event => event.id === 'old-2')).toEqual(expect.not.objectContaining({ part: expect.anything() }));
    database.close();
  });

  it('validates to exactly what it validated to before', () => {
    const events = [touch('a', { region: 'side', strength: 0.456 }), { id: 'b', type: 'ownerAway', audience: 'others', occurredAt: START, minutesAway: 3 }];
    expect(validatedBodyEvents(events)).toEqual([
      { id: 'a', type: 'pet', audience: 'owner', occurredAt: START, durationMs: 1_500, strength: 0.46, region: 'side' },
      { id: 'b', type: 'ownerAway', audience: 'others', occurredAt: START, minutesAway: 3 },
    ]);
    expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'holdHand', durationMs: 2_000, ongoing: true, region: 'hand' }, audience: 'owner', occurredAt: START }))
      .toEqual({ id: 'r', audience: 'owner', occurredAt: START, touch: { type: 'holdHand', durationMs: 2_000, ongoing: true, region: 'hand' } });
  });

  it('is never an impossible touch, whatever its type and region', () => {
    for (const type of ['pet', 'tickle', 'poke', 'carry', 'holdHand']) {
      for (const region of [undefined, 'head', 'face', 'side', 'hand', 'body']) expect(isImpossibleTouch({ ...(region ? { region: region as 'head' } : {}) }), `${type} ${region}`).toBe(false);
    }
  });
});

describe('touch vocabulary 2: the fields', () => {
  it('takes each word of the closed lists, on an event and on a reaction', () => {
    expect(BODY_TOUCH_PARTS).toEqual(['head', 'hair', 'forehead', 'cheek', 'face', 'shoulder', 'arm', 'hand', 'belly', 'side', 'neck', 'chest', 'waist', 'leg', 'skirt', 'other']);
    expect(BODY_TOUCH_SIDES).toEqual(['left', 'right']);
    expect(BODY_TOUCH_GESTURES).toEqual(['stroke', 'poke', 'tickle', 'rest', 'hold', 'carry']);
    expect(BODY_TOUCH_INPUTS).toEqual(['press', 'hover']);
    expect(BODY_TOUCH_REFLEXES).toEqual(['none', 'flinch', 'avoid']);
    for (const part of BODY_TOUCH_PARTS) expect(validatedBodyEvents([touch('p', { part })]), part).toMatchObject([{ part }]);
    expect(validatedBodyEvents([touch('d', { region: 'face', ...detail })])).toEqual([{ ...touch('d'), region: 'face', ...detail }]);
    expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'pet', durationMs: 10, ongoing: true, region: 'face', ...detail }, audience: 'owner', occurredAt: START }))
      .toMatchObject({ touch: { region: 'face', ...detail } });
  });

  it('drops a part outside the list, as a region is dropped, and the touch still counts', async () => {
    expect(validatedBodyEvents([touch('t', { part: 'tail', region: 'body' })])).toEqual([{ ...touch('t'), region: 'body' }]);
    expect(validatedBodyEvents([touch('t', { part: 7 })])).toEqual([touch('t')]);
    expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'poke', durationMs: 10, ongoing: false, part: 'antenna' }, audience: 'owner', occurredAt: START }))
      .toEqual({ id: 'r', audience: 'owner', occurredAt: START, touch: { type: 'poke', durationMs: 10, ongoing: false } });
    const { events, state, reactionStore } = await reactionHarness();
    expect(((await events(touch('tail-1', { part: 'tail' }))).body as BodyIngestReceipt).results).toEqual([{ id: 'tail-1', status: 'stored' }]);
    expect(state().version).toBeGreaterThan(0);
    expect(reactionStore.touchDetail(scope, 'tail-1')).toEqual({});
    // A dropped part is not part of the content: the same event without it is a duplicate.
    expect(((await events(touch('tail-1'))).body as BodyIngestReceipt).results).toEqual([{ id: 'tail-1', status: 'duplicate' }]);
  });

  it('drops a side, gesture, input or reflex outside its list, and refuses any of them only on an event that is not a touch', async () => {
    for (const [field, value] of [['side', 'up'], ['gesture', 'kiss'], ['input', 'tap'], ['reflex', 'scream'], ['gesture', 3]] as const) {
      expect(validatedBodyEvents([touch('x', { region: 'face', part: 'cheek', [field]: value })]), field).toEqual([{ ...touch('x'), region: 'face', part: 'cheek' }]);
      expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'pet', durationMs: 1, ongoing: true, [field]: value }, audience: 'owner', occurredAt: START }), field)
        .toEqual({ id: 'r', audience: 'owner', occurredAt: START, touch: { type: 'pet', durationMs: 1, ongoing: true } });
    }
    for (const field of ['part', 'side', 'gesture', 'input', 'reflex']) {
      expect(validatedBodyEvents([{ id: 'x', type: 'ownerReturned', audience: 'owner', occurredAt: START, [field]: 'left' }]), field).toContain('is not allowed for ownerReturned');
    }
    // A body of a later vocabulary never loses its batch, and a call event beside such a touch still arrives.
    const { events, state, reactionStore } = await reactionHarness();
    const receipt = (await events(touch('later', { gesture: 'hug', reflex: 'blush' }), { id: 'call', type: 'callStarted', audience: 'owner', occurredAt: START })).body as BodyIngestReceipt;
    expect(receipt.results).toEqual([{ id: 'later', status: 'stored' }, { id: 'call', status: 'stored' }]);
    expect(state().version).toBeGreaterThan(0);
    expect(reactionStore.touchDetail(scope, 'later')).toEqual({});
    // A dropped word is not part of the content.
    expect(((await events(touch('later'))).body as BodyIngestReceipt).results).toEqual([{ id: 'later', status: 'duplicate' }]);
  });

  it('lets the old fields win: a part whose parent is not the region sent, or a gesture not sent with this type, is left out', async () => {
    expect(validatedBodyEvents([touch('m', { region: 'head', part: 'chest' })])).toEqual([{ ...touch('m'), region: 'head' }]);
    expect(validatedBodyEvents([touch('m', { region: 'body', part: 'chest' })])).toEqual([{ ...touch('m'), region: 'body', part: 'chest' }]);
    // Without a region sent, the part stands.
    expect(validatedBodyEvents([touch('m', { part: 'chest' })])).toEqual([{ ...touch('m'), part: 'chest' }]);
    expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'poke', durationMs: 1, ongoing: false, region: 'face', part: 'hand' }, audience: 'owner', occurredAt: START }))
      .toMatchObject({ touch: { type: 'poke', region: 'face' } });
    expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'poke', durationMs: 1, ongoing: false, region: 'face', part: 'hand' }, audience: 'owner', occurredAt: START }))
      .not.toHaveProperty('touch.part');
    const pairs: [string, string, boolean][] = [
      ['stroke', 'pet', true], ['stroke', 'poke', false], ['poke', 'poke', true], ['poke', 'pet', false], ['tickle', 'tickle', true], ['tickle', 'pet', false],
      ['rest', 'pet', true], ['rest', 'holdHand', true], ['rest', 'carry', false], ['hold', 'holdHand', true], ['hold', 'pet', false], ['carry', 'carry', true], ['carry', 'holdHand', false],
    ];
    for (const [gesture, type, kept] of pairs) {
      const [event] = validatedBodyEvents([touch('g', { type, gesture })]) as readonly BodyEvent[];
      expect(event!.gesture, `${gesture} with ${type}`).toBe(kept ? gesture : undefined);
      const request = validatedBodyReactionRequest({ id: 'r', touch: { type, durationMs: 1, ongoing: false, gesture }, audience: 'owner', occurredAt: START }) as BodyReactionRequest;
      expect(request.touch.gesture, `${gesture} with ${type} (reaction)`).toBe(kept ? gesture : undefined);
    }
    // A hold on the chest sent as a pet is a pet on the chest: the gesture is left out, so it is no impossible touch.
    const { events, reactionStore } = await reactionHarness();
    expect(((await events(touch('pet-chest', { region: 'body', part: 'chest', gesture: 'hold' }))).body as BodyIngestReceipt).results).toEqual([{ id: 'pet-chest', status: 'stored' }]);
    expect(reactionStore.touchDetail(scope, 'pet-chest')).toEqual({ part: 'chest' });
  });

  it('is part of the content only when sent: the same id with another part, side, gesture, input or reflex is a conflict', async () => {
    const { events, send } = await reactionHarness();
    expect(((await events(touch('d-1', { region: 'face', ...detail }))).body as BodyIngestReceipt).results).toEqual([{ id: 'd-1', status: 'stored' }]);
    const changes = [{ part: 'face' }, { side: 'right' }, { gesture: 'rest' }, { input: 'hover', part: 'head', region: 'head' }, { reflex: 'flinch' }];
    for (const change of changes) {
      expect(((await events(touch('d-1', { region: 'face', ...detail, ...change }))).body as BodyIngestReceipt).results, JSON.stringify(change)).toEqual([{ id: 'd-1', status: 'conflict' }]);
    }
    expect(((await events(touch('d-1', { region: 'face' }))).body as BodyIngestReceipt).results).toEqual([{ id: 'd-1', status: 'conflict' }]);
    expect(((await events(touch('d-1', { region: 'face', ...detail }))).body as BodyIngestReceipt).results).toEqual([{ id: 'd-1', status: 'duplicate' }]);
    const reaction = { id: 'r-d', touch: { type: 'pet', durationMs: 1_500, ongoing: true, region: 'face', ...detail }, audience: 'owner', occurredAt: START };
    const first = await send('POST', '/v1/body/reactions', reaction);
    expect((await send('POST', '/v1/body/reactions', reaction)).body).toEqual(first.body);
    expect(await send('POST', '/v1/body/reactions', { ...reaction, touch: { ...reaction.touch, reflex: 'flinch' } })).toMatchObject({ status: 409 });
    expect(await send('POST', '/v1/body/reactions', { ...reaction, touch: { type: 'pet', durationMs: 1_500, ongoing: true, region: 'face' } })).toMatchObject({ status: 409 });
  });
});

describe('touch vocabulary 2: what cannot be a touch', () => {
  it('names holding anything but the hand, and a hover anywhere but the head and the hair or that is not a stroke', () => {
    expect(isImpossibleTouch({ gesture: 'hold', part: 'hand' })).toBe(false);
    expect(isImpossibleTouch({ gesture: 'hold', region: 'hand' })).toBe(false);
    expect(isImpossibleTouch({ gesture: 'hold' })).toBe(false);
    for (const part of BODY_TOUCH_PARTS.filter(part => part !== 'hand')) expect(isImpossibleTouch({ gesture: 'hold', part }), part).toBe(true);
    expect(isImpossibleTouch({ gesture: 'hold', region: 'body' })).toBe(true);
    for (const part of ['head', 'hair'] as const) expect(isImpossibleTouch({ input: 'hover', gesture: 'stroke', part }), part).toBe(false);
    expect(isImpossibleTouch({ input: 'hover', region: 'head' })).toBe(false);
    expect(isImpossibleTouch({ input: 'hover' })).toBe(false);
    for (const part of BODY_TOUCH_PARTS.filter(part => part !== 'head' && part !== 'hair')) expect(isImpossibleTouch({ input: 'hover', gesture: 'stroke', part }), part).toBe(true);
    expect(isImpossibleTouch({ input: 'hover', region: 'face' })).toBe(true);
    expect(isImpossibleTouch({ input: 'hover', gesture: 'poke', part: 'head' })).toBe(true);
    for (const gesture of BODY_TOUCH_GESTURES) expect(isImpossibleTouch({ input: 'press', gesture, part: gesture === 'hold' ? 'hand' : 'chest' }), gesture).toBe(false);
  });

  it('answers such an event ignored with not_a_touch, item by item, and takes the rest of the batch', async () => {
    const { events, state, reactionStore, bodyStore } = await reactionHarness();
    const receipt = (await events(
      touch('hold-chest', { type: 'holdHand', region: 'body', part: 'chest', gesture: 'hold' }),
      touch('hover-cheek', { region: 'face', part: 'cheek', gesture: 'stroke', input: 'hover' }),
      touch('good', { region: 'head', part: 'hair', gesture: 'stroke', input: 'hover', reflex: 'none' }),
      touch('hold-hand', { type: 'holdHand', region: 'hand', part: 'hand', gesture: 'hold', side: 'right' }),
    )).body as BodyIngestReceipt;
    expect(receipt).toEqual({
      schemaVersion: 1, stored: 2, duplicates: 0,
      results: [
        { id: 'hold-chest', status: 'ignored', reason: 'not_a_touch' }, { id: 'hover-cheek', status: 'ignored', reason: 'not_a_touch' },
        { id: 'good', status: 'stored' }, { id: 'hold-hand', status: 'stored' },
      ],
    });
    expect(bodyStore.recent(scope, 'owner', '2026-10-01T00:00:00.000Z', 10).map(event => event.id).sort()).toEqual(['good', 'hold-hand']);
    expect(reactionStore.touchDetail(scope, 'hold-chest')).toBeNull();
    expect(reactionStore.touchDetail(scope, 'hover-cheek')).toBeNull();
    const version = state().version;
    // A retry answers the same way, and still moves nothing.
    expect(((await events(touch('hold-chest', { type: 'holdHand', region: 'body', part: 'chest', gesture: 'hold' }))).body as BodyIngestReceipt).results)
      .toEqual([{ id: 'hold-chest', status: 'ignored', reason: 'not_a_touch' }]);
    expect(state().version).toBe(version);
  });

  it('answers such a reaction quiet with ignored: not_a_touch, with no feeling, memory, model call, request counted or row written', async () => {
    const { send, speaker, state, reactionStore } = await reactionHarness();
    const request = { id: 'r-hold', touch: { type: 'holdHand', durationMs: 2_000, ongoing: true, region: 'body', part: 'skirt', gesture: 'hold' }, audience: 'owner', occurredAt: START };
    const answer = await send('POST', '/v1/body/reactions', request);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ schemaVersion: 1, id: 'r-hold', status: 'quiet', message: null, mood: expect.objectContaining({ expression: expect.any(String) }), ignored: 'not_a_touch' });
    expect(speaker.calls).toHaveLength(0);
    expect(state().version).toBe(0);
    expect(reactionStore.touchDetail(scope, 'r-hold')).toBeNull();
    expect(reactionStore.reaction(scope, 'r-hold')).toBeNull();
    // Answered the same way every time, and never counted against the twelve requests a minute.
    for (let attempt = 0; attempt < 20; attempt += 1) expect((await send('POST', '/v1/body/reactions', request)).body).toEqual(answer.body);
    // Nothing was kept under the id, so the id is free for a real touch.
    const real = await send('POST', '/v1/body/reactions', { ...request, touch: { ...request.touch, part: 'hand', region: 'hand' } });
    expect(real).toMatchObject({ status: 200, body: { status: 'said' } });
    expect(real.body).not.toHaveProperty('ignored');
  });

  it('answers a known id resent in an impossible shape not_a_touch on both routes, and changes nothing stored', async () => {
    const { send, events, state, reactionStore } = await reactionHarness();
    const good = { type: 'holdHand', durationMs: 2_000, region: 'hand', part: 'hand', gesture: 'hold' };
    const impossible = { ...good, region: 'body', part: 'skirt' };
    // Known through a reaction, resent as a reaction and as an event.
    expect((await send('POST', '/v1/body/reactions', { id: 'k-1', touch: { ...good, ongoing: true }, audience: 'owner', occurredAt: START })).status).toBe(200);
    const version = state().version;
    expect((await send('POST', '/v1/body/reactions', { id: 'k-1', touch: { ...impossible, ongoing: true }, audience: 'owner', occurredAt: START })).body).toMatchObject({ ignored: 'not_a_touch' });
    expect(((await events({ id: 'k-1', audience: 'owner', occurredAt: START, ...impossible })).body as BodyIngestReceipt).results).toEqual([{ id: 'k-1', status: 'ignored', reason: 'not_a_touch' }]);
    // Known through an event, resent as an event and as a reaction.
    expect(((await events({ id: 'k-2', audience: 'owner', occurredAt: START, ...good })).body as BodyIngestReceipt).results).toEqual([{ id: 'k-2', status: 'stored' }]);
    expect(((await events({ id: 'k-2', audience: 'owner', occurredAt: START, ...impossible })).body as BodyIngestReceipt).results).toEqual([{ id: 'k-2', status: 'ignored', reason: 'not_a_touch' }]);
    expect((await send('POST', '/v1/body/reactions', { id: 'k-2', touch: { ...impossible, ongoing: false }, audience: 'owner', occurredAt: START })).body).toMatchObject({ ignored: 'not_a_touch' });
    expect(state().version).toBeGreaterThan(version);
    const after = state().version;
    expect(((await events({ id: 'k-2', audience: 'owner', occurredAt: START, ...impossible })).body as BodyIngestReceipt).results[0]).toMatchObject({ reason: 'not_a_touch' });
    expect(state().version).toBe(after);
    expect(reactionStore.touchDetail(scope, 'k-1')).toEqual({ part: 'hand', gesture: 'hold' });
    expect(reactionStore.touchDetail(scope, 'k-2')).toEqual({ part: 'hand', gesture: 'hold' });
  });
});

describe('touch vocabulary 2: stored, and read by the reaction since stage 1b', () => {
  it('keeps part, side, gesture and reflex on the touch, from an event and from a reaction, and fills in what a later message adds', async () => {
    const { events, send, reactionStore } = await reactionHarness();
    await events(touch('e-1', { type: 'poke', region: 'body', part: 'neck', side: 'left', gesture: 'poke', input: 'press', reflex: 'flinch' }));
    expect(reactionStore.touchDetail(scope, 'e-1')).toEqual({ part: 'neck', side: 'left', gesture: 'poke', reflex: 'flinch' });
    await send('POST', '/v1/body/reactions', { id: 'r-1', touch: { type: 'pet', durationMs: 1_500, ongoing: true, region: 'face', part: 'cheek', side: 'right', gesture: 'stroke' }, audience: 'owner', occurredAt: START });
    expect(reactionStore.touchDetail(scope, 'r-1')).toEqual({ part: 'cheek', side: 'right', gesture: 'stroke' });
    // The finished touch with the same id adds what its first message did not say, and changes nothing it said.
    await events(touch('r-1', { durationMs: 3_000, region: 'face', part: 'forehead', side: 'right', gesture: 'stroke', reflex: 'none' }));
    expect(reactionStore.touchDetail(scope, 'r-1')).toEqual({ part: 'cheek', side: 'right', gesture: 'stroke', reflex: 'none' });
  });

  it('on an ordinary part changes no feeling and no answer; since stage 1b the reaction model is told the part, the side and the flinch', async () => {
    const run = async (extra: Record<string, unknown>) => {
      const harness = await reactionHarness();
      const answers: BodyReactionAnswer[] = [];
      for (const [index, type] of (['pet', 'poke', 'tickle', 'holdHand'] as const).entries()) {
        harness.advance(10_000);
        const region = type === 'holdHand' ? 'hand' : type === 'tickle' ? 'side' : 'face';
        // In the new shape each touch names a part and a gesture that agree with its type and region.
        const shaped = { pet: { part: 'cheek', gesture: 'stroke' }, poke: { part: 'cheek', gesture: 'poke' }, tickle: { part: 'side', gesture: 'tickle' }, holdHand: { part: 'hand', gesture: 'hold' } }[type];
        const sent = { region, ...(Object.keys(extra).length ? { ...extra, ...shaped } : {}) };
        answers.push(await harness.said({ type, ...sent }, { id: `same-${index}` }));
        await harness.events({ id: `same-${index}`, type, audience: 'owner', occurredAt: harness.clock.at, durationMs: 2_400, ...sent });
      }
      const { updatedAt: _updatedAt, ...snapshot } = harness.state() as unknown as Record<string, unknown>;
      return {
        answers: answers.map(answer => ({ ...answer, ...(answer.message ? { message: { ...answer.message, id: 'x' } } : {}) })),
        prompts: harness.speaker.prompts, snapshot, chat: (await harness.chat('こんにちは')).systemPrompt,
        stored: ['same-0', 'same-1', 'same-2', 'same-3'].map(id => harness.reactionStore.touchDetail(scope, id)),
      };
    };
    const { stored: oldStored, ...old } = await run({});
    const { stored, ...newer } = await run({ side: 'left', input: 'press', reflex: 'flinch' });
    // The new shape was taken in whole, and the old one left nothing.
    expect(stored).toEqual([
      { part: 'cheek', side: 'left', gesture: 'stroke', reflex: 'flinch' }, { part: 'cheek', side: 'left', gesture: 'poke', reflex: 'flinch' },
      { part: 'side', side: 'left', gesture: 'tickle', reflex: 'flinch' }, { part: 'hand', side: 'left', gesture: 'hold', reflex: 'flinch' },
    ]);
    expect(oldStored).toEqual([{}, {}, {}, {}]);
    // Stage 1b (Syzygy ADR-0005): the words of the touch name the part and the side, her flinch is told, and one line says
    // that how she takes it is hers. Nothing else of what she is told changed.
    const told = (prompt: string) => prompt.replace('左の頬をなでられている', '頬をなでられている').replace('左の頬をつつかれている', '頬をつつかれている')
      .replace('左の脇をくすぐられている', '脇をくすぐられている').replace('\n- 体: 思わず小さく身を引いた', '').replace(`\n- ${BODY_REACTION_OWN_RULE}`, '');
    expect(newer.prompts.map(told)).toEqual(old.prompts);
    expect(newer.prompts.every(prompt => prompt.includes('- 体: 思わず小さく身を引いた') && prompt.includes(BODY_REACTION_OWN_RULE))).toBe(true);
    expect(old.prompts.some(prompt => prompt.includes(BODY_REACTION_OWN_RULE) || prompt.includes('- 体: '))).toBe(false);
    expect(newer.answers).toEqual(old.answers);
    expect(newer.snapshot).toEqual(old.snapshot);
    expect(newer.chat).toEqual(old.chat);
    expect(old.prompts).toHaveLength(4);
  });
});
