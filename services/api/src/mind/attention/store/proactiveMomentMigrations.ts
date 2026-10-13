import type { DatabaseSync } from 'node:sqlite';
import { PROACTIVE_MOMENT_KINDS } from '../proactiveMoments.js';

/** `proactive_moments` (`proactiveMomentStore.ts`): additive, created by her own time's worker, which alone reads and writes it. */
export function ensureProactiveMomentsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS proactive_moments (
      scope_key TEXT NOT NULL,
      moment_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (${PROACTIVE_MOMENT_KINDS.map(kind => `'${kind}'`).join(', ')})),
      minutes INTEGER,
      audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
      perceived_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('perceived', 'wanted', 'quiet', 'taken', 'skipped', 'expired')),
      decider TEXT CHECK (decider IS NULL OR decider IN ('jev', 'writer')),
      reason TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      decided_at TEXT,
      PRIMARY KEY (scope_key, moment_key)
    );
    CREATE INDEX IF NOT EXISTS proactive_moments_scope ON proactive_moments (scope_key, perceived_at);
  `);
}
