import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';

const scope = 'owner';
const hostId = 'mac';
const at = '2026-10-09T00:00:00.000Z';
const later = '2026-10-09T00:10:00.000Z';
let directory: string;
let path: string;
let host: SQLiteAgentTaskStore;
let db: DatabaseSync;
let authority: SQLiteFcaTaskAuthority;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shannon-fca-host-'));
  path = join(directory, 'tasks.sqlite');
  // The legacy store may already be running before the FCA schema is opened.
  host = new SQLiteAgentTaskStore(path);
  db = new DatabaseSync(path);
  authority = new SQLiteFcaTaskAuthority(db);
});
afterEach(() => { host.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

function fca(id: string, parentId: string | null = null) {
  return authority.transaction(() => authority.create({
    id, scopeKey: scope, parentId, kind: parentId ? 'generic' : 'root', origin: 'owner_request',
    title: id, goal: `${id} goal`, completionCriteria: 'Result recorded', status: 'queued',
    pauseReason: null, summary: 'FCA accepted', createdAt: at, requestKey: `fca:${id}`,
  }));
}
function legacy(key = 'host-task') {
  return host.create(scope, {
    idempotencyKey: key, conversationThreadID: 'conversation', title: key, goal: 'Host work',
    summary: 'Host accepted', hostHint: hostId,
  }, at).task;
}
function heartbeat(time = at) {
  host.heartbeat({ hostId, displayName: 'Mac', kind: 'local', capabilities: [], projects: [], models: [] }, time);
}
function snapshot(id: string) {
  return {
    task: db.prepare('SELECT * FROM agent_tasks WHERE task_id=?').get(id),
    events: db.prepare('SELECT * FROM agent_task_events WHERE task_id=? ORDER BY sequence').all(id),
    commands: db.prepare('SELECT * FROM agent_task_commands WHERE task_id=? ORDER BY sequence').all(id),
  };
}
function unexpectedCommand(id: string, taskId: string, leased = false) {
  db.prepare(`INSERT INTO agent_task_commands
    (command_id,task_id,scope_key,idempotency_key,command_type,payload_json,status,available_at,
      attempts,created_at,lease_owner,lease_until)
    VALUES(?,?,?,?,'start','{}',?,?,?, ?,?,?)`).run(id, taskId, scope, id,
      leased ? 'leased' : 'pending', at, leased ? 1 : 0, at, leased ? hostId : null, leased ? at : null);
}

describe('FCA tasks retain their canonical authority across legacy Host paths', () => {
  it('keeps canonical views readable without constructing Host task trees or commands on reopen', () => {
    const existing = legacy();
    const root = fca('fca-root');
    const child = fca('fca-child', root.id);
    const before = [snapshot(root.id), snapshot(child.id)];
    host.close();
    host = new SQLiteAgentTaskStore(path, { taskTreeEnabled: true });

    expect(host.taskTrees?.get(scope, existing.id)).not.toBeNull();
    for (const task of [root, child]) {
      expect(host.taskTrees?.get(scope, task.id)).toBeNull();
      expect(host.get(scope, task.id)).toMatchObject({ id: task.id, status: 'queued', latestSequence: task.revision });
      expect(host.get(scope, task.id)?.taskTree).toBeUndefined();
    }
    // The Host's list is its own tasks (ADR-0009 S9: common tasks are left out before its limit); they stay readable by id.
    expect(host.list(scope).map(task => task.id)).toEqual([existing.id]);
    expect([snapshot(root.id), snapshot(child.id)]).toEqual(before);
    expect(host.claim(hostId, at)?.taskId).toBe(existing.id);
  });

  it.each(['start', 'steer', 'interrupt', 'resume', 'resolve_approval'] as const)(
    'refuses the Host %s command before it can change FCA state or append an event', type => {
      const task = fca('fca-root');
      const before = snapshot(task.id);
      expect(() => host.enqueue(scope, task.id, {
        idempotencyKey: `host:${type}`, type, payload: { instruction: 'Resume', decision: 'allow_once' },
      }, later)).toThrow('AGENT_COMMAND_INVALID_EXECUTION_KIND');
      expect(snapshot(task.id)).toEqual(before);
    },
  );

  it('rejects a Host create idempotency key that belongs to FCA and preserves ordinary create retries', () => {
    const task = fca('fca-root');
    const input = { idempotencyKey: `fca:${task.id}`, conversationThreadID: 'conversation', title: 'Host', goal: 'Host work', summary: 'Host accepted' };
    const before = snapshot(task.id);
    expect(() => host.create(scope, input, later)).toThrow('AGENT_TASK_ID_CONFLICT');
    expect(snapshot(task.id)).toEqual(before);
    const original = host.create(scope, { ...input, idempotencyKey: 'ordinary' }, at);
    expect(host.create(scope, { ...input, idempotencyKey: 'ordinary' }, later)).toMatchObject({ created: false, task: { id: original.task.id } });
  });

  it('rejects Host results even when an FCA row carries a stale Host assignment', () => {
    const task = fca('fca-root');
    db.prepare('UPDATE agent_tasks SET assigned_host_id=? WHERE task_id=?').run(hostId, task.id);
    const before = snapshot(task.id);
    expect(() => host.recordHostEvents(hostId, [{
      eventId: 'unexpected-host-result', taskId: task.id, type: 'completed', title: 'Completed', occurredAt: later,
    }], later)).toThrow('AGENT_HOST_TASK_MISMATCH');
    expect(snapshot(task.id)).toEqual(before);
  });

  it('never claims unexpected FCA commands or lets their rows block ordinary Host admission', () => {
    const root = fca('fca-root');
    const child = fca('fca-child', root.id);
    db.prepare("UPDATE agent_tasks SET assigned_host_id=?,status='running' WHERE task_id=?").run(hostId, root.id);
    unexpectedCommand('fca-pending', root.id);
    unexpectedCommand('fca-unassigned', child.id);
    unexpectedCommand('fca-expired', root.id, true);
    const before = [snapshot(root.id), snapshot(child.id)];
    heartbeat();
    expect(host.workspaceCatalog(undefined, at, null).hosts.find(item => item.hostId === hostId)?.status).toBe('available');
    const task = legacy();
    expect(task.summary).toBe('Host accepted');
    expect(host.peekCommand(hostId, at)?.taskId).toBe(task.id);
    expect(host.claim(hostId, at)?.taskId).toBe(task.id);
    expect(host.claim(hostId, at)).toBeNull();
    expect([snapshot(root.id), snapshot(child.id)]).toEqual(before);
  });

  it('does not replace FCA progress with Host offline/online queue projections', () => {
    const root = fca('fca-root');
    db.prepare("UPDATE agent_tasks SET assigned_host_id=?,current_action='オフライン待ち',summary='Macがオフラインのため、戻るのを待っています。' WHERE task_id=?")
      .run(hostId, root.id);
    heartbeat();
    const before = snapshot(root.id);
    expect(host.peekCommand(hostId, later)).toBeNull();
    heartbeat(later);
    expect(host.peekCommand(hostId, later)).toBeNull();
    expect(snapshot(root.id)).toEqual(before);
  });
});
