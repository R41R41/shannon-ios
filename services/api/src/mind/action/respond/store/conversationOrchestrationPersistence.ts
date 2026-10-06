import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  InMemoryConversationOrchestrationStore,
  type ConversationOrchestrationState,
  type ConversationOrchestrationStore,
} from '../conversationOrchestration.js';

export class SQLiteConversationOrchestrationStore implements ConversationOrchestrationStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS conversation_orchestration_states (
        scope_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (scope_key, thread_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_orchestration_updated
        ON conversation_orchestration_states (scope_key, updated_at DESC);
    `);
    this.secureFiles();
  }

  read(scopeKey: string, threadId: string): ConversationOrchestrationState | null {
    const row = this.database.prepare(`SELECT state_json FROM conversation_orchestration_states
      WHERE scope_key = ? AND thread_id = ? LIMIT 1`).get(scopeKey, threadId) as { state_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.state_json) as ConversationOrchestrationState;
      if (parsed.scopeKey !== scopeKey || parsed.threadId !== threadId) return null;
      return new InMemoryConversationOrchestrationStore().save(parsed);
    } catch { return null; }
  }

  save(state: ConversationOrchestrationState): ConversationOrchestrationState {
    this.database.prepare(`INSERT INTO conversation_orchestration_states
      (scope_key, thread_id, revision, updated_at, state_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, thread_id) DO UPDATE SET
        revision = excluded.revision, updated_at = excluded.updated_at, state_json = excluded.state_json
      WHERE excluded.revision >= conversation_orchestration_states.revision`).run(
      state.scopeKey, state.threadId, state.revision, state.updatedAt, JSON.stringify(state),
    );
    this.secureFiles();
    return this.read(state.scopeKey, state.threadId) ?? state;
  }

  close(): void {
    if (!this.database.isOpen) return;
    this.database.close();
    this.secureFiles();
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}
