import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { VISION_STEPS } from '../../../infra/sqlite/migrations/vision/visionSteps.js';

export type VisionChoiceKind = 'react' | 'notice' | 'escalate';

/** The camera notice's chosen candidates (closed ids and times), for cooldowns and the hourly cap across restarts. */
export class SQLiteVisionChoiceStore {
  constructor(private readonly database: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    applySchemaSteps(database, VISION_STEPS, now);
  }

  record(scopeKey: string, candidateId: string, kind: VisionChoiceKind, at: string): void {
    this.database.prepare('INSERT INTO vision_choices (scope_key, candidate_id, kind, chosen_at) VALUES (?, ?, ?, ?)').run(scopeKey, candidateId, kind, at);
    // Nothing older than a day is needed: the longest cooldown is 30 minutes and the cap counts one hour.
    this.database.prepare('DELETE FROM vision_choices WHERE scope_key = ? AND chosen_at < ?')
      .run(scopeKey, new Date(Date.parse(at) - 24 * 60 * 60_000).toISOString());
  }

  lastChosenAt(scopeKey: string, candidateId: string): string | null {
    const row = this.database.prepare('SELECT MAX(chosen_at) AS latest FROM vision_choices WHERE scope_key = ? AND candidate_id = ?')
      .get(scopeKey, candidateId) as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }

  countSince(scopeKey: string, kinds: readonly VisionChoiceKind[], since: string): number {
    const marks = kinds.map(() => '?').join(', ');
    const sql = `SELECT COUNT(*) AS total FROM vision_choices WHERE scope_key = ? AND chosen_at >= ? AND kind IN (${marks})`;
    const row = this.database.prepare(sql).get(scopeKey, since, ...kinds) as { total: number };
    return row.total;
  }
}
