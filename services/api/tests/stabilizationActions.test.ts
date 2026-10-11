import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_LIMITS, type ActionView } from '@shannon/mind';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { actionResource, leaseOf, type ActionThreads } from '../src/contracts/actionThreadContract.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
import { sweepActions } from '../src/wiring/mindWorkerWiring.js';
import { isSqliteBusy, throttledLog } from '../src/infra/sqlite/sqliteBusy.js';

/** Stabilization 2026-10-12: long-unknown actions release their slot; the mind worker survives a busy database. */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) close(); });
const MINUTE = 60_000;
function clock(start = '2026-10-09T00:00:00.000Z') {
  let time = Date.parse(start);
  return { now: () => new Date(time).toISOString(), advance: (milliseconds: number) => { time += milliseconds; } };
}
function store() {
  const db = new DatabaseSync(':memory:'), actions = new SQLiteActionStore(db);
  cleanups.push(() => db.close());
  return { db, actions };
}
/** Claims, dispatches and lets the lease expire: the production path to `unknown` with `sent=1`. */
function strand(s: ReturnType<typeof store>, c: ReturnType<typeof clock>, kind: 'ownTime' | 'agentTask', source: string, resources: string[] = []) {
  const queued = s.actions.enqueue({ scopeKey: 'owner', kind, origin: kind === 'ownTime' ? 'own_time' : 'owner_request', sourceId: source, resources }, c.now());
  const running = s.actions.claim(queued.id, 'runner', c.now())!;
  expect(s.actions.dispatch(leaseOf(running), c.now(), resources)).toBe(true);
  return leaseOf(running);
}

describe('unknown actions are released after the deadline, never replayed', () => {
  it('keeps the slot and resource for ten minutes, then frees them while the action stays unknown and unresumable', () => {
    const s = store(), c = clock(), resource = actionResource('owner', 'ownTime');
    const lease = strand(s, c, 'ownTime', 'cycle-1', [resource]);
    c.advance(ACTION_LIMITS.leaseMs + 1);
    expect(s.actions.transaction(() => s.actions.sweep(c.now()))).toBe(0);
    expect(s.actions.get(lease.id)).toMatchObject({ state: 'unknown', sent: true, result: 'lease_expired' });
    const next = s.actions.enqueue({ scopeKey: 'owner', kind: 'ownTime', origin: 'own_time', sourceId: 'cycle-2', resources: [resource] }, c.now());
    c.advance(9 * MINUTE);
    expect(s.actions.claim(next.id, 'runner', c.now())).toBeNull();

    c.advance(MINUTE);
    expect(s.actions.transaction(() => s.actions.sweep(c.now()))).toBe(1);
    expect(s.actions.get(lease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'unknown_expired', resources: [resource] });
    expect(s.actions.claim(next.id, 'runner', c.now())).toMatchObject({ state: 'running' });
    expect(s.actions.resume('owner', lease.id, c.now())).toBe(false);
    // A late canonical acknowledgement still closes the original attempt.
    expect(s.actions.reconcile(lease, 'completed', 'late_result', c.now())).toBe(true);
    expect(s.actions.get(lease.id)).toMatchObject({ state: 'completed', result: 'late_result' });
  });

  it('keeps a provable physical resource excluded after release until its proof, freeing the slot and other locks', () => {
    const c = clock(), db = new DatabaseSync(':memory:');
    const body = actionResource('minebot', 'minecraft-body'), study = actionResource('owner', 'study'), base = actionResource('owner', 'fca:task');
    const actions = new SQLiteActionStore(db, () => true, key => key === body);
    cleanups.push(() => db.close());
    const queued = actions.enqueue({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: 'dig', resources: [base] }, c.now());
    const lease = leaseOf(actions.claim(queued.id, 'runner', c.now())!);
    expect(actions.dispatch(lease, c.now(), [body, study])).toBe(true);
    c.advance(ACTION_LIMITS.leaseMs + 1 + ACTION_LIMITS.unknownReleaseMs);
    actions.transaction(() => actions.sweep(c.now()));
    c.advance(ACTION_LIMITS.unknownReleaseMs);
    expect(actions.transaction(() => actions.sweep(c.now()))).toBe(1);
    expect(actions.get(lease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'unknown_expired' });
    expect([...actions.get(lease.id)!.resources].sort()).toEqual([base, body].sort());
    const claimable = (source: string, resources: string[]) => {
      const next = actions.enqueue({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: source, resources }, c.now());
      const view = actions.claim(next.id, 'runner', c.now());
      if (view) actions.finish(leaseOf(view), 'completed', 'done', c.now());
      return view !== null;
    };
    expect(claimable('base-again', [base])).toBe(true);
    expect(claimable('study-again', [study])).toBe(true);
    expect(claimable('body-again', [body])).toBe(false);
    expect(actions.reconcileResource({ ...lease, generation: lease.generation }, body, 'release-proof')).toBe(true);
    expect(claimable('body-after-proof', [body])).toBe(true);
  });

  it('frees both background slots that two unknown actions held', () => {
    const s = store(), c = clock();
    strand(s, c, 'ownTime', 'cycle-1'); strand(s, c, 'agentTask', 'task-1');
    c.advance(ACTION_LIMITS.leaseMs + 1);
    const waiting = s.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task-2' }, c.now());
    expect(s.actions.claim(waiting.id, 'runner', c.now())).toBeNull();
    c.advance(ACTION_LIMITS.unknownReleaseMs);
    expect(s.actions.claim(waiting.id, 'runner', c.now())).toMatchObject({ state: 'running' });
    // The respond lane was never affected.
    expect(s.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'turn' }, 'api', c.now())).not.toBeNull();
  });

  it('gives the owner one fresh notice for the released episode', () => {
    const s = store(), c = clock();
    const lease = strand(s, c, 'agentTask', 'task-1');
    c.advance(ACTION_LIMITS.leaseMs + 1); s.actions.transaction(() => s.actions.sweep(c.now()));
    const before = s.actions.get(lease.id)!.notification!.id;
    c.advance(ACTION_LIMITS.unknownReleaseMs); s.actions.transaction(() => s.actions.sweep(c.now()));
    expect(s.actions.get(lease.id)!.notification).toMatchObject({ acknowledgedAt: null });
    expect(s.actions.get(lease.id)!.notification!.id).not.toBe(before);
    c.advance(ACTION_LIMITS.unknownReleaseMs);
    expect(s.actions.transaction(() => s.actions.sweep(c.now()))).toBe(0);
  });
});

describe('the mind worker survives a busy database', () => {
  it('recognises SQLITE_BUSY from node:sqlite and nothing else', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-busy-'));
    const path = join(directory, 'db.sqlite'), holder = new DatabaseSync(path), waiter = new DatabaseSync(path);
    cleanups.push(() => { holder.close(); waiter.close(); rmSync(directory, { recursive: true, force: true }); });
    holder.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE'); waiter.exec('PRAGMA busy_timeout=0');
    let caught: unknown;
    try { waiter.exec('BEGIN IMMEDIATE'); } catch (error) { caught = error; }
    holder.exec('COMMIT');
    expect(isSqliteBusy(caught)).toBe(true);
    expect(isSqliteBusy(new Error('MIND_ARGS'))).toBe(false);
    expect(isSqliteBusy('database is locked')).toBe(false);
  });

  it('skips a sweep that met the write lock and runs the next one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-sweep-'));
    const path = join(directory, 'db.sqlite'), holder = new DatabaseSync(path), worker = new DatabaseSync(path);
    cleanups.push(() => { holder.close(); worker.close(); rmSync(directory, { recursive: true, force: true }); });
    worker.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0');
    const actions = new SQLiteActionStore(worker), lines: string[] = [];
    holder.exec('BEGIN IMMEDIATE');
    expect(() => sweepActions(actions, '2026-10-09T00:00:00.000Z', line => lines.push(line))).not.toThrow();
    expect(lines).toEqual(['Shannon mind sweep skipped: database busy']);
    holder.exec('COMMIT');
    expect(() => sweepActions(actions, '2026-10-09T00:00:01.000Z', line => lines.push(line))).not.toThrow();
    expect(lines).toHaveLength(1);
    // Anything else still reaches the process handler, which exits for a clean restart.
    expect(() => sweepActions({ transaction: () => { throw new Error('SQLITE_CORRUPT'); }, sweep: () => 0 }, '2026-10-09T00:00:02.000Z', () => {}))
      .toThrow('SQLITE_CORRUPT');
  });

  it('folds repeated busy lines into one a minute', () => {
    let now = 0;
    const lines: string[] = [], log = throttledLog(line => lines.push(line), 60_000, () => now);
    log('busy'); log('busy'); now = 30_000; log('busy'); now = 61_000; log('busy');
    expect(lines).toEqual(['busy', 'busy (+2 since last line)']);
  });
});

describe('lease renewal tolerates transient failures within the lease', () => {
  function threads(renew: ActionThreads['renew']): ActionThreads {
    const view = { id: 'action-1', scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'source', parentId: null, state: 'running',
      generation: 1, holder: 'runner', lastHolder: 'runner', leaseUntil: null, resources: [], ownerInformed: false, deadline: null, progress: null,
      result: null, sent: false, failures: 0, lastFailure: null, createdAt: '', updatedAt: '' } as ActionView;
    return { enqueue: async () => view, claim: async () => view, renew } as unknown as ActionThreads;
  }
  const draft = { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'source' } as const;

  it('keeps working through two failed renewals and stops at the third', async () => {
    vi.useFakeTimers();
    const outcomes: Array<'fail' | 'ok'> = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'];
    const running = (await acquireAction(threads(async () => {
      if (outcomes.shift() === 'fail') throw new Error('MIND_IPC_DEADLINE');
      return {} as ActionView;
    }), draft))!;
    cleanups.push(() => running.stop());
    for (let n = 0; n < 3; n++) await vi.advanceTimersByTimeAsync(5_000);
    expect(running.execution.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000); await vi.advanceTimersByTimeAsync(5_000);
    expect(running.execution.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(running.execution.signal.aborted).toBe(true);
  });

  it('stops at once when the scheduler says the lease is gone', async () => {
    vi.useFakeTimers();
    const running = (await acquireAction(threads(async () => null), draft))!;
    cleanups.push(() => running.stop());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(running.execution.signal.aborted).toBe(true);
  });
});
