import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentActivityStatus,
  AgentApproval,
  AgentCommandType,
  AgentEventTone,
  AgentPauseReason,
  AgentTask,
  AgentTaskStatus,
  AgentTimelineActivity,
  HostAgentEvent,
} from '../agentTaskStore.js';
import { migrateAgentProjectProvisioning } from './agentProjectProvisioning.js';
import { migrateAgentWorkspaceResources } from './agentWorkspaceResources.js';

export interface AgentTaskRow {
  task_id: string;
  /** Absent while FCA has never been enabled; NULL identifies the existing Agent Host executor. */
  fca_kind?: string | null;
  scope_key: string;
  conversation_thread_id: string;
  source_message_id: string | null;
  cognitive_intent_id: string | null;
  title: string;
  goal: string;
  assigned_host_id: string | null;
  project_hint: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  status: AgentTaskStatus;
  summary: string;
  current_action: string | null;
  pause_reason: string | null;
  pause_sequence: number | null;
  plan_json: string;
  pending_approval_json: string | null;
  changes_json: string;
  tests_json: string;
  is_pinned: number;
  is_archived: number;
  created_at: string;
  updated_at: string;
  latest_sequence: number;
}

export interface AgentEventRow {
  event_id: string;
  sequence: number;
  title: string;
  detail: string | null;
  occurred_at: string;
  tone: AgentEventTone;
  payload_json: string;
}

export interface AgentCommandRow {
  command_id: string;
  task_id: string;
  scope_key: string;
  command_type: AgentCommandType;
  payload_json: string;
  attempts: number;
  created_at: string;
  lease_until: string | null;
}

export function migrateAgentTasks(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      task_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      conversation_thread_id TEXT NOT NULL,
      source_message_id TEXT,
      cognitive_intent_id TEXT,
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
      host_kind TEXT NOT NULL DEFAULT 'local',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      projects_json TEXT NOT NULL DEFAULT '[]',
      models_json TEXT NOT NULL DEFAULT '[]',
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT NOT NULL
    );
  `);
  const taskColumns = database.prepare("PRAGMA table_info('agent_tasks')").all() as unknown as Array<{ name: string }>;
  if (!taskColumns.some(column => column.name === 'assigned_host_id')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN assigned_host_id TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'cognitive_intent_id')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN cognitive_intent_id TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'project_hint')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN project_hint TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'model_id')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN model_id TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'reasoning_effort')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN reasoning_effort TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'is_pinned')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1));');
  }
  if (!taskColumns.some(column => column.name === 'is_archived')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1));');
  }
  if (!taskColumns.some(column => column.name === 'pause_reason')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN pause_reason TEXT;');
  }
  if (!taskColumns.some(column => column.name === 'pause_sequence')) {
    database.exec('ALTER TABLE agent_tasks ADD COLUMN pause_sequence INTEGER;');
  }
  const hostColumns = database.prepare("PRAGMA table_info('agent_hosts')").all() as unknown as Array<{ name: string }>;
  if (!hostColumns.some(column => column.name === 'host_kind')) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN host_kind TEXT NOT NULL DEFAULT 'local';");
  }
  if (!hostColumns.some(column => column.name === 'projects_json')) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!hostColumns.some(column => column.name === 'models_json')) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!hostColumns.some(column => column.name === 'workspaces_json')) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN workspaces_json TEXT NOT NULL DEFAULT '[]';");
  }
  migrateAgentProjectProvisioning(database);
  migrateAgentWorkspaceResources(database);
}

export function validateCommandTransition(task: AgentTask, type: AgentCommandType, payload: Record<string, unknown>): void {
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

/** A paused row says why: the owner paused it, or the host stopped and needs the owner (older rows infer it). */
export function pauseProjection(row: AgentTaskRow): { pauseReason?: AgentPauseReason; pauseSequence?: number } {
  if (row.status !== 'paused') return {};
  const pauseReason: AgentPauseReason = row.pause_reason === 'owner' || row.pause_reason === 'needs_owner'
    ? row.pause_reason : row.current_action ? 'needs_owner' : 'owner';
  return { pauseReason, ...(row.pause_sequence === null ? {} : { pauseSequence: Number(row.pause_sequence) }) };
}

export function projectedStatusForCommand(
  status: AgentTaskStatus,
  type: AgentCommandType,
  payload: Record<string, unknown>,
  approval?: AgentApproval,
): {
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
    case 'resolve_approval':
      if (payload.decision !== 'deny') {
        return { status: 'starting', summary: '許可を受け取り、続きを始めています。', currentAction: '操作結果を作業環境へ送信中', clearApproval: true };
      }
      // A host that declines only the one operation says so on the approval. Older hosts stop the whole task.
      return approval?.denyContinues === true
        ? { status: 'starting', summary: 'この操作は許可されなかった。別の進め方を確認しています。', currentAction: '許可しない判断を作業環境へ送信中', clearApproval: true }
        : { status: 'cancelled', summary: '許可されなかったので、作業を中止した。', currentAction: '', clearApproval: true };
    case 'start': return { status };
  }
}

export function commandTitle(type: AgentCommandType, payload: Record<string, unknown>): string {
  switch (type) {
    case 'start': return '作業を開始';
    case 'steer': return '追加の指示を送信';
    case 'interrupt': return isTrue(payload.cancel) ? '作業を中止' : '作業を一時停止';
    case 'resume': return '作業を再開';
    case 'resolve_approval': return payload.decision === 'deny' ? '操作を許可しない' : '操作を許可';
  }
}

export function toneForHostEvent(type: HostAgentEvent['type']): AgentEventTone {
  if (type === 'completed') return 'success';
  if (type === 'failed') return 'error';
  if (type === 'approval_requested' || type === 'paused') return 'warning';
  return 'progress';
}

export function normalizeApproval(value: unknown, now: string): AgentApproval {
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
    ...(object.denyContinues === true ? { denyContinues: true } : {}),
    requestedAt: typeof object.requestedAt === 'string' ? object.requestedAt : now,
  };
}

export function timelineActivity(value: unknown): AgentTimelineActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const activity = value as Record<string, unknown>;
  if (activity.kind !== 'command') return undefined;
  if (!['running', 'completed', 'failed'].includes(String(activity.status))) return undefined;
  return {
    kind: 'command',
    status: activity.status as AgentActivityStatus,
  };
}

export function parseArray<T>(json: string): T[] {
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? value as T[] : [];
}

export function parseObject<T extends object>(json: string): T {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_JSON_INVALID');
  return value as T;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function prepareDatabaseLocation(path: string): void {
  if (path === ':memory:') return;
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
}

export function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}
