import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { taskTreeNodesProblem, type TaskFinishContract, type TaskNodeDraft } from '@shannon/mind';
import { SQLiteAgentTaskStore, type HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { taskTreeWiring } from '../src/wiring/taskTreeWiring.js';
import { taskTestCommandHash } from '../src/integrations/agentHost/codexTaskProjection.js';
import { ROOT_VALUE } from '@shannon/learning';
import { TaskTreeStore } from '../src/mind/action/agentTasks/store/taskTreeStore.js';

const at = '2026-10-08T03:00:00.000Z';
const lease = { id: 'action-one', holder: 'mind-owner', generation: 1 };
const temporary: string[] = [], stores: SQLiteAgentTaskStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function setup(path = ':memory:', enabled = true, callbacks?: ConstructorParameters<typeof SQLiteAgentTaskStore>[1]) {
  const store = new SQLiteAgentTaskStore(path, { taskTreeEnabled: enabled, ...callbacks }); stores.push(store);
  const task = store.create('owner', { taskId: 'task-one', idempotencyKey: 'create', conversationThreadID: 'talk-one',
    taskAuthority: { origin: 'owner_request', budgetLane: 'owner', ownerInformed: true, permissionId: 'task:task-one' },
    title: 'fix', goal: 'preserve history', summary: 'fix', plan: [{ id: 'leaf-one', title: 'verify', status: 'pending' }] }, at).task;
  return { store, task, trees: store.taskTrees! };
}
const contract: TaskFinishContract = { result: 'preserve history', checks: [{ id: 'test-one', kind: 'test', target: 'pnpm test' }],
  constraints: ['preserve history'], boundary: ['original task permission'], stop: ['owner stop'] };
function define(trees: ReturnType<typeof setup>['trees'], rootId: string) {
  const current = trees.get('owner', 'task-one')!;
  const nodes = current.nodes.map(node => ({ ...node, contract }));
  const proposal = trees.propose('owner', 'task-one', current.revision, { goal: current.goal, content: current.content, deadline: null, nodes }, at);
  return trees.approve('owner', 'task-one', proposal.id, current.revision, proposal.diffHash, at);
}
function event(type: HostAgentEvent['type'], payload: Record<string, unknown> = {}, eventId = `event-${type}`): HostAgentEvent {
  return { eventId, taskId: 'task-one', type, title: type, occurredAt: at, payload: { actionLease: lease, executionTurnId: 'turn-one', ...payload } };
}
function passedTest(id = 'host-test', command = 'pnpm test', turnId = 'turn-one') {
  return { id, name: command, status: 'passed', execution: { turnId, actionLease: lease, commandHash: taskTestCommandHash(command), exitCode: 0 } };
}
function claim(store: SQLiteAgentTaskStore) { const command = store.claim('host-one', at)!; store.bindActionLease(command.id, lease); return command; }

describe('task tree with the existing task queue and original execution', () => {
  it('rejects parent/dependency cycles, duplicate IDs and child boundary weakening', () => {
    const root: TaskNodeDraft = { id: 'root', parentId: null, order: 0, dependsOn: [], title: 'root', contract };
    const child = { ...root, id: 'child', parentId: 'root' };
    expect(taskTreeNodesProblem('root', [root, child])).toBeNull();
    expect(taskTreeNodesProblem('root', [root, { ...child, id: 'root' }])).toBe('TREE_SHAPE');
    expect(taskTreeNodesProblem('root', [root, { ...child, parentId: 'missing' }])).toBe('TREE_LINK');
    expect(taskTreeNodesProblem('root', [{ ...root, dependsOn: ['child'] }, child])).toBe('TREE_CYCLE');
    expect(taskTreeNodesProblem('root', [root, { ...child, contract: { ...contract, boundary: [] } }])).toBe('TREE_BOUNDARY');
    expect(taskTreeNodesProblem('root', [root, { ...child, grant: 'invented' } as TaskNodeDraft])).toBe('TREE_AUTHORITY');
  });
  it('uses durable CAS and exact owner approval for changed root conditions', () => {
    const { trees } = setup(); const current = trees.get('owner', 'task-one')!;
    const nodes = current.nodes.map(node => ({ ...node, contract }));
    expect(() => trees.replan('owner', 'task-one', current.revision, nodes, at)).toThrow('TREE_OWNER_CHANGE_REQUIRED');
    const proposal = trees.propose('owner', 'task-one', current.revision, { goal: current.goal, content: current.content, deadline: null, nodes }, at);
    expect(() => trees.approve('other-owner', 'task-one', proposal.id, current.revision, proposal.diffHash, at)).toThrow('TREE_PROPOSAL_NOT_FOUND');
    expect(() => trees.approve('owner', 'task-one', proposal.id, current.revision, 'different', at)).toThrow('TREE_STALE_APPROVAL');
    const next = trees.approve('owner', 'task-one', proposal.id, current.revision, proposal.diffHash, at);
    expect(next).toMatchObject({ origin: 'owner_request', budgetLane: 'owner', ownerInformed: true, permissionId: 'task:task-one', legacy: false });
    expect(() => trees.replan('owner', 'task-one', current.revision, nodes, at)).toThrow('TREE_CONFLICT');
    expect(() => trees.approve('owner', 'task-one', proposal.id, next.revision, proposal.diffHash, at)).toThrow('TREE_STALE_APPROVAL');
  });
  it('keeps grandfathered authorized queued/running/resume despite unknown completion conditions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-')); temporary.push(directory); const path = join(directory, 'db.sqlite');
    const original = setup(path, false); original.store.close();
    const migrated = new SQLiteAgentTaskStore(path, { taskTreeEnabled: true }); stores.push(migrated);
    expect(migrated.get('owner', 'task-one')?.taskTree).toMatchObject({ legacy: true, origin: 'unknown', budgetLane: 'unknown', permissionId: null,
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'leaf-one' })]) });
    const command = migrated.claim('host-one', at)!; expect(command.type).toBe('start'); migrated.bindActionLease(command.id, lease);
    migrated.recordHostEvents('host-one', [event('paused')], at);
    migrated.enqueue('owner', 'task-one', { idempotencyKey: 'resume', type: 'resume' }, at);
    expect(migrated.claim('host-one', at)?.type).toBe('resume');
    expect(migrated.taskTrees!.proofForTask('owner', 'task-one')).toBeNull();
  });
  it('preserves trusted self origin/lane and refuses mixed or forged authority, without deriving it from prose', () => {
    const { store, trees } = setup();
    const input = { taskId: 'self-task', idempotencyKey: 'self-create', conversationThreadID: 'talk-one', title: 'owner_request',
      goal: 'owner_requested words are not authority', summary: 'owner', taskAuthority: {
        origin: 'own_time' as const, budgetLane: 'autonomy' as const, ownerInformed: true, permissionId: 'proposal:original' } };
    store.create('owner', input, at);
    const current = trees.get('owner', 'self-task')!;
    expect(current).toMatchObject(input.taskAuthority);
    const proposal = trees.propose('owner', 'self-task', current.revision, { goal: current.goal, content: current.content, deadline: null,
      nodes: current.nodes.map(node => ({ ...node, contract })) }, at);
    expect(trees.approve('owner', 'self-task', proposal.id, current.revision, proposal.diffHash, at)).toMatchObject(input.taskAuthority);
    expect(() => store.create('owner', { ...input, taskId: 'forged', idempotencyKey: 'forged',
      taskAuthority: { ...input.taskAuthority, budgetLane: 'owner' } }, at)).toThrow('TREE_AUTHORITY');
    expect(store.get('owner', 'forged')).toBeNull();
    expect(() => trees.propose('owner', 'self-task', trees.get('owner', 'self-task')!.revision,
      { goal: current.goal, content: current.content, deadline: null, nodes: current.nodes, origin: 'owner_request' } as never, at)).toThrow('TREE_CHANGE_INVALID');
  });
  it('allows unknown legacy to run but never upgrades authority or creates trusted proof/callbacks', () => {
    const calls: string[] = [];
    const store = new SQLiteAgentTaskStore(':memory:', { taskTreeEnabled: true, taskTreeCallbacks: {
      taskDispatched: () => { calls.push('dispatch'); }, taskVerified: () => { calls.push('verified'); }, taskUnusable: () => {},
    } }); stores.push(store);
    store.create('owner', { taskId: 'task-one', idempotencyKey: 'unknown', conversationThreadID: 'talk-one', title: 'owner', goal: 'owner', summary: 'owner' }, at);
    define(store.taskTrees!, 'root:task-one'); claim(store);
    store.recordHostEvents('host-one', [event('completed', { tests: [passedTest()] })], at);
    expect(store.get('owner', 'task-one')!.status).toBe('completed');
    expect(store.taskTrees!.get('owner', 'task-one')).toMatchObject({ origin: 'unknown', budgetLane: 'unknown', permissionId: null });
    expect(store.taskTrees!.proofForTask('owner', 'task-one')).toBeNull(); expect(calls).toEqual([]);
  });
  it('does not reuse passed tests from a foreign turn, command or generation', () => {
    const { store, trees } = setup(); define(trees, 'root:task-one'); claim(store);
    store.recordHostEvents('host-one', [event('completed', { tests: [passedTest('foreign-turn', 'pnpm test', 'turn-other'),
      passedTest('foreign-command', 'pnpm other'), { ...passedTest('foreign-generation'), execution: { ...passedTest().execution, actionLease: { ...lease, generation: 2 } } }] })], at);
    expect(trees.proofForTask('owner', 'task-one')).toBeNull();
  });
  it('never derives done from completed prose, plan status, thumbs or unbound old task results', () => {
    const { store, trees } = setup(); define(trees, 'root:task-one'); claim(store);
    store.recordHostEvents('host-one', [event('progress', { plan: [{ id: 'leaf-one', title: 'verify', status: 'completed' }] }),
      event('completed', { thumb: 'up', summary: 'passed all tests' })], at);
    expect(store.get('owner', 'task-one')?.status).toBe('completed');
    expect(trees.get('owner', 'task-one')!.nodes.every(node => node.state === 'wait')).toBe(true);
    expect(trees.proofStatus('owner', 'task-one')).toEqual({ status: 'invalid' });
  });
  it('verifies whole current contract once from original canonical terminal plus actual command test facts', () => {
    const called: string[] = []; const { store, trees } = setup(':memory:', true, { taskTreeCallbacks: {
      taskDispatched: (_scope, input) => { called.push(`dispatch:${input.attemptId}`); },
      taskVerified: (_scope, proof) => { called.push(`verified:${proof.attemptId}`); }, taskUnusable: () => {},
    } });
    define(trees, 'root:task-one'); const command = claim(store);
    const completed = event('completed', { tests: [passedTest()] });
    store.recordHostEvents('host-one', [completed], at); const revision = trees.get('owner', 'task-one')!.revision;
    store.recordHostEvents('host-one', [completed], at);
    expect(trees.get('owner', 'task-one')!.revision).toBe(revision);
    expect(trees.proofForTask('owner', 'task-one')).toMatchObject({ status: 'verified', attemptId: command.id, threadId: 'talk-one', actionId: lease.id, generation: 1 });
    expect(called).toEqual([`dispatch:${command.id}`, `verified:${command.id}`]);
  });
  it('holds unknown and original mapping under reorder, blocks detach and new execution, accepts exact original late ACK', () => {
    const { store, trees } = setup(); define(trees, 'root:task-one'); const command = claim(store);
    store.recordHostEvents('host-one', [event('progress', { executionUncertain: true })], at);
    const unknown = trees.get('owner', 'task-one')!;
    trees.replan('owner', 'task-one', unknown.revision, unknown.nodes.map(node => ({ ...node, order: node.parentId ? 3 : 0 })), at);
    const current = trees.get('owner', 'task-one')!;
    expect(() => trees.replan('owner', 'task-one', current.revision, [current.nodes[0]!], at)).toThrow('TREE_ATTEMPT_HELD');
    store.enqueue('owner', 'task-one', { idempotencyKey: 'steer', type: 'steer', payload: { instruction: 'retry' } }, at);
    expect(store.claim('host-one', at)).toBeNull();
    store.recordHostEvents('host-one', [event('completed', { actionLease: { ...lease, generation: 2 }, tests: [passedTest()] }, 'foreign')], at);
    expect(trees.proofForTask('owner', 'task-one')).toBeNull();
    store.recordHostEvents('host-one', [event('completed', { tests: [passedTest()] }, 'late-original')], at);
    expect(trees.proofForTask('owner', 'task-one')?.attemptId).toBe(command.id);
  });
  it('invalidates proof after an exact owner-approved new contract, without paying completed history again', () => {
    const { store, trees } = setup(); define(trees, 'root:task-one'); claim(store);
    store.recordHostEvents('host-one', [event('completed', { tests: [passedTest()] })], at);
    const before = trees.get('owner', 'task-one')!;
    const changed = { ...contract, checks: [{ id: 'new-check', kind: 'test' as const, target: 'pnpm verify-new' }] };
    const proposal = trees.propose('owner', 'task-one', before.revision, { goal: before.goal, content: before.content, deadline: null,
      nodes: before.nodes.map(node => ({ ...node, contract: changed })) }, at);
    trees.approve('owner', 'task-one', proposal.id, before.revision, proposal.diffHash, at);
    expect(trees.proofStatus('owner', 'task-one')).toEqual({ status: 'invalid' });
    store.recordHostEvents('host-one', [event('completed', { tests: [{ id: 'new-check', name: 'pnpm verify-new', status: 'passed' }] }, 'stale-completed')], at);
    expect(trees.proofStatus('owner', 'task-one')).toEqual({ status: 'invalid' });
  });
  it('retains callback outbox across false ACK and restart, never invokes writers inside task transaction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-outbox-')); temporary.push(directory); const path = join(directory, 'db.sqlite');
    const original = setup(path, true, { taskTreeCallbacks: { taskDispatched: () => false, taskVerified: () => {}, taskUnusable: () => {} } });
    claim(original.store); original.store.close();
    const read = new DatabaseSync(path); expect(read.prepare('SELECT delivered FROM agent_task_tree_learning').get()).toEqual({ delivered: 0 }); read.close();
    let recovered = 0;
    const reopened = new SQLiteAgentTaskStore(path, { taskTreeEnabled: true, taskTreeCallbacks: {
      taskDispatched: () => { const connection = new DatabaseSync(path); connection.exec('BEGIN IMMEDIATE; ROLLBACK;'); connection.close(); recovered++; },
      taskVerified: () => {}, taskUnusable: () => {},
    } }); stores.push(reopened); reopened.taskTrees!.flushLearning(); expect(recovered).toBe(1);
  });
  it('projects only exact original pending action IDs across restart, without guessing a missing legacy dispatch ID', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-action-refs-')); temporary.push(directory); const path = join(directory, 'db.sqlite');
    const { store, trees } = setup(path, true, { taskTreeCallbacks: { taskDispatched: () => false, taskVerified: () => false, taskUnusable: () => false } });
    define(trees, trees.get('owner', 'task-one')!.rootId); const command = claim(store);
    store.recordHostEvents('host-one', [event('completed', { tests: [passedTest()] })], at);
    expect(trees.pendingLearningActions('owner')).toEqual([{ taskId: 'task-one', actionId: lease.id }, { taskId: 'task-one', actionId: lease.id }]);
    expect(trees.pendingLearningActions('other')).toEqual([]); store.close();
    const connection = new DatabaseSync(path); const read = new TaskTreeStore(connection, undefined, false);
    expect(read.pendingLearningActions('owner')).toHaveLength(2);
    const row = connection.prepare('SELECT event_json FROM agent_task_tree_learning WHERE id=?').get(`dispatch:${command.id}`) as { event_json: string };
    const legacy = JSON.parse(row.event_json) as Record<string, unknown>; delete legacy.actionId;
    connection.prepare('UPDATE agent_task_tree_learning SET event_json=? WHERE id=?').run(JSON.stringify(legacy), `dispatch:${command.id}`);
    expect(read.pendingLearningActions('owner')).toEqual([{ taskId: 'task-one', actionId: lease.id }]);
    connection.close();
  });
  it('reads the same first 128 undelivered outbox rows as flush, excluding delivered and later actions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-action-window-')); temporary.push(directory); const path = join(directory, 'db.sqlite');
    const { store } = setup(path); store.close(); const connection = new DatabaseSync(path);
    const insert = connection.prepare('INSERT INTO agent_task_tree_learning VALUES(?,?,?)');
    insert.run('already-delivered', JSON.stringify({ kind: 'dispatched', scopeKey: 'owner', taskId: 'old', actionId: 'old' }), 1);
    for (let index = 0; index < 130; index++) insert.run(`pending-${index}`, JSON.stringify({ kind: 'dispatched', scopeKey: 'owner', taskId: `task-${index}`, actionId: `action-${index}` }), 0);
    const read = new TaskTreeStore(connection, undefined, false), pending = read.pendingLearningActions('owner');
    expect(pending).toHaveLength(128); expect(pending[0]).toEqual({ taskId: 'task-0', actionId: 'action-0' });
    expect(pending[127]).toEqual({ taskId: 'task-127', actionId: 'action-127' }); connection.close();
  });
  it('freezes original value/audience in the durable dispatch event and never replaces it on retries', () => {
    const original = { presence: 'alone' as const, value: { ...ROOT_VALUE, version: 'value-original', mean: .2 } };
    let snapshot = original, reads = 0; const delivered: unknown[] = [];
    const { store, trees } = setup(':memory:', true, { taskTreeCallbacks: {
      dispatchContext: () => { reads++; return snapshot; }, taskDispatched: (_scope, input) => { delivered.push(input.expectation); return false; },
      taskVerified: () => {}, taskUnusable: () => {},
    } });
    const command = claim(store); snapshot = { ...original, value: { ...ROOT_VALUE, version: 'value-later', mean: .8 } };
    store.bindActionLease(command.id, lease); trees.flushLearning();
    expect(reads).toBe(1); expect(delivered).toEqual([original, original, original]);
  });
  it('records unavailable dispatch expectation without blocking existing execution or borrowing later value', () => {
    const seen: unknown[] = [];
    const { store } = setup(':memory:', true, { taskTreeCallbacks: {
      dispatchContext: () => { throw new Error('read_unavailable'); }, taskDispatched: (_scope, input) => { seen.push(input.expectation); },
      taskVerified: () => {}, taskUnusable: () => {},
    } });
    expect(claim(store).type).toBe('start'); expect(seen).toEqual([{ presence: 'unknown', value: null }]);
  });
  it('recovers an exact proposal operation after lost response/restart, rejects changed content and reads proof without migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-operation-')); temporary.push(directory); const path = join(directory, 'db.sqlite');
    const first = setup(path), tree = first.trees.get('owner', 'task-one')!;
    const change = { goal: 'new root', content: 'exact new content', deadline: null, nodes: tree.nodes.map(node => ({ ...node, contract })) };
    const proposal = first.trees.propose('owner', 'task-one', tree.revision, change, at, 'owner-operation'); first.store.close();
    const reopened = new SQLiteAgentTaskStore(path, { taskTreeEnabled: true }); stores.push(reopened);
    expect(reopened.taskTrees!.propose('owner', 'task-one', tree.revision, change, at, 'owner-operation')).toEqual(proposal);
    expect(() => reopened.taskTrees!.propose('owner', 'task-one', tree.revision, { ...change, content: 'different' }, at, 'owner-operation')).toThrow('TREE_OPERATION_CONFLICT');
    expect(reopened.taskTrees!.proposals('owner', 'task-one')).toEqual([proposal]);
    reopened.taskTrees!.approve('owner', 'task-one', proposal.id, tree.revision, proposal.diffHash, at);
    expect(reopened.claim('host-one', at)!.payload.goal).toBe(change.content);
    const read = new DatabaseSync(path, { readOnly: true });
    try { const projection = new TaskTreeStore(read, undefined, false); expect(projection.get('owner', 'task-one')!.goal).toBe('new root'); expect(projection.proofStatus('owner', 'task-one')).toEqual({ status: 'invalid' }); }
    finally { read.close(); }
  });
  it('keeps Stage5 OFF task JSON and schema free of new planning effects; owner-only tree route uses CAS', () => {
    const { store } = setup(':memory:', false); expect(store.get('owner', 'task-one')).not.toHaveProperty('taskTree');
    const on = setup(); const route = taskTreeWiring(on.store, 'owner', () => at).route;
    expect(route({ method: 'GET', path: '/v1/agent/tasks/task-one/tree', query: new URLSearchParams({ scopeKey: 'other' }) })?.status).toBe(403);
    const body = { scopeKey: 'owner', expectedRevision: 999, nodes: on.trees.get('owner', 'task-one')!.nodes };
    expect(route({ method: 'POST', path: '/v1/agent/tasks/task-one/tree/replan', body })?.status).toBe(409);
  });
});
