import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { MINECRAFT_REQUEST_QUEUE_STEP } from '../../../infra/sqlite/migrations/execution/014_minecraft_request_queue.js';
import { underWriteLock } from '../../../infra/sqlite/lockWaits.js';
import { EMPTY_QUEUE, type QueueRecord, type QueueSnapshot } from '../minecraftRequestQueue.js';
import type { MinecraftQueueOrigin, MinecraftQueueState } from '../../../contracts/minecraftQueueContract.js';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function recordOf(row: Record<string, unknown>): QueueRecord {
  return { id: String(row.id), seq: Number(row.seq), goal: String(row.goal), state: String(row.state) as MinecraftQueueState,
    pos: Number(row.pos), origin: String(row.origin) as MinecraftQueueOrigin, requestId: text(row.request_id),
    experienceId: text(row.experience_id), observedAt: text(row.observed_at), askedBy: text(row.asked_by), taskId: text(row.task_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), endedAt: text(row.ended_at), note: text(row.note) };
}

/**
 * The stored list of requests (`execution/014_minecraft_request_queue`). The list is small (a few dozen rows at most), so a write
 * replaces the owner's rows as a whole, inside the caller's write lock (a savepoint when it already holds one); the revision rises
 * only when what is stored differs.
 */
export class MinecraftRequestQueueStore {
  constructor(private readonly db: DatabaseSync) {
    applySchemaSteps(db, [MINECRAFT_REQUEST_QUEUE_STEP]);
  }

  read(scopeKey: string): QueueSnapshot & { rev: number } {
    const state = this.db.prepare('SELECT auto_run, rev, next_seq FROM minecraft_request_queue_state WHERE scope_key = ?').get(scopeKey);
    if (!state) return { ...EMPTY_QUEUE, rev: 0 };
    const rows = this.db.prepare('SELECT * FROM minecraft_request_queue WHERE scope_key = ? ORDER BY seq').all(scopeKey);
    return { autoRun: Number(state.auto_run) === 1, nextSeq: Number(state.next_seq), rev: Number(state.rev), entries: rows.map(recordOf) };
  }

  /** Stores the list; the revision it has now. */
  write(scopeKey: string, snapshot: QueueSnapshot): number {
    return underWriteLock(this.db, null, '', () => {
      const before = this.read(scopeKey);
      const same = before.autoRun === snapshot.autoRun && before.nextSeq === snapshot.nextSeq
        && JSON.stringify(before.entries) === JSON.stringify([...snapshot.entries].sort((a, b) => a.seq - b.seq));
      if (same && before.rev > 0) return before.rev;
      const rev = before.rev + 1;
      this.db.prepare('DELETE FROM minecraft_request_queue WHERE scope_key = ?').run(scopeKey);
      const insert = this.db.prepare(`INSERT INTO minecraft_request_queue(id, scope_key, seq, goal, state, pos, origin, request_id, experience_id,
        observed_at, asked_by, task_id, created_at, updated_at, ended_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of snapshot.entries) {
        insert.run(e.id, scopeKey, e.seq, e.goal, e.state, e.pos, e.origin, e.requestId, e.experienceId, e.observedAt, e.askedBy, e.taskId,
          e.createdAt, e.updatedAt, e.endedAt, e.note);
      }
      this.db.prepare(`INSERT INTO minecraft_request_queue_state(scope_key, auto_run, rev, next_seq) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET auto_run = excluded.auto_run, rev = excluded.rev, next_seq = excluded.next_seq`)
        .run(scopeKey, snapshot.autoRun ? 1 : 0, rev, snapshot.nextSeq);
      return rev;
    }, 'minecraft_queue_write');
  }
}
