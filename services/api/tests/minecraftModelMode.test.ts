import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';
import { validClaim } from '../src/contracts/minecraftBodyRequestContract.js';
import type { MinecraftPrimaryModel } from '../src/contracts/minecraftPrimaryModelContract.js';

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-model-mode-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'requests.sqlite');
  let selected: MinecraftPrimaryModel | null = { mode: 'haiku', model: HAIKU, revision: 0 };
  let time = Date.parse('2026-10-09T00:00:00Z');
  const reader = vi.fn(() => selected);
  const open = () => new MinecraftBodyRequests(path, { deviceId: 'body', ownerScopeKey: 'owner' }, () => new Date(time).toISOString(), null, undefined, reader);
  let queue = open();
  cleanups.push(() => queue.close());
  const claim = async (supportedPrimaryModels?: string[], holding: string[] = []) => {
    const response = await queue.claim('owner', 'body', { holding, waitSeconds: 0, ...(supportedPrimaryModels ? { supportedPrimaryModels } : {}) });
    if (typeof response === 'string') throw new Error(response);
    return response;
  };
  return { path, reader, claim, get queue() { return queue; }, set: (pin: MinecraftPrimaryModel | null) => { selected = pin; },
    advance: (ms: number) => { time += ms; }, restart: () => { queue.close(); queue = open(); },
    enqueue: (key: string) => queue.enqueue('owner', { goal: '木を集める', dedupeKey: key, origin: { surface: 'text' } }) };
}

describe('Minecraft owner primary model pin and body capability handshake', () => {
  it('pins once, persists across restart, and applies later changes only to a new original request', async () => {
    const f = setup(); await f.claim([HAIKU, SONNET]);
    const first = f.enqueue('first'); expect(first.kind).toBe('queued');
    f.set({ mode: 'sonnet', model: SONNET, revision: 1 });
    const duplicate = f.enqueue('first');
    expect(duplicate).toMatchObject({ duplicate: true, request: { primaryModel: { mode: 'haiku', model: HAIKU, revision: 0 } } });
    expect(f.reader).toHaveBeenCalledTimes(1);
    f.restart();
    const claimed = await f.claim([HAIKU, SONNET]);
    expect(claimed.request?.primaryModel).toEqual({ mode: 'haiku', model: HAIKU, revision: 0 });
    f.queue.report('owner', 'body', claimed.request!.id, { outcome: 'done', gained: [] });
    expect(f.enqueue('second')).toMatchObject({ request: { primaryModel: { mode: 'sonnet', model: SONNET, revision: 1 } } });
    expect((await f.claim([HAIKU, SONNET])).request?.primaryModel?.model).toBe(SONNET);
  });

  it('requires exact negotiated support and holds a queued request when an old body replaces it', async () => {
    const f = setup(); f.set({ mode: 'sonnet', model: SONNET, revision: 2 });
    await f.claim(); expect(f.enqueue('old')).toEqual({ kind: 'model_unavailable' });
    await f.claim([HAIKU]); expect(f.enqueue('haiku-only')).toEqual({ kind: 'model_unavailable' });
    await f.claim([HAIKU, SONNET]); const queued = f.enqueue('supported');
    expect(queued.kind).toBe('queued');
    const admit = vi.fn(async () => true);
    f.queue.execution = { admit, heartbeat: vi.fn(async () => true), acknowledge: vi.fn(async () => {}) } as any;
    const blocked = await f.claim();
    expect(blocked).toMatchObject({ request: null, blocked: { reason: 'model_unavailable' } });
    expect(admit).not.toHaveBeenCalled();
    expect(f.queue.recent('owner')[0].state).toBe('queued');
    expect((await f.claim([SONNET])).request?.primaryModel).toEqual({ mode: 'sonnet', model: SONNET, revision: 2 });
  });

  it('never borrows a concurrent modern claim capability for an old claim', async () => {
    const f = setup(); f.set({ mode: 'sonnet', model: SONNET, revision: 4 });
    await f.claim([SONNET]); f.enqueue('concurrent');
    const admit = vi.fn(async () => true);
    f.queue.execution = { admit, heartbeat: vi.fn(async () => true), acknowledge: vi.fn(async () => {}) } as any;
    const oldClaim = f.claim();
    const modernClaim = f.claim([SONNET]);
    expect((await oldClaim).request).toBeNull();
    expect((await modernClaim).request?.primaryModel?.model).toBe(SONNET);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('retains the running pin and stop path even when advertised capability or preference changes', async () => {
    const f = setup(); f.set({ mode: 'sonnet', model: SONNET, revision: 7 });
    await f.claim([SONNET]); f.enqueue('run'); const request = (await f.claim([SONNET])).request!;
    f.set({ mode: 'haiku', model: HAIKU, revision: 8 });
    expect(await f.claim([HAIKU], [request.id])).toEqual({ request: null, cancel: [] });
    expect(f.queue.recent('owner')[0].primaryModel?.model).toBe(SONNET);
    f.queue.cancel('owner', request.id);
    expect((await f.claim([], [request.id])).cancel).toEqual([request.id]);
  });

  it('fails closed on unreadable or invalid selections and expires advertised availability', async () => {
    const f = setup(); await f.claim([HAIKU, SONNET]);
    expect(f.queue.primaryModelAvailable('owner', SONNET)).toBe(true);
    expect(f.queue.primaryModelAvailable('other', SONNET)).toBe(false);
    for (const pin of [null, { mode: ['sonnet'], model: SONNET, revision: 1 }, { mode: 'sonnet', model: HAIKU, revision: 1 }, { mode: 'sonnet', model: SONNET, revision: -1 }]) {
      f.set(pin as any); expect(f.enqueue('invalid')).toEqual({ kind: 'model_unavailable' });
    }
    f.reader.mockImplementationOnce(() => { throw new Error('unreadable'); });
    expect(f.enqueue('read-error')).toEqual({ kind: 'model_unavailable' });
    f.advance(40_001); expect(f.queue.primaryModelAvailable('owner', SONNET)).toBe(false);
  });

  it('adds only nullable pin/capability columns and leaves old requests usable', async () => {
    const f = setup(); await f.claim([HAIKU]); const queued = f.enqueue('old-row');
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE minecraft_body_requests SET primary_model_json=NULL').run();
    db.exec('ALTER TABLE minecraft_body_requests DROP COLUMN primary_model_json; ALTER TABLE minecraft_body_presence DROP COLUMN primary_models_json;');
    db.close(); f.restart();
    const result = await f.claim();
    expect(result.request?.id).toBe(queued.kind === 'queued' ? queued.request.id : 'missing');
    expect(result.request).not.toHaveProperty('primaryModel');
  });

  it('accepts only closed bounded exact model capability lists', () => {
    expect(validClaim({ supportedPrimaryModels: [HAIKU, SONNET] })).toMatchObject({ supportedPrimaryModels: [HAIKU, SONNET] });
    for (const supportedPrimaryModels of [[SONNET, SONNET], ['sonnet'], [HAIKU, SONNET, 'extra'], null, 'all']) {
      expect(validClaim({ supportedPrimaryModels })).toBe('supportedPrimaryModels is invalid');
    }
  });
});
