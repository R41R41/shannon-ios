import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskTree, TaskTreeOwnerChange, TaskTreeProposal } from '../src/mind/action/agentTasks/taskTreePorts.js';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { configuredAutonomy } from '../src/mind/inhibition/inhibitionPorts.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { configuredServerStage5 } from '../src/wiring/serverStage5Wiring.js';
import { taskTestCommandHash } from '../src/integrations/agentHost/codexTaskProjection.js';

const upper = 'ABCDEF01-2345-6789-ABCD-EF0123456789', lower = upper.toLowerCase();
const mixed = 'AbCdEf01-2345-6789-aBcD-eF0123456789';
const now = () => '2026-10-08T15:00:00.000Z';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
function create(tasks: SQLiteAgentTaskStore, id: string, scope = 'owner', trusted = false) {
  return tasks.create(scope, { taskId: id, idempotencyKey: `create:${id}`, conversationThreadID: 'original-thread',
    title: 'original task', goal: 'preserve original work', summary: 'original',
    ...(trusted ? { taskAuthority: { origin: 'owner_request' as const, budgetLane: 'owner' as const, ownerInformed: true, permissionId: `original:${id}` } } : {}),
    plan: [{ id: 'original-leaf', title: 'verify', status: 'pending' }] }, now()).task;
}
function fixture(legacy = true, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-tree-uuid-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.sqlite');
  if (legacy) { const before = new SQLiteAgentTaskStore(path); create(before, upper); before.close(); }
  const store = new SQLiteShannonStore({ path, now }); cleanups.push(() => store.close());
  const autonomyStore = createAutonomyStore(path); cleanups.push(() => autonomyStore.close());
  const config = configuredAutonomy({});
  const autonomy = createInMemoryAutonomyService(now, { store: autonomyStore, config });
  let server: ReturnType<typeof configuredServerStage5>;
  let alone: boolean | 'throws' = true, audienceRule: (() => boolean) | null = null;
  function open() {
    server = configuredServerStage5(enabled ? { SHANNON_ADR8_STAGE5: 'on' } : {}, { path, store, ownerScope: 'owner', now });
    server.attach({ ownerAlone: () => { if (audienceRule) return audienceRule(); if (alone === 'throws') throw new Error('unreadable audience'); return alone; }, actions: null, autonomy, autonomyStore, config });
  }
  open(); cleanups.push(() => server.close());
  const db = new DatabaseSync(path); cleanups.push(() => db.close());
  async function request(id: string, suffix = '', body?: Record<string, unknown>, principal = 'owner', duringBody?: () => void) {
    const request = Readable.from((async function* () { duringBody?.(); if (body) yield JSON.stringify(body); })()) as unknown as IncomingMessage;
    request.method = body ? 'POST' : 'GET';
    let status = 0, responseBody = '';
    const response = { writeHead(code: number) { status = code; }, end(value: string) { responseBody = value; } } as unknown as ServerResponse;
    const url = new URL(`http://isolated/v1/agent/tasks/${id}/tree${suffix}`);
    expect(await server.serve(request, response, { scopeKey: principal }, url)).toBe(true);
    return { status, body: JSON.parse(responseBody) as { error?: string; tree?: TaskTree; proposals?: TaskTreeProposal[]; proposal?: TaskTreeProposal; verification?: { status: string; evidenceIds?: readonly string[] } } };
  }
  return { path, db, request, tasks: () => server.tasks, audience: (value: typeof alone) => { alone = value; },
    audienceRule: (rule: (() => boolean) | null) => { audienceRule = rule; },
    reopen: () => { server.close(); open(); } };
}
function change(tree: TaskTree): TaskTreeOwnerChange {
  return { goal: tree.goal, content: tree.content, deadline: tree.deadline,
    nodes: tree.nodes.map(node => ({ ...node, contract: { result: 'preserve original work', checks: [{ id: 'check', kind: 'test', target: 'pnpm test' }],
      constraints: ['preserve original work'], boundary: ['original permission'], stop: ['owner stop'] } })) };
}
function fingerprint(db: DatabaseSync) {
  const tables = ['agent_tasks', 'agent_task_commands', 'agent_task_events', 'agent_task_trees', 'agent_task_tree_versions',
    'agent_task_tree_proposals', 'agent_task_tree_proposal_ops', 'agent_task_tree_attempts', 'agent_task_tree_receipts', 'agent_task_tree_learning'];
  return createHash('sha256').update(JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).digest('hex');
}

describe('owner task UUID spelling through the production Stage5 facade', () => {
  it('reads every UUID spelling of a migrated uppercase task without changing its original IDs or rows', async () => {
    const run = fixture(); const before = fingerprint(run.db);
    const canonical = run.tasks().taskTrees!.get('owner', upper)!;
    expect(canonical).toMatchObject({ taskId: upper, rootId: `root:${upper}`, legacy: true, origin: 'unknown' });
    for (const id of [lower, upper, mixed]) {
      const result = await run.request(id); expect(result.status).toBe(200);
      expect(result.body.tree).toEqual({ ...canonical, taskId: id });
      expect(result.body.verification).toEqual({ status: 'invalid' });
      expect((await run.request(id, '/proposals')).body.proposals).toEqual([]);
    }
    expect(run.tasks().get('owner', lower)).toBeNull(); // Internal task/proof lookup remains binary/original.
    expect(run.tasks().taskTrees!.get('owner', lower)).toBeNull();
    expect(fingerprint(run.db)).toBe(before);
  });

  it('uses one original proposal receipt across aliases/restart/approval, while preserving CAS and diff hashes', async () => {
    const run = fixture(); const tree = (await run.request(lower)).body.tree!, draft = change(tree);
    const body = { expectedRevision: tree.revision, change: draft, operationId: 'original-operation' };
    const created = await run.request(lower, '/proposals', body); expect(created.status).toBe(201);
    const proposal = created.body.proposal!; expect(proposal.taskId).toBe(lower);
    const saved = run.tasks().taskTrees!.proposals('owner', upper)[0]!;
    expect(saved).toEqual({ ...proposal, taskId: upper });
    run.reopen();
    const retry = await run.request(mixed, '/proposals', body);
    expect(retry.body.proposal).toEqual({ ...proposal, taskId: mixed });
    const conflict = await run.request(lower, '/proposals', { ...body, change: { ...draft, content: 'different' } });
    expect(conflict).toMatchObject({ status: 409, body: { error: 'TREE_OPERATION_CONFLICT', tree: { taskId: lower, revision: tree.revision } } });
    const approval = { expectedRevision: proposal.expectedRevision, proposalId: proposal.id, diffHash: proposal.diffHash };
    expect((await run.request(lower, '/approve', { ...approval, diffHash: 'foreign' })).body.error).toBe('TREE_STALE_APPROVAL');
    const approved = await run.request(lower, '/approve', approval); expect(approved.status).toBe(200);
    expect(approved.body.tree).toMatchObject({ taskId: lower, rootId: tree.rootId, legacy: false, revision: tree.revision + 1 });
    expect((await run.request(mixed, '/proposals')).body.proposals).toEqual([{ ...proposal, taskId: mixed, state: 'approved' }]);
    expect((await run.request(upper, '/proposals', body)).body.proposal).toEqual({ ...proposal, taskId: upper, state: 'approved' });
    const stale = await run.request(lower, '/replan', { expectedRevision: tree.revision, nodes: draft.nodes });
    expect(stale).toMatchObject({ status: 409, body: { error: 'TREE_CONFLICT', tree: { taskId: lower, revision: tree.revision + 1 } } });
    expect((await run.request(lower, '/approve', { ...approval, expectedRevision: tree.revision + 1 })).body.error).toBe('TREE_STALE_APPROVAL');
    const replanned = await run.request(mixed, '/replan', { expectedRevision: tree.revision + 1, nodes: draft.nodes.map(node => ({ ...node, order: node.parentId ? 3 : 0 })) });
    expect(replanned.status).toBe(200); expect(replanned.body.tree?.taskId).toBe(mixed);
    expect(run.db.prepare('SELECT task_id,operation_id,proposal_id FROM agent_task_tree_proposal_ops').all()).toEqual([{ task_id: upper, operation_id: 'original-operation', proposal_id: proposal.id }]);
    for (const table of ['agent_tasks', 'agent_task_commands', 'agent_task_trees', 'agent_task_tree_versions', 'agent_task_tree_proposals', 'agent_task_tree_proposal_ops']) {
      expect(run.db.prepare(`SELECT DISTINCT task_id FROM ${table}`).all()).toEqual([{ task_id: upper }]);
    }
    expect(run.tasks().taskTrees!.get('owner', upper)?.rootId).toBe(tree.rootId);
    expect(run.tasks().taskTrees!.proposals('owner', upper)[0]?.diffHash).toBe(proposal.diffHash);
  });

  it('fails closed for same-scope UUID collisions including exact spellings, without writing any task rows', async () => {
    const run = fixture();
    const beforeTreeMigration = new SQLiteAgentTaskStore(run.path); create(beforeTreeMigration, lower); beforeTreeMigration.close();
    expect(run.tasks().taskTrees!.get('owner', lower)).toBeNull(); // A second original task counts even before its tree exists.
    const before = fingerprint(run.db);
    for (const id of [lower, upper, mixed]) {
      for (const [suffix, body] of [['', undefined], ['/proposals', undefined], ['/proposals', { expectedRevision: 1, change: {}, operationId: 'collision' }],
        ['/approve', { expectedRevision: 1, proposalId: 'original', diffHash: 'original' }], ['/replan', { expectedRevision: 1, nodes: [] }]] as const) {
        const result = await run.request(id, suffix, body); expect(result.status).toBe(404); expect(result.body.tree).toBeNull();
      }
    }
    expect(fingerprint(run.db)).toBe(before);
  });

  it('does not resolve another scope or case-fold opaque non-UUID IDs', async () => {
    const run = fixture(); create(run.tasks(), lower, 'another-owner');
    expect((await run.request(lower)).status).toBe(200); // Other-scope alias cannot create an owner ambiguity.
    expect((await run.request(lower, '', undefined, 'another-owner')).status).toBe(403);
    const foreign = '01234567-ABCD-ABCD-ABCD-0123456789AB'; create(run.tasks(), foreign, 'another-owner');
    expect((await run.request(foreign.toLowerCase())).status).toBe(404);
    for (const id of ['Opaque-ID', 'opaque-id', `${upper}-suffix`]) create(run.tasks(), id);
    expect((await run.request('Opaque-ID')).body.tree?.taskId).toBe('Opaque-ID');
    expect((await run.request('opaque-id')).body.tree?.taskId).toBe('opaque-id');
    expect((await run.request('OPAQUE-ID')).status).toBe(404);
    expect((await run.request(`${lower}-suffix`)).status).toBe(404);
  });

  it('keeps original Host/attempt/lease/learning proof exact while projecting only public taskId', async () => {
    const run = fixture(false); create(run.tasks(), upper, 'owner', true);
    const tree = (await run.request(lower)).body.tree!, draft = change(tree);
    const proposal = (await run.request(lower, '/proposals', { expectedRevision: tree.revision, change: draft })).body.proposal!;
    expect((await run.request(lower, '/approve', { expectedRevision: tree.revision, proposalId: proposal.id, diffHash: proposal.diffHash })).status).toBe(200);
    const command = run.tasks().claim('original-host', now())!, lease = { id: 'original-action', holder: 'original-holder', generation: 7 };
    run.tasks().bindActionLease(command.id, lease);
    expect(command.taskId).toBe(upper);
    const active = (await run.request(lower)).body.tree!;
    expect(active.nodes.every(node => node.attemptId === command.id)).toBe(true);
    expect((await run.request(lower, '/proposals', { expectedRevision: active.revision, change: change(active) })).body.error).toBe('TREE_ATTEMPT_HELD');
    run.tasks().recordHostEvents('original-host', [{ eventId: 'original-terminal', taskId: upper, type: 'completed', title: 'original', occurredAt: now(),
      payload: { actionLease: lease, executionTurnId: 'original-turn', tests: [{ id: 'original-test', name: 'pnpm test', status: 'passed',
        execution: { turnId: 'original-turn', actionLease: lease, commandHash: taskTestCommandHash('pnpm test'), exitCode: 0 } }] } }], now());
    const before = fingerprint(run.db), proof = run.tasks().taskTrees!.proofForTask('owner', upper)!;
    expect(proof).toMatchObject({ taskId: upper, nodeId: tree.rootId, attemptId: command.id, actionId: lease.id, holder: lease.holder, generation: 7, status: 'verified' });
    expect(run.tasks().taskTrees!.proofForTask('owner', lower)).toBeNull();
    for (const id of [lower, upper, mixed]) {
      const result = await run.request(id);
      expect(result.body.verification).toEqual({ status: 'verified', evidenceIds: proof.evidenceIds });
      expect(result.body.tree?.taskId).toBe(id); expect(result.body.tree?.rootId).toBe(tree.rootId);
      expect(result.body.tree?.nodes.every(node => node.attemptId === command.id)).toBe(true);
    }
    expect(run.tasks().taskTrees!.proofForTask('owner', upper)).toEqual(proof); expect(fingerprint(run.db)).toBe(before);
  });

  it('keeps current owner-alone checks before body/mutation and fails closed on unreadable audience; OFF remains disabled', async () => {
    const run = fixture(); const tree = (await run.request(lower)).body.tree!, before = fingerprint(run.db);
    for (const audience of [false, 'throws'] as const) { run.audience(audience); expect((await run.request(lower)).status).toBe(403); }
    run.audience(true);
    const blocked = await run.request(lower, '/proposals', { expectedRevision: tree.revision, change: change(tree) }, 'owner', () => run.audience(false));
    expect(blocked.status).toBe(403); expect(fingerprint(run.db)).toBe(before);
    run.audience(true);
    let afterBodyReads = 0;
    const uncertain = await run.request(lower, '/proposals', { expectedRevision: tree.revision, change: change(tree), operationId: 'original-private-operation' }, 'owner',
      () => run.audienceRule(() => ++afterBodyReads === 1));
    expect(uncertain).toEqual({ status: 403, body: { error: 'STAGE5_OWNER_ALONE_REQUIRED' } });
    run.audienceRule(null);
    const receipt = (await run.request(lower, '/proposals')).body.proposals!;
    expect(receipt).toHaveLength(1); expect(receipt[0]).toMatchObject({ taskId: lower, operationId: 'original-private-operation' });
    const off = fixture(true, false); expect((await off.request(lower)).status).toBe(503);
    expect(off.tasks().taskTrees).toBeUndefined();
    expect(off.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'agent_task_tree%'").all()).toEqual([]);
  });

  it('holds the owner ID resolution transaction against competing insertion and rolls back a failed operation', () => {
    const run = fixture(), other = new DatabaseSync(run.path); other.exec('PRAGMA busy_timeout=1');
    try {
      const before = fingerprint(run.db), trees = run.tasks().taskTrees!;
      expect(() => trees.withRequestTaskId('owner', lower, canonical => {
        expect(canonical).toBe(upper);
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/u);
        const tree = trees.get('owner', canonical)!;
        trees.propose('owner', canonical, tree.revision, change(tree), now(), 'rolled-back-operation');
        throw new Error('route aborted');
      })).toThrow('route aborted');
      expect(fingerprint(run.db)).toBe(before);
      other.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } finally { other.close(); }
  });
});
