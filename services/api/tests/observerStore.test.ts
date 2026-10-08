import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { SQLiteObserverStore, startObserverPublisher } from '../src/infra/observer/store/observerStore.js';
import { observeSync, withObserverRun } from '../src/infra/observer/observerContext.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function temporary() { const path = mkdtempSync(join(tmpdir(), 'shannon-observer-')); cleanups.push(() => rmSync(path, { force: true, recursive: true })); return join(path, 'events.sqlite'); }
function store(path = ':memory:', now = () => Date.now(), rows = 2000, retention = 900_000) { const value = new SQLiteObserverStore(path, now, rows, retention); cleanups.push(() => value.close()); return value; }
const event = (index: number, scopeKey = 'owner'): ObserverDraft => ({ scopeKey, runId: `run-${index}`, spanId: `span-${index}`, parentSpanId: null, node: 'llm', kind: 'span.completed', at: '2026-10-08T00:00:00.000Z', output: { index } });

describe('observer sidecar storage', () => {
  it('queues without writing or awaiting, and reads only the exact scope with ordered cursors', () => {
    const db = store(); expect(db.publish(event(1))).toBeUndefined(); expect(db.read('owner', 0, 200).events).toEqual([]);
    db.publish(event(2, 'owner-other')); db.publish(event(3)); db.flush();
    const first = db.read('owner', 0, 1); expect(first.events.map(row => row.runId)).toEqual(['run-1']);
    const next = db.read('owner', first.cursor, 200); expect(next.events.map(row => row.runId)).toEqual(['run-3']);
    expect(db.read('OWNER', 0, 200).events).toEqual([]); expect(next.events.every(row => !Object.hasOwn(row, 'scopeKey'))).toBe(true);
    expect(db.read('owner', next.cursor, 200)).toMatchObject({ events: [], cursor: next.cursor, gap: false });
  });

  it('enforces bounded retention, reports a pruned cursor gap, and never returns expired payloads', () => {
    let clock = 1_000; const db = store(':memory:', () => clock, 3, 100);
    for (let i = 1; i <= 5; i++) db.publish(event(i)); db.flush();
    const retained = db.read('owner', 1, 200); expect(retained.events.map(row => row.runId)).toEqual(['run-3', 'run-4', 'run-5']);
    expect(retained).toMatchObject({ oldestCursor: 3, gap: true });
    clock += 101; expect(db.read('owner', 0, 200).events).toEqual([]);
    expect(db.read('owner', retained.cursor, 200)).toMatchObject({ events: [], gap: true });
    db.publish(event(6)); db.flush(); expect(db.read('owner', 0, 200).events.map(row => row.runId)).toEqual(['run-6']);
  });

  it('physically prunes expired rows without another published event and prunes them on restart', () => {
    let clock = 1_000; const path = temporary(), db = store(path, () => clock, 2000, 100);
    db.publish(event(1)); db.flush();
    const reader = new DatabaseSync(path, { readOnly: true }); cleanups.push(() => reader.close());
    const count = () => Number((reader.prepare('SELECT COUNT(*) AS count FROM observer_events').get() as { count: number }).count);
    expect(count()).toBe(1); clock += 101; db.prune(); expect(count()).toBe(0);
    db.publish(event(2)); db.flush(); db.close(); clock += 101;
    const restarted = store(path, () => clock, 2000, 100); expect(restarted.read('owner', 0, 200).events).toEqual([]); expect(count()).toBe(0);
  });

  it('bounds the queue, reports drops, limits each flush and keeps held replies empty', () => {
    const db = store(); for (let i = 0; i < 600; i++) db.publish(event(i));
    expect(db.held()).toMatchObject({ availability: 'held', events: [], cursor: 0, dropped: 88 });
    db.flush(); expect(db.read('owner', 0, 200).events).toHaveLength(64);
    for (let i = 0; i < 7; i++) db.flush();
    let cursor = 0, count = 0;
    for (;;) { const batch = db.read('owner', cursor, 200); if (!batch.events.length) break; count += batch.events.length; cursor = batch.cursor; }
    expect(count).toBe(512);
  });

  it('reports native loss alongside queue drops in read and held batches without inventing events', () => {
    const db = store(); db.noteDropped(12);
    expect(db.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 12 });
    for (let i = 0; i < 600; i++) db.publish(event(i));
    expect(db.held()).toMatchObject({ events: [], dropped: 100 });
    db.flush(); const batch = db.read('owner', 0, 200); expect(batch.dropped).toBe(100); expect(batch.events).toHaveLength(64);
    db.noteDropped(0); expect(db.held().dropped).toBe(100);
  });

  it('shares persisted worker loss across connections without double counting local pending loss', () => {
    const path = temporary(), worker = store(path), otherWorker = store(path), reader = store(path);
    expect(worker.noteDropped(7)).toBeUndefined(); expect(worker.read('owner', 0, 200).dropped).toBe(7);
    expect(reader.read('owner', 0, 200).dropped).toBe(0); // noteDropped performed no synchronous SQL.
    worker.flush(); expect(reader.read('owner', 0, 200).dropped).toBe(7); expect(worker.held().dropped).toBe(7);
    worker.noteDropped(2); otherWorker.noteDropped(3); otherWorker.flush();
    expect(reader.read('owner', 0, 200).dropped).toBe(10); expect(worker.held().dropped).toBe(12);
    worker.flush(); expect(reader.read('owner', 0, 200).dropped).toBe(12); expect(worker.held().dropped).toBe(12);
    for (let i = 0; i < 600; i++) worker.publish(event(i));
    expect(worker.held().dropped).toBe(100); expect(reader.read('owner', 0, 200).dropped).toBe(12); // Overflow also stays in memory until flush.
    worker.flush(); expect(reader.read('owner', 0, 200).dropped).toBe(100);
    for (let i = 0; i < 7; i++) worker.flush();
    worker.close(); otherWorker.close(); expect(store(path).read('owner', 0, 200).dropped).toBe(100);
  });

  it('persists a failed worker flush loss through maintenance without replaying the lost event', () => {
    const path = temporary(), worker = store(path), reader = store(path), locker = new DatabaseSync(path);
    cleanups.push(() => locker.close());
    locker.exec('BEGIN IMMEDIATE');
    worker.noteDropped(2); worker.publish(event(1)); expect(() => worker.flush()).not.toThrow();
    expect(worker.held().dropped).toBe(3); expect(reader.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 0 });
    locker.exec('COMMIT');
    worker.prune(); expect(reader.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 3 });
    worker.prune(); worker.flush(); expect(worker.held().dropped).toBe(3); expect(reader.held().dropped).toBe(3);
  });

  it('bounds the shared loss counter across additive writes and restart', () => {
    const path = temporary(), first = store(path), second = store(path);
    first.noteDropped(Number.MAX_SAFE_INTEGER); first.flush(); second.noteDropped(20); second.flush();
    expect(first.read('owner', 0, 200).dropped).toBe(Number.MAX_SAFE_INTEGER);
    first.close(); second.close(); expect(store(path).held().dropped).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('drops oversized events and catches disk errors without failing publication', () => {
    const path = temporary(), db = store(path); db.publish({ ...event(1), output: { text: 'x'.repeat(17_000) } }); db.flush();
    expect(db.read('owner', 0, 200)).toMatchObject({ events: [], dropped: 1 });
    const sabotage = new DatabaseSync(path); sabotage.exec('DROP TABLE observer_events'); sabotage.close();
    expect(() => { db.publish(event(2)); db.flush(); }).not.toThrow();
    expect(db.held().dropped).toBe(2);
  });

  it('supports separate connection readers and process restart without erasing retained events', () => {
    const path = temporary(), writer = store(path), reader = store(path);
    writer.publish(event(1)); writer.flush(); expect(reader.read('owner', 0, 200).events.map(row => row.runId)).toEqual(['run-1']);
    const previousInstance = writer.instanceId; writer.publish(event(2)); writer.close();
    const restarted = store(path); expect(restarted.instanceId).not.toBe(previousInstance);
    expect(restarted.read('owner', 1, 200).events.map(row => row.runId)).toEqual(['run-2']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('installs a nonawaiting publisher in a separate sidecar and safely disables an unavailable store', async () => {
    const path = temporary(), publisher = startObserverPublisher(path)!; expect(publisher).not.toBeNull(); cleanups.push(publisher.close);
    let work = 0; expect(await withObserverRun({ scopeKey: 'owner', surface: 'text' }, async () => observeSync('tools', {}, () => ++work))).toBe(1);
    expect(publisher.store.read('owner', 0, 200).events).toEqual([]); publisher.store.flush();
    expect(publisher.store.read('owner', 0, 200).events).toHaveLength(4);
    expect(startObserverPublisher(join(`${path}.observer`, 'not-a-directory', 'events'))).toBeNull();
  });
});
