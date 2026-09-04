import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AgentTaskStatus = 'proposed' | 'queued' | 'starting' | 'running'
  | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentCommandType = 'start' | 'steer' | 'interrupt' | 'resume' | 'resolve_approval';
export type AgentCommandStatus = 'pending' | 'leased' | 'completed' | 'failed';
export type AgentEventTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error';
export type AgentActivityKind = 'command';
export type AgentActivityStatus = 'running' | 'completed' | 'failed';

export interface AgentTimelineActivity {
  kind: AgentActivityKind;
  status: AgentActivityStatus;
}

export interface AgentPlanItem {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed';
}

export interface AgentTimelineEvent {
  id: string;
  sequence: number;
  title: string;
  detail?: string;
  occurredAt: string;
  tone: AgentEventTone;
  activity?: AgentTimelineActivity;
}

export interface AgentApproval {
  id: string;
  externalRequestID: string;
  kind: 'command' | 'file_change' | 'network' | 'permission';
  title: string;
  reason: string;
  resource?: string;
  requestedAt: string;
}

export interface AgentChangeSummary {
  id: string;
  displayName: string;
  summary: string;
  additions: number;
  deletions: number;
}

export interface AgentTestResult {
  id: string;
  name: string;
  status: 'pending' | 'passed' | 'failed';
  detail?: string;
}

export interface AgentTask {
  id: string;
  conversationThreadID: string;
  sourceMessageID?: string;
  title: string;
  goal: string;
  status: AgentTaskStatus;
  summary: string;
  currentAction?: string;
  plan: AgentPlanItem[];
  timeline: AgentTimelineEvent[];
  pendingApproval?: AgentApproval;
  changes: AgentChangeSummary[];
  tests: AgentTestResult[];
  createdAt: string;
  updatedAt: string;
  latestSequence: number;
}

export interface CreateAgentTaskInput {
  taskId?: string;
  idempotencyKey: string;
  conversationThreadID: string;
  sourceMessageID?: string;
  title: string;
  goal: string;
  summary: string;
  plan?: AgentPlanItem[];
  hostHint?: string;
  projectHint?: string;
}

export interface CreateAgentCommandInput {
  idempotencyKey: string;
  type: AgentCommandType;
  payload?: Record<string, unknown>;
}

export interface ClaimedAgentCommand {
  id: string;
  taskId: string;
  scopeKey: string;
  type: AgentCommandType;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: string;
  leaseUntil: string;
}

export interface HostAgentEvent {
  eventId: string;
  taskId: string;
  type: 'started' | 'progress' | 'approval_requested' | 'paused' | 'completed' | 'failed' | 'command_completed';
  title: string;
  detail?: string;
  tone?: AgentEventTone;
  occurredAt: string;
  payload?: Record<string, unknown>;
}

export interface AgentTaskStore {
  create(scopeKey: string, input: CreateAgentTaskInput, now: string): { task: AgentTask; created: boolean };
  list(scopeKey: string): readonly AgentTask[];
  get(scopeKey: string, taskId: string): AgentTask | null;
  enqueue(scopeKey: string, taskId: string, input: CreateAgentCommandInput, now: string): {
    task: AgentTask;
    command: ClaimedAgentCommand | null;
    created: boolean;
  };
  claim(hostId: string, now: string, leaseSeconds?: number): ClaimedAgentCommand | null;
  recordHostEvents(hostId: string, events: readonly HostAgentEvent[], now: string): readonly AgentTask[];
  heartbeat(hostId: string, displayName: string, capabilities: readonly string[], now: string): void;
}

interface TaskRow {
  task_id: string;
  conversation_thread_id: string;
  source_message_id: string | null;
  title: string;
  goal: string;
  status: AgentTaskStatus;
  summary: string;
  current_action: string | null;
  plan_json: string;
  pending_approval_json: string | null;
  changes_json: string;
  tests_json: string;
  created_at: string;
  updated_at: string;
  latest_sequence: number;
}

interface EventRow {
  event_id: string;
  sequence: number;
  title: string;
  detail: string | null;
  occurred_at: string;
  tone: AgentEventTone;
  payload_json: string;
}

interface CommandRow {
  command_id: string;
  task_id: string;
  scope_key: string;
  command_type: AgentCommandType;
  payload_json: string;
  attempts: number;
  created_at: string;
  lease_until: string | null;
}

export class SQLiteAgentTaskStore implements AgentTaskStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string) {
    prepareDatabaseLocation(path);
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    migrateAgentTasks(this.database);
    secureDatabaseFiles(path);
  }

  create(scopeKey: string, input: CreateAgentTaskInput, now: string): { task: AgentTask; created: boolean } {
    let created = false;
    let taskId = '';
    this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT task_id FROM agent_tasks WHERE scope_key = ? AND start_idempotency_key = ?
      `).get(scopeKey, input.idempotencyKey) as unknown as { task_id: string } | undefined;
      if (existing) {
        taskId = existing.task_id;
        return;
      }
      taskId = input.taskId ?? randomUUID();
      const idCollision = this.database.prepare('SELECT 1 AS found FROM agent_tasks WHERE task_id = ?').get(taskId);
      if (idCollision) throw new Error('AGENT_TASK_ID_CONFLICT');
      this.database.prepare(`
        INSERT INTO agent_tasks
          (task_id, scope_key, conversation_thread_id, source_message_id, start_idempotency_key,
           title, goal, status, summary, current_action, plan_json, pending_approval_json,
           changes_json, tests_json, created_at, updated_at, latest_sequence, assigned_host_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, '[]', '[]', ?, ?, 0, ?)
      `).run(
        taskId, scopeKey, input.conversationThreadID, input.sourceMessageID ?? null,
        input.idempotencyKey, input.title, input.goal, input.summary,
        JSON.stringify(input.plan ?? []), now, now, input.hostHint?.trim() || null,
      );
      this.appendEvent(taskId, 'queued', '作業を受け付けた', input.summary, 'neutral', now, {});
      this.insertCommand(taskId, scopeKey, `${input.idempotencyKey}:start`, 'start', {
        goal: input.goal,
        hostHint: input.hostHint,
        projectHint: input.projectHint,
      }, now);
      created = true;
    });
    return { task: this.requiredTask(scopeKey, taskId), created };
  }

  list(scopeKey: string): readonly AgentTask[] {
    const rows = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE scope_key = ? ORDER BY updated_at DESC LIMIT 100
    `).all(scopeKey) as unknown as TaskRow[];
    return Object.freeze(rows.map(row => this.inflate(row)));
  }

  get(scopeKey: string, taskId: string): AgentTask | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE scope_key = ? AND task_id = ?
    `).get(scopeKey, taskId) as unknown as TaskRow | undefined;
    return row ? this.inflate(row) : null;
  }

  enqueue(scopeKey: string, taskId: string, input: CreateAgentCommandInput, now: string): {
    task: AgentTask;
    command: ClaimedAgentCommand | null;
    created: boolean;
  } {
    let created = false;
    let commandId: string | null = null;
    this.transaction(() => {
      const task = this.requiredTask(scopeKey, taskId);
      const existing = this.database.prepare(`
        SELECT command_id FROM agent_task_commands WHERE scope_key = ? AND idempotency_key = ?
      `).get(scopeKey, input.idempotencyKey) as unknown as { command_id: string } | undefined;
      if (existing) {
        commandId = existing.command_id;
        return;
      }
      validateCommandTransition(task, input.type, input.payload ?? {});
      commandId = this.insertCommand(taskId, scopeKey, input.idempotencyKey, input.type, input.payload ?? {}, now);
      const projection = projectedStatusForCommand(task.status, input.type, input.payload ?? {});
      this.database.prepare(`
        UPDATE agent_tasks
        SET status = ?, summary = ?, current_action = ?, pending_approval_json = ?, updated_at = ?
        WHERE task_id = ? AND scope_key = ?
      `).run(
        projection.status,
        projection.summary ?? task.summary,
        projection.currentAction ?? task.currentAction ?? null,
        projection.clearApproval ? null : task.pendingApproval ? JSON.stringify(task.pendingApproval) : null,
        now, taskId, scopeKey,
      );
      this.appendEvent(
        taskId,
        `command.${input.type}`,
        commandTitle(input.type, input.payload ?? {}),
        typeof input.payload?.instruction === 'string' ? input.payload.instruction : undefined,
        input.type === 'interrupt' ? 'warning' : 'progress',
        now,
        { commandId },
      );
      created = true;
    });
    return {
      task: this.requiredTask(scopeKey, taskId),
      command: commandId ? this.command(commandId) : null,
      created,
    };
  }

  claim(hostId: string, now: string, leaseSeconds = 35): ClaimedAgentCommand | null {
    let commandId: string | null = null;
    const leaseUntil = new Date(Date.parse(now) + Math.max(10, Math.min(120, leaseSeconds)) * 1_000).toISOString();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE agent_task_commands
        SET status = 'pending', lease_owner = NULL, lease_until = NULL
        WHERE status = 'leased' AND lease_until <= ?
      `).run(now);
      const row = this.database.prepare(`
        SELECT c.command_id
        FROM agent_task_commands c
        JOIN agent_tasks t ON t.task_id = c.task_id
        WHERE c.status = 'pending' AND c.available_at <= ?
          AND (
            t.assigned_host_id = ?
            OR (
              c.command_type = 'start' AND t.assigned_host_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_tasks active
                WHERE active.assigned_host_id = ?
                  AND active.status IN ('queued','starting','running','waiting_approval','paused')
              )
            )
          )
        ORDER BY c.sequence ASC LIMIT 1
      `).get(now, hostId, hostId) as unknown as { command_id: string } | undefined;
      if (!row) return;
      const changed = this.database.prepare(`
        UPDATE agent_task_commands
        SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE command_id = ? AND status = 'pending'
      `).run(hostId, leaseUntil, row.command_id);
      if (Number(changed.changes) === 0) return;
      commandId = row.command_id;
      const command = this.command(commandId);
      if (command?.type === 'start') {
        this.database.prepare(`
          UPDATE agent_tasks SET status = 'starting', summary = '作業を始める準備中。',
            current_action = '作業環境へ接続中', assigned_host_id = ?, updated_at = ?
          WHERE task_id = ? AND status = 'queued'
        `).run(hostId, now, command.taskId);
        this.appendEvent(command.taskId, 'starting', '作業環境が依頼を受け取った', undefined, 'progress', now, { hostId });
      }
    });
    return commandId ? this.command(commandId, leaseUntil) : null;
  }

  recordHostEvents(hostId: string, events: readonly HostAgentEvent[], now: string): readonly AgentTask[] {
    const changed = new Set<string>();
    this.transaction(() => {
      for (const event of events) {
        const duplicate = this.database.prepare(`
          SELECT 1 AS found FROM agent_task_events WHERE event_id = ?
        `).get(event.eventId);
        if (duplicate) continue;
        const row = this.database.prepare(`SELECT scope_key, assigned_host_id, status FROM agent_tasks WHERE task_id = ?`)
          .get(event.taskId) as unknown as {
            scope_key: string;
            assigned_host_id: string | null;
            status: AgentTaskStatus;
          } | undefined;
        if (!row) continue;
        if (row.assigned_host_id !== hostId) throw new Error('AGENT_HOST_TASK_MISMATCH');
        if (['completed', 'failed', 'cancelled'].includes(row.status) && event.type !== 'command_completed') continue;
        this.projectHostEvent(event, now);
        this.appendEvent(
          event.taskId, `host.${event.type}`, event.title, event.detail,
          event.tone ?? toneForHostEvent(event.type), event.occurredAt, { ...(event.payload ?? {}), hostId }, event.eventId,
        );
        if (event.type === 'command_completed' && typeof event.payload?.commandId === 'string') {
          this.database.prepare(`
            UPDATE agent_task_commands SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_until = NULL
            WHERE command_id = ? AND lease_owner = ?
          `).run(event.occurredAt, event.payload.commandId, hostId);
        }
        changed.add(event.taskId);
      }
    });
    return Object.freeze([...changed].map(taskId => this.taskById(taskId)).filter((task): task is AgentTask => task !== null));
  }

  heartbeat(hostId: string, displayName: string, capabilities: readonly string[], now: string): void {
    this.database.prepare(`
      INSERT INTO agent_hosts (host_id, display_name, capabilities_json, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET display_name = excluded.display_name,
        capabilities_json = excluded.capabilities_json, last_seen_at = excluded.last_seen_at
    `).run(hostId, displayName, JSON.stringify(capabilities), now);
  }

  close(): void {
    if (!this.database.isOpen) return;
    this.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
    secureDatabaseFiles(this.path);
    this.database.close();
  }

  private inflate(row: TaskRow): AgentTask {
    const eventRows = this.database.prepare(`
      SELECT event_id, sequence, title, detail, occurred_at, tone, payload_json
      FROM agent_task_events WHERE task_id = ? ORDER BY sequence ASC
    `).all(row.task_id) as unknown as EventRow[];
    return Object.freeze({
      id: row.task_id,
      conversationThreadID: row.conversation_thread_id,
      ...(row.source_message_id ? { sourceMessageID: row.source_message_id } : {}),
      title: row.title,
      goal: row.goal,
      status: row.status,
      summary: row.summary,
      ...(row.current_action ? { currentAction: row.current_action } : {}),
      plan: parseArray<AgentPlanItem>(row.plan_json),
      timeline: eventRows.map(event => {
        const activity = timelineActivity(parseObject<Record<string, unknown>>(event.payload_json).activity);
        return {
          id: event.event_id,
          sequence: Number(event.sequence),
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          occurredAt: event.occurred_at,
          tone: event.tone,
          ...(activity ? { activity } : {}),
        };
      }),
      ...(row.pending_approval_json ? { pendingApproval: parseObject<AgentApproval>(row.pending_approval_json) } : {}),
      changes: parseArray<AgentChangeSummary>(row.changes_json),
      tests: parseArray<AgentTestResult>(row.tests_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestSequence: Number(row.latest_sequence),
    });
  }

  private requiredTask(scopeKey: string, taskId: string): AgentTask {
    const task = this.get(scopeKey, taskId);
    if (!task) throw new Error('AGENT_TASK_NOT_FOUND');
    return task;
  }

  private taskById(taskId: string): AgentTask | null {
    const row = this.database.prepare('SELECT * FROM agent_tasks WHERE task_id = ?')
      .get(taskId) as unknown as TaskRow | undefined;
    return row ? this.inflate(row) : null;
  }

  private insertCommand(
    taskId: string,
    scopeKey: string,
    idempotencyKey: string,
    type: AgentCommandType,
    payload: Record<string, unknown>,
    now: string,
  ): string {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO agent_task_commands
        (command_id, task_id, scope_key, idempotency_key, command_type, payload_json,
         status, available_at, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
    `).run(id, taskId, scopeKey, idempotencyKey, type, JSON.stringify(payload), now, now);
    return id;
  }

  private command(commandId: string, fallbackLeaseUntil?: string): ClaimedAgentCommand | null {
    const row = this.database.prepare(`SELECT * FROM agent_task_commands WHERE command_id = ?`)
      .get(commandId) as unknown as CommandRow | undefined;
    if (!row) return null;
    return Object.freeze({
      id: row.command_id,
      taskId: row.task_id,
      scopeKey: row.scope_key,
      type: row.command_type,
      payload: parseObject<Record<string, unknown>>(row.payload_json),
      attempts: Number(row.attempts),
      createdAt: row.created_at,
      leaseUntil: row.lease_until ?? fallbackLeaseUntil ?? row.created_at,
    });
  }

  private appendEvent(
    taskId: string,
    type: string,
    title: string,
    detail: string | undefined,
    tone: AgentEventTone,
    occurredAt: string,
    payload: Record<string, unknown>,
    eventId: string = randomUUID(),
  ): void {
    const task = this.database.prepare('SELECT latest_sequence FROM agent_tasks WHERE task_id = ?')
      .get(taskId) as unknown as { latest_sequence: number } | undefined;
    if (!task) throw new Error('AGENT_TASK_NOT_FOUND');
    const sequence = Number(task.latest_sequence) + 1;
    this.database.prepare(`
      INSERT INTO agent_task_events
        (event_id, task_id, sequence, event_type, title, detail, tone, occurred_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, taskId, sequence, type, title, detail ?? null, tone, occurredAt, JSON.stringify(payload));
    this.database.prepare(`UPDATE agent_tasks SET latest_sequence = ?, updated_at = ? WHERE task_id = ?`)
      .run(sequence, occurredAt, taskId);
  }

  private projectHostEvent(event: HostAgentEvent, now: string): void {
    const payload = event.payload ?? {};
    const clearPendingApproval = (): void => {
      this.database.prepare('UPDATE agent_tasks SET pending_approval_json = NULL WHERE task_id = ?')
        .run(event.taskId);
    };
    const update = (status: AgentTaskStatus, summary: string, currentAction?: string): void => {
      this.database.prepare(`
        UPDATE agent_tasks SET status = ?, summary = ?, current_action = ?, updated_at = ? WHERE task_id = ?
      `).run(status, summary, currentAction ?? null, event.occurredAt || now, event.taskId);
    };
    switch (event.type) {
      case 'started':
        update('running', event.detail ?? '作業を始めた。', stringValue(payload.currentAction));
        clearPendingApproval();
        break;
      case 'progress':
        update('running', event.detail ?? event.title, stringValue(payload.currentAction));
        if (Array.isArray(payload.plan)) this.database.prepare('UPDATE agent_tasks SET plan_json = ? WHERE task_id = ?')
          .run(JSON.stringify(payload.plan), event.taskId);
        break;
      case 'approval_requested': {
        const approval = normalizeApproval(payload.approval, event.occurredAt);
        update('waiting_approval', event.detail ?? '判断を待っています。', approval.title);
        this.database.prepare('UPDATE agent_tasks SET pending_approval_json = ? WHERE task_id = ?')
          .run(JSON.stringify(approval), event.taskId);
        break;
      }
      case 'paused':
        update('paused', event.detail ?? '作業を一時停止した。');
        clearPendingApproval();
        break;
      case 'completed':
        update('completed', event.detail ?? '作業が完了した。');
        this.database.prepare(`
          UPDATE agent_tasks SET changes_json = ?, tests_json = ?, pending_approval_json = NULL WHERE task_id = ?
        `).run(JSON.stringify(arrayValue(payload.changes)), JSON.stringify(arrayValue(payload.tests)), event.taskId);
        break;
      case 'failed':
        update('failed', event.detail ?? '作業を完了できなかった。');
        clearPendingApproval();
        break;
      case 'command_completed':
        break;
    }
  }

  private transaction(operation: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.database.exec('COMMIT');
      secureDatabaseFiles(this.path);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly delegate = new SQLiteAgentTaskStore(':memory:');
  create(scopeKey: string, input: CreateAgentTaskInput, now: string) { return this.delegate.create(scopeKey, input, now); }
  list(scopeKey: string) { return this.delegate.list(scopeKey); }
  get(scopeKey: string, taskId: string) { return this.delegate.get(scopeKey, taskId); }
  enqueue(scopeKey: string, taskId: string, input: CreateAgentCommandInput, now: string) {
    return this.delegate.enqueue(scopeKey, taskId, input, now);
  }
  claim(hostId: string, now: string, leaseSeconds?: number) { return this.delegate.claim(hostId, now, leaseSeconds); }
  recordHostEvents(hostId: string, events: readonly HostAgentEvent[], now: string) {
    return this.delegate.recordHostEvents(hostId, events, now);
  }
  heartbeat(hostId: string, displayName: string, capabilities: readonly string[], now: string) {
    this.delegate.heartbeat(hostId, displayName, capabilities, now);
  }
}

export function migrateAgentTasks(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      task_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      conversation_thread_id TEXT NOT NULL,
      source_message_id TEXT,
      start_idempotency_key TEXT NOT NULL,
      assigned_host_id TEXT,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed','queued','starting','running','waiting_approval','paused','completed','failed','cancelled')),
      summary TEXT NOT NULL,
      current_action TEXT,
      plan_json TEXT NOT NULL DEFAULT '[]',
      pending_approval_json TEXT,
      changes_json TEXT NOT NULL DEFAULT '[]',
      tests_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
      UNIQUE (scope_key, start_idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_scope_updated ON agent_tasks (scope_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      tone TEXT NOT NULL CHECK (tone IN ('neutral','progress','success','warning','error')),
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (task_id, sequence),
      FOREIGN KEY (task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_task_events_task_sequence ON agent_task_events (task_id, sequence);

    CREATE TABLE IF NOT EXISTS agent_task_commands (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK (command_type IN ('start','steer','interrupt','resume','resolve_approval')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending','leased','completed','failed')),
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT,
      UNIQUE (scope_key, idempotency_key),
      FOREIGN KEY (task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_task_commands_claim ON agent_task_commands (status, available_at, sequence);

    CREATE TABLE IF NOT EXISTS agent_hosts (
      host_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT NOT NULL
    );
  `);
  const taskColumns = database.prepare("PRAGMA table_info('agent_tasks')").all() as unknown as Array<{ name: string }>;
  if (!taskColumns.some(column => column.name === 'assigned_host_id')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN assigned_host_id TEXT;');
  }
}

function validateCommandTransition(task: AgentTask, type: AgentCommandType, payload: Record<string, unknown>): void {
  const status = task.status;
  const allowed = (type === 'steer' && (status === 'running' || status === 'paused'))
    || (type === 'interrupt' && ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(status))
    || (type === 'resume' && status === 'paused')
    || (type === 'resolve_approval' && status === 'waiting_approval');
  if (!allowed) throw new Error('AGENT_COMMAND_INVALID_STATE');
  if (type === 'steer' && (typeof payload.instruction !== 'string' || !payload.instruction.trim())) {
    throw new Error('AGENT_COMMAND_INVALID_PAYLOAD');
  }
  if (type === 'resolve_approval'
    && !['allow_once', 'allow_session', 'deny'].includes(String(payload.decision))) {
    throw new Error('AGENT_COMMAND_INVALID_PAYLOAD');
  }
  if (type === 'resolve_approval'
    && payload.externalRequestID !== task.pendingApproval?.externalRequestID) {
    throw new Error('AGENT_COMMAND_STALE_APPROVAL');
  }
}

function projectedStatusForCommand(status: AgentTaskStatus, type: AgentCommandType, payload: Record<string, unknown>): {
  status: AgentTaskStatus;
  summary?: string;
  currentAction?: string;
  clearApproval?: boolean;
} {
  switch (type) {
    case 'steer': return { status: 'running', summary: '追加の指示を受け付けた。', currentAction: String(payload.instruction) };
    case 'interrupt': return isTrue(payload.cancel)
      ? { status: 'cancelled', summary: 'この作業を中止した。', currentAction: '', clearApproval: true }
      : { status: 'paused', summary: '作業を一時停止しています。', currentAction: '' };
    case 'resume': return { status: 'starting', summary: '作業を再開しています。', currentAction: '作業環境へ再接続中' };
    case 'resolve_approval': return payload.decision === 'deny'
      ? { status: 'cancelled', summary: '許可されなかったので、ここで止めた。', currentAction: '', clearApproval: true }
      : { status: 'starting', summary: '判断を受け取り、続きを始めています。', currentAction: '操作結果を作業環境へ送信中', clearApproval: true };
    case 'start': return { status };
  }
}

function commandTitle(type: AgentCommandType, payload: Record<string, unknown>): string {
  switch (type) {
    case 'start': return '作業を開始';
    case 'steer': return '追加の指示を送信';
    case 'interrupt': return isTrue(payload.cancel) ? '作業を中止' : '作業を一時停止';
    case 'resume': return '作業を再開';
    case 'resolve_approval': return payload.decision === 'deny' ? '操作を許可しない' : '操作を許可';
  }
}

function toneForHostEvent(type: HostAgentEvent['type']): AgentEventTone {
  if (type === 'completed') return 'success';
  if (type === 'failed') return 'error';
  if (type === 'approval_requested' || type === 'paused') return 'warning';
  return 'progress';
}

function normalizeApproval(value: unknown, now: string): AgentApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_APPROVAL_INVALID');
  const object = value as Record<string, unknown>;
  const kind = ['command', 'file_change', 'network', 'permission'].includes(String(object.kind))
    ? String(object.kind) as AgentApproval['kind'] : 'permission';
  return {
    id: typeof object.id === 'string' ? object.id : randomUUID(),
    externalRequestID: typeof object.externalRequestID === 'string' ? object.externalRequestID : randomUUID(),
    kind,
    title: typeof object.title === 'string' ? object.title : '操作の許可',
    reason: typeof object.reason === 'string' ? object.reason : '作業を続けるために確認が必要です。',
    ...(typeof object.resource === 'string' ? { resource: object.resource } : {}),
    requestedAt: typeof object.requestedAt === 'string' ? object.requestedAt : now,
  };
}

function timelineActivity(value: unknown): AgentTimelineActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const activity = value as Record<string, unknown>;
  if (activity.kind !== 'command') return undefined;
  if (!['running', 'completed', 'failed'].includes(String(activity.status))) return undefined;
  return {
    kind: 'command',
    status: activity.status as AgentActivityStatus,
  };
}

function parseArray<T>(json: string): T[] {
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? value as T[] : [];
}

function parseObject<T extends object>(json: string): T {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_JSON_INVALID');
  return value as T;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
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
