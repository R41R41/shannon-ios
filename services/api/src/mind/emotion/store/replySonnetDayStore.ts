import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { REPLY_SONNET_DAYS_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';
import type { SonnetReplyCap } from '../../../infra/models/replySonnetChatModel.js';

/** Days kept: the count of a day is read only on that day; a few weeks stay for diagnosis. */
export const REPLY_SONNET_DAY_RETENTION_DAYS = 30;

/**
 * The day's count of her replies given to Sonnet (owner 2026-10-21, `SHANNON_REPLY_SONNET`; table `shannon_reply_sonnet_days`, schema
 * step `emotion/008_reply_sonnet_days`), one cap a day for voice and text together, kept across restarts. A reply is counted when it is
 * given to Sonnet and given back when Sonnet did not serve it. When the count cannot be read or written, the reply is Haiku's (the cap
 * fails closed) and the log says so.
 */
export class SQLiteReplySonnetDays implements SonnetReplyCap {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;
  private warned = '';

  constructor(source: string | DatabaseSync, readonly cap: number, private readonly today: () => string,
    private readonly now: () => string = () => new Date().toISOString(), private readonly log: (line: string) => void = line => console.warn(line)) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, REPLY_SONNET_DAYS_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
    this.prune();
  }

  take(): boolean {
    const day = this.today();
    try {
      const at = this.now();
      this.database.prepare('INSERT INTO shannon_reply_sonnet_days (day, used, updated_at) VALUES (?, 0, ?) ON CONFLICT(day) DO NOTHING').run(day, at);
      const taken = this.database.prepare('UPDATE shannon_reply_sonnet_days SET used = used + 1, updated_at = ? WHERE day = ? AND used < ?')
        .run(at, day, this.cap);
      if (Number(taken.changes) === 1) return true;
      this.warnOnce(day, `Shannon replies: the day's cap of ${this.cap} Sonnet replies is reached; replies stay on Haiku today`);
      return false;
    } catch {
      this.warnOnce(day, 'Shannon replies: the day\'s count of Sonnet replies could not be read; this reply is Haiku\'s');
      return false;
    }
  }

  release(): void {
    try {
      this.database.prepare('UPDATE shannon_reply_sonnet_days SET used = MAX(0, used - 1), updated_at = ? WHERE day = ?').run(this.now(), this.today());
    } catch { /* a count not given back only makes the day's cap a little sooner */ }
  }

  count(): number {
    const row = this.database.prepare('SELECT used FROM shannon_reply_sonnet_days WHERE day = ?').get(this.today()) as { used?: unknown } | undefined;
    return Number(row?.used ?? 0);
  }

  close(): void {
    if (this.owned) this.database.close();
  }

  private prune(): void {
    const before = new Date(Date.parse(this.now()) - REPLY_SONNET_DAY_RETENTION_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
    this.database.prepare('DELETE FROM shannon_reply_sonnet_days WHERE day < ?').run(before);
  }

  private warnOnce(day: string, line: string): void {
    if (this.warned === day) return;
    this.warned = day;
    this.log(line);
  }
}
