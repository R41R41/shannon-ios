import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkpointPassive, openDatabase } from '../../../../infra/sqlite/sqliteOpen.js';
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
} from '../agentTaskStore.js';
import { AgentHostRegistry, isReasoningEffort } from './agentHostRegistry.js';
import { closedWithUnknownOutcome, hostEventIgnored, projectHostEventInBatch } from './agentTaskHostProjection.js';
import { AgentTaskQueue } from './agentTaskQueue.js';
import { fcaHostPredicate } from './fcaHostPredicate.js';
import { TaskTreeStore } from './taskTreeStore.js';
import { TASK_STORE_STEPS } from './taskExecutionColumns.js';
import { writeTaskState } from './taskStore.js';
import { closeUnknownHostTasks, type ClosedUnknownHostTasks } from './agentTaskUnknownExit.js';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { withAgentTaskRequest } from './agentTaskRequestWindow.js';
import { taskTreeAuthority } from '@shannon/mind';
import type { ActionLease } from '../../../../contracts/actionThreadContract.js';
import type { TaskTreeLearningCallbacks } from '../taskTreePorts.js';
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
  commandTitle,
  isTrue,
  migrateAgentTasks,
  parseArray,
  parseObject,
  pauseProjection,
  prepareDatabaseLocation,
  secureDatabaseFiles,
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
  private readonly queue: AgentTaskQueue;
  readonly taskTrees?: TaskTreeStore;

  constructor(private readonly path: string, options: { taskTreeEnabled?: boolean; taskTreeCallbacks?: TaskTreeLearningCallbacks } = {}) {
    prepareDatabaseLocation(path);
    this.database = openDatabase(path, 'agentTasks');
    this.queue = new AgentTaskQueue(this.database, (...event) => this.appendEvent(...event));
    migrateAgentTasks(this.database);
    applySchemaSteps(this.database, TASK_STORE_STEPS);
    if (options.taskTreeEnabled) {
      this.taskTrees = new TaskTreeStore(this.database, options.taskTreeCallbacks);
      const rows = this.database.prepare(`SELECT * FROM agent_tasks WHERE ${fcaHostPredicate(this.database)}`).all() as unknown as AgentTaskRow[];
      this.transaction(() => { for (const row of rows) this.taskTrees!.ensure(this.inflate(row), row.scope_key, row.updated_at); });
      this.taskTrees.flushLearning();
    }
    secureDatabaseFiles(path);
  }

  create(scopeKey: string, input: CreateAgentTaskInput, now: string): { task: AgentTask; created: boolean } {
    if (this.taskTrees && input.taskAuthority !== undefined && !taskTreeAuthority(input.taskAuthority)) throw new Error('TREE_AUTHORITY');
    let created = false;
    let taskId = '';
    this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM agent_tasks WHERE scope_key = ? AND start_idempotency_key = ?
      `).get(scopeKey, input.idempotencyKey) as unknown as { task_id: string; fca_kind?: string | null } | undefined;
      if (existing) {
        if (existing.fca_kind != null) throw new Error('AGENT_TASK_ID_CONFLICT');
        taskId = existing.task_id;
        return;
      }
      taskId = input.taskId ?? randomUUID();
      const idCollision = this.database.prepare('SELECT 1 AS found FROM agent_tasks WHERE task_id = ?').get(taskId);
      if (idCollision) throw new Error('AGENT_TASK_ID_CONFLICT');
      this.database.prepare(`
        INSERT INTO agent_tasks
          (task_id, scope_key, conversation_thread_id, source_message_id, cognitive_intent_id, start_idempotency_key,
           title, goal, status, summary, current_action, plan_json, pending_approval_json,
           changes_json, tests_json, created_at, updated_at, latest_sequence, assigned_host_id,
           project_hint, model_id, reasoning_effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, '[]', '[]', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        taskId, scopeKey, input.conversationThreadID, input.sourceMessageID ?? null,
        input.cognitiveIntentID ?? null, input.idempotencyKey, input.title, input.goal, input.summary,
        JSON.stringify(input.plan ?? []), now, now, input.hostHint?.trim() || null,
        input.projectHint?.trim() || null, input.model?.trim() || null, input.reasoningEffort ?? null,
      );
      writeTaskState(this.database, taskId, { status: 'queued', pauseReason: null }, now);
      this.appendEvent(taskId, 'queued', '作業を受け付けた', input.summary, 'neutral', now, {});
      this.insertCommand(taskId, scopeKey, `${input.idempotencyKey}:start`, 'start', {
        goal: input.goal,
        hostHint: input.hostHint,
        projectHint: input.projectHint,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      }, now);
      this.queue.markWaiting(taskId, input.hostHint?.trim() || undefined, now);
      this.taskTrees?.ensure({ id: taskId, goal: input.goal, plan: input.plan ?? [], createdAt: now }, scopeKey, now, input.taskAuthority);
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

  withRequestTaskId<T>(scopeKey: string, requestTaskId: string, operation: (storedTaskId: string) => T): T {
    const result = withAgentTaskRequest(this.database, scopeKey, requestTaskId, operation);
    secureDatabaseFiles(this.path);
    return result;
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
      this.requireHostTask(scopeKey, taskId);
      const existing = this.database.prepare(`
        SELECT command_id FROM agent_task_commands WHERE scope_key = ? AND idempotency_key = ?
      `).get(scopeKey, input.idempotencyKey) as unknown as { command_id: string } | undefined;
      if (existing) {
        commandId = existing.command_id;
        return;
      }
      validateCommandTransition(task, input.type, input.payload ?? {});
      const { projection, settledByStore } = this.queue.admit(task, input.type, input.payload ?? {});
      // The host follows the projection made here, so a deny never continues a task this store cancelled.
      const denyContinues = input.type === 'resolve_approval' && input.payload?.decision === 'deny'
        && projection.status !== 'cancelled';
      commandId = this.insertCommand(taskId, scopeKey, input.idempotencyKey, input.type,
        { ...(input.payload ?? {}), ...(denyContinues ? { denyContinues: true } : {}) }, now);
      const currentAction = projection.currentAction ?? task.currentAction ?? null;
      // The state machine writes the status with its pause reason (ADR-0009 stage 1, S4); the rest of the row follows.
      writeTaskState(this.database, taskId, { status: projection.status, pauseReason: projection.status === 'paused' ? 'owner' : null,
        currentAction }, now);
      this.database.prepare(`
        UPDATE agent_tasks
        SET summary = ?, current_action = ?, pending_approval_json = ?, pause_sequence = NULL, updated_at = ?
        WHERE task_id = ? AND scope_key = ?
      `).run(
        projection.summary ?? task.summary,
        currentAction,
        projection.clearApproval ? null : task.pendingApproval ? JSON.stringify(task.pendingApproval) : null,
        now, taskId, scopeKey,
      );
      if (input.type === 'interrupt') this.queue.withdrawTurns(taskId, input.payload ?? {}, now);
      if (settledByStore) this.queue.settle(commandId, now);
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

  peekCommand(hostId: string, now: string): ClaimedAgentCommand | null {
    const id = this.queue.nextCommand(hostId, now);
    return id ? this.command(id) : null;
  }

  claim(hostId: string, now: string, leaseSeconds = 35, expectedId?: string): ClaimedAgentCommand | null {
    let commandId: string | null = null;
    const leaseUntil = new Date(Date.parse(now) + Math.max(10, Math.min(120, leaseSeconds)) * 1_000).toISOString();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE agent_task_commands
        SET status = 'pending', lease_owner = NULL, lease_until = NULL
        WHERE status = 'leased' AND lease_until <= ?
          AND task_id IN (SELECT task_id FROM agent_tasks WHERE ${fcaHostPredicate(this.database)})
      `).run(now);
      const next = this.queue.nextCommand(hostId, now);
      if (!next || (expectedId && next !== expectedId)) return;
      if (this.taskTrees && !this.taskTrees.allowsCommand(this.command(next)!)) return;
      const changed = this.database.prepare(`
        UPDATE agent_task_commands
        SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE command_id = ? AND status = 'pending'
      `).run(hostId, leaseUntil, next);
      if (Number(changed.changes) === 0) return;
      commandId = next;
      const command = this.command(next);
      if (command) { this.queue.begin(command, hostId, now); this.taskTrees?.bindCommand(command, now); }
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
        const row = this.database.prepare(`SELECT * FROM agent_tasks WHERE task_id = ?`)
          .get(event.taskId) as unknown as {
            scope_key: string;
            assigned_host_id: string | null;
            status: AgentTaskStatus;
            fca_kind?: string | null;
            unknown_since?: string | null;
          } | undefined;
        if (!row) continue;
        if (row.fca_kind != null || row.assigned_host_id !== hostId) throw new Error('AGENT_HOST_TASK_MISMATCH');
        if (this.taskTrees && !this.taskTrees.acceptsEvent(row.scope_key, event)) continue;
        if (hostEventIgnored(row, event)) continue;
        projectHostEventInBatch(this.database, event, now, closedWithUnknownOutcome(row));
        this.taskTrees?.recordEvent(row.scope_key, event, now);
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
    this.taskTrees?.flushLearning();
    return Object.freeze([...changed].map(taskId => this.taskById(taskId)).filter((task): task is AgentTask => task !== null));
  }

  heartbeat(heartbeat: AgentHostHeartbeat, now: string): void {
    new AgentHostRegistry(this.database).heartbeat(heartbeat, now);
  }
  bindActionLease(commandId: string, lease: ActionLease): void { this.taskTrees?.bindLease(commandId, lease); }
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
  /** The one unknown exit of an Agent Host task (ADR-0009 stage 1, S5; `agentTaskUnknownExit.ts`). Returns how many closed. */
  closeUnknownOutcomes(now: string, closedUnknown: ClosedUnknownHostTasks): number {
    if (!closedUnknown(this.database).length) return 0; // Read without a write lock; the lock only when something closes.
    let closed = 0;
    this.transaction(() => { closed = closeUnknownHostTasks(this.database, now, closedUnknown, (...event) => this.appendEvent(...event)); });
    return closed;
  }

  close(): void {
    if (!this.database.isOpen) return;
    checkpointPassive(this.database);
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
      scopeKey: row.scope_key,
      conversationThreadID: row.conversation_thread_id,
      ...(row.source_message_id ? { sourceMessageID: row.source_message_id } : {}),
      ...(row.cognitive_intent_id ? { cognitiveIntentID: row.cognitive_intent_id } : {}),
      title: row.title,
      goal: row.goal,
      ...(row.assigned_host_id ? { assignedHostID: row.assigned_host_id } : {}),
      ...(row.project_hint ? { projectHint: row.project_hint } : {}),
      ...(row.model_id ? { model: row.model_id } : {}),
      ...(isReasoningEffort(row.reasoning_effort) ? { reasoningEffort: row.reasoning_effort } : {}),
      status: row.status,
      summary: row.summary,
      ...(row.current_action ? { currentAction: row.current_action } : {}),
      ...pauseProjection(row),
      plan: parseArray<AgentPlanItem>(row.plan_json),
      ...(this.taskTrees && row.fca_kind == null ? { taskTree: this.taskTrees.get(row.scope_key, row.task_id) ?? undefined } : {}),
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
    this.requireHostTask(scopeKey, taskId);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO agent_task_commands
        (command_id, task_id, scope_key, idempotency_key, command_type, payload_json,
         status, available_at, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
    `).run(id, taskId, scopeKey, idempotencyKey, type, JSON.stringify(payload), now, now);
    return id;
  }

  private requireHostTask(scopeKey: string, taskId: string): void {
    const row = this.database.prepare('SELECT * FROM agent_tasks WHERE scope_key = ? AND task_id = ?')
      .get(scopeKey, taskId) as { fca_kind?: string | null } | undefined;
    if (!row) throw new Error('AGENT_TASK_NOT_FOUND');
    if (row.fca_kind != null) throw new Error('AGENT_COMMAND_INVALID_EXECUTION_KIND');
  }

  private command(commandId: string, fallbackLeaseUntil?: string): ClaimedAgentCommand | null {
    const row = this.database.prepare(`SELECT * FROM agent_task_commands WHERE command_id = ?`)
      .get(commandId) as unknown as AgentCommandRow | undefined;
    if (!row) return null;
    const tree = this.taskTrees?.get(row.scope_key, row.task_id);
    return Object.freeze({
      id: row.command_id,
      taskId: row.task_id,
      scopeKey: row.scope_key,
      type: row.command_type,
      payload: { ...parseObject<Record<string, unknown>>(row.payload_json), ...(tree && !tree.legacy ? { goal: tree.content, taskTree: tree } : {}) },
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

  private transaction(operation: () => void): void {
    if (this.database.isTransaction) { operation(); return; }
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
