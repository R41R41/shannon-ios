import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createInitialCompanionState,
  freezeSnapshot,
  reduceCompanionState,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';
import type {
  ConversationStore,
  ShannonExperience,
  StoredConversationMessage,
  TurnPersistenceContext,
} from './conversationStore.js';

const SCHEMA_VERSION = 1;
const DEFAULT_DATABASE_PATH = resolve(fileURLToPath(new URL('../../../data/shannon.sqlite', import.meta.url)));

interface StateRow {
  snapshot_json: string;
}

interface MessageRow {
  message_id: string;
  role: string;
  content: string;
  observed_at: string;
  metadata_json: string | null;
}

interface EventRow {
  sequence: number;
  event_id: string;
  scope_key: string;
  event_type: string;
  observed_at: string;
  payload_json: string;
}

interface TurnPayload {
  userMessage: string;
  shannonReply: string;
  summary: string;
  capturedStateVersion?: number;
  messageEmotion?: ShannonMessageEmotion;
}

interface MessageMetadata {
  stateVersion?: number;
  messageEmotion?: ShannonMessageEmotion;
}

export interface PersistedExperienceEvent {
  sequence: number;
  id: string;
  scopeKey: string;
  type: string;
  observedAt: string;
  payload: unknown;
}

export interface SQLiteShannonStoreOptions {
  path: string;
  now: CompanionClock;
  maximumModelConversationItems?: number;
  maximumDisplayedConversationItems?: number;
  maximumExperiences?: number;
}

/**
 * Durable adapter only. Cognition remains in packages/cognition; this class
 * stores immutable snapshots, conversation messages, and append-only events.
 */
export class SQLiteShannonStore implements CompanionStateStore, ConversationStore {
  private readonly database: DatabaseSync;
  private readonly maximumModelConversationItems: number;
  private readonly maximumDisplayedConversationItems: number;
  private readonly maximumExperiences: number;

  constructor(private readonly options: SQLiteShannonStoreOptions) {
    if (!options.path.trim()) throw new Error('SHANNON_DATABASE_PATH is required');
    this.maximumModelConversationItems = positiveInteger(options.maximumModelConversationItems ?? 20, 200);
    this.maximumDisplayedConversationItems = positiveInteger(options.maximumDisplayedConversationItems ?? 200, 2_000);
    this.maximumExperiences = positiveInteger(options.maximumExperiences ?? 1_000, 10_000);
    prepareDatabaseLocation(options.path);
    this.database = new DatabaseSync(options.path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
    secureDatabaseFiles(options.path);
  }

  snapshot(scopeKey: string): CompanionStateSnapshot {
    const row = this.database.prepare(`
      SELECT snapshot_json
      FROM companion_states
      WHERE scope_key = ?
    `).get(scopeKey) as unknown as StateRow | undefined;
    if (row) return parseSnapshot(row.snapshot_json, scopeKey);

    const initial = createInitialCompanionState(scopeKey, this.options.now());
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO companion_states (scope_key, version, updated_at, snapshot_json)
        VALUES (?, ?, ?, ?)
      `).run(scopeKey, initial.version, initial.updatedAt, JSON.stringify(initial));
      this.insertEvent(scopeKey, 'state.initialized', initial.updatedAt, {
        toVersion: initial.version,
      });
    });
    return initial;
  }

  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot {
    const current = this.snapshot(scopeKey);
    const next = reduceCompanionState(current, event, this.options.now());
    if (next === current) return current;
    this.transaction(() => {
      this.database.prepare(`
        UPDATE companion_states
        SET version = ?, updated_at = ?, snapshot_json = ?
        WHERE scope_key = ?
      `).run(next.version, next.updatedAt, JSON.stringify(next), scopeKey);
      this.insertEvent(scopeKey, `state.${event.type}`, next.updatedAt, {
        event,
        fromVersion: current.version,
        toVersion: next.version,
      });
    });
    return next;
  }

  history(scopeKey: string): readonly ShannonConversationItem[] {
    return Object.freeze(this.conversationHistory(scopeKey)
      .slice(-this.maximumModelConversationItems)
      .map(item => Object.freeze({ role: item.role, content: item.content })));
  }

  conversationHistory(scopeKey: string): readonly StoredConversationMessage[] {
    const rows = this.database.prepare(`
      SELECT message_id, role, content, observed_at, metadata_json
      FROM (
        SELECT sequence, message_id, role, content, observed_at, metadata_json
        FROM conversation_messages
        WHERE scope_key = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(scopeKey, this.maximumDisplayedConversationItems) as unknown as MessageRow[];
    return Object.freeze(rows.map(row => freezeStoredMessage(row)));
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] {
    const rows = this.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed'
      ORDER BY sequence DESC
      LIMIT ?
    `).all(scopeKey, this.maximumExperiences) as unknown as EventRow[];
    return Object.freeze(rows.reverse().flatMap(row => {
      const payload = parseTurnPayload(row.payload_json);
      if (!payload) return [];
      return [Object.freeze({
        id: row.event_id,
        userMessage: payload.userMessage,
        shannonReply: payload.shannonReply,
        summary: payload.summary,
        observedAt: row.observed_at,
      })];
    }));
  }

  appendTurn(
    scopeKey: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience {
    const turnId = randomUUID();
    const summary = summarizeExperience(userMessage, shannonReply);
    const payload: TurnPayload = {
      userMessage,
      shannonReply,
      summary,
      ...(context ? {
        capturedStateVersion: context.capturedStateVersion,
        messageEmotion: context.messageEmotion,
      } : {}),
    };
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(randomUUID(), scopeKey, turnId, 0, 'user', userMessage, observedAt, null);
      insert.run(
        randomUUID(),
        scopeKey,
        turnId,
        1,
        'assistant',
        shannonReply,
        observedAt,
        context ? JSON.stringify({
          stateVersion: context.capturedStateVersion,
          messageEmotion: context.messageEmotion,
        } satisfies MessageMetadata) : null,
      );
      this.insertEvent(scopeKey, 'turn.completed', observedAt, payload, turnId);
    });
    return Object.freeze({ id: turnId, userMessage, shannonReply, summary, observedAt });
  }

  events(scopeKey: string): readonly PersistedExperienceEvent[] {
    const rows = this.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ?
      ORDER BY sequence ASC
    `).all(scopeKey) as unknown as EventRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      sequence: Number(row.sequence),
      id: row.event_id,
      scopeKey: row.scope_key,
      type: row.event_type,
      observedAt: row.observed_at,
      payload: parseJson(row.payload_json),
    })));
  }

  close(): void {
    if (!this.database.isOpen) return;
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    secureDatabaseFiles(this.options.path);
    this.database.close();
  }

  private migrate(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    if (Number(version.user_version) > SCHEMA_VERSION) {
      throw new Error(`SHANNON_DATABASE_SCHEMA_TOO_NEW:${version.user_version}`);
    }
    if (Number(version.user_version) === SCHEMA_VERSION) return;
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS companion_states (
          scope_key TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 0),
          updated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          metadata_json TEXT,
          UNIQUE (scope_key, turn_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS conversation_messages_scope_sequence
          ON conversation_messages (scope_key, sequence);

        CREATE TABLE IF NOT EXISTS experience_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experience_events_scope_sequence
          ON experience_events (scope_key, sequence);
        CREATE INDEX IF NOT EXISTS experience_events_scope_type_sequence
          ON experience_events (scope_key, event_type, sequence);

        PRAGMA user_version = 1;
      `);
    });
  }

  private insertEvent(
    scopeKey: string,
    type: string,
    observedAt: string,
    payload: unknown,
    eventId = randomUUID(),
  ): void {
    this.database.prepare(`
      INSERT INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, scopeKey, type, observedAt, JSON.stringify(payload));
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      secureDatabaseFiles(this.options.path);
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function configuredDatabasePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment.SHANNON_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
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

function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

function parseSnapshot(raw: string, expectedScopeKey: string): CompanionStateSnapshot {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SHANNON_STATE_CORRUPT');
  const row = value as Partial<CompanionStateSnapshot>;
  if (row.scopeKey !== expectedScopeKey
    || !Number.isSafeInteger(row.version)
    || typeof row.updatedAt !== 'string'
    || !row.temperament || !row.emotion
    || !Array.isArray(row.interests)
    || !Array.isArray(row.userFacts)
    || !Array.isArray(row.activeMemories)) {
    throw new Error('SHANNON_STATE_CORRUPT');
  }
  return freezeSnapshot(row as CompanionStateSnapshot);
}

function freezeStoredMessage(row: MessageRow): StoredConversationMessage {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const metadata = row.metadata_json ? parseMessageMetadata(row.metadata_json) : null;
  return Object.freeze({
    id: row.message_id,
    role,
    content: row.content,
    observedAt: row.observed_at,
    ...(metadata?.messageEmotion ? { messageEmotion: Object.freeze({ ...metadata.messageEmotion }) } : {}),
    ...(metadata?.stateVersion !== undefined ? { stateVersion: metadata.stateVersion } : {}),
  });
}

function parseMessageMetadata(raw: string): MessageMetadata | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as MessageMetadata;
  return {
    ...(Number.isSafeInteger(row.stateVersion) ? { stateVersion: row.stateVersion } : {}),
    ...(validMessageEmotion(row.messageEmotion) ? { messageEmotion: row.messageEmotion } : {}),
  };
}

function parseTurnPayload(raw: string): TurnPayload | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<TurnPayload>;
  if (typeof row.userMessage !== 'string'
    || typeof row.shannonReply !== 'string'
    || typeof row.summary !== 'string') return null;
  return row as TurnPayload;
}

function validMessageEmotion(value: unknown): value is ShannonMessageEmotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonMessageEmotion>;
  return typeof row.valence === 'number'
    && typeof row.arousal === 'number'
    && typeof row.openness === 'number'
    && typeof row.expression === 'string';
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('SHANNON_DATABASE_JSON_CORRUPT');
  }
}

function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}
