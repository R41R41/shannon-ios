import { DatabaseSync } from 'node:sqlite';
import { BODY_TOUCH_SOURCE } from '../../../contracts/bodyReactionContract.js';
import { type TouchExperience, type TouchExperienceWriter, touchEvidence } from '../bodyTouchExperience.js';
export { type TouchExperience, type TouchExperienceWriter, touchWhen, touchExperienceSummary, touchEvidence, touchExperience } from '../bodyTouchExperience.js';

export class SQLiteTouchExperiences implements TouchExperienceWriter {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  write(scopeKey: string, experience: TouchExperience): boolean {
    // The experience table belongs to the conversation store.
    if (!this.has('table', 'experience_events')) return false;
    const payload = JSON.stringify({
      userMessage: touchEvidence(experience.id), shannonReply: experience.shannonReply, summary: experience.summary, disclosure: experience.disclosure,
      source: BODY_TOUCH_SOURCE, touch: experience.touch,
    });
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // The insert trigger of the search index runs for a new experience only.
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json) VALUES (?, ?, 'turn.completed', ?, ?)
      `).run(experience.id, scopeKey, experience.observedAt, payload);
      if (!Number(inserted.changes)) {
        const updated = this.database.prepare(`
          UPDATE experience_events SET payload_json = ?
          WHERE event_id = ? AND scope_key = ? AND event_type = 'turn.completed' AND json_extract(payload_json, '$.source') = ?
        `).run(payload, experience.id, scopeKey, BODY_TOUCH_SOURCE);
        if (!Number(updated.changes)) {
          this.database.exec('ROLLBACK');
          return false;
        }
        // A rewritten memory is searched and embedded by its new text.
        if (this.has('table', 'memory_search_documents')) {
          const revision = (this.database.prepare("PRAGMA table_info('memory_search_documents')").all() as unknown as Array<{ name: string }>)
            .some(column => column.name === 'revision') ? ', revision = revision + 1' : '';
          this.database.prepare(`
            UPDATE memory_search_documents SET body = ?${revision} WHERE source_kind = 'experience' AND source_id = ? AND scope_key = ? AND body IS NOT ?
          `).run(experience.summary.slice(0, 2_000), experience.id, scopeKey, experience.summary.slice(0, 2_000));
        }
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private has(type: string, name: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?').get(type, name));
  }
}
