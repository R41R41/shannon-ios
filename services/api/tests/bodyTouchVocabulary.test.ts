import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_TOUCH_GESTURES, BODY_TOUCH_INPUTS, BODY_TOUCH_REFLEXES, BODY_TOUCH_SIDES, BODY_TOUCH_VOCABULARY, isImpossibleTouch, validatedBodyEvents,
} from '../src/bodyContract.js';
import { bodyReactionContentHash, validatedBodyReactionRequest, type BodyReactionAnswer, type BodyReactionRequest } from '../src/bodyReactionContract.js';
import { BODY_TOUCH_PARTS } from '../src/bodyTouchWords.js';
import type { BodyIngestReceipt, BodyPresence } from '../src/shannonBody.js';
import { START, reactionHarness, scope } from './bodyReactionHarness.js';

/**
 * Touch vocabulary 2 (Syzygy ADR-0005, phase 1a): optional facts beside `type` and `region`. Nothing about a
 * touch in the old shape may change, and the new facts are stored only: no feeling, no prompt, no word reads them.
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

  it('refuses a side, gesture, input or reflex outside its list, and any of them on an event that is not a touch', async () => {
    for (const [field, value] of [['side', 'up'], ['gesture', 'kiss'], ['input', 'tap'], ['reflex', 'scream'], ['gesture', 3]] as const) {
      expect(validatedBodyEvents([touch('x', { [field]: value })]), field).toContain(`${field} must be one of`);
      expect(validatedBodyReactionRequest({ id: 'r', touch: { type: 'pet', durationMs: 1, ongoing: true, [field]: value }, audience: 'owner', occurredAt: START }), field)
        .toContain(`touch.${field} must be one of`);
    }
    for (const field of ['part', 'side', 'gesture', 'input', 'reflex']) {
      expect(validatedBodyEvents([{ id: 'x', type: 'ownerReturned', audience: 'owner', occurredAt: START, [field]: 'left' }]), field).toContain('is not allowed for ownerReturned');
    }
    const { events, state } = await reactionHarness();
    expect((await events(touch('ok'), touch('bad', { gesture: 'kiss' }))).status).toBe(400);
    expect(state().version).toBe(0);
  });

  it('is part of the content only when sent: the same id with another part, side, gesture, input or reflex is a conflict', async () => {
    const { events, send } = await reactionHarness();
    expect(((await events(touch('d-1', { region: 'face', ...detail }))).body as BodyIngestReceipt).results).toEqual([{ id: 'd-1', status: 'stored' }]);
    const changes = [{ part: 'face' }, { side: 'right' }, { gesture: 'poke' }, { input: 'hover', part: 'head', region: 'head' }, { reflex: 'flinch' }];
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

  it('answers such a reaction quiet with ignored: not_a_touch, with no feeling, memory or model call, and the same again on a retry', async () => {
    const { send, speaker, state, reactionStore } = await reactionHarness();
    const request = { id: 'r-hold', touch: { type: 'holdHand', durationMs: 2_000, ongoing: true, region: 'body', part: 'skirt', gesture: 'hold' }, audience: 'owner', occurredAt: START };
    const answer = await send('POST', '/v1/body/reactions', request);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ schemaVersion: 1, id: 'r-hold', status: 'quiet', message: null, mood: expect.objectContaining({ expression: expect.any(String) }), ignored: 'not_a_touch' });
    expect(speaker.calls).toHaveLength(0);
    expect(state().version).toBe(0);
    expect(reactionStore.touchDetail(scope, 'r-hold')).toBeNull();
    expect((await send('POST', '/v1/body/reactions', request)).body).toEqual(answer.body);
    expect(await send('POST', '/v1/body/reactions', { ...request, touch: { ...request.touch, part: 'hand', region: 'hand' } })).toMatchObject({ status: 409 });
  });
});

describe('touch vocabulary 2: stored, and read by nothing else yet', () => {
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

  it('changes no feeling, no answer and no word the reaction model is told', async () => {
    const run = async (extra: Record<string, unknown>) => {
      const harness = await reactionHarness();
      const answers: BodyReactionAnswer[] = [];
      for (const [index, type] of (['pet', 'poke', 'tickle', 'holdHand'] as const).entries()) {
        harness.advance(10_000);
        const region = type === 'holdHand' ? 'hand' : type === 'tickle' ? 'side' : 'face';
        // In the new shape a held hand names the hand (a hold elsewhere is not a touch).
        const sent = { region, ...extra, ...(type === 'holdHand' && Object.keys(extra).length ? { part: 'hand', gesture: 'hold' } : {}) };
        answers.push(await harness.said({ type, ...sent }, { id: `same-${index}` }));
        await harness.events({ id: `same-${index}`, type, audience: 'owner', occurredAt: harness.clock.at, durationMs: 2_400, ...sent });
      }
      const { updatedAt: _updatedAt, ...snapshot } = harness.state() as unknown as Record<string, unknown>;
      return {
        answers: answers.map(answer => ({ ...answer, ...(answer.message ? { message: { ...answer.message, id: 'x' } } : {}) })),
        prompts: harness.speaker.prompts, snapshot, chat: (await harness.chat('こんにちは')).systemPrompt,
      };
    };
    const old = await run({});
    const newer = await run({ part: 'cheek', side: 'left', gesture: 'stroke', input: 'press', reflex: 'flinch' });
    expect(newer.prompts).toEqual(old.prompts);
    expect(newer.answers).toEqual(old.answers);
    expect(newer.snapshot).toEqual(old.snapshot);
    expect(newer.chat).toEqual(old.chat);
    expect(old.prompts).toHaveLength(4);
  });
});
