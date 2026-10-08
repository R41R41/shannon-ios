import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRequest, ApiResponse } from '../src/contracts/contracts.js';
import { SQLiteAgentTaskStore, type AgentTask, type ClaimedAgentCommand } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';

const lower = 'abcdef01-2345-6789-abcd-ef0123456789', upper = lower.toUpperCase();
const mixed = 'AbCdEf01-2345-6789-aBcD-eF0123456789';
const now = () => '2026-10-08T16:00:00.000Z';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
function fixture(enabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-agent-uuid-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.sqlite');
  let tasks: SQLiteAgentTaskStore, api: ReturnType<typeof createLocalApiKernel>;
  function open() {
    tasks = new SQLiteAgentTaskStore(path, { taskTreeEnabled: enabled });
    api = createLocalApiKernel(now, { agentTasks: tasks, chatModel: { mode: 'openai', model: 'unused', generate: async () => { throw new Error('model must not run'); } } });
  }
  open(); cleanups.push(() => tasks.close());
  const db = new DatabaseSync(path); cleanups.push(() => db.close());
  const request = (value: ApiRequest): Promise<ApiResponse> => api.dispatch(value);
  const get = (id: string, scope = 'owner', afterSequence?: number) => request({ method: 'GET', path: `/v1/agent/tasks/${id}`,
    query: new URLSearchParams({ scopeKey: scope, ...(afterSequence === undefined ? {} : { afterSequence: String(afterSequence) }) }) });
  const post = (id: string, suffix: 'commands' | 'metadata', body: Record<string, unknown>, scope = 'owner') => request({ method: 'POST',
    path: `/v1/agent/tasks/${id}/${suffix}`, body: { scopeKey: scope, ...body } });
  async function create(id = lower, scope = 'owner') {
    const result = await request({ method: 'POST', path: '/v1/agent/tasks', body: { scopeKey: scope, taskId: id, idempotencyKey: `create:${id}`,
      conversationThreadID: 'original-thread', title: 'original', goal: 'preserve original work', summary: 'original',
      plan: [{ id: 'original-node', title: 'verify original work', status: 'pending' }] } });
    expect(result.status).toBe(201); return (result.body as { task: AgentTask }).task;
  }
  return { path, db, get, post, create, request, tasks: () => tasks, reopen: () => { tasks.close(); open(); } };
}
function digest(db: DatabaseSync, includeTreeOnly = false) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const contents = tables.filter(row => !includeTreeOnly || row.name.startsWith('agent_task_tree'))
    .map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]);
  return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}
function command(response: ApiResponse) { return (response.body as { command: ClaimedAgentCommand }).command; }

describe('existing owner task API UUID aliases with original SQLite identities', () => {
  it.each([false, true])('reads a lowercase original through Foundation uppercase UUID, preserving polling and Stage5=%s', async enabled => {
    const run = fixture(enabled), original = await run.create(), before = digest(run.db);
    for (const id of [upper, lower, mixed]) {
      expect(await run.get(id)).toMatchObject({ status: 200, body: { task: { id: lower, latestSequence: original.latestSequence } } });
      expect(await run.get(id, 'owner', original.latestSequence)).toEqual({ status: 304, body: null });
      expect((await run.get(id, 'owner', original.latestSequence - 1)).status).toBe(200);
    }
    expect(run.tasks().get('owner', upper)).toBeNull(); // The raw store is never made case-insensitive.
    expect(digest(run.db)).toBe(before);
    if (!enabled) expect(run.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'agent_task_tree%'").all()).toEqual([]);
  });

  it('deduplicates pause/resume and preserved command receipts across request spelling and restart while OFF', async () => {
    const run = fixture(); await run.create();
    const pause = { idempotencyKey: 'original-pause', type: 'interrupt' };
    const first = await run.post(upper, 'commands', pause); expect(first).toMatchObject({ status: 202, body: { created: true, task: { id: lower, status: 'paused' } } });
    const originalCommand = command(first), beforeRetry = digest(run.db);
    expect(originalCommand.taskId).toBe(lower);
    expect(await run.post(mixed, 'commands', pause)).toMatchObject({ status: 200, body: { created: false, command: { id: originalCommand.id, taskId: lower } } });
    expect(digest(run.db)).toBe(beforeRetry);
    run.reopen();
    expect(await run.post(lower, 'commands', pause)).toMatchObject({ status: 200, body: { created: false, command: { id: originalCommand.id, taskId: lower } } });
    const resume = { idempotencyKey: 'original-resume', type: 'resume' };
    const resumed = await run.post(mixed, 'commands', resume); expect(resumed).toMatchObject({ status: 202, body: { task: { id: lower, status: 'queued' } } });
    expect(await run.post(upper, 'commands', resume)).toMatchObject({ status: 200, body: { created: false, command: { id: command(resumed).id, taskId: lower } } });
    expect(run.db.prepare('SELECT DISTINCT task_id FROM agent_task_commands').all()).toEqual([{ task_id: lower }]);
    expect(run.db.prepare('SELECT COUNT(*) AS count FROM agent_task_commands').get()).toEqual({ count: 3 });
    expect(run.tasks().claim('original-host', now())?.taskId).toBe(lower);
    expect(run.tasks().taskTrees).toBeUndefined();
  });

  it('preserves original approval request, Host ID, action lease and attempts while generic aliases operate', async () => {
    const run = fixture(true); await run.create();
    const start = run.tasks().claim('original-host', now())!, lease = { id: 'original-action', holder: 'original-holder', generation: 5 };
    run.tasks().bindActionLease(start.id, lease);
    const treeBefore = digest(run.db, true);
    expect((await run.post(upper, 'metadata', { isPinned: true })).status).toBe(200);
    expect(digest(run.db, true)).toBe(treeBefore);
    const payload = { actionLease: lease, executionTurnId: 'original-turn', approval: { externalRequestID: 'Original-Approval-ID', kind: 'network', title: 'permission', reason: 'original' } };
    run.tasks().recordHostEvents('original-host', [{ eventId: 'original-approval-event', taskId: lower, type: 'approval_requested', title: 'permission', occurredAt: now(), payload }], now());
    const beforeWrong = digest(run.db);
    expect(await run.post(upper, 'commands', { idempotencyKey: 'wrong-approval', type: 'resolve_approval', payload: { decision: 'allow_once', externalRequestID: 'original-approval-id' } }))
      .toMatchObject({ status: 409, body: { error: 'AGENT_COMMAND_STALE_APPROVAL' } });
    expect(digest(run.db)).toBe(beforeWrong);
    const approval = { idempotencyKey: 'original-approval-operation', type: 'resolve_approval', payload: { decision: 'allow_once', externalRequestID: 'Original-Approval-ID' } };
    const accepted = await run.post(upper, 'commands', approval); expect(accepted.status).toBe(202);
    const repeated = await run.post(mixed, 'commands', approval); expect(repeated.status).toBe(200); expect(command(repeated)).toEqual(command(accepted));
    expect(command(accepted)).toMatchObject({ taskId: lower, payload: { externalRequestID: 'Original-Approval-ID' } });
    const attempts = run.db.prepare('SELECT task_id,attempt_id,command_id,attempt_json FROM agent_task_tree_attempts').all() as { task_id: string; attempt_id: string; command_id: string; attempt_json: string }[];
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ task_id: lower, attempt_id: start.id, command_id: start.id });
    expect(JSON.parse(attempts[0]!.attempt_json)).toMatchObject({ taskId: lower, lease });
    const ignored = run.tasks().recordHostEvents('original-host', [{ eventId: 'wrong-case-host-event', taskId: upper, type: 'completed', title: 'foreign alias is not an ACK', occurredAt: now(), payload: { actionLease: lease } }], now());
    expect(ignored).toEqual([]); // Only owner HTTP references are aliases; Host acknowledgement identity remains exact.
    run.tasks().recordHostEvents('original-host', [{ eventId: 'original-completed', taskId: lower, type: 'completed', title: 'original result', occurredAt: now(), payload: { actionLease: lease, executionTurnId: 'original-turn' } }], now());
    expect((await run.get(upper)).body).toMatchObject({ task: { id: lower, status: 'completed', taskTree: { taskId: lower, rootId: `root:${lower}` } } });
    expect(run.tasks().taskTrees!.proofForTask('owner', lower)).toBeNull(); // No fabricated completion checks.
    expect((await run.post(upper, 'metadata', { isArchived: true })).status).toBe(200);
    expect(run.db.prepare('SELECT DISTINCT task_id FROM agent_task_tree_receipts').all()).toEqual([{ task_id: lower }]);
    expect(run.db.prepare('SELECT DISTINCT task_id FROM agent_task_commands').all()).toEqual([{ task_id: lower }]);
  });

  it('keeps pin/archive guards and idempotent metadata on the original row across aliases', async () => {
    const run = fixture(); await run.create(); const before = digest(run.db);
    expect(await run.post(upper, 'metadata', { isArchived: true })).toMatchObject({ status: 409, body: { error: 'AGENT_TASK_ARCHIVE_ACTIVE' } });
    expect(digest(run.db)).toBe(before);
    expect(await run.post(upper, 'metadata', { isPinned: true })).toMatchObject({ status: 200, body: { task: { id: lower, isPinned: true, isArchived: false } } });
    const pinned = digest(run.db);
    expect((await run.post(mixed, 'metadata', { isPinned: true })).status).toBe(200); expect(digest(run.db)).toBe(pinned);
    expect((await run.post(mixed, 'commands', { idempotencyKey: 'original-cancel', type: 'interrupt', payload: { cancel: true } })).status).toBe(202);
    expect(await run.post(upper, 'metadata', { isPinned: false, isArchived: true })).toMatchObject({ status: 200, body: { task: { id: lower, isPinned: false, isArchived: true, status: 'cancelled' } } });
    run.reopen(); expect((await run.get(mixed)).body).toMatchObject({ task: { id: lower, isArchived: true } });
  });

  it('rejects same-scope UUID ambiguity including exact matches for reads/commands/metadata, but ignores another scope', async () => {
    const run = fixture(); await run.create(); await run.create(upper, 'another-owner');
    expect((await run.get(upper)).body).toMatchObject({ task: { id: lower } });
    expect((await run.get(lower, 'absent-owner')).status).toBe(404);
    expect((await run.post(upper, 'commands', { idempotencyKey: 'foreign', type: 'interrupt' }, 'absent-owner')).status).toBe(404);
    expect((await run.post(upper, 'metadata', { isPinned: true }, 'absent-owner')).status).toBe(404);
    const anotherId = '01234567-abcd-abcd-abcd-0123456789ab'; await run.create(anotherId, 'another-owner');
    expect((await run.get(anotherId.toUpperCase())).status).toBe(404);
    await run.create(mixed); const before = digest(run.db);
    for (const id of [lower, upper, mixed]) {
      expect((await run.get(id)).status).toBe(404);
      expect((await run.post(id, 'commands', { idempotencyKey: 'collision', type: 'interrupt' })).status).toBe(404);
      expect((await run.post(id, 'metadata', { isPinned: true })).status).toBe(404);
    }
    expect(digest(run.db)).toBe(before);
  });

  it('keeps non-UUID IDs binary exact, including same-scope opaque case variants', async () => {
    const run = fixture(); await run.create('Opaque-ID'); await run.create('opaque-id');
    expect((await run.get('OPAQUE-ID')).status).toBe(404);
    expect((await run.post('OPAQUE-ID', 'metadata', { isPinned: true })).status).toBe(404);
    expect((await run.post('Opaque-ID', 'metadata', { isPinned: true })).status).toBe(200);
    expect(run.tasks().get('owner', 'Opaque-ID')?.isPinned).toBe(true); expect(run.tasks().get('owner', 'opaque-id')?.isPinned).toBe(false);
    expect((await run.post('opaque-id', 'commands', { idempotencyKey: 'opaque-pause', type: 'interrupt' })).status).toBe(202);
    expect(run.tasks().get('owner', 'opaque-id')?.status).toBe('paused'); expect(run.tasks().get('owner', 'Opaque-ID')?.status).toBe('queued');
    await run.create(`${upper}-suffix`); expect((await run.get(`${lower}-suffix`)).status).toBe(404);
  });

  it('keeps resolution and nested command/metadata writes atomic against a competing connection and rolls back together', async () => {
    const run = fixture(); await run.create(); const before = digest(run.db), other = new DatabaseSync(run.path); other.exec('PRAGMA busy_timeout=1');
    try {
      expect(() => run.tasks().withRequestTaskId('owner', upper, canonical => {
        expect(canonical).toBe(lower); expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/u);
        run.tasks().enqueue('owner', canonical, { idempotencyKey: 'rollback-pause', type: 'interrupt' }, now());
        run.tasks().updateMetadata('owner', canonical, { isPinned: true }, now());
        throw new Error('owner route failed');
      })).toThrow('owner route failed');
      expect(digest(run.db)).toBe(before); other.exec('BEGIN IMMEDIATE; ROLLBACK;');
      expect((await run.post(upper, 'commands', { idempotencyKey: 'rollback-pause', type: 'interrupt' })).status).toBe(202);
    } finally { other.close(); }
  });
});
