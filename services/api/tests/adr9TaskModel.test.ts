import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { ensureTaskKinds, hostTaskPredicate } from '../src/mind/action/agentTasks/store/taskKinds.js';

// Syzygy ADR-0009 stage 1, S8: one task model. A row's kind is its `task_kind`, written at its birth; `fca_kind` is data.
const scope = 'owner', at = '2026-10-13T00:00:00.000Z';
let directory: string, path: string, host: SQLiteAgentTaskStore, db: DatabaseSync, authority: SQLiteFcaTaskAuthority;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shannon-task-model-'));
  path = join(directory, 'tasks.sqlite');
  host = new SQLiteAgentTaskStore(path);
  db = new DatabaseSync(path);
  authority = new SQLiteFcaTaskAuthority(db);
});
afterEach(() => { host.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

const kindOf = (id: string) => db.prepare('SELECT task_kind,fca_kind FROM agent_tasks WHERE task_id=?').get(id);
const common = (id: string, kind: 'root' | 'research' | 'generic' | 'sleep', parentId: string | null) => authority.transaction(() => authority.create({
  id, scopeKey: scope, parentId, kind, origin: kind === 'sleep' ? 'maintenance' : 'owner_request', title: id, goal: id,
  completionCriteria: 'done', status: 'queued', pauseReason: null, summary: '', createdAt: at, requestKey: `fca:${id}`,
}));

describe('one task model', () => {
  it('writes the kind in each row\'s INSERT, for an Agent Host task and every common kind', () => {
    const codex = host.create(scope, { idempotencyKey: 'codex', conversationThreadID: 'thread', title: 'c', goal: 'g', summary: 's' }, at).task;
    common('root', 'root', null); common('research', 'research', 'root'); common('generic', 'generic', 'root');
    expect(kindOf(codex.id)).toEqual({ task_kind: 'codex', fca_kind: null });
    expect(kindOf('research')).toEqual({ task_kind: 'work', fca_kind: 'research' });
    expect(kindOf('generic')).toEqual({ task_kind: 'work', fca_kind: 'generic' });
    expect(authority.root(scope)?.id).toBe('root');
    expect(authority.list(scope).map(task => task.id).sort()).toEqual(['generic', 'research', 'root']);
    expect(db.prepare(`SELECT task_id FROM agent_tasks t WHERE ${hostTaskPredicate(db, 't')}`).all()).toEqual([{ task_id: codex.id }]);
    expect(() => authority.transaction(() => authority.create({ id: 'odd', scopeKey: scope, parentId: 'root', kind: 'odd' as never,
      origin: 'owner_request', title: 'x', goal: 'x', completionCriteria: 'x', status: 'queued', pauseReason: null, summary: '',
      createdAt: at, requestKey: 'fca:odd' }))).toThrow('FCA_KIND');
    expect(kindOf('odd')).toBeUndefined();
  });

  it('gives a row an older build wrote without its kind the same kind once a store opens, so neither model loses it', () => {
    const codex = host.create(scope, { idempotencyKey: 'old-codex', conversationThreadID: 'thread', title: 'c', goal: 'g', summary: 's' }, at).task;
    common('root', 'root', null); common('night', 'sleep', 'root');
    db.prepare('UPDATE agent_tasks SET task_kind=NULL').run();
    expect(authority.get(scope, 'root')).toBeNull();
    ensureTaskKinds(db);
    expect([kindOf(codex.id), kindOf('root'), kindOf('night')]).toEqual([
      { task_kind: 'codex', fca_kind: null }, { task_kind: 'root', fca_kind: 'root' }, { task_kind: 'sleep', fca_kind: 'sleep' }]);
    expect(authority.get(scope, 'root')?.kind).toBe('root');
    expect(host.get(scope, codex.id)?.id).toBe(codex.id);
    // Host paths still refuse a common task by its kind.
    expect(() => host.enqueue(scope, 'root', { idempotencyKey: 'steer-root', type: 'steer', payload: { message: 'x' } }, at)).toThrow();
  });
});
