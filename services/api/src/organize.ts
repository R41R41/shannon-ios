import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ShannonConversationItem } from './chatModel.js';
import type { StoredConversationMessage } from './conversationStore.js';

export type OrganizeDecision = 'proposed' | 'accepted' | 'rejected' | 'deferred';
export type OrganizeDestinationStatus = 'pending' | 'applied' | 'failed';
export type OrganizeSessionState = 'ready_for_review' | 'partially_applied' | 'applied';
export type OrganizeOperation = 'create' | 'update';
export type OrganizeUpdateField = 'title' | 'details' | 'projectIds';

export interface VoyagerTaskProjection {
  id: string;
  title: string;
  details: string;
  status: string;
  projectIds: string[];
  revision: number;
  updatedAt: string;
}

export interface VoyagerProjectProjection {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
}

export interface OrganizeTaskDraft {
  title: string;
  details: string;
  operation?: OrganizeOperation;
  target?: VoyagerTaskProjection;
  projectIds?: string[];
  targetQuery?: string;
  updateFields?: OrganizeUpdateField[];
  projectSelectionRequired?: boolean;
}

export interface VoyagerTaskReference {
  system: 'voyager';
  resourceType: 'task';
  resourceId: string;
  title: string;
  summary: string | null;
  updatedAt: string;
  href: null;
}

export interface OrganizeItem extends OrganizeTaskDraft {
  id: string;
  operation: OrganizeOperation;
  projectIds: string[];
  targetQuery: string;
  updateFields: OrganizeUpdateField[];
  projectSelectionRequired: boolean;
  decision: OrganizeDecision;
  destinationStatus: OrganizeDestinationStatus;
  requestId: string;
  idempotencyKey: string;
  result?: VoyagerTaskReference;
  errorCode?: string;
}

export interface OrganizeSession {
  id: string;
  scopeKey: string;
  threadId: string;
  state: OrganizeSessionState;
  revision: number;
  sourceMessageIds: string[];
  commandThroughMessageId?: string;
  items: OrganizeItem[];
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface OrganizeStore {
  cursor(scopeKey: string, threadId: string): string | undefined;
  list(scopeKey: string, threadId: string): OrganizeSession[];
  create(input: Pick<OrganizeSession, 'scopeKey' | 'threadId' | 'sourceMessageIds'> & { drafts: OrganizeTaskDraft[] }, now: string): OrganizeSession;
  get(scopeKey: string, sessionId: string): OrganizeSession | undefined;
  setCommandThrough(scopeKey: string, sessionId: string, messageId: string, now: string): OrganizeSession;
  decide(scopeKey: string, sessionId: string, itemId: string, expectedRevision: number, decision: OrganizeDecision, edit: Partial<OrganizeTaskDraft>, now: string): OrganizeSession;
  recordAttempt(scopeKey: string, sessionId: string, itemId: string, result: VoyagerTaskReference | undefined, errorCode: string | undefined, now: string): OrganizeSession;
  finishApply(scopeKey: string, sessionId: string, now: string): OrganizeSession;
}

export class InMemoryOrganizeStore implements OrganizeStore {
  private readonly sessions = new Map<string, OrganizeSession>();
  private readonly cursors = new Map<string, string>();

  cursor(scopeKey: string, threadId: string): string | undefined { return this.cursors.get(`${scopeKey}\u0000${threadId}`); }
  list(scopeKey: string, threadId: string): OrganizeSession[] {
    return [...this.sessions.values()].filter(session => session.scopeKey === scopeKey && session.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(cloneSession);
  }

  create(input: Pick<OrganizeSession, 'scopeKey' | 'threadId' | 'sourceMessageIds'> & { drafts: OrganizeTaskDraft[] }, now: string): OrganizeSession {
    const session: OrganizeSession = {
      id: randomUUID(), scopeKey: input.scopeKey, threadId: input.threadId,
      state: 'ready_for_review', revision: 1, sourceMessageIds: [...new Set(input.sourceMessageIds)],
      items: input.drafts.slice(0, 12).map(draft => {
        const operation = normalizedOperation(draft.operation, draft.target);
        const updateFields = normalizedUpdateFields(draft.updateFields, operation);
        return {
          id: randomUUID(), title: bounded(draft.title, 500), details: bounded(draft.details, 1_000),
          operation,
          ...(draft.target ? { target: normalizedTaskProjection(draft.target) } : {}),
          projectIds: normalizedIds(draft.projectIds ?? []),
          targetQuery: bounded(draft.targetQuery ?? draft.target?.title ?? (operation === 'update' ? draft.title : ''), 160),
          updateFields,
          projectSelectionRequired: operation === 'update' && updateFields.includes('projectIds') && draft.projectSelectionRequired === true,
          decision: 'proposed', destinationStatus: 'pending', requestId: randomUUID(), idempotencyKey: randomUUID(),
        };
      }),
      createdAt: now, updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  get(scopeKey: string, sessionId: string): OrganizeSession | undefined {
    const value = this.sessions.get(sessionId);
    return value?.scopeKey === scopeKey ? cloneSession(value) : undefined;
  }

  setCommandThrough(scopeKey: string, sessionId: string, messageId: string, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => ({ ...session, commandThroughMessageId: messageId, updatedAt: now }));
  }

  decide(scopeKey: string, sessionId: string, itemId: string, expectedRevision: number, decision: OrganizeDecision, edit: Partial<OrganizeTaskDraft>, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => {
      if (session.revision !== expectedRevision) throw new OrganizeError('REVISION_CONFLICT', 409);
      if (session.state === 'applied') throw new OrganizeError('SESSION_FINALIZED', 409);
      const index = session.items.findIndex(item => item.id === itemId);
      if (index < 0) throw new OrganizeError('ITEM_NOT_FOUND', 404);
      if (session.items[index]?.destinationStatus !== 'pending') throw new OrganizeError('ITEM_ALREADY_ATTEMPTED', 409);
      const items = session.items.map((item, position) => position === index ? {
        ...item,
        decision,
        ...(edit.title !== undefined ? { title: requiredBounded(edit.title, 500, 'title') } : {}),
        ...(edit.details !== undefined ? { details: bounded(edit.details, 1_000) } : {}),
        ...(edit.operation !== undefined || edit.target !== undefined ? operationEdit(item, edit) : {}),
        ...(edit.projectIds !== undefined ? { projectIds: normalizedIds(edit.projectIds) } : {}),
      } : item);
      const changed = items[index]!;
      if (decision === 'accepted' && changed.operation === 'update' && !changed.target) {
        throw new OrganizeError('TARGET_REQUIRED', 400);
      }
      if (decision === 'accepted' && changed.projectSelectionRequired && changed.projectIds.length === 0) {
        throw new OrganizeError('PROJECT_SELECTION_REQUIRED', 400);
      }
      return { ...session, items, revision: session.revision + 1, updatedAt: now };
    });
  }

  recordAttempt(scopeKey: string, sessionId: string, itemId: string, result: VoyagerTaskReference | undefined, errorCode: string | undefined, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => ({
      ...session, updatedAt: now,
      items: session.items.map(item => {
        if (item.id !== itemId) return item;
        const { result: _priorResult, errorCode: _priorError, ...unchanged } = item;
        return { ...unchanged, destinationStatus: result ? 'applied' : 'failed',
          ...(result ? { result } : {}), ...(errorCode ? { errorCode } : {}) };
      }),
    }));
  }

  finishApply(scopeKey: string, sessionId: string, now: string): OrganizeSession {
    return this.update(scopeKey, sessionId, session => {
      const failed = session.items.some(item => item.decision === 'accepted' && item.destinationStatus !== 'applied');
      const state: OrganizeSessionState = failed ? 'partially_applied' : 'applied';
      const next = { ...session, state, revision: session.revision + 1, updatedAt: now, ...(state === 'applied' ? { appliedAt: now } : {}) };
      if (state === 'applied' && session.commandThroughMessageId) {
        this.cursors.set(`${scopeKey}\u0000${session.threadId}`, session.commandThroughMessageId);
      }
      return next;
    });
  }

  private update(scopeKey: string, sessionId: string, change: (session: OrganizeSession) => OrganizeSession): OrganizeSession {
    const current = this.sessions.get(sessionId);
    if (!current || current.scopeKey !== scopeKey) throw new OrganizeError('SESSION_NOT_FOUND', 404);
    const next = change(cloneSession(current));
    this.sessions.set(sessionId, next);
    return cloneSession(next);
  }
}

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

export interface OrganizeExtractor {
  readonly mode: string;
  extract(scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]>;
}

export class LocalOrganizeExtractor implements OrganizeExtractor {
  readonly mode = 'local-stub';
  async extract(_scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]> {
    const explicitUpdate = explicitVoyagerUpdateDraft(messages);
    if (explicitUpdate) return [explicitUpdate];
    const last = [...messages].reverse().find(message => message.role === 'user' && !isOrganizeCommand(message.content));
    if (!last) return [];
    const text = last.content.replace(/\s+/gu, ' ').trim();
    return [{ title: bounded(text, 80), details: bounded(text, 1_000) }];
  }
}

export class OpenAIOrganizeExtractor implements OrganizeExtractor {
  readonly mode = 'openai';
  constructor(private readonly options: { apiKey: string; model: string; endpoint?: string; fetcher?: typeof fetch; }) {}
  async extract(scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]> {
    if (!messages.length) return [];
    const explicitUpdate = explicitVoyagerUpdateDraft(messages);
    if (explicitUpdate) return [explicitUpdate];
    const response = await (this.options.fetcher ?? fetch)(this.options.endpoint ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        instructions: `会話から、ユーザーが実際に行いたい未完了の行動だけをVoyager Task案へ変換する。\n
各案は単独で着手できる粒度にする。単なる話題、完了済み事項、Shannonの相槌、内部推論はTaskにしない。\n
新規Taskはoperation=create、targetQuery=""、updateFields=[]、projectSelectionRequired=falseとする。titleは動詞で終わる短い日本語、detailsは具体的な実行内容にする。\n
既存Taskの更新依頼はoperation=updateとし、targetQueryへ対象Taskを検索できる元の名前、updateFieldsへユーザーが変更を求めたフィールドだけを入れる。変更を求められていないtitleを絶対にupdateFieldsへ入れず、更新操作の説明をtitleやdetailsとして生成しない。title/detailsには変更後の値を入れ、変更しないフィールドは空文字にする。Projectを選びたい依頼はupdateFieldsへprojectIdsを入れ、projectSelectionRequired=trueにする。会話全文を複製しない。最大12件。`,
        input: messages.slice(-100).map(message => ({ role: message.role, content: message.content.slice(0, 4_000) })),
        reasoning: { effort: 'none' },
        text: { verbosity: 'low', format: {
          type: 'json_schema', name: 'shannon_organize_voyager_tasks', strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            properties: { tasks: { type: 'array', maxItems: 12, items: {
              type: 'object', additionalProperties: false,
              properties: {
                operation: { type: 'string', enum: ['create', 'update'] },
                targetQuery: { type: 'string' },
                title: { type: 'string' },
                details: { type: 'string' },
                updateFields: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['title', 'details', 'projectIds'] } },
                projectSelectionRequired: { type: 'boolean' },
              },
              required: ['operation', 'targetQuery', 'title', 'details', 'updateFields', 'projectSelectionRequired'],
            } } }, required: ['tasks'],
          },
        } },
        max_output_tokens: 2_000, store: false,
        prompt_cache_key: `shannon_organize_${createHash('sha256').update(scopeKey).digest('hex').slice(0, 32)}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new OrganizeError('EXTRACTION_UNAVAILABLE', 502, true);
    const direct = typeof envelope.output_text === 'string' ? envelope.output_text : extractResponseText(envelope.output);
    let decoded: unknown;
    try { decoded = JSON.parse(direct); } catch { throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502); }
    if (!decoded || typeof decoded !== 'object' || !Array.isArray((decoded as { tasks?: unknown }).tasks)) throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
    return (decoded as { tasks: unknown[] }).tasks.map(value => {
      if (!value || typeof value !== 'object') throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      const row = value as Record<string, unknown>;
      if (typeof row.operation !== 'string' || !['create', 'update'].includes(row.operation)
        || typeof row.targetQuery !== 'string' || typeof row.title !== 'string' || typeof row.details !== 'string'
        || !Array.isArray(row.updateFields) || typeof row.projectSelectionRequired !== 'boolean') {
        throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      }
      const operation = row.operation as OrganizeOperation;
      if (operation === 'create') {
        return { title: requiredBounded(row.title, 500, 'title'), details: bounded(row.details, 1_000), operation };
      }
      const targetQuery = requiredBounded(row.targetQuery, 160, 'targetQuery');
      const updateFields = normalizedUpdateFields(row.updateFields as OrganizeUpdateField[], operation, false);
      const projectSelectionRequired = row.projectSelectionRequired === true;
      const fields = projectSelectionRequired && !updateFields.includes('projectIds')
        ? [...updateFields, 'projectIds' as const]
        : updateFields;
      if (fields.length === 0) throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      return {
        operation, targetQuery, updateFields: fields, projectSelectionRequired,
        title: fields.includes('title') ? requiredBounded(row.title, 500, 'title') : targetQuery,
        details: fields.includes('details') ? bounded(row.details, 1_000) : '',
      };
    });
  }
}

export function createConfiguredOrganizeExtractor(environment: Readonly<Record<string, string | undefined>> = process.env): OrganizeExtractor {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalOrganizeExtractor();
  const model = environment.SHANNON_ORGANIZE_MODEL?.trim() || environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna';
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(model)) throw new Error('SHANNON_ORGANIZE_MODEL is invalid');
  return new OpenAIOrganizeExtractor({ apiKey, model });
}

export interface VoyagerTaskDestination {
  apply(session: OrganizeSession, item: OrganizeItem): Promise<VoyagerTaskReference>;
}

export interface VoyagerCatalog {
  searchTasks(query: string, limit: number): Promise<VoyagerTaskProjection[]>;
  listProjects(limit: number): Promise<VoyagerProjectProjection[]>;
}

export class DisabledVoyagerCatalog implements VoyagerCatalog {
  async searchTasks(): Promise<VoyagerTaskProjection[]> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
  async listProjects(): Promise<VoyagerProjectProjection[]> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
}

export class HttpVoyagerCatalog implements VoyagerCatalog {
  constructor(private readonly options: {
    tasksEndpoint: string;
    projectsEndpoint: string;
    token: string;
    workspaceId: string;
    fetcher?: typeof fetch;
  }) {}

  async searchTasks(query: string, limit: number): Promise<VoyagerTaskProjection[]> {
    const url = new URL(this.options.tasksEndpoint);
    url.searchParams.set('workspaceId', this.options.workspaceId);
    url.searchParams.set('query', requiredBounded(query, 160, 'query'));
    url.searchParams.set('limit', String(normalizedLimit(limit, 20, 50)));
    const value = await this.read(url);
    return projectionItems(value).map(value => normalizedTaskProjection(value as VoyagerTaskProjection));
  }

  async listProjects(limit: number): Promise<VoyagerProjectProjection[]> {
    const url = new URL(this.options.projectsEndpoint);
    url.searchParams.set('workspaceId', this.options.workspaceId);
    url.searchParams.set('limit', String(normalizedLimit(limit, 20, 50)));
    const value = await this.read(url);
    return projectionItems(value).map(value => normalizedProjectProjection(value as VoyagerProjectProjection));
  }

  private async read(url: URL): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(url, {
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'x-syzygy-contract-version': '1.1',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof value.error === 'object' && value.error ? value.error as Record<string, unknown> : {};
      throw new OrganizeError(typeof error.code === 'string' ? error.code : 'DESTINATION_UNAVAILABLE', response.status, error.retryable === true);
    }
    if (value.contractVersion !== '1.1' || value.workspaceId !== this.options.workspaceId) {
      throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
    }
    return value;
  }
}

export class DisabledVoyagerTaskDestination implements VoyagerTaskDestination {
  async apply(): Promise<VoyagerTaskReference> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
}

export class HttpVoyagerTaskDestination implements VoyagerTaskDestination {
  constructor(private readonly options: { endpoint: string; token: string; workspaceId: string; fetcher?: typeof fetch; }) {}
  async apply(session: OrganizeSession, item: OrganizeItem): Promise<VoyagerTaskReference> {
    const isPhaseTwo = item.operation === 'update' || item.projectIds.length > 0;
    if (item.operation === 'update' && !item.target) throw new OrganizeError('TARGET_REQUIRED', 400);
    if (item.operation === 'update' && item.updateFields.length === 0) throw new OrganizeError('UPDATE_FIELDS_REQUIRED', 400);
    if (item.operation === 'update' && item.projectSelectionRequired && item.projectIds.length === 0) {
      throw new OrganizeError('PROJECT_SELECTION_REQUIRED', 400);
    }
    const contractVersion = isPhaseTwo ? '1.1' : '1.0';
    const changes = item.operation === 'update'
      ? {
          ...(item.updateFields.includes('title') ? { title: item.title } : {}),
          ...(item.updateFields.includes('details') ? { details: item.details } : {}),
          ...(item.updateFields.includes('projectIds') ? { projectIds: item.projectIds } : {}),
        }
      : {
          title: item.title,
          ...(isPhaseTwo ? { details: item.details, projectIds: item.projectIds } : item.details ? { details: item.details } : {}),
        };
    const body = {
      contractVersion, requestId: item.requestId, idempotencyKey: item.idempotencyKey,
      workspaceId: this.options.workspaceId, projectId: null,
      source: {
        system: 'shannon', resourceType: 'workSession', resourceId: session.id, title: '会話を整理',
        summary: item.operation === 'update' ? 'ユーザーが確認した既存Taskの更新案' : isPhaseTwo ? 'ユーザーが確認した新規Task案' : 'ユーザーが確認したTask案',
        updatedAt: session.createdAt, href: `shannon://work-sessions/${session.id}`,
      },
      kind: 'voyager.taskChange',
      payload: item.operation === 'update'
        ? {
            operation: 'update', targetTaskId: item.target!.id, expectedRevision: item.target!.revision,
            changes, reason: 'ユーザーが既存Taskへの反映を承認',
          }
        : { operation: 'create', changes },
      provenance: { conversationId: session.threadId, messageIds: session.sourceMessageIds, reason: '整理して' }, createdAt: session.createdAt,
    };
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(this.options.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json; charset=utf-8', 'idempotency-key': item.idempotencyKey, 'x-syzygy-contract-version': contractVersion },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof value.error === 'object' && value.error ? value.error as Record<string, unknown> : {};
      throw new OrganizeError(typeof error.code === 'string' ? error.code : 'DESTINATION_UNAVAILABLE', response.status, error.retryable === true);
    }
    const result = value.result as VoyagerTaskReference | undefined;
    if (!result || result.system !== 'voyager' || result.resourceType !== 'task' || !result.resourceId || !result.title) throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
    return result;
  }
}

export function createConfiguredVoyagerDestination(environment: Readonly<Record<string, string | undefined>> = process.env): VoyagerTaskDestination {
  const endpoint = environment.SHANNON_VOYAGER_INTEGRATION_URL?.trim();
  const token = environment.SHANNON_VOYAGER_INTEGRATION_TOKEN?.trim();
  const workspaceId = environment.SHANNON_VOYAGER_WORKSPACE_ID?.trim();
  return endpoint && token && workspaceId ? new HttpVoyagerTaskDestination({ endpoint, token, workspaceId }) : new DisabledVoyagerTaskDestination();
}

export function createConfiguredVoyagerCatalog(environment: Readonly<Record<string, string | undefined>> = process.env): VoyagerCatalog {
  const applyEndpoint = environment.SHANNON_VOYAGER_INTEGRATION_URL?.trim();
  const token = environment.SHANNON_VOYAGER_INTEGRATION_TOKEN?.trim();
  const workspaceId = environment.SHANNON_VOYAGER_WORKSPACE_ID?.trim();
  if (!applyEndpoint || !token || !workspaceId) return new DisabledVoyagerCatalog();
  let tasksEndpoint: string;
  let projectsEndpoint: string;
  try {
    const base = new URL(applyEndpoint);
    const prefix = base.pathname.replace(/\/task-changes:apply$/u, '');
    tasksEndpoint = environment.SHANNON_VOYAGER_TASK_SEARCH_URL?.trim() || new URL(`${prefix}/tasks/search`, base).toString();
    projectsEndpoint = environment.SHANNON_VOYAGER_PROJECTS_URL?.trim() || new URL(`${prefix}/projects`, base).toString();
  } catch { return new DisabledVoyagerCatalog(); }
  return new HttpVoyagerCatalog({ tasksEndpoint, projectsEndpoint, token, workspaceId });
}

export function isOrganizeCommand(value: string): boolean {
  return value.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '').trim() === '整理して';
}

export function isExplicitVoyagerUpdateRequest(value: string): boolean {
  return explicitVoyagerUpdateDraft([{ role: 'user', content: value }]) !== undefined;
}

export function explicitVoyagerUpdateDraft(messages: readonly ShannonConversationItem[]): OrganizeTaskDraft | undefined {
  const last = [...messages].reverse().find(message => message.role === 'user' && !isOrganizeCommand(message.content));
  if (!last) return undefined;
  const text = last.content.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = text.match(/^Voyagerにある[「"](.{1,160}?)[」"]の詳細を[「"]([\s\S]{1,1000}?)[」"]に更新して(?:、|,|して|、?\s*)?(.*)$/u);
  if (!match) return undefined;
  const targetQuery = requiredBounded(match[1] ?? '', 160, 'targetQuery');
  const details = bounded(match[2] ?? '', 1_000);
  if (!details) return undefined;
  const remainder = match[3] ?? '';
  const projectSelectionRequired = /(?:Project|プロジェクト).{0,40}(?:選|割り当て)/iu.test(remainder);
  return {
    operation: 'update',
    targetQuery,
    title: targetQuery,
    details,
    updateFields: projectSelectionRequired ? ['details', 'projectIds'] : ['details'],
    projectSelectionRequired,
  };
}

export function messagesAfterCursor(messages: readonly StoredConversationMessage[], cursor?: string): StoredConversationMessage[] {
  if (!cursor) return [...messages];
  const index = messages.findIndex(message => message.id === cursor);
  return index < 0 ? [...messages] : messages.slice(index + 1);
}

export class OrganizeError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryable = false) { super(code); }
}

function bounded(value: string, limit: number): string { return value.normalize('NFC').trim().slice(0, limit); }
function requiredBounded(value: string, limit: number, field: string): string {
  const result = bounded(value, limit); if (!result) throw new OrganizeError(`${field.toUpperCase()}_INVALID`, 400); return result;
}
function cloneSession(session: OrganizeSession): OrganizeSession { return structuredClone(session); }
function normalizedOperation(operation: OrganizeOperation | undefined, target: VoyagerTaskProjection | undefined): OrganizeOperation {
  return operation ?? (target ? 'update' : 'create');
}
function operationEdit(item: OrganizeItem, edit: Partial<OrganizeTaskDraft>): Pick<OrganizeItem, 'operation' | 'target'> {
  const operation = edit.operation ?? (edit.target ? 'update' : item.operation);
  if (operation === 'create') return { operation, target: undefined };
  const target = edit.target ?? item.target;
  if (!target) throw new OrganizeError('TARGET_REQUIRED', 400);
  return { operation, target: normalizedTaskProjection(target) };
}
function normalizedIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 12 || values.some(value => typeof value !== 'string')) {
    throw new OrganizeError('PROJECT_IDS_INVALID', 400);
  }
  return [...new Set(values.map(value => requiredBounded(value, 160, 'projectId')))];
}
function normalizedUpdateFields(
  values: readonly OrganizeUpdateField[] | undefined,
  operation: OrganizeOperation,
  legacyDefault = true,
): OrganizeUpdateField[] {
  if (operation === 'create') return [];
  if (values === undefined || (legacyDefault && values.length === 0)) return ['title', 'details', 'projectIds'];
  if (!Array.isArray(values) || values.length > 3 || values.some(value => !['title', 'details', 'projectIds'].includes(value))) {
    throw new OrganizeError('UPDATE_FIELDS_INVALID', 400);
  }
  return [...new Set(values)];
}
function storedUpdateFields(operation: OrganizeOperation, value: unknown): OrganizeUpdateField[] {
  if (operation === 'create') return [];
  if (typeof value !== 'string' || !value.trim()) return ['title', 'details', 'projectIds'];
  try {
    return normalizedUpdateFields(JSON.parse(value) as OrganizeUpdateField[], operation);
  } catch {
    return ['title', 'details', 'projectIds'];
  }
}
function normalizedTaskProjection(value: VoyagerTaskProjection): VoyagerTaskProjection {
  if (!value || typeof value !== 'object') throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.details !== 'string'
    || !Array.isArray(value.projectIds) || !Number.isInteger(value.revision) || value.revision < 1
    || typeof value.status !== 'string' || typeof value.updatedAt !== 'string') {
    throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  }
  return {
    id: requiredBounded(value.id, 160, 'taskId'), title: requiredBounded(value.title, 500, 'title'),
    details: bounded(value.details ?? '', 1_000), status: requiredBounded(value.status, 80, 'status'),
    projectIds: normalizedIds(value.projectIds ?? []), revision: value.revision, updatedAt: requiredBounded(value.updatedAt, 80, 'updatedAt'),
  };
}
function normalizedProjectProjection(value: VoyagerProjectProjection): VoyagerProjectProjection {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.title !== 'string'
    || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string') {
    throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  }
  return {
    id: requiredBounded(value.id, 160, 'projectId'), title: requiredBounded(value.title, 500, 'title'),
    revision: value.revision, updatedAt: requiredBounded(value.updatedAt, 80, 'updatedAt'),
  };
}
function projectionItems(value: Record<string, unknown>): unknown[] {
  if (!Array.isArray(value.items)) throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
  return value.items;
}
function normalizedLimit(value: number, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function extractResponseText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => {
    if (!item || typeof item !== 'object' || !Array.isArray((item as { content?: unknown }).content)) return [];
    return ((item as { content: unknown[] }).content).flatMap(entry => entry && typeof entry === 'object'
      && (entry as { type?: unknown }).type === 'output_text' && typeof (entry as { text?: unknown }).text === 'string'
      ? [(entry as { text: string }).text] : []);
  }).join('');
}
