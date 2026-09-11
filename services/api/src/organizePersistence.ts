import { DatabaseSync } from 'node:sqlite';
import type {
  OrganizeDecision,
  OrganizeDestinationStatus,
  OrganizeOperation,
  OrganizeSession,
  OrganizeSessionState,
  OrganizeStore,
  OrganizeTaskDraft,
  VoyagerTaskProjection,
  VoyagerTaskReference,
} from './organize.js';
import { InMemoryOrganizeStore } from './organizeMemoryStore.js';
import {
  OrganizeError,
  bounded,
  normalizedIds,
  normalizedTaskProjection,
  operationEdit,
  requiredBounded,
  storedUpdateFields,
} from './organizeSupport.js';

export class SQLiteOrganizeStore implements OrganizeStore {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS organize_sessions (
        session_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, source_message_ids_json TEXT NOT NULL,
        command_through_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS organize_items (
        item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES organize_sessions(session_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, decision TEXT NOT NULL,
        destination_status TEXT NOT NULL, request_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        result_json TEXT, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS organize_thread_cursors (
        scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, through_message_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(scope_key, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_organize_sessions_scope ON organize_sessions(scope_key, thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_organize_items_session ON organize_items(session_id, position);
    `);
    this.ensureItemColumn('operation', "TEXT NOT NULL DEFAULT 'create'");
    this.ensureItemColumn('target_json', 'TEXT');
    this.ensureItemColumn('project_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureItemColumn('target_query', "TEXT NOT NULL DEFAULT ''");
    this.ensureItemColumn('update_fields_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureItemColumn('project_selection_required', 'INTEGER NOT NULL DEFAULT 0');
  }
  close(): void { this.database.close(); }
  cursor(scopeKey: string, threadId: string): string | undefined {
    const row = this.database.prepare('SELECT through_message_id FROM organize_thread_cursors WHERE scope_key=? AND thread_id=?').get(scopeKey, threadId) as { through_message_id: string } | undefined;
    return row?.through_message_id;
  }
  list(scopeKey: string, threadId: string): OrganizeSession[] {
    const rows = this.database.prepare('SELECT session_id FROM organize_sessions WHERE scope_key=? AND thread_id=? ORDER BY created_at').all(scopeKey, threadId) as Array<{ session_id: string }>;
    return rows.flatMap(row => { const session = this.read(scopeKey, row.session_id); return session ? [session] : []; });
  }
  create(input: Pick<OrganizeSession, 'scopeKey' | 'threadId' | 'sourceMessageIds'> & { drafts: OrganizeTaskDraft[] }, now: string): OrganizeSession {
    const memory = new InMemoryOrganizeStore();
    const session = memory.create(input, now);
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare(`INSERT INTO organize_sessions
        (session_id,scope_key,thread_id,state,revision,source_message_ids_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(session.id, session.scopeKey, session.threadId, session.state, session.revision, JSON.stringify(session.sourceMessageIds), now, now);
      const insert = this.database.prepare(`INSERT INTO organize_items
        (item_id,session_id,position,title,details,operation,target_json,project_ids_json,target_query,update_fields_json,project_selection_required,decision,destination_status,request_id,idempotency_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      session.items.forEach((item, position) => insert.run(
        item.id, session.id, position, item.title, item.details, item.operation,
        item.target ? JSON.stringify(item.target) : null, JSON.stringify(item.projectIds), item.targetQuery,
        JSON.stringify(item.updateFields), item.projectSelectionRequired ? 1 : 0,
        item.decision, item.destinationStatus, item.requestId, item.idempotencyKey,
      ));
      this.database.exec('COMMIT;');
      return session;
    } catch (error) { this.database.exec('ROLLBACK;'); throw error; }
  }
  get(scopeKey: string, sessionId: string): OrganizeSession | undefined { return this.read(scopeKey, sessionId); }
  setCommandThrough(scopeKey: string, sessionId: string, messageId: string, now: string): OrganizeSession {
    this.require(scopeKey, sessionId);
    this.database.prepare('UPDATE organize_sessions SET command_through_message_id=?, updated_at=? WHERE session_id=?').run(messageId, now, sessionId);
    return this.require(scopeKey, sessionId);
  }
  decide(scopeKey: string, sessionId: string, itemId: string, expectedRevision: number, decision: OrganizeDecision, edit: Partial<OrganizeTaskDraft>, now: string): OrganizeSession {
    const session = this.require(scopeKey, sessionId);
    if (session.revision !== expectedRevision) throw new OrganizeError('REVISION_CONFLICT', 409);
    if (session.state === 'applied') throw new OrganizeError('SESSION_FINALIZED', 409);
    const item = session.items.find(value => value.id === itemId);
    if (!item) throw new OrganizeError('ITEM_NOT_FOUND', 404);
    if (item.destinationStatus !== 'pending') throw new OrganizeError('ITEM_ALREADY_ATTEMPTED', 409);
    const title = edit.title === undefined ? item.title : requiredBounded(edit.title, 500, 'title');
    const details = edit.details === undefined ? item.details : bounded(edit.details, 1_000);
    const operation = edit.operation !== undefined || edit.target !== undefined
      ? operationEdit(item, edit)
      : { operation: item.operation, ...(item.target ? { target: item.target } : {}) };
    const projectIds = edit.projectIds === undefined ? item.projectIds : normalizedIds(edit.projectIds);
    if (decision === 'accepted' && operation.operation === 'update' && !operation.target) throw new OrganizeError('TARGET_REQUIRED', 400);
    if (decision === 'accepted' && item.projectSelectionRequired && projectIds.length === 0) {
      throw new OrganizeError('PROJECT_SELECTION_REQUIRED', 400);
    }
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const changed = this.database.prepare('UPDATE organize_sessions SET revision=revision+1, updated_at=? WHERE session_id=? AND scope_key=? AND revision=?').run(now, sessionId, scopeKey, expectedRevision);
      if (Number(changed.changes) !== 1) throw new OrganizeError('REVISION_CONFLICT', 409);
      this.database.prepare(`UPDATE organize_items
        SET decision=?, title=?, details=?, operation=?, target_json=?, project_ids_json=?
        WHERE item_id=? AND session_id=?`).run(
        decision, title, details, operation.operation,
        operation.target ? JSON.stringify(operation.target) : null,
        JSON.stringify(projectIds), itemId, sessionId,
      );
      this.database.exec('COMMIT;');
    } catch (error) { this.database.exec('ROLLBACK;'); throw error; }
    return this.require(scopeKey, sessionId);
  }
  recordAttempt(scopeKey: string, sessionId: string, itemId: string, result: VoyagerTaskReference | undefined, errorCode: string | undefined, now: string): OrganizeSession {
    this.require(scopeKey, sessionId);
    this.database.prepare('UPDATE organize_items SET destination_status=?, result_json=?, error_code=? WHERE item_id=? AND session_id=?')
      .run(result ? 'applied' : 'failed', result ? JSON.stringify(result) : null, errorCode ?? null, itemId, sessionId);
    this.database.prepare('UPDATE organize_sessions SET updated_at=? WHERE session_id=?').run(now, sessionId);
    return this.require(scopeKey, sessionId);
  }
  finishApply(scopeKey: string, sessionId: string, now: string): OrganizeSession {
    const session = this.require(scopeKey, sessionId);
    const failed = session.items.some(item => item.decision === 'accepted' && item.destinationStatus !== 'applied');
    const state: OrganizeSessionState = failed ? 'partially_applied' : 'applied';
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.database.prepare('UPDATE organize_sessions SET state=?, revision=revision+1, updated_at=?, applied_at=? WHERE session_id=? AND scope_key=?')
        .run(state, now, state === 'applied' ? now : null, sessionId, scopeKey);
      if (state === 'applied' && session.commandThroughMessageId) {
        this.database.prepare(`INSERT INTO organize_thread_cursors(scope_key,thread_id,through_message_id,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(scope_key,thread_id) DO UPDATE SET through_message_id=excluded.through_message_id, updated_at=excluded.updated_at`)
          .run(scopeKey, session.threadId, session.commandThroughMessageId, now);
      }
      this.database.exec('COMMIT;');
    } catch (error) { this.database.exec('ROLLBACK;'); throw error; }
    return this.require(scopeKey, sessionId);
  }
  private require(scopeKey: string, sessionId: string): OrganizeSession {
    const value = this.read(scopeKey, sessionId);
    if (!value) throw new OrganizeError('SESSION_NOT_FOUND', 404);
    return value;
  }
  private read(scopeKey: string, sessionId: string): OrganizeSession | undefined {
    const row = this.database.prepare('SELECT * FROM organize_sessions WHERE session_id=? AND scope_key=?').get(sessionId, scopeKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const items = this.database.prepare('SELECT * FROM organize_items WHERE session_id=? ORDER BY position').all(sessionId) as Record<string, unknown>[];
    return {
      id: String(row.session_id), scopeKey: String(row.scope_key), threadId: String(row.thread_id), state: row.state as OrganizeSessionState,
      revision: Number(row.revision), sourceMessageIds: JSON.parse(String(row.source_message_ids_json)) as string[],
      ...(row.command_through_message_id ? { commandThroughMessageId: String(row.command_through_message_id) } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.applied_at ? { appliedAt: String(row.applied_at) } : {}),
      items: items.map(item => {
        const operation: OrganizeOperation = item.operation === 'update' ? 'update' : 'create';
        const target = item.target_json
          ? normalizedTaskProjection(JSON.parse(String(item.target_json)) as VoyagerTaskProjection)
          : undefined;
        return {
          id: String(item.item_id), title: String(item.title), details: String(item.details), decision: item.decision as OrganizeDecision,
          operation,
          ...(target ? { target } : {}),
          projectIds: normalizedIds(item.project_ids_json ? JSON.parse(String(item.project_ids_json)) as string[] : []),
          targetQuery: bounded(String(item.target_query ?? ''), 160) || (operation === 'update' ? target?.title ?? String(item.title) : ''),
          updateFields: storedUpdateFields(operation, item.update_fields_json),
          projectSelectionRequired: operation === 'update' && Number(item.project_selection_required ?? 0) === 1,
          destinationStatus: item.destination_status as OrganizeDestinationStatus, requestId: String(item.request_id), idempotencyKey: String(item.idempotency_key),
          ...(item.result_json ? { result: JSON.parse(String(item.result_json)) as VoyagerTaskReference } : {}),
          ...(item.error_code ? { errorCode: String(item.error_code) } : {}),
        };
      }),
    };
  }

  private ensureItemColumn(name: string, declaration: string): void {
    const columns = this.database.prepare('PRAGMA table_info(organize_items)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === name)) this.database.exec(`ALTER TABLE organize_items ADD COLUMN ${name} ${declaration}`);
  }
}
