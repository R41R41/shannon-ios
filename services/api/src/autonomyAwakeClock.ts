import { DatabaseSync } from 'node:sqlite';
import { reduceCompanionState, restoreCompanionState } from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';

/**
 * While she works in a session of her own she is awake, so her awake clock runs. Core: emotion.
 *
 * This is the one write the activity loop's process makes to the companion state. It opens no
 * conversation store and runs no migration: inside one write transaction it reads the stored
 * snapshot, reduces the content-free event `awake-observed` with the same reducer every other
 * writer uses, and writes back only the three values that event can move (`emotionClock`, the
 * mood values, what has settled underneath). Every other field of the stored snapshot is written
 * back exactly as it was read, also one this process does not know. It gives the loop nothing
 * back, so the loop learns nothing of her feeling or of any conversation from it.
 *
 * It writes at most once a minute; the time between two writes is still counted, up to the idle
 * cap. A scope without a stored state is left alone. A failure here never stops a step.
 */
const MINIMUM_INTERVAL_MILLISECONDS = 60_000;

export interface AutonomyAwakeClock {
  /** She just took a step of her own for this scope. */
  observe(scopeKey: string): void;
  close(): void;
}

export function configuredAwakeClock(databasePath: string, options: { now: () => string }): AutonomyAwakeClock {
  let database: DatabaseSync | null = null;
  const last = new Map<string, number>();
  const open = (): DatabaseSync => {
    if (database) return database;
    const opened = new DatabaseSync(databasePath);
    try {
      opened.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    } catch (error) {
      opened.close();
      throw error;
    }
    database = opened;
    return opened;
  };
  return {
    observe(scopeKey) {
      try {
        const timing = emotionTiming();
        // Under the kill switch nothing fades on an awake clock, so nothing is opened or written.
        if (timing.clock !== 'awake') return;
        const at = options.now();
        const time = Date.parse(at);
        if (!Number.isFinite(time)) return;
        const previous = last.get(scopeKey);
        if (previous !== undefined && time - previous >= 0 && time - previous < MINIMUM_INTERVAL_MILLISECONDS) return;
        const connection = open();
        if (!connection.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'companion_states'`).get()) return;
        // The write lock first, then the read: the API and its workers write the same row.
        connection.exec('BEGIN IMMEDIATE');
        try {
          const row = connection.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scopeKey) as unknown as { snapshot_json: string } | undefined;
          const stored: unknown = row ? JSON.parse(row.snapshot_json) : null;
          if (stored && typeof stored === 'object' && !Array.isArray(stored) && (stored as { scopeKey?: unknown }).scopeKey === scopeKey) {
            const current = restoreCompanionState(scopeKey, stored, at);
            const next = reduceCompanionState(current, { type: 'awake-observed' }, at, timing);
            if (next !== current) {
              connection.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run(JSON.stringify({
                ...stored, emotion: next.emotion, emotionClock: next.emotionClock, lingering: next.lingering ?? [],
              }), scopeKey);
            }
          }
          connection.exec('COMMIT');
        } catch (error) {
          if (connection.isTransaction) connection.exec('ROLLBACK');
          throw error;
        }
        last.set(scopeKey, time);
      } catch (error) {
        // The name and the code only: a parse error's message can quote the stored snapshot.
        const code = (error as { code?: unknown } | null)?.code;
        console.error('Shannon awake clock failed', error instanceof Error ? error.name : 'unknown', typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : '');
      }
    },
    close() {
      if (database?.isOpen) database.close();
      database = null;
    },
  };
}
