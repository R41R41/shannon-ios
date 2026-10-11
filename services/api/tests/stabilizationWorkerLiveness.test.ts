import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ShannonBackgroundWorker } from '../src/mind/sleep/backgroundWorker.js';
import { LocalRuleSleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { recordMindWorkerStart } from '../src/infra/ops/store/livenessStore.js';
import { startLivenessMonitor, withLiveness } from '../src/wiring/livenessWiring.js';

/** Stabilization 2026-10-12: the background worker loop survives a busy claim; a liveness check names stalls once. */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'shannon-stabilize-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

describe('background worker under a busy database', () => {
  it('reports a busy claim and returns idle instead of ending its loop, then claims normally', async () => {
    const store = new SQLiteShannonStore({ path: join(directory(), 'db.sqlite'), now: () => '2026-09-01T15:00:00.000Z' });
    cleanups.push(() => store.close());
    store.appendTurn('owner-a', store.createThread('owner-a', 'busy'), 'こんにちは', 'こんにちは', '2026-09-01T03:00:00.000Z');
    const errors: string[] = [];
    const worker = new ShannonBackgroundWorker(store, store, store, new LocalRuleSleepMemoryAnalyzer(), {
      workerId: 'busy-worker', now: () => new Date('2026-09-01T18:30:00.000Z'), reportError: code => errors.push(code) });
    const claim = store.claimNextBackgroundJob.bind(store);
    store.claimNextBackgroundJob = () => { throw busy(); };
    expect(await worker.runOnce()).toBe('idle');
    expect(errors).toEqual(['CLAIM_SQLITE_BUSY']);
    store.claimNextBackgroundJob = claim;
    expect(await worker.runOnce()).toBe('processed');
  });

  it('retries maintenance on the next poll when enqueueing met the write lock', async () => {
    const store = new SQLiteShannonStore({ path: join(directory(), 'db.sqlite'), now: () => '2026-09-01T15:00:00.000Z' });
    cleanups.push(() => store.close());
    const errors: string[] = [];
    let attempts = 0;
    const enqueue = store.enqueueSleepConsolidations.bind(store);
    store.enqueueSleepConsolidations = (...args) => { attempts++; if (attempts === 1) throw busy(); return enqueue(...args); };
    const worker = new ShannonBackgroundWorker(store, store, store, new LocalRuleSleepMemoryAnalyzer(), {
      workerId: 'busy-worker', now: () => new Date('2026-09-01T18:30:00.000Z'), reportError: code => errors.push(code) });
    expect(await worker.runOnce()).toBe('idle');
    expect(errors).toEqual(['MAINTENANCE_SQLITE_BUSY']);
    expect(await worker.runOnce()).toBe('idle');
    expect(attempts).toBeGreaterThan(1); // retried at once, not after the 30 s maintenance interval
  });
});

describe('liveness monitor', () => {
  function database() {
    const db = new DatabaseSync(join(directory(), 'db.sqlite'));
    cleanups.push(() => db.close());
    db.exec(`CREATE TABLE background_jobs (job_id TEXT, scope_key TEXT, job_kind TEXT, status TEXT, available_at TEXT, completed_at TEXT);
      CREATE TABLE autonomy_loop_cycles (cycle_id TEXT, scope_key TEXT, started_at TEXT);
      CREATE TABLE autonomy_loop_steps (step_id TEXT, scope_key TEXT, created_at TEXT);
      CREATE TABLE autonomy_control (scope_key TEXT, paused INTEGER);`);
    return db;
  }
  it('logs one line when each incident begins and one when it ends, and shows the view to the owner only', () => {
    const db = database(), lines: string[] = [];
    let now = '2026-10-12T00:00:00.000Z';
    db.prepare("INSERT INTO background_jobs VALUES ('night-1','owner','sleep-consolidation','completed','2026-10-08T18:00:00.000Z','2026-10-08T19:00:00.000Z')").run();
    db.prepare("INSERT INTO background_jobs VALUES ('night-2','owner','sleep-consolidation','leased','2026-10-09T18:00:00.000Z',NULL)").run();
    db.prepare("INSERT INTO autonomy_loop_cycles VALUES ('cycle','owner','2026-10-09T10:00:00.000Z')").run();
    for (let n = 0; n < 3; n++) recordMindWorkerStart(db, `2026-10-11T23:${10 + n * 10}:00.000Z`);
    const monitor = startLivenessMonitor({ database: db, ownerScope: 'owner', ownTimeEnabled: true, now: () => now, log: line => lines.push(line), intervalMs: null });
    cleanups.push(() => monitor.close());

    const view = monitor.check()!;
    expect(view.incidents).toEqual(['sleep_stalled', 'own_time_stalled', 'mind_worker_restarting']);
    expect(view.sleep).toEqual({ lastCompletedAt: '2026-10-08T19:00:00.000Z', oldestDueAt: '2026-10-09T18:00:00.000Z' });
    expect(lines).toHaveLength(3);
    expect(lines.every(line => line.startsWith('Shannon liveness: incident '))).toBe(true);
    monitor.check(); monitor.check();
    expect(lines).toHaveLength(3); // not repeated while the incident lasts

    db.prepare("UPDATE background_jobs SET status='completed', completed_at='2026-10-12T00:30:00.000Z' WHERE job_id='night-2'").run();
    db.prepare("INSERT INTO autonomy_loop_steps VALUES ('step','owner','2026-10-12T00:30:00.000Z')").run();
    now = '2026-10-12T01:30:00.000Z';
    expect(monitor.check()!.incidents).toEqual([]);
    expect(lines.slice(3)).toEqual(['Shannon liveness: recovered sleep_stalled', 'Shannon liveness: recovered own_time_stalled',
      'Shannon liveness: recovered mind_worker_restarting']);

    expect(monitor.view('guest')).toBeNull();
    expect(withLiveness({ revision: 'r' }, monitor.view('owner'))).toMatchObject({ revision: 'r', liveness: { incidents: [] } });
    expect(withLiveness(null, monitor.view('owner'))).toBeNull();
  });

  it('does not call quiet own time a stall when it is off or paused, nor a fresh database', () => {
    const db = database();
    db.prepare("INSERT INTO autonomy_loop_cycles VALUES ('cycle','owner','2026-10-09T10:00:00.000Z')").run();
    const at = () => '2026-10-12T00:00:00.000Z';
    expect(startLivenessMonitor({ database: db, ownerScope: 'owner', ownTimeEnabled: false, now: at, log: () => {}, intervalMs: null }).check()!.incidents).toEqual([]);
    db.prepare("INSERT INTO autonomy_control VALUES ('owner', 1)").run();
    expect(startLivenessMonitor({ database: db, ownerScope: 'owner', ownTimeEnabled: true, now: at, log: () => {}, intervalMs: null }).check()!.incidents).toEqual([]);
    const fresh = new DatabaseSync(':memory:'); cleanups.push(() => fresh.close());
    expect(startLivenessMonitor({ database: fresh, ownerScope: 'owner', ownTimeEnabled: true, now: at, log: () => {}, intervalMs: null }).check()!.incidents).toEqual([]);
  });
});
