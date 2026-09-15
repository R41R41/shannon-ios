import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentActivityStatus,
  AgentApproval,
  AgentChangeSummary,
  AgentCommandType,
  AgentEventTone,
  AgentHostHeartbeat,
  AgentPlanItem,
  AgentReasoningEffort,
  AgentTask,
  AgentTaskStatus,
  AgentTaskStore,
  AgentTestResult,
  AgentTimelineActivity,
  ClaimedAgentCommand,
  CreateAgentCommandInput,
  CreateAgentTaskInput,
  HostAgentEvent,
  AgentWorkspaceCatalog,
} from './agentTaskStore.js';
import { AgentHostRegistry, isReasoningEffort } from './agentHostRegistry.js';
import {
  AgentProjectProvisioningPersistence,
  type AgentProjectProvisioningEvent,
  type CreateAgentProjectProvisioningInput,
} from './agentProjectProvisioning.js';
import {
  AgentWorkspaceResourcePersistence,
  type AgentWorkspaceResourceEvent,
  type CreateAgentWorkspaceResourceInput,
} from './agentWorkspaceResources.js';

import {
  arrayValue,
  commandTitle,
  isTrue,
  migrateAgentTasks,
  normalizeApproval,
  parseArray,
  parseObject,
  prepareDatabaseLocation,
  projectedStatusForCommand,
  secureDatabaseFiles,
  stringValue,
  timelineActivity,
  toneForHostEvent,
  validateCommandTransition,
  type AgentCommandRow,
  type AgentEventRow,
  type AgentTaskRow,
} from './agentTaskPersistenceSupport.js';
export { migrateAgentTasks } from './agentTaskPersistenceSupport.js';

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
           changes_json, tests_json, created_at, updated_at, latest_sequence, assigned_host_id,
           project_hint, model_id, reasoning_effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, '[]', '[]', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        taskId, scopeKey, input.conversationThreadID, input.sourceMessageID ?? null,
        input.idempotencyKey, input.title, input.goal, input.summary,
        JSON.stringify(input.plan ?? []), now, now, input.hostHint?.trim() || null,
        input.projectHint?.trim() || null, input.model?.trim() || null, input.reasoningEffort ?? null,
      );
      this.appendEvent(taskId, 'queued', '作業を受け付けた', input.summary, 'neutral', now, {});
      this.insertCommand(taskId, scopeKey, `${input.idempotencyKey}:start`, 'start', {
        goal: input.goal,
        hostHint: input.hostHint,
        projectHint: input.projectHint,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      }, now);
      created = true;
    });
    return { task: this.requiredTask(scopeKey, taskId), created };
  }

  list(scopeKey: string): readonly AgentTask[] {
    const rows = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE scope_key = ? ORDER BY updated_at DESC LIMIT 100
    `).all(scopeKey) as unknown as AgentTaskRow[];
    return Object.freeze(rows.map(row => this.inflate(row)));
  }

  get(scopeKey: string, taskId: string): AgentTask | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE scope_key = ? AND task_id = ?
    `).get(scopeKey, taskId) as unknown as AgentTaskRow | undefined;
    return row ? this.inflate(row) : null;
  }

  updateMetadata(
    scopeKey: string,
    taskId: string,
    metadata: { isPinned?: boolean; isArchived?: boolean },
    now: string,
  ): AgentTask {
    const task = this.requiredTask(scopeKey, taskId);
    const archivableStatuses = new Set(['completed', 'failed', 'cancelled', 'proposed']);
    if (metadata.isArchived === true && !archivableStatuses.has(task.status)) {
      throw new Error('AGENT_TASK_ARCHIVE_ACTIVE');
    }
    const isPinned = metadata.isPinned ?? task.isPinned;
    const isArchived = metadata.isArchived ?? task.isArchived;
    this.database.prepare(`
      UPDATE agent_tasks SET is_pinned = ?, is_archived = ?, updated_at = ?
      WHERE task_id = ? AND scope_key = ?
    `).run(isPinned ? 1 : 0, isArchived ? 1 : 0, now, taskId, scopeKey);
    secureDatabaseFiles(this.path);
    return this.requiredTask(scopeKey, taskId);
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
        if (event.type === 'output') {
          this.database.prepare(`
            DELETE FROM agent_task_events WHERE event_id IN (
              SELECT event_id FROM agent_task_events
              WHERE task_id = ? AND event_type = 'host.output'
              ORDER BY sequence DESC LIMIT -1 OFFSET 120
            )
          `).run(event.taskId);
        }
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

  heartbeat(heartbeat: AgentHostHeartbeat, now: string): void {
    new AgentHostRegistry(this.database).heartbeat(heartbeat, now);
  }
  resolveHost(
    projectHint: string | undefined,
    preference: string | undefined,
    now: string,
    fallbackHost: string | null,
  ): string | null {
    return new AgentHostRegistry(this.database).resolveHost(projectHint, preference, now, fallbackHost);
  }

  workspaceCatalog(projectHint: string | undefined, now: string, fallbackHost: string | null): AgentWorkspaceCatalog {
    return new AgentHostRegistry(this.database).catalog(projectHint, now, fallbackHost);
  }
  resolveProvisioningHost(preference: string | undefined, now: string): string | null {
    return new AgentHostRegistry(this.database).resolveProvisioningHost(preference, now);
  }
  resolveProvisioningHosts(preference: string | undefined, now: string): readonly string[] {
    return new AgentHostRegistry(this.database).resolveProvisioningHosts(preference, now);
  }

  createProjectProvisioning(scopeKey: string, input: CreateAgentProjectProvisioningInput, now: string) {
    return new AgentProjectProvisioningPersistence(this.database).create(scopeKey, input, now);
  }
  listProjectProvisioning(scopeKey: string) { return new AgentProjectProvisioningPersistence(this.database).list(scopeKey); }
  claimProjectProvisioning(hostId: string, now: string) { return new AgentProjectProvisioningPersistence(this.database).claim(hostId, now); }
  recordProjectProvisioning(hostId: string, event: AgentProjectProvisioningEvent) {
    return new AgentProjectProvisioningPersistence(this.database).record(hostId, event);
  }
  createWorkspaceResource(scopeKey: string, input: CreateAgentWorkspaceResourceInput, now: string) {
    return new AgentWorkspaceResourcePersistence(this.database).create(scopeKey, input, now);
  }
  getWorkspaceResource(scopeKey: string, requestId: string) { return new AgentWorkspaceResourcePersistence(this.database).get(scopeKey, requestId); }
  claimWorkspaceResource(hostId: string, now: string) { return new AgentWorkspaceResourcePersistence(this.database).claim(hostId, now); }
  recordWorkspaceResource(hostId: string, event: AgentWorkspaceResourceEvent) { return new AgentWorkspaceResourcePersistence(this.database).record(hostId, event); }
  close(): void {
    if (!this.database.isOpen) return;
    this.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
    secureDatabaseFiles(this.path);
    this.database.close();
  }

  private inflate(row: AgentTaskRow): AgentTask {
    const eventRows = this.database.prepare(`
      SELECT event_id, sequence, title, detail, occurred_at, tone, payload_json
      FROM agent_task_events WHERE task_id = ? ORDER BY sequence ASC
    `).all(row.task_id) as unknown as AgentEventRow[];
    return Object.freeze({
      id: row.task_id,
      conversationThreadID: row.conversation_thread_id,
      ...(row.source_message_id ? { sourceMessageID: row.source_message_id } : {}),
      title: row.title,
      goal: row.goal,
      ...(row.assigned_host_id ? { assignedHostID: row.assigned_host_id } : {}),
      ...(row.project_hint ? { projectHint: row.project_hint } : {}),
      ...(row.model_id ? { model: row.model_id } : {}),
      ...(isReasoningEffort(row.reasoning_effort) ? { reasoningEffort: row.reasoning_effort } : {}),
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
      isPinned: row.is_pinned === 1,
      isArchived: row.is_archived === 1,
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
      .get(taskId) as unknown as AgentTaskRow | undefined;
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
      .get(commandId) as unknown as AgentCommandRow | undefined;
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
      case 'output':
        break;
      case 'approval_requested': {
        const approval = normalizeApproval(payload.approval, event.occurredAt);
        update('waiting_approval', event.detail ?? '判断を待っています。', approval.title);
        this.database.prepare('UPDATE agent_tasks SET pending_approval_json = ? WHERE task_id = ?')
          .run(JSON.stringify(approval), event.taskId);
        break;
      }
      case 'paused':
        update('paused', event.detail ?? '作業を一時停止した。', stringValue(payload.currentAction));
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
