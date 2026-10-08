import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const databases: DatabaseSync[] = [], directories: string[] = [];
const at = '2026-10-09T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path); databases.push(db); db.exec('PRAGMA foreign_keys=ON'); migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db), actions = new SQLiteActionStore(db);
  let now = at;
  const hub = new SQLiteTaskRuntimeStore(db, { authority, now: () => now, leaseValid(scope, taskId, lease, time) {
    const action = actions.check(lease, time);
    return Boolean(action && action.scopeKey === scope && action.origin === 'owner_request' && action.sourceId.startsWith(`fca-${taskId}-`));
  } });
  const root = hub.ensureRoot('owner');
  const child = (request = 'child', parent = root.id) => hub.createChild('owner', parent, { title: request, goal: `Goal ${request}` }, request);
  function begin(id: string): TaskStep {
    const task = hub.get('owner', id)!;
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `fca-${id}-${task.revision}`,
      kind: 'agentTask', origin: 'owner_request' }, now).id, 'worker', now)!;
    const step = hub.beginStep('owner', id, leaseOf(action), task.revision); expect(step).not.toBeNull(); return step!;
  }
  function finish(step: TaskStep) { actions.finish(step.lease, 'completed', 'yielded', now); hub.acknowledgeReceipt(step.scopeKey, step.id); }
  return { db, authority, actions, hub, root, child, begin, finish, advance() { now = '2026-10-09T00:01:00.000Z'; } };
}
describe('durable FCA task authority', () => {
  it('reuses one scoped root, adds canonical task rows/events and no Host commands', () => {
    const f = fixture(); const a = f.child(), b = f.child();
    expect(a.id).toBe(b.id); expect(f.hub.ensureRoot('owner').id).toBe(f.root.id);
    expect(f.hub.ensureRoot('other').id).not.toBe(f.root.id);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toEqual({ n: 3 });
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
    expect(f.db.prepare('SELECT event_type FROM agent_task_events WHERE task_id=?').all(a.id)).toEqual([{ event_type: 'fca_created' }]);
    expect(f.hub.get('owner', f.root.id)?.childIds).toEqual([a.id]);
    expect(f.hub.get('other', a.id)).toBeNull();
    expect(() => f.hub.send('other', f.hub.ensureRoot('other').id, a.id, 'private', 'message')).toThrow('FCA_TASK_NOT_FOUND');
    expect(() => f.hub.createChild('owner', f.root.id, { title: 'different', goal: 'different' }, 'child')).toThrow('FCA_REQUEST_CONFLICT');
    expect(() => f.hub.createChild('owner', f.root.id, { title: 'own', goal: 'own', origin: 'own_time' }, 'own')).toThrow('FCA_OWN_TIME_NOT_ADMITTED');
  });
  it('admits a child and its initial context atomically, including retries after its context was consumed', () => {
    const f = fixture(), spec = { title: 'delegated', goal: 'Find the answer', context: 'Use this source' };
    f.db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON fca_task_messages BEGIN SELECT RAISE(ABORT,'injected_context_failure'); END;");
    expect(() => f.hub.createChild('owner', f.root.id, spec, 'context-request')).toThrow('injected_context_failure');
    expect(f.hub.get('owner', f.root.id)?.childIds).toEqual([]);
    f.db.exec('DROP TRIGGER fail_context');
    const task = f.hub.createChild('owner', f.root.id, spec, 'context-request');
    expect(f.hub.snapshot('owner', task.id)?.messages).toMatchObject([{ text: spec.context, sourceTaskId: f.root.id }]);
    const step = f.begin(task.id); f.hub.commitStep(step, { disposition: 'wait' }); f.finish(step);
    expect(f.hub.createChild('owner', f.root.id, spec, 'context-request').id).toBe(task.id);
    expect(() => f.hub.createChild('owner', f.root.id, { ...spec, context: 'Different source' }, 'context-request')).toThrow('FCA_REQUEST_CONFLICT');
    expect(f.hub.snapshot('owner', task.id)?.messages).toEqual([]);
  });
  it('commits a canonical event and checkpoint atomically, rolling back failed history writes', () => {
    const f = fixture(), child = f.child(), step = f.begin(child.id);
    f.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON fca_task_history BEGIN SELECT RAISE(ABORT,'injected_history_failure'); END;");
    const before = f.hub.snapshot('owner', child.id);
    expect(() => f.hub.commitStep(step, { disposition: 'wait', history: [{ result: 'record' }], checkpoint: { round: 1 } })).toThrow('injected_history_failure');
    expect(f.hub.snapshot('owner', child.id)).toEqual(before);
    expect(f.hub.pendingReceipts('owner')).toEqual([]);
    f.db.exec('DROP TRIGGER fail_history');
    expect(f.hub.commitStep(step, { disposition: 'wait', history: [{ result: 'record' }], checkpoint: { round: 1 } }))
      .toMatchObject({ task: { status: 'running', phase: 'waiting' }, history: [{ result: 'record' }], checkpoint: { round: 1 } });
    expect(f.hub.commitStep(step, { disposition: 'continue', history: ['duplicate'] })).toBeNull();
    expect(f.hub.pendingReceipts('owner')).toEqual([{ id: step.id, taskId: child.id, lease: step.lease, state: 'completed' }]);
    expect(f.hub.acknowledgeReceipt('other', step.id)).toBe(false);
    expect(f.hub.acknowledgeReceipt('owner', step.id)).toBe(true);
    expect(f.hub.acknowledgeReceipt('owner', step.id)).toBe(false);
  });
  it('keeps task lifetime distinct from a completed root response and releases execution slots on yield', () => {
    const f = fixture(), child = f.child();
    f.hub.send('owner', child.id, f.root.id, 'reply requested', 'root-message');
    const step = f.begin(f.root.id);
    expect(f.hub.commitStep(step, { disposition: 'complete', history: ['answer'] })?.task).toMatchObject({ status: 'running', phase: 'waiting' });
    f.finish(step);
    const childStep = f.begin(child.id);
    expect(f.actions.get(childStep.lease.id)?.state).toBe('running');
    expect(f.hub.get('owner', f.root.id)?.phase).toBe('waiting');
  });
});
describe('FCA inbox and single-writer steps', () => {
  it('deduplicates delivery durably and closes both send/wait race orders', () => {
    const f = fixture(), child = f.child();
    f.hub.wait('owner', child.id, child.revision);
    expect(f.hub.get('owner', child.id)?.phase).toBe('waiting');
    const sent = f.hub.send('owner', f.root.id, child.id, 'wake up', 'm1');
    expect(sent).toMatchObject({ duplicate: false, task: { phase: 'ready' } });
    expect(f.hub.send('owner', f.root.id, child.id, 'wake up', 'm1')).toMatchObject({ duplicate: true });
    expect(f.hub.get('owner', child.id)?.revision).toBe(sent.task.revision);
    expect(f.hub.wait('owner', child.id, sent.task.revision)?.phase).toBe('ready');
    expect(() => f.hub.send('owner', f.root.id, child.id, 'different', 'm1')).toThrow('FCA_MESSAGE_CONFLICT');
    const step = f.begin(child.id);
    f.hub.send('owner', f.root.id, child.id, 'late message', 'm2');
    const committed = f.hub.commitStep(step, { disposition: 'wait' })!; f.finish(step);
    expect(committed.task.phase).toBe('ready'); expect(committed.messages.map(message => message.id)).toEqual(['m2']);
    const next = f.begin(child.id);
    expect(f.hub.commitStep(next, { disposition: 'wait' })?.task.phase).toBe('waiting');
  });
  it('rejects a second writer, stale lease, and consumption of messages unseen by the claimed snapshot', () => {
    const f = fixture(), child = f.child(), step = f.begin(child.id);
    expect(f.hub.beginStep('owner', child.id, step.lease)).toBeNull();
    f.hub.send('owner', f.root.id, child.id, 'after begin', 'late');
    expect(() => f.hub.commitStep(step, { disposition: 'wait', consumedMessageIds: ['late'] })).toThrow('FCA_MESSAGE_NOT_OBSERVED');
    f.advance();
    expect(f.hub.commitStep(step, { disposition: 'complete' })).toBeNull();
    expect(f.hub.snapshot('owner', child.id)?.history).toEqual([]);
    expect(f.hub.snapshot('owner', child.id)?.messages.map(message => message.id)).toEqual(['late']);
  });
  it('keeps a task ready when new input arrives during its final response', () => {
    const f = fixture(), child = f.child(), step = f.begin(child.id);
    f.hub.send('owner', f.root.id, child.id, 'another question', 'late-final');
    const saved = f.hub.commitStep(step, { disposition: 'complete', history: ['initial answer'] })!;
    expect(saved.task.phase).toBe('ready');
    expect(saved.messages.map(message => message.id)).toEqual(['late-final']);
    expect(f.hub.snapshot('owner', f.root.id)?.messages).toEqual([]);
  });
  it('notifies a waiting parent after child completion, and refuses orphaning live descendants', () => {
    const f = fixture(), parent = f.child('parent'), child = f.child('nested', parent.id), parentStep = f.begin(parent.id);
    expect(() => f.hub.commitStep(parentStep, { disposition: 'complete' })).toThrow('FCA_CHILDREN_ACTIVE');
    expect(() => f.hub.commitStep(parentStep, { disposition: 'fail' })).toThrow('FCA_CHILDREN_ACTIVE');
    f.hub.commitStep(parentStep, { disposition: 'wait' }); f.finish(parentStep);
    const childStep = f.begin(child.id);
    f.hub.commitStep(childStep, { disposition: 'complete', summary: 'Found the answer' }); f.finish(childStep);
    expect(f.hub.get('owner', parent.id)?.phase).toBe('ready');
    expect(f.hub.snapshot('owner', parent.id)?.messages).toMatchObject([{ sourceTaskId: child.id, text: 'Found the answer' }]);
    const final = f.begin(parent.id);
    expect(f.hub.commitStep(final, { disposition: 'complete' })?.task.phase).toBe('completed');
  });
});
describe('FCA stop and recovery', () => {
  it('propagates stop, fences commits and waits for actual action cancellation before acknowledging the subtree', () => {
    const f = fixture(), child = f.child(), step = f.begin(child.id);
    f.hub.stop('owner', f.root.id, 'owner stop');
    expect(f.hub.get('owner', child.id)?.phase).toBe('stopping');
    expect(f.hub.get('owner', f.root.id)?.phase).toBe('stopping');
    expect(f.hub.commitStep(step, { disposition: 'complete' })).toBeNull();
    expect(f.hub.resume('owner', child.id)).toBeNull();
    f.actions.stop('owner', step.lease.id, 'stop-action', at);
    expect(f.actions.get(step.lease.id)?.state).toBe('stopping');
    f.actions.finish(step.lease, 'cancelled', 'stopped', at);
    expect(f.hub.acknowledgeStop(step)?.phase).toBe('stopped');
    expect(f.hub.get('owner', f.root.id)?.phase).toBe('stopped');
    expect(f.hub.resume('owner', child.id)).toBeNull();
    expect(f.hub.resume('owner', f.root.id)?.phase).toBe('ready');
    expect(f.hub.resume('owner', child.id)?.phase).toBe('ready');
  });
  it('restores persisted inbox/history/root across two database connections without replaying unknown work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fca-task-')); directories.push(directory); const path = join(directory, 'tasks.sqlite');
    const f = fixture(path), child = f.child();
    f.hub.send('owner', f.root.id, child.id, 'input', 'message');
    const first = f.begin(child.id);
    f.hub.commitStep(first, { disposition: 'continue', history: [{ reply: 'one' }], checkpoint: { rounds: 1 } });
    const restored = fixture(path);
    expect(restored.root.id).toBe(f.root.id);
    expect(restored.hub.pendingReceipts('owner')).toEqual([{ id: first.id, taskId: child.id, lease: first.lease, state: 'completed' }]);
    expect(restored.hub.snapshot('owner', child.id)).toMatchObject({ history: [{ reply: 'one' }], checkpoint: { rounds: 1 }, messages: [] });
    expect(restored.hub.beginStep('owner', child.id, first.lease)).toBeNull();
    f.finish(first);
    expect(restored.hub.pendingReceipts('owner')).toEqual([]);
    const pending = f.begin(child.id); f.actions.dispatch(pending.lease, at); f.advance();
    const recovered = restored.hub.recover('owner', () => 'unknown');
    expect(recovered[0]?.phase).toBe('unknown'); expect(restored.hub.resume('owner', child.id)).toBeNull();
    restored.hub.send('owner', restored.root.id, child.id, 'new input', 'message-2');
    expect(restored.hub.get('owner', child.id)?.phase).toBe('unknown');
    expect(restored.hub.beginStep('owner', child.id, pending.lease)).toBeNull();
    expect(f.hub.commitStep(pending, { disposition: 'complete' })).toBeNull();
    expect(restored.hub.snapshot('owner', child.id)?.messages).toHaveLength(1);
  });
  it('recovers confirmed unsent execution without losing inbox, and enforces bounded task depth', () => {
    const f = fixture(), child = f.child(), step = f.begin(child.id);
    f.hub.send('owner', f.root.id, child.id, 'retained', 'm');
    f.actions.finish(step.lease, 'failed', 'not_sent', at);
    expect(f.hub.recover('owner', () => 'safe')[0]?.phase).toBe('ready');
    expect(f.hub.snapshot('owner', child.id)?.messages).toHaveLength(1);
    let parent = child.id;
    for (let i = 0; i < 7; i++) parent = f.child(`depth-${i}`, parent).id;
    expect(() => f.child('too-deep', parent)).toThrow('FCA_DEPTH_LIMIT');
  });
  it('finds and stops live descendants after more than one page of completed siblings', () => {
    const f = fixture(), parent = f.child('parent');
    for (let index = 0; index < 101; index++) {
      const old = f.child(`historical-${index}`, parent.id);
      f.authority.transaction(() => f.authority.event('owner', old.id, 'fixture_completed', at, { status: 'completed' }));
    }
    f.db.prepare('UPDATE agent_tasks SET created_at=? WHERE fca_parent_id=?').run('2026-10-08T00:00:00.000Z', parent.id);
    const newest = f.child('newest-live', parent.id);
    expect(f.hub.get('owner', parent.id)?.childIds).toHaveLength(102);
    expect(f.hub.get('owner', parent.id)?.childIds.at(-1)).toBe(newest.id);
    const step = f.begin(parent.id);
    expect(() => f.hub.commitStep(step, { disposition: 'complete' })).toThrow('FCA_CHILDREN_ACTIVE');
    expect(f.hub.stop('owner', parent.id, 'stop all descendants').map(task => task.id)).toContain(newest.id);
    expect(f.hub.get('owner', newest.id)?.phase).toBe('stopped');
  });
});
