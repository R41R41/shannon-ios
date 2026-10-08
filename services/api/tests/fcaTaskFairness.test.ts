import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-09T00:00:00.000Z';
const closers = new Set<() => void>(), directories: string[] = [];
afterEach(() => { for (const close of closers) close(); closers.clear(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(path = ':memory:', legacy = false) {
  const h = actionHarness(() => at, path); migrateAgentTasks(h.db);
  const authority = new SQLiteFcaTaskAuthority(h.db);
  if (legacy) h.db.exec(`CREATE TABLE fca_task_checkpoints (
    task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), checkpoint_json TEXT, wait_reason TEXT,
    stop_requested INTEGER NOT NULL DEFAULT 0, step_id TEXT, lease_json TEXT);`);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid(scope, taskId, lease, time) {
    const action = h.store.check(lease, time);
    return Boolean(action && action.scopeKey === scope && action.origin === 'owner_request' && action.sourceId.startsWith(`fca:${taskId}:`));
  } });
  const root = runtime.ensureRoot('owner');
  const child = (title: string, scope = 'owner') => runtime.createChild(scope, runtime.ensureRoot(scope).id, { title, goal: title }, title);
  async function claim(taskId: string, scope = 'owner') {
    const task = runtime.get(scope, taskId)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: scope, kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${taskId}:${task.revision}`, resources: [actionResource(scope, `fca:${taskId}`)] })).id);
    expect(action).not.toBeNull(); return leaseOf(action!);
  }
  async function run(taskId: string, scope = 'owner', acknowledge = true) {
    const lease = await claim(taskId, scope), step = runtime.beginStep(scope, taskId, lease)!;
    expect(step).not.toBeNull();
    expect(runtime.commitStep(step, { disposition: 'continue', history: [{ result: step.id }] })?.task.phase).toBe('ready');
    if (acknowledge) { await h.actions.finish(lease, 'completed', 'fca_segment_committed'); expect(runtime.acknowledgeReceipt(scope, step.id)).toBe(true); }
    return step;
  }
  const close = () => { h.close(); closers.delete(close); }; closers.add(close);
  return { ...h, authority, runtime, root, child, claim, run, close };
}

describe('durable FCA admission fairness', () => {
  it('rotates continuing tasks under timestamp ties instead of starving the third task', async () => {
    const f = fixture(); ['one', 'two', 'three'].forEach(title => f.child(title));
    const presentationOrder = f.runtime.list('owner').map(task => task.id);
    const readyOrder = f.runtime.readyTasks('owner').map(task => task.id), counts = new Map<string, number>();
    for (let tick = 0; tick < 6; tick++) {
      const candidates = f.runtime.readyTasks('owner', 2);
      expect(candidates).toHaveLength(2);
      if (tick === 1) expect(candidates[0]?.id).toBe(readyOrder[2]);
      for (const candidate of candidates) { await f.run(candidate.id); counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1); }
    }
    expect(readyOrder.map(id => counts.get(id))).toEqual([4, 4, 4]);
    expect(f.runtime.list('owner').map(task => task.id)).toEqual(presentationOrder);
    expect(f.db.prepare('SELECT last_admission FROM fca_task_dispatch_order WHERE scope_key=?').get('owner')).toEqual({ last_admission: 12 });
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
  });

  it('keeps received-message storms from changing admission order and excludes pending receipts', async () => {
    const f = fixture(); ['one', 'two', 'three'].forEach(title => f.child(title));
    const [first, second, third] = f.runtime.readyTasks('owner');
    await f.run(first!.id); const pending = await f.run(second!.id, 'owner', false);
    for (let i = 0; i < 30; i++) f.runtime.send('owner', f.root.id, first!.id, 'new input', `storm-${i}`);
    expect(f.runtime.readyTasks('owner').map(task => task.id)).toEqual([third!.id, first!.id]);
    await f.actions.finish(pending.lease, 'completed', 'fca_segment_committed'); f.runtime.acknowledgeReceipt('owner', pending.id);
    expect(f.runtime.readyTasks('owner').map(task => task.id)).toEqual([third!.id, first!.id, second!.id]);
    expect(f.runtime.snapshot('owner', first!.id)?.messages).toHaveLength(30);
  });

  it('preserves admission order across database close/reopen and isolates scopes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fca-fairness-')); directories.push(directory);
    const path = join(directory, 'tasks.sqlite'), original = fixture(path);
    ['one', 'two', 'three'].forEach(title => original.child(title));
    const [first, second, third] = original.runtime.readyTasks('owner');
    await original.run(first!.id); await original.run(second!.id);
    const foreign = original.child('foreign', 'other'); await original.run(foreign.id, 'other');
    const order = original.runtime.readyTasks('owner').map(task => task.id); original.close();
    const restored = fixture(path);
    expect(restored.runtime.readyTasks('owner').map(task => task.id)).toEqual(order);
    expect(order[0]).toBe(third!.id);
    expect(restored.runtime.readyTasks('other').map(task => task.id)).toEqual([foreign.id]);
    await restored.run(third!.id);
    expect(restored.db.prepare('SELECT last_admission FROM fca_task_dispatch_order WHERE scope_key=?').get('owner')).toEqual({ last_admission: 3 });
  });

  it('advances ordering only when the existing lease is valid and the start commits', async () => {
    const f = fixture(), task = f.child('one');
    expect(f.runtime.beginStep('owner', task.id, { id: 'missing', holder: 'missing', generation: 1 })).toBeNull();
    expect(f.db.prepare('SELECT * FROM fca_task_dispatch_order').all()).toEqual([]);
    const lease = await f.claim(task.id);
    f.db.exec("CREATE TRIGGER fail_start BEFORE UPDATE ON agent_tasks WHEN OLD.status='queued' AND NEW.status='running' BEGIN SELECT RAISE(ABORT,'start_failed'); END;");
    expect(() => f.runtime.beginStep('owner', task.id, lease)).toThrow('start_failed');
    expect(f.db.prepare('SELECT * FROM fca_task_dispatch_order').all()).toEqual([]);
    expect(f.runtime.readyTasks('owner').map(candidate => candidate.id)).toEqual([task.id]);
    f.db.exec('DROP TRIGGER fail_start');
    expect(f.runtime.beginStep('owner', task.id, lease)).not.toBeNull();
    expect(f.runtime.beginStep('owner', task.id, lease)).toBeNull();
    expect(f.db.prepare('SELECT last_admission FROM fca_task_dispatch_order WHERE scope_key=?').get('owner')).toEqual({ last_admission: 1 });
    expect(f.runtime.readyTasks('owner')).toEqual([]);
  });

  it('adds fairness metadata to an existing checkpoint schema without resetting task content', async () => {
    const f = fixture(':memory:', true), task = f.child('legacy');
    const step = await f.run(task.id);
    expect(f.runtime.snapshot('owner', task.id)?.history).toEqual([{ result: step.id }]);
    expect(f.db.prepare('PRAGMA table_info(fca_task_checkpoints)').all().some(row => row.name === 'last_admission')).toBe(true);
    expect(f.runtime.readyTasks('owner', 1).map(candidate => candidate.id)).toEqual([task.id]);
    expect(() => f.runtime.readyTasks('owner', 0)).toThrow('FCA_PAGE');
    expect(f.runtime.readyTasks('owner', 256).map(candidate => candidate.id)).toEqual([task.id]);
    expect(() => f.runtime.readyTasks('owner', 257)).toThrow('FCA_PAGE');
  });
});
