import { DatabaseSync } from 'node:sqlite';
import { gameEvidence, BODY_GAME_SOURCE, type GameExperience, type GameExperienceWriter } from '../gameBodyMemory.js';

export class SQLiteGameExperiences implements GameExperienceWriter {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  write(scopeKey: string, experience: GameExperience): boolean {
    // The experience table belongs to the conversation store.
    if (!this.database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'experience_events'").get()) return false;
    const payload = JSON.stringify({
      userMessage: gameEvidence(experience.id), shannonReply: '', summary: experience.summary, disclosure: experience.disclosure,
      source: BODY_GAME_SOURCE, game: experience.game,
    });
    // An event is written once: the body's retry of the same id finds it there.
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json) VALUES (?, ?, 'turn.completed', ?, ?)
    `).run(experience.id, scopeKey, experience.observedAt, payload);
    return Number(inserted.changes) > 0;
  }

  recorded(scopeKey: string, experienceId: string): boolean {
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_events'").get()) return false;
    return Boolean(this.database.prepare(`SELECT 1 FROM experience_events WHERE event_id = ? AND scope_key = ?
      AND event_type = 'turn.completed' AND json_extract(payload_json, '$.source') = ?`).get(experienceId, scopeKey, BODY_GAME_SOURCE));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
