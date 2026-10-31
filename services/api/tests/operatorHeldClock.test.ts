import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';

const minute = (n: number) => new Date(Date.parse('2026-10-31T00:00:00Z') + n * 60_000).toISOString();
function audit() {
  const db = new DatabaseSync(':memory:'), store = new OperatorAuditStore(db);
  const add = (command: string, at: number, detail = '') => store.append({ operationId: `op-${command}-${at}-${detail}`, scopeKey: 'owner',
    at: minute(at), operator: 'test', command, event: command === 'resume' ? 'accepted' : 'settled', code: 'test', argsJson: '{}', taskId: 'task', detail });
  return { db, store, add };
}
it('does not count the same pause twice after a refused runtime resume re-announces its old timestamp', () => {
  const f = audit(); try {
    f.add('paused', 10); f.add('resume', 30); f.add('paused', 10); f.add('resume', 50);
    expect(f.store.heldMs('task', minute(60))).toBe(40 * 60_000);
  } finally { f.db.close(); }
});
it('unions an open replayed pause while retaining genuinely separate pauses and explicit deductions', () => {
  const f = audit(); try {
    f.add('hold', 10); f.add('resume', 20, 'deduct=120000'); f.add('paused', 30); f.add('resume', 40); f.add('paused', 30);
    expect(f.store.heldMs('task', minute(50))).toBe(32 * 60_000);
  } finally { f.db.close(); }
});
it('never grants time from a reversed or invalid pause interval', () => {
  const f = audit(); try {
    f.add('paused', 20); f.add('resume', 10);
    expect(f.store.heldMs('task', minute(30))).toBe(0);
  } finally { f.db.close(); }
});
