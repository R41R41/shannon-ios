import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import type { SleepFcaPhaseHandler } from '../mind/sleep/sleepFcaPorts.js';

interface Barrier { writerBarrier: 1; seqs: readonly number[]; done: boolean; state: unknown }
/** Dependencies consume committed writer results, not merely accepted proposals. Never starts a second memory writer. */
export function withSleepWriterBarrier(store: SQLiteShannonStore, handler: SleepFcaPhaseHandler,
  origins: readonly string[]): SleepFcaPhaseHandler {
  const db = store.fcaDatabase();
  const saved = (state: unknown): Barrier | null => {
    if (!state || typeof state !== 'object' || !('writerBarrier' in state)) return null;
    const value = state as Barrier;
    if (value.writerBarrier !== 1 || !Array.isArray(value.seqs) || value.seqs.length > 256
      || value.seqs.some(seq => !Number.isSafeInteger(seq) || seq < 1) || typeof value.done !== 'boolean') throw new Error('SLEEP_WRITER_CHECKPOINT');
    return value;
  };
  return {
    decide: input => { input.signal.throwIfAborted(); return saved(input.state) ? Promise.resolve(null) : handler.decide(input); },
    async apply(answer, input) {
      input.signal.throwIfAborted();
      let barrier = saved(input.state);
      if (!barrier) {
        const before = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM memory_outbox').get()!.seq);
        const result = await handler.apply(answer, input);
        input.signal.throwIfAborted();
        const rows = db.prepare('SELECT seq,origin FROM memory_outbox WHERE seq>? AND scope_key=? ORDER BY seq').all(before, input.job.scopeKey);
        const seqs = rows.filter(row => origins.includes(String(row.origin))).map(row => Number(row.seq));
        if (!seqs.length) return result;
        barrier = { writerBarrier: 1, seqs, done: result.done, state: result.state ?? null };
      }
      const statuses = barrier.seqs.map(seq => db.prepare('SELECT scope_key,status FROM memory_outbox WHERE seq=?').get(seq));
      if (statuses.some(row => !row || row.scope_key !== input.job.scopeKey || row.status === 'failed')) throw new Error('SLEEP_WRITER_UNCONFIRMED');
      if (statuses.some(row => row!.status === 'pending')) return { done: false, state: barrier, summary: '記憶ライターの反映を待っています。' };
      return { done: barrier.done, state: barrier.state,
        summary: `記憶ライター確認: 反映${statuses.filter(row => row!.status === 'applied').length}・保留${statuses.filter(row => row!.status !== 'applied').length}` };
    },
  };
}
