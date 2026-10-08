import { afterEach, describe, expect, it } from 'vitest';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-09T00:00:00.000Z', close: Array<() => void> = [];
afterEach(() => { for (const stop of close.splice(0)) stop(); });
function fixture() {
  const h = actionHarness(() => at); close.push(h.close); migrateAgentTasks(h.db);
  const authority = new SQLiteFcaTaskAuthority(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at,
    leaseValid(scope, taskId, lease, time) { const action = h.store.check(lease, time); return !!action && action.scopeKey === scope
      && action.kind === 'agentTask' && action.sourceId.startsWith(`fca:${taskId}:`); },
    conversationLeaseValid(scope, lease, time) { const action = h.store.check(lease, time); return !!action && action.scopeKey === scope
      && action.kind === 'respond' && action.origin === 'owner_request'; },
  });
  const root = runtime.ensureRoot('owner');
  const child = (title: string, parentId = root.id) => runtime.createChild('owner', parentId, { title, goal: title }, title);
  async function conversation(request: string, thread = 'thread') {
    const action = await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: request });
    expect(action).not.toBeNull();
    const step = runtime.beginConversation('owner', thread, leaseOf(action!)); expect(step).not.toBeNull(); return step!;
  }
  async function background(taskId: string) {
    const task = runtime.get('owner', taskId)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${taskId}:${task.revision}`, resources: [actionResource('owner', `fca:${taskId}`)] })).id);
    expect(action).not.toBeNull(); return runtime.beginStep('owner', taskId, leaseOf(action!));
  }
  const source = (experienceId: string, threadId = 'thread') => ({ experienceId, threadId, observedAt: at, recalledMemoryIds: ['memory-a'] });
  return { ...h, runtime, root, child, conversation, background, source };
}

describe('foreground conversation provenance without another executor', () => {
  it('holds descendants until the existing foreground turn has a durable source, then retains source IDs through descendants', async () => {
    const f = fixture(), step = await f.conversation('turn-one');
    const child = f.child('delegated', step.taskId), grandchild = f.child('nested', child.id);
    expect(f.runtime.taskSources('owner', child.id)).toEqual([{ stepId: step.id, threadId: 'thread', experienceId: null, observedAt: at, recalledMemoryIds: [] }]);
    expect(f.runtime.readyTasks('owner')).toEqual([]);
    expect(await f.background(child.id)).toBeNull();
    const refs = Array.from({ length: 4096 }, (_, index) => `memory-${index}`);
    expect(f.runtime.completeConversation(step, { ...f.source('experience-one'), recalledMemoryIds: refs })).toBe(true);
    expect(f.runtime.taskSources('owner', grandchild.id)).toEqual([{ ...f.source('experience-one'), recalledMemoryIds: refs, stepId: step.id }]);
    expect(f.runtime.readyTasks('owner').map(task => task.id)).toEqual(expect.arrayContaining([child.id, grandchild.id]));
    expect(f.runtime.readyTasks('owner').some(task => task.id === step.taskId)).toBe(false);
    expect(f.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.runtime.snapshot('owner', step.taskId)?.history).toEqual([]);
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
    expect(f.store.get(step.lease.id)?.state).toBe('running');
  });

  it('keeps pending-source messages invisible and dormant, then wakes the target when their source binds', async () => {
    const f = fixture(), target = f.child('receiver');
    f.runtime.wait('owner', target.id, target.revision);
    const step = await f.conversation('turn');
    f.runtime.send('owner', step.taskId, target.id, 'pending private input', 'message');
    expect(f.runtime.get('owner', target.id)?.phase).toBe('waiting');
    expect(f.runtime.snapshot('owner', target.id)?.messages).toEqual([]);
    expect(f.runtime.taskSources('owner', target.id)).toEqual([]);
    f.runtime.completeConversation(step, f.source('experience'));
    expect(f.runtime.get('owner', target.id)?.phase).toBe('ready');
    expect(f.runtime.snapshot('owner', target.id)?.messages).toMatchObject([{ id: 'message', text: 'pending private input' }]);
    expect(f.runtime.taskSources('owner', target.id)).toMatchObject([{ experienceId: 'experience' }]);
  });

  it('lets an unrelated in-flight step commit while retaining an unresolved message for later', async () => {
    const f = fixture(), target = f.child('receiver'), background = (await f.background(target.id))!;
    const conversation = await f.conversation('turn');
    f.runtime.send('owner', conversation.taskId, target.id, 'after source commit', 'late');
    expect(f.runtime.snapshot('owner', target.id)?.messages).toEqual([]);
    const committed = f.runtime.commitStep(background, { disposition: 'complete', history: ['own result'] });
    expect(committed?.task.phase).toBe('waiting');
    expect(committed?.history).toEqual(['own result']);
    expect(committed?.messages).toEqual([]);
    f.runtime.completeConversation(conversation, f.source('experience'));
    expect(f.runtime.get('owner', target.id)?.phase).toBe('ready');
    expect(f.runtime.snapshot('owner', target.id)?.messages).toMatchObject([{ id: 'late' }]);
  });

  it('fails an unbound source without executing its children or exposing its sent messages', async () => {
    const f = fixture(), target = f.child('receiver'); f.runtime.wait('owner', target.id, target.revision);
    const step = await f.conversation('failed-turn'), child = f.child('pending-child', step.taskId), grandchild = f.child('pending-grandchild', child.id);
    f.runtime.send('owner', step.taskId, target.id, 'never persisted turn', 'failed-message');
    f.runtime.failConversation(step);
    expect([child.id, grandchild.id].map(id => f.runtime.get('owner', id)?.phase)).toEqual(['stopped', 'stopped']);
    expect(f.runtime.resume('owner', child.id)).toBeNull();
    expect(f.runtime.snapshot('owner', target.id)?.messages).toEqual([]);
    expect(f.runtime.get('owner', target.id)?.phase).toBe('waiting');
    expect(f.runtime.get('owner', step.taskId)?.phase).toBe('waiting');
    expect(f.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.runtime.completeConversation(step, f.source('should-not-bind'))).toBe(false);
  });

  it('releases a completion held only by a pending message when that source fails', async () => {
    const f = fixture(), target = f.child('receiver'), background = (await f.background(target.id))!;
    const conversation = await f.conversation('turn');
    f.runtime.send('owner', conversation.taskId, target.id, 'uncommitted context', 'pending');
    expect(f.runtime.commitStep(background, { disposition: 'complete', history: ['known result'] })?.task.phase).toBe('waiting');
    f.runtime.failConversation(conversation);
    expect(f.runtime.get('owner', target.id)?.phase).toBe('ready');
    expect(f.runtime.snapshot('owner', target.id)?.messages).toEqual([]);
    expect(f.runtime.taskSources('owner', target.id)).toEqual([]);
  });

  it('reuses the Talk task but does not poison a new foreground turn with prior source lineage', async () => {
    const f = fixture(), previous = await f.conversation('first');
    f.runtime.completeConversation(previous, f.source('old-experience'));
    await f.actions.finish(previous.lease, 'completed', 'responded');
    const current = await f.conversation('second');
    expect(current.taskId).toBe(previous.taskId);
    expect(f.runtime.taskSources('owner', current.taskId)).toEqual([{ stepId: current.id, threadId: 'thread', experienceId: null, observedAt: at, recalledMemoryIds: [] }]);
    const child = f.child('new-child', current.taskId);
    expect(f.runtime.completeConversation(current, f.source('wrong-thread', 'other'))).toBe(false);
    expect(f.runtime.readyTasks('owner')).toEqual([]);
    expect(f.runtime.completeConversation(current, f.source('new-experience'))).toBe(true);
    expect(f.runtime.taskSources('owner', child.id).map(source => source.experienceId)).toEqual(['new-experience']);
    expect(f.runtime.taskSources('other', child.id)).toEqual([]);
  });

  it('refuses to attach a conversation to a background or foreign-scope lease', async () => {
    const f = fixture(), task = f.child('work'), background = (await f.background(task.id))!;
    expect(f.runtime.beginConversation('owner', 'thread', background.lease)).toBeNull();
    const foreground = await f.actions.admitRespond({ scopeKey: 'other', kind: 'respond', origin: 'owner_request', sourceId: 'foreign' });
    expect(f.runtime.beginConversation('owner', 'thread', leaseOf(foreground!))).toBeNull();
    expect(f.runtime.list('owner').some(row => row.kind === 'conversation')).toBe(false);
  });

  it('retires a safely recovered foreground source and its descendants without background replay', async () => {
    const f = fixture(), step = await f.conversation('interrupted'), child = f.child('pending', step.taskId);
    f.runtime.recover('owner', () => 'unknown');
    expect(f.runtime.get('owner', step.taskId)?.phase).toBe('unknown');
    expect(f.runtime.activeSteps('owner')).toHaveLength(1);
    expect(f.runtime.taskSources('owner', child.id)).toMatchObject([{ experienceId: null }]);
    expect(f.runtime.readyTasks('owner')).toEqual([]);
    f.runtime.recover('owner', () => 'safe');
    expect(f.runtime.get('owner', step.taskId)?.phase).toBe('waiting');
    expect(f.runtime.get('owner', child.id)?.phase).toBe('stopped');
    expect(f.runtime.activeSteps('owner')).toEqual([]);
    expect(f.runtime.readyTasks('owner')).toEqual([]);
    expect(f.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.runtime.completeConversation(step, f.source('too-late'))).toBe(false);
  });

  it('consumes only inbox IDs actually rendered to the foreground model', async () => {
    const f = fixture(), previous = await f.conversation('first'); f.runtime.completeConversation(previous, f.source('first'));
    await f.actions.finish(previous.lease, 'completed', 'responded');
    f.runtime.send('owner', f.root.id, previous.taskId, 'visible result', 'shown');
    f.runtime.send('owner', f.root.id, previous.taskId, 'withheld result', 'hidden');
    const step = await f.conversation('second'); expect(step.messageIds).toEqual(['shown', 'hidden']);
    expect(() => f.runtime.completeConversation(step, f.source('second'), ['shown'])).toThrow('FCA_MESSAGE_NOT_OBSERVED');
    expect(f.runtime.observeConversationMessages(step, ['shown'])).toBe(true);
    expect(f.runtime.observeConversationMessages(step, ['shown'])).toBe(true);
    expect(f.runtime.observeConversationMessages(step, ['hidden'])).toBe(false);
    f.runtime.completeConversation(step, f.source('second'), ['shown']);
    expect(f.runtime.snapshot('owner', step.taskId)?.messages.map(message => message.id)).toEqual(['hidden']);
    await f.actions.finish(step.lease, 'completed', 'responded');
    const next = await f.conversation('third');
    f.runtime.completeConversation(next, f.source('third'));
    expect(f.runtime.snapshot('owner', step.taskId)?.messages.map(message => message.id)).toEqual(['hidden']);
  });

  it('pins admitted source references while retaining consumed history dependencies', async () => {
    const f = fixture(), target = f.child('receiver'), background = (await f.background(target.id))!;
    const conversation = await f.conversation('turn');
    f.runtime.send('owner', conversation.taskId, target.id, 'late source', 'late');
    f.runtime.completeConversation(conversation, { ...f.source('experience'), readSourceIds: ['aether:document-1'] });
    expect(background.snapshot.sources).toEqual([]);
    expect(f.runtime.taskSources('owner', target.id, background.messageIds)).toEqual([]);
    expect(f.runtime.snapshot('owner', target.id)?.sources).toMatchObject([{ experienceId: 'experience', readSourceIds: ['aether:document-1'] }]);
    f.runtime.commitStep(background, { disposition: 'continue' });
    await f.actions.finish(background.lease, 'completed', 'committed'); f.runtime.acknowledgeReceipt('owner', background.id);
    const next = (await f.background(target.id))!;
    expect(next.snapshot.sources).toMatchObject([{ experienceId: 'experience' }]);
    f.runtime.commitStep(next, { disposition: 'continue' });
    expect(f.runtime.snapshot('owner', target.id)?.messages).toEqual([]);
    expect(f.runtime.taskSources('owner', target.id, [])).toMatchObject([{ experienceId: 'experience' }]);
  });

  it('inherits only rendered conversation inbox refs and binds late private-read refs to already created children', async () => {
    const f = fixture(), producer = await f.conversation('producer', 'producer-thread');
    const sender = f.child('sender', producer.taskId);
    f.runtime.completeConversation(producer, f.source('producer-source', 'producer-thread'));
    await f.actions.finish(producer.lease, 'completed', 'responded');
    const initial = await f.conversation('receiver'); f.runtime.completeConversation(initial, f.source('receiver-old'));
    await f.actions.finish(initial.lease, 'completed', 'responded');
    f.runtime.send('owner', sender.id, initial.taskId, 'sourced result', 'result');
    const current = await f.conversation('receiver-next');
    const before = f.child('created-before-render', current.taskId);
    expect(f.runtime.taskSources('owner', before.id).map(source => source.stepId)).toEqual([current.id]);
    expect(f.runtime.observeConversationMessages(current, ['result'])).toBe(true);
    const after = f.child('created-after-render', current.taskId);
    expect(f.runtime.taskSources('owner', after.id).map(source => source.stepId)).toEqual(expect.arrayContaining([current.id, producer.id]));
    f.runtime.completeConversation(current, { ...f.source('receiver-new'), readSourceIds: ['shannon:study-1'] }, ['result']);
    expect(f.runtime.taskSources('owner', before.id)).toMatchObject([{ experienceId: 'receiver-new', readSourceIds: ['shannon:study-1'] }]);
  });

  it('durably follows a task projection into native history and children under the exact scoped lease', async () => {
    const f = fixture(), conversation = await f.conversation('origin'), sourceTask = f.child('source', conversation.taskId);
    f.runtime.completeConversation(conversation, f.source('source-experience'));
    const receiver = f.child('reader'), step = (await f.background(receiver.id))!;
    const foreign = f.runtime.createChild('foreign', f.runtime.ensureRoot('foreign').id, { title: 'foreign', goal: 'foreign' }, 'foreign');
    expect(f.runtime.inheritTaskSources(step, [sourceTask.id, foreign.id])).toBe(false);
    expect(f.runtime.taskSources('owner', receiver.id)).toEqual([]);
    expect(f.runtime.inheritTaskSources({ ...step, lease: { ...step.lease, generation: step.lease.generation + 1 } }, [sourceTask.id])).toBe(false);
    expect(f.runtime.inheritTaskSources(step, [sourceTask.id])).toBe(true);
    step.snapshot.sources = f.runtime.taskSources('owner', receiver.id, step.messageIds);
    const child = f.child('reader-child', receiver.id);
    expect(f.runtime.taskSources('owner', child.id)).toMatchObject([{ experienceId: 'source-experience' }]);
    f.runtime.commitStep(step, { disposition: 'wait', history: ['observed task projection'] });
    expect(f.runtime.history('owner', receiver.id)?.rounds[0]?.sources).toMatchObject([{ experienceId: 'source-experience' }]);
    expect(f.runtime.inheritTaskSources(step, [sourceTask.id])).toBe(false);
  });
});
