import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ShannonEmotionTiming } from '@shannon/cognition';
import { emotionTiming } from '../../mind/emotion/emotionTiming.js';
import { prepared } from './sqliteOpen.js';
import { sqliteContention } from './sqliteBusy.js';
import type { SQLiteShannonStoreOptions } from './sqliteStore.js';

export class SQLiteStoreContext {
  readonly database: DatabaseSync;
  readonly maximumModelConversationItems: number;
  readonly maximumDisplayedConversationItems: number;
  readonly maximumExperiences: number;
  readonly defaultThreadCache = new Map<string, string>();

  constructor(readonly options: SQLiteShannonStoreOptions) {
    if (!options.path.trim()) throw new Error('SHANNON_DATABASE_PATH is required');
    this.maximumModelConversationItems = positiveInteger(options.maximumModelConversationItems ?? 20, 200);
    this.maximumDisplayedConversationItems = positiveInteger(options.maximumDisplayedConversationItems ?? 200, 2_000);
    this.maximumExperiences = positiveInteger(options.maximumExperiences ?? 1_000, 10_000);
    prepareDatabaseLocation(options.path);
    this.database = new DatabaseSync(options.path);
    this.database.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
  }

  now(): string { return this.options.now(); }

  /** A statement of fixed text that a hot path runs again and again, prepared once (prepared in sqliteOpen.ts). */
  prepared(text: string) { return prepared(this.database, text); }

  /** The timing every emotion event of this store is reduced with. */
  emotionTiming(): ShannonEmotionTiming { return this.options.emotionTiming ?? emotionTiming(); }

  insertEvent(scopeKey: string, type: string, observedAt: string, payload: unknown, eventId = randomUUID()): void {
    this.database.prepare(`
      INSERT INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, scopeKey, type, observedAt, JSON.stringify(payload));
  }

  insertActivity(scopeKey: string, type: string, title: string, detail: string | null, occurredAt: string, metadata: unknown = {}): void {
    this.database.prepare(`
      INSERT INTO activity_events
        (activity_id, scope_key, activity_type, title, detail, occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scopeKey, type, title, detail, occurredAt, JSON.stringify(metadata));
  }

  transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    // Where it was taken, for the slow-lock line (Minecraft run 18: a lock held about 150 s that no journal could place).
    const site = new Error(), asked = Date.now();
    try { this.database.exec('BEGIN IMMEDIATE'); } catch (error) {
      // Never taken (busy past the timeout): the wait is named as well.
      sqliteContention(site, Date.now() - asked, 0);
      throw error;
    }
    const taken = Date.now();
    try {
      const result = operation();
      this.database.exec('COMMIT');
      sqliteContention(site, taken - asked, Date.now() - taken);
      secureDatabaseFiles(this.options.path);
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      sqliteContention(site, taken - asked, Date.now() - taken);
      throw error;
    }
  }

  close(): void {
    if (!this.database.isOpen) return;
    this.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
    secureDatabaseFiles(this.options.path);
    this.database.close();
  }
}

export function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(candidate)) chmodSync(candidate, 0o600);
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('SQLITE_STORE_LIMIT_INVALID');
  return value;
}

function prepareDatabaseLocation(path: string): void {
  if (path === ':memory:') return;
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
}
