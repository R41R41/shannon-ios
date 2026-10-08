import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleMemoryText } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteGameExperiences } from '../src/mind/memory/store/gameExperiences.js';
import { gameExperienceId, type GameExperienceWriter } from '../src/mind/memory/memoryPorts.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { MemoryWithholding } from '../src/mind/memory/memoryVisibility.js';
import { MinecraftBodyRequests } from '../src/surfaces/minecraft/minecraftBodyRequests.js';

const AT = '2026-10-08T00:00:00.000Z';
const DEVICE = 'fixture-body';
const config = { deviceId: DEVICE, ownerScopeKey: 'owner' };
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function harness(options: { memoryReady?: boolean; writer?: (memory: SQLiteGameExperiences) => GameExperienceWriter } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-minecraft-outbox-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let clock = Date.parse(AT);
  const now = () => new Date(clock).toISOString();
  const store = options.memoryReady === false ? null : new SQLiteShannonStore({ path, now });
  if (store) cleanup.push(() => store.close());
  const memory = new SQLiteGameExperiences(path);
  cleanup.push(() => memory.close());
  let requests = new MinecraftBodyRequests(path, config, now, options.writer?.(memory) ?? memory);
  cleanup.push(() => requests.close());
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
  const payloads = () => (db.prepare("SELECT payload_json FROM experience_events WHERE event_type='turn.completed' AND json_extract(payload_json,'$.source')='body.game'")
    .all() as Array<{ payload_json: string }>).map(row => JSON.parse(row.payload_json));
  const start = async () => {
    await requests.claim('owner', DEVICE, { holding: [], waitSeconds: 0 });
    const queued = requests.enqueue('owner', { goal: 'オークの原木を16個集める', dedupeKey: 'one-original-turn', origin: { surface: 'text', threadId: 'fixture-talk' } });
    if (queued.kind !== 'queued') throw new Error('FIXTURE_NOT_QUEUED');
    const claimed = await requests.claim('owner', DEVICE, { holding: [], waitSeconds: 0 });
    if (typeof claimed === 'string' || claimed.request?.id !== queued.request.id) throw new Error('FIXTURE_NOT_CLAIMED');
    return queued.request.id;
  };
  return { path, now, store, memory, db, rows, payloads, start, get requests() { return requests; },
    advance(days: number) { clock += days * 86_400_000; },
    reopen(deviceId = DEVICE, writer: GameExperienceWriter = memory) {
      requests.close();
      requests = new MinecraftBodyRequests(path, { ...config, deviceId }, now, writer);
      return requests;
    },
  };
}

describe('Minecraft result memory delivery', () => {
  it.each(['before_write', 'after_write'])('recovers an actual post-commit child kill (%s) without repeating the body action', async mode => {
    const h = harness();
    const id = await h.start();
    h.requests.close();
    const child = spawnSync(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./support/minecraftResultOutboxCrash.ts', import.meta.url)), h.path, id, mode], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC' }, encoding: 'utf8',
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe('SIGKILL');
    expect(h.rows('minecraft_body_requests')).toMatchObject([{ id, state: 'done' }]);
    expect(h.rows('minecraft_experience_outbox')).toEqual([{ request_id: id, scope_key: 'owner', delivered: 0 }]);
    expect(h.payloads()).toHaveLength(mode === 'after_write' ? 1 : 0);
    const requests = h.reopen('replacement-body');
    expect(h.payloads()).toHaveLength(1);
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 1 }]);
    expect(h.memory.recorded('owner', gameExperienceId('owner', DEVICE, `request:${id}`))).toBe(true);
    expect(h.memory.recorded('owner', gameExperienceId('owner', 'replacement-body', `request:${id}`))).toBe(false);
    expect(h.memory.recorded('foreign-scope', gameExperienceId('owner', DEVICE, `request:${id}`))).toBe(false);
    requests.maintain();
    expect(await requests.claim('owner', 'replacement-body', { holding: [], waitSeconds: 0 })).toEqual({ request: null, cancel: [] });
    expect(h.rows('minecraft_body_requests')).toHaveLength(1);
    expect(h.payloads()).toHaveLength(1);
  });

  it('retains a throwing writer until maintenance, keeps the first result, and protects undelivered references from pruning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const h = harness({ writer: memory => ({ write(scope, experience) {
      if (fail) throw new Error('SYNTHETIC_WRITE_FAILURE');
      return memory.write(scope, experience);
    }, recorded: (scope, id) => memory.recorded(scope, id) }) });
    const id = await h.start();
    expect(h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] })).toMatchObject({ recorded: true });
    expect(h.requests.report('owner', DEVICE, id, { outcome: 'failed', code: 'error', gained: [] })).toMatchObject({ state: 'done', recorded: false });
    expect(h.payloads()).toEqual([]);
    h.advance(31);
    h.requests.maintain();
    expect(h.rows('minecraft_body_requests')).toHaveLength(1);
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 0 }]);
    fail = false;
    h.requests.maintain();
    expect(h.payloads()).toHaveLength(1);
    expect(h.payloads()[0]).toMatchObject({ source: 'body.game', game: { type: 'request', requestId: id, state: 'done' },
      disclosure: { sensitivity: 'sensitive', speaker: 'unknown' } });
    expect(h.payloads()[0].summary).toContain('オークの原木 16個');
    expect(h.payloads()[0].summary).not.toContain('できなかった');
    h.requests.maintain();
    expect(h.rows('minecraft_body_requests')).toEqual([]);
    expect(h.rows('minecraft_experience_outbox')).toEqual([]);
    expect(h.payloads()).toHaveLength(1);
  });

  it('does not acknowledge write:false while the experience table is unavailable', async () => {
    const h = harness({ memoryReady: false });
    const id = await h.start();
    h.requests.report('owner', DEVICE, id, { outcome: 'failed', code: 'gave_up', gained: [] });
    expect(h.rows('minecraft_experience_outbox')).toEqual([{ request_id: id, scope_key: 'owner', delivered: 0 }]);
    expect(h.memory.recorded('owner', gameExperienceId('owner', DEVICE, `request:${id}`))).toBe(false);
    const store = new SQLiteShannonStore({ path: h.path, now: h.now });
    cleanup.push(() => store.close());
    h.requests.maintain();
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 1 }]);
    expect(h.payloads()).toHaveLength(1);
    expect(h.payloads()[0].game.state).toBe('failed');
  });

  it('keeps a duplicate delivery pending while its exact receipt read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    const id = await h.start();
    h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] });
    // Recreate the durable window after the experience commit but before the delivery bit.
    h.db.prepare('UPDATE minecraft_experience_outbox SET delivered=0 WHERE request_id=?').run(id);
    let failRead = true;
    h.reopen(DEVICE, { write: (scope, experience) => h.memory.write(scope, experience), recorded(scope, experienceId) {
      if (failRead) throw new Error('SYNTHETIC_RECEIPT_READ_FAILURE');
      return h.memory.recorded(scope, experienceId);
    } });
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 0 }]);
    expect(h.payloads()).toHaveLength(1);
    failRead = false;
    h.requests.maintain();
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 1 }]);
    expect(h.payloads()).toHaveLength(1);
  });

  it('acknowledges an already forgotten experience without restoring it or writing any owner control', async () => {
    const h = harness();
    if (!h.store) throw new Error('FIXTURE_MEMORY_NOT_READY');
    const id = await h.start();
    h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] });
    const experienceId = gameExperienceId('owner', DEVICE, `request:${id}`);
    const source = h.store.experienceCandidates('owner').find(item => item.id === experienceId)!;
    new ShannonMemoryService(h.store, h.store, h.now).mutate('owner', { memoryId: experienceId, action: 'forget' });
    const forgotten = h.store.snapshot('owner');
    const allEvents = h.rows('experience_events');
    expect(visibleMemoryText(forgotten, experienceId, source.summary)).toBeNull();
    h.db.prepare('UPDATE minecraft_experience_outbox SET delivered=0 WHERE request_id=?').run(id);
    h.reopen();
    h.requests.maintain();
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 1 }]);
    expect(h.payloads()).toHaveLength(1);
    expect(h.rows('experience_events')).toEqual(allEvents);
    const after = h.store.snapshot('owner');
    expect(after).toEqual(forgotten);
    expect(visibleMemoryText(after, experienceId, source.summary)).toBeNull();
    expect(new MemoryWithholding(after, h.store, 'owner').withholdsExperience(source)).toBe(true);
  });

  it('does not backfill a historical terminal request whose experience and receipt are absent', async () => {
    const h = harness();
    const id = await h.start();
    h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] });
    // Model the pre-outbox binary's terminal row, which cannot prove why memory is absent.
    h.db.prepare('DELETE FROM minecraft_experience_outbox WHERE request_id=?').run(id);
    h.db.prepare('DELETE FROM experience_events WHERE event_id=?').run(gameExperienceId('owner', DEVICE, `request:${id}`));
    h.reopen();
    h.requests.report('owner', DEVICE, id, { outcome: 'failed', code: 'unknown', gained: [] });
    h.requests.maintain();
    expect(h.rows('minecraft_body_requests')).toMatchObject([{ id, state: 'done' }]);
    expect(h.rows('minecraft_experience_outbox')).toEqual([]);
    expect(h.payloads()).toEqual([]);
  });

  it('rolls back the canonical result and its execution ACK when the memory outbox insert fails', async () => {
    const h = harness();
    h.requests.execution = { admit: async () => true, heartbeat: async () => true, acknowledge: async () => {} };
    const id = await h.start();
    h.db.exec("CREATE TRIGGER reject_memory_ref BEFORE INSERT ON minecraft_experience_outbox BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_OUTBOX_FULL'); END;");
    expect(() => h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] })).toThrow('SYNTHETIC_OUTBOX_FULL');
    expect(h.rows('minecraft_body_requests')).toMatchObject([{ id, state: 'claimed', result_json: null, finished_at: null }]);
    expect(h.rows('minecraft_execution_acknowledgements')).toEqual([]);
    expect(h.rows('minecraft_experience_outbox')).toEqual([]);
    expect(h.payloads()).toEqual([]);
    h.db.exec('DROP TRIGGER reject_memory_ref');
    h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] });
    expect(h.rows('minecraft_execution_acknowledgements')).toMatchObject([{ request_id: id, state: 'completed', delivered: 0 }]);
    expect(h.payloads()).toHaveLength(1);
  });

  it('preserves the separate execution ACK hold and delivers only its original terminal outcome', async () => {
    const h = harness();
    const states: string[] = [];
    let failAck = true;
    h.requests.execution = { admit: async () => true, heartbeat: async () => true, acknowledge: async (_scope, _id, state) => {
      states.push(state);
      if (failAck) throw new Error('SYNTHETIC_IPC_FAILURE');
    } };
    const id = await h.start();
    h.requests.report('owner', DEVICE, id, { outcome: 'done', gained: [] });
    await expect(h.requests.acknowledgeExecution('owner', id, 'completed')).rejects.toThrow('SYNTHETIC_IPC_FAILURE');
    expect(h.rows('minecraft_experience_outbox')).toMatchObject([{ delivered: 1 }]);
    expect(h.rows('minecraft_execution_acknowledgements')).toMatchObject([{ state: 'completed', delivered: 0 }]);
    h.requests.report('owner', DEVICE, id, { outcome: 'failed', code: 'unknown', gained: [] });
    h.advance(31);
    h.requests.maintain();
    expect(h.rows('minecraft_body_requests')).toHaveLength(1);
    failAck = false;
    await h.requests.acknowledgeExecution('owner', id, 'failed');
    expect(states.every(state => state === 'completed')).toBe(true);
    expect(h.rows('minecraft_execution_acknowledgements')).toMatchObject([{ delivered: 1 }]);
    h.requests.maintain();
    expect(h.rows('minecraft_body_requests')).toEqual([]);
    expect(h.rows('minecraft_execution_acknowledgements')).toEqual([]);
    expect(h.payloads()).toHaveLength(1);
  });

  it('creates no memory for an unclaimed cancellation', async () => {
    const h = harness();
    await h.requests.claim('owner', DEVICE, { holding: [], waitSeconds: 0 });
    const queued = h.requests.enqueue('owner', { goal: '合成の依頼', dedupeKey: 'unclaimed', origin: { surface: 'text' } });
    if (queued.kind !== 'queued') throw new Error('FIXTURE_NOT_QUEUED');
    h.requests.cancel('owner', queued.request.id);
    expect(h.rows('minecraft_experience_outbox')).toEqual([]);
    expect(h.payloads()).toEqual([]);
  });
});
