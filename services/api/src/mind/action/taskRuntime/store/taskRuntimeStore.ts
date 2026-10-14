import { insertTaskMessage } from './taskMessageStore.js';
import { TaskInbox } from './taskInboxRedelivery.js';
import { TaskMaintenanceStore } from './taskMaintenanceStore.js';
import { TaskRuntimeRecovery } from './taskRuntimeRecovery.js';
import { bounded, json, taskRuntimeLimits as limits } from './taskRuntimeValidation.js';
import { observeExternalEvent } from './taskExternalEventStore.js';
import type { TaskExternalEvent } from '../taskExternalEventPorts.js';
import { TaskConversationDeliveryStore } from './taskConversationDeliveryStore.js';
import type { TaskConversationDeliveryInput, TaskConversationDeliveryStage } from '../taskConversationDeliveryPorts.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { FCA_TASK_RUNTIME_STEP } from '../../../../infra/sqlite/migrations/executionSteps.js';
import type { ActionLease } from '@shannon/mind';
import type { TaskAuthority, TaskCommit, TaskConversationSource, TaskHistoryCommit, TaskHistoryWindow, TaskMessage, TaskQuery, TaskRecord, TaskRuntime, TaskRuntimeOptions, TaskSource, TaskSourceObservation,
  TaskSegmentReceipt, TaskSnapshot, TaskSpec, TaskStep, TaskView } from '../taskRuntimePorts.js';
import { TaskSourceStore } from './taskSourceStore.js';
import { TaskHistoryStore } from './taskHistoryStore.js';
import { TaskProgressStore } from './taskProgressStore.js';
import type { TaskProgressEvent } from '../taskProgressPorts.js';
interface Checkpoint {
  checkpoint_json: string | null; wait_reason: string | null; stop_requested: number;
  step_id: string | null; lease_json: string | null; last_admission: number; observed_messages_json: string | null;
}
const terminal = (task: TaskRecord): boolean => ['completed', 'failed', 'cancelled'].includes(task.status);
/** Subordinate inbox/history/checkpoints. The injected authority alone owns task status and its event sequence. */
export class SQLiteTaskRuntimeStore implements TaskRuntime {
  private readonly progressStore: TaskProgressStore;
  placeContext(scope: string, id: string) { return this.authority.get(scope, id) ? this.progressStore.places(id) : undefined; }
  admitPlaceContext(step: TaskStep, id: string, context: import('../../../../integrations/places/placeDiscovery.js').PlaceSearchContext) { return this.progressStore.admitPlaces(id, context, () => this.matches(step) && this.get(step.scopeKey, id)?.parentId === step.taskId && Boolean(this.options.conversationLeaseValid?.(step.scopeKey, step.lease, this.now()))); }
  progress(scope: string, id: string) { return this.authority.get(scope, id) ? this.progressStore.read(id) : null; }
  recordSpokenReport(s: string, id: string, r: string, t: string, heard?: true) { return this.progressStore[heard ? 'hear' : 'speak'](s, id, r, t); }
  recordProgress(step: TaskStep, event: TaskProgressEvent) { return this.progressStore.record(step, event, () => this.matches(step) && this.get(step.scopeKey, step.taskId)?.phase === 'executing' && this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now())); }
  admitSleep(scope: string, jobId: string) {
    const root = this.authority.root(scope);
    if (root && this.options.sleepTicket?.(scope, jobId)) this.authority.transaction(() => this.recovery.revive(root, 'sleep_admission'));
    return this.maintenance.admit(scope, jobId);
  }
  sleepTicketForTask(scope: string, taskId: string) { return this.maintenance.get(scope, taskId); }
  observeExternal(scope: string, target: string, event: TaskExternalEvent) {
    if (this.authority.get(scope, target)?.origin === 'maintenance') throw new Error('FCA_MAINTENANCE_INPUT');
    const result = observeExternalEvent(this.db, this.authority, scope, this.ensureRoot(scope).id, target, event, this.now());
    return { accepted: true as const, duplicate: result.duplicate, task: this.view(result.task) };
  }
  private readonly authority: TaskAuthority; private readonly now: () => string;
  private readonly sources: TaskSourceStore; private readonly deliveries: TaskConversationDeliveryStore;
  private readonly histories: TaskHistoryStore; private readonly maintenance: TaskMaintenanceStore;
  private readonly recovery: TaskRuntimeRecovery; private readonly inbox: TaskInbox;
  constructor(private readonly db: DatabaseSync, private readonly options: TaskRuntimeOptions) {
    this.authority = options.authority;
    this.now = options.now ?? (() => new Date().toISOString());
    applySchemaSteps(db, [FCA_TASK_RUNTIME_STEP]);
    this.progressStore = new TaskProgressStore(db, this.authority, this.now);
    this.sources = new TaskSourceStore(db);
    this.histories = new TaskHistoryStore(db);
    this.maintenance = new TaskMaintenanceStore(db, { authority: this.authority, now: this.now, resolve: options.sleepTicket, root: scope => this.ensureRoot(scope), view: task => this.view(task) });
    this.recovery = new TaskRuntimeRecovery(db, { authority: this.authority, maintenance: this.maintenance, now: this.now,
      checkpoint: id => this.checkpoint(id), required: (scope, id) => this.required(scope, id), all: scope => this.all(scope),
      view: task => this.view(task), get: (scope, id) => this.get(scope, id), finishStops: task => this.finishStops(task),
      pendingReceipts: scope => this.pendingReceipts(scope), activeSteps: scope => this.activeSteps(scope),
      snapshot: (scope, id) => this.snapshotInTransaction(scope, id)!, failConversation: step => this.failConversationInTransaction(step),
      send: (scope, source, target, text, id) => this.sendInTransaction(scope, source, target, text, id),
      redeliver: (task, stepId, reason) => this.inbox.redeliverLost(task, stepId, reason),
      wake: (task, reason) => { this.inbox.wake(task.scopeKey, task.id, reason); },
      notice: (scope, taskId, stepId, operationId, text) => this.progressStore.notice(scope, taskId, stepId, operationId, text) });
    this.inbox = new TaskInbox(db, { authority: this.authority, sources: this.sources, now: this.now, messages: id => this.messages(id),
      checkpoint: id => this.checkpoint(id), required: (scope, id) => this.required(scope, id),
      stepValid: step => this.matches(step) && this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now()) });
    this.deliveries = new TaskConversationDeliveryStore(db, { authority: this.authority, sources: this.sources, now: this.now,
      begin: (scope, thread, lease, claim) => this.beginConversation(scope, thread, lease, claim), matches: step => this.matches(step) && Boolean(this.options.conversationLeaseValid?.(step.scopeKey, step.lease, this.now())),
      observed: step => this.observedMessages(this.required(step.scopeKey, step.taskId)) ?? [],
      staged: step => {
        db.prepare("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason='message' WHERE task_id=?").run(step.taskId);
        this.authority.event(step.scopeKey, step.taskId, 'fca_conversation_staged', this.now(), { status: 'running', pauseReason: null }, { stepId: step.id });
        if (this.checkpoint(step.taskId).stop_requested) this.finishStops(this.required(step.scopeKey, step.taskId));
      }, bound: (scope, stepId, taskId) => {
        this.authority.event(scope, taskId, 'fca_conversation_bound', this.now(), {}, { stepId }); this.inbox.sourceBound(scope, stepId);
      } });
  }
  ensureRoot(scopeKey: string): TaskView {
    bounded(scopeKey, 160, 'SCOPE');
    return this.authority.transaction(() => {
      const known = this.authority.root(scopeKey);
      if (known) return this.view(known);
      const root = this.authority.create({ id: randomUUID(), scopeKey, parentId: null, kind: 'root', origin: 'owner_request',
        title: '共通タスク', goal: '入力を受け取り、目的ごとのタスクを進める', completionCriteria: '', status: 'running',
        pauseReason: null, summary: '', requestKey: 'fca:root', createdAt: this.now() });
      this.initialize(root.id, 'message');
      return this.view(root);
    });
  }
  createChild(scopeKey: string, parentId: string, spec: TaskSpec, requestId: string): TaskView {
    bounded(requestId, 160, 'REQUEST'); bounded(spec.title, 240, 'TITLE'); bounded(spec.goal, limits.text, 'GOAL');
    if (spec.completionCriteria !== undefined) bounded(spec.completionCriteria, limits.text, 'CRITERIA', true);
    if (spec.context !== undefined) bounded(spec.context, limits.text, 'CONTEXT', true);
    if (spec.origin && spec.origin !== 'owner_request') throw new Error('FCA_OWN_TIME_NOT_ADMITTED');
    if (spec.kind && !['conversation', 'research', 'generic'].includes(spec.kind)) throw new Error('FCA_KIND');
    return this.authority.transaction(() => {
      const parent = this.required(scopeKey, parentId);
      if (parent.origin !== 'owner_request') throw new Error('FCA_PARENT_ORIGIN');
      const requestKey = `fca:child:${parentId}:${requestId}`;
      const known = this.authority.byRequest(scopeKey, requestKey);
      if (known) {
        const context = this.db.prepare('SELECT text FROM fca_task_messages WHERE scope_key=? AND message_id=?').get(scopeKey, `context:${known.id}`);
        if ((context?.text ?? '') !== (spec.context ?? '') || known.title !== spec.title || known.goal !== spec.goal || known.kind !== (spec.kind ?? 'generic')
          || known.completionCriteria !== (spec.completionCriteria ?? '')) throw new Error('FCA_REQUEST_CONFLICT');
        return this.view(known);
      }
      if (['stopped', 'stopping', 'unknown', 'completed', 'failed'].includes(this.view(parent).phase)) throw new Error('FCA_PARENT_INACTIVE');
      let ancestor: TaskRecord | null = parent;
      for (let depth = 0; ancestor; depth++) {
        if (depth >= limits.depth) throw new Error('FCA_DEPTH_LIMIT');
        ancestor = ancestor.parentId ? this.required(scopeKey, ancestor.parentId) : null;
      }
      if (this.children(parent).filter(child => !terminal(child)).length >= limits.children) throw new Error('FCA_CHILD_LIMIT');
      if (this.all(scopeKey).filter(task => !terminal(task)).length >= limits.activeTasks) throw new Error('FCA_ACTIVE_TASK_LIMIT');
      const child = this.authority.create({ id: randomUUID(), scopeKey, parentId, kind: spec.kind ?? 'generic', origin: parent.origin,
        title: spec.title, goal: spec.goal, completionCriteria: spec.completionCriteria ?? '', status: 'queued', pauseReason: null,
        summary: '', requestKey, createdAt: this.now() });
      this.sources.inherit(parent, this.checkpoint(parentId).step_id, child.id, '', this.observedMessages(parent));
      this.initialize(child.id, null);
      if (spec.context) this.sendInTransaction(scopeKey, parentId, child.id, spec.context, `context:${child.id}`);
      this.authority.event(scopeKey, parentId, 'fca_child_created', this.now(), {}, { childId: child.id });
      return this.get(scopeKey, child.id)!;
    });
  }
  get(scopeKey: string, taskId: string): TaskView | null { const task = this.authority.get(scopeKey, taskId); return task ? this.view(task) : null; }
  list(scopeKey: string, query: TaskQuery = {}): TaskView[] {
    if (!Number.isInteger(query.limit ?? 100) || (query.limit ?? 100) < 1 || (query.limit ?? 100) > 100
      || !Number.isInteger(query.offset ?? 0) || (query.offset ?? 0) < 0) throw new Error('FCA_PAGE');
    return this.authority.list(scopeKey, query).map(task => this.view(task));
  }
  readyTasks(scopeKey: string, limit = 100): TaskView[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.activeTasks) throw new Error('FCA_PAGE');
    return this.authority.transaction(() => {
      const pending = new Set(this.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
      return this.all(scopeKey).filter(task => task.status === 'queued' && task.kind !== 'conversation' && !pending.has(task.id)
        && !this.sources.hasUnboundOrigin(task.id))
        .map(task => ({ task, checkpoint: this.checkpoint(task.id) }))
        .filter(({ checkpoint }) => !checkpoint.step_id && !checkpoint.stop_requested)
        .sort((left, right) => left.checkpoint.last_admission - right.checkpoint.last_admission
          || left.task.createdAt.localeCompare(right.task.createdAt) || left.task.id.localeCompare(right.task.id))
        .slice(0, limit).map(({ task }) => this.view(task));
    });
  }
  beginConversation(scopeKey: string, threadId: string, lease: ActionLease, onBegin?: (step: TaskStep) => void): TaskStep | null {
    bounded(threadId, 160, 'THREAD');
    if (!this.options.conversationLeaseValid?.(scopeKey, lease, this.now())) return null;
    const root = this.ensureRoot(scopeKey);
    return this.authority.transaction(() => {
      if (!this.options.conversationLeaseValid?.(scopeKey, lease, this.now())) return null;
      const requestKey = `fca:conversation:${threadId}`;
      // The owner speaking again revives her internal root and this thread's conversation after a stop-all or a lost turn.
      this.recovery.revive(this.required(scopeKey, root.id), 'owner_turn');
      const existing = this.authority.byRequest(scopeKey, requestKey);
      if (existing) this.recovery.revive(existing, 'owner_turn');
      if (['stopped', 'stopping', 'unknown'].includes(this.get(scopeKey, root.id)!.phase)) return null;
      let task = this.authority.byRequest(scopeKey, requestKey);
      if (!task) {
        if (this.all(scopeKey).filter(candidate => !terminal(candidate)).length >= limits.activeTasks) return null;
        task = this.authority.create({ id: randomUUID(), scopeKey, parentId: root.id, kind: 'conversation', origin: 'owner_request',
          title: '会話', goal: 'このトークの会話を続ける', completionCriteria: '', status: 'running', pauseReason: null,
          summary: '', requestKey, createdAt: this.now() });
        this.initialize(task.id, 'message');
      }
      if (task.kind !== 'conversation' || terminal(task) || this.checkpoint(task.id).step_id
        || ['stopped', 'stopping', 'unknown'].includes(this.view(task).phase)) return null;
      const id = randomUUID();
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=?,lease_json=?,wait_reason=NULL,observed_messages_json=NULL WHERE task_id=?')
        .run(id, JSON.stringify(lease), task.id);
      this.sources.begin(task, id, threadId, this.now());
      this.authority.event(scopeKey, task.id, 'fca_conversation_started', this.now(), { status: 'running', pauseReason: null },
        { stepId: id, actionId: lease.id, generation: lease.generation });
      const snapshot = this.snapshotInTransaction(scopeKey, task.id)!;
      const step = { id, scopeKey, taskId: task.id, lease, revision: snapshot.revision, messageIds: snapshot.messages.map(message => message.id), snapshot };
      onBegin?.(step); return step;
    });
  }
  observeConversationMessages(step: TaskStep, messageIds: readonly string[]): boolean {
    if (messageIds.some(id => !step.messageIds.includes(id))) throw new Error('FCA_MESSAGE_NOT_OBSERVED');
    return this.authority.transaction(() => {
      if (!this.matches(step) || !this.options.conversationLeaseValid?.(step.scopeKey, step.lease, this.now()) || this.required(step.scopeKey, step.taskId).kind !== 'conversation') return false;
      const value = JSON.stringify([...new Set(messageIds)]), prior = this.checkpoint(step.taskId).observed_messages_json;
      if (prior !== null) return prior === value;
      if (messageIds.some(id => !this.sources.messageVisible(step.taskId, id))) return false;
      this.db.prepare('UPDATE fca_task_checkpoints SET observed_messages_json=? WHERE task_id=?').run(value, step.taskId);
      return true;
    });
  }
  completeConversation(step: TaskStep, source: TaskConversationSource, consumedMessageIds: readonly string[] = []): boolean {
    bounded(source.experienceId, 160, 'EXPERIENCE'); bounded(source.threadId, 160, 'THREAD');
    if (!Number.isFinite(Date.parse(source.observedAt)) || !Array.isArray(source.recalledMemoryIds)
      || source.recalledMemoryIds.length > 5000 || source.recalledMemoryIds.some(id => typeof id !== 'string' || !id || id.length > 240)
      || (source.readSourceIds !== undefined && (!Array.isArray(source.readSourceIds) || source.readSourceIds.length > 5000
        || source.readSourceIds.some(id => typeof id !== 'string' || !id || id.length > 240)))) throw new Error('FCA_SOURCE');
    if (consumedMessageIds.some(id => !step.messageIds.includes(id))) throw new Error('FCA_MESSAGE_NOT_OBSERVED');
    return this.authority.transaction(() => {
      if (!this.matches(step) || !this.options.conversationLeaseValid?.(step.scopeKey, step.lease, this.now()) || this.required(step.scopeKey, step.taskId).kind !== 'conversation') return false;
      const observed = this.observedMessages(this.required(step.scopeKey, step.taskId))!;
      if (consumedMessageIds.some(id => !observed.includes(id))) throw new Error('FCA_MESSAGE_NOT_OBSERVED');
      if (!this.sources.bind(step.scopeKey, step.id, source)) return false;
      for (const id of consumedMessageIds) this.db.prepare('UPDATE fca_task_messages SET consumed_by=? WHERE scope_key=? AND target_task_id=? AND message_id=? AND consumed_by IS NULL')
        .run(step.id, step.scopeKey, step.taskId, id);
      this.db.prepare("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason='message' WHERE task_id=?").run(step.taskId);
      this.authority.event(step.scopeKey, step.taskId, 'fca_conversation_completed', this.now(), { status: 'running', pauseReason: null }, { stepId: step.id, experienceId: source.experienceId });
      this.inbox.sourceBound(step.scopeKey, step.id);
      if (this.checkpoint(step.taskId).stop_requested) this.finishStops(this.required(step.scopeKey, step.taskId));
      return true;
    });
  }
  conversationDelivery(scope: string, thread: string, utterance: string) { return this.deliveries.get(scope, thread, utterance); }
  beginConversationDelivery(scope: string, thread: string, lease: ActionLease, input: TaskConversationDeliveryInput) { return this.deliveries.begin(scope, thread, lease, input); }
  stageConversationDelivery(step: TaskStep, input: TaskConversationDeliveryStage): boolean { return this.deliveries.stage(step, input); }
  bindConversationDelivery(scope: string, input: TaskConversationDeliveryInput & { threadId: string; experienceId: string }): boolean { return this.deliveries.bind(scope, input); }
  failConversation(step: TaskStep): void {
    this.authority.transaction(() => this.failConversationInTransaction(step));
  }
  private failConversationInTransaction(step: TaskStep): void {
    if (!this.matches(step) || this.required(step.scopeKey, step.taskId).kind !== 'conversation') return;
    this.deliveries.fail(step);
    this.sources.fail(step.scopeKey, step.id);
    for (const id of this.sources.dependents(step.scopeKey, step.id, true)) {
      if (id === step.taskId) continue;
      const task = this.required(step.scopeKey, id); if (terminal(task)) continue;
      this.db.prepare('UPDATE fca_task_checkpoints SET stop_requested=1,wait_reason=NULL WHERE task_id=?').run(id);
      const stopped = this.sources.failedOriginStop(task);
      this.authority.event(step.scopeKey, id, 'fca_source_failed', this.now(), stopped, { sourceStepId: step.id });
    }
    for (const id of this.sources.dependents(step.scopeKey, step.id)) {
      if (id === step.taskId) continue;
      const task = this.required(step.scopeKey, id), row = this.checkpoint(id);
      if (task.status !== 'running' || row.wait_reason !== 'source' || row.step_id || row.stop_requested || this.sources.hasPendingMessage(id)) continue;
      this.db.prepare('UPDATE fca_task_checkpoints SET wait_reason=NULL WHERE task_id=?').run(id);
      this.authority.event(step.scopeKey, id, 'fca_source_rejected', this.now(), { status: 'queued' }, { sourceStepId: step.id });
    }
    this.db.prepare("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason='message' WHERE task_id=?").run(step.taskId);
    this.authority.event(step.scopeKey, step.taskId, 'fca_conversation_failed', this.now(), { status: 'running', pauseReason: null }, { stepId: step.id });
    if (this.checkpoint(step.taskId).stop_requested) this.finishStops(this.required(step.scopeKey, step.taskId));
  }
  taskSources(scopeKey: string, taskId: string, messageIds?: readonly string[]): TaskSource[] {
    const task = this.authority.get(scopeKey, taskId);
    return task ? this.sources.refs(task, this.checkpoint(taskId).step_id, messageIds ?? this.observedMessages(task)) : [];
  }
  inheritTaskSources(step: TaskStep, sourceTaskIds: readonly string[]): boolean {
    if (sourceTaskIds.length > 100) throw new Error('FCA_SOURCE');
    return this.authority.transaction(() => {
      if (!this.matches(step) || this.get(step.scopeKey, step.taskId)?.phase !== 'executing'
        || !this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now())) return false;
      const sources = [...new Set(sourceTaskIds)].map(id => this.authority.get(step.scopeKey, id));
      if (sources.some(task => !task || (task.origin === 'maintenance' && !this.maintenance.publicOnly(task)) || this.taskSources(step.scopeKey, task.id).some(source => source.kind !== 'memory' && !source.experienceId))) return false;
      for (const task of sources.filter(task => !(task!.origin === 'maintenance' && step.snapshot.task.origin === 'owner_request'))) this.sources.inherit(task!, this.checkpoint(task!.id).step_id, step.taskId, '', this.observedMessages(task!));
      this.authority.event(step.scopeKey, step.taskId, 'fca_sources_inherited', this.now(), {}, { sourceTaskIds: [...new Set(sourceTaskIds)] });
      return true;
    });
  }
  observeSources(step: TaskStep, observation: TaskSourceObservation): boolean {
    return this.authority.transaction(() => this.matches(step) && this.get(step.scopeKey, step.taskId)?.phase === 'executing'
      && this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now()) && this.sources.observe(step, observation, this.now()));
  }
  send(scopeKey: string, sourceTaskId: string, targetId: string, text: string, messageId: string):
    { accepted: true; duplicate: boolean; task: TaskView } {
    bounded(text, limits.text, 'MESSAGE'); bounded(messageId, 160, 'MESSAGE_ID');
    return this.authority.transaction(() => this.sendInTransaction(scopeKey, sourceTaskId, targetId, text, messageId));
  }
  pendingMessageIds(scopeKey: string, taskId: string): readonly string[] {
    if (!this.authority.get(scopeKey, taskId)) return [];
    return this.db.prepare('SELECT message_id FROM fca_task_messages WHERE target_task_id=? AND scope_key=? AND consumed_by IS NULL ORDER BY rowid DESC LIMIT 1000').all(taskId, scopeKey).filter(row => this.sources.messageVisible(taskId, String(row.message_id)) && !this.deliveries.reserved(taskId, String(row.message_id))).map(row => String(row.message_id));
  }
  snapshot(scopeKey: string, taskId: string): TaskSnapshot | null {
    return this.authority.transaction(() => this.snapshotInTransaction(scopeKey, taskId));
  }
  history(scopeKey: string, taskId: string, messageIds?: readonly string[]): TaskHistoryWindow | null {
    return this.authority.transaction(() => this.authority.get(scopeKey, taskId)
      ? this.histories.window(taskId, this.taskSources(scopeKey, taskId, messageIds)) : null);
  }
  commitCompaction(step: TaskStep, request: TaskHistoryCommit, sourcesVisible: () => boolean): boolean {
    return this.authority.transaction(() => {
      if (!this.matches(step) || this.get(step.scopeKey, step.taskId)?.phase !== 'executing'
        || !this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now()) || !sourcesVisible()) return false;
      return this.histories.commit(step.taskId, request, this.taskSources(step.scopeKey, step.taskId, step.messageIds), this.now());
    });
  }
  beginStep(scopeKey: string, taskId: string, lease: ActionLease, expectedRevision?: number): TaskStep | null {
    return this.authority.transaction(() => {
      const task = this.get(scopeKey, taskId);
      if (!task || task.phase !== 'ready' || task.kind === 'conversation' || this.sources.hasUnboundOrigin(taskId)
        || (expectedRevision !== undefined && task.revision !== expectedRevision)
        || !this.options.leaseValid(scopeKey, taskId, lease, this.now()) || this.checkpoint(taskId).step_id
        || this.db.prepare('SELECT 1 FROM fca_task_segment_receipts WHERE task_id=?').get(taskId)) return null;
      const id = randomUUID();
      const order = this.db.prepare(`INSERT INTO fca_task_dispatch_order(scope_key,last_admission) VALUES(?,1)
        ON CONFLICT(scope_key) DO UPDATE SET last_admission=last_admission+1 RETURNING last_admission`).get(scopeKey)!;
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=?,lease_json=?,wait_reason=NULL,last_admission=? WHERE task_id=?')
        .run(id, JSON.stringify(lease), Number(order.last_admission), taskId);
      this.authority.event(scopeKey, taskId, 'fca_step_started', this.now(), { status: 'running', pauseReason: null },
        { stepId: id, actionId: lease.id, generation: lease.generation, messageIds: this.messages(taskId).map(message => message.id) });
      const snapshot = this.snapshotInTransaction(scopeKey, taskId)!;
      return { id, scopeKey, taskId, lease, revision: snapshot.revision, messageIds: snapshot.messages.map(message => message.id), snapshot };
    });
  }
  commitStep(step: TaskStep, commit: TaskCommit): TaskSnapshot | null {
    const history = json(commit.history ?? []), checkpoint = commit.checkpoint === undefined ? undefined : json(commit.checkpoint);
    if (history.length > limits.historyBytes || (checkpoint?.length ?? 0) > limits.historyBytes) throw new Error('FCA_HISTORY_LIMIT');
    if (!['continue', 'wait', 'complete', 'fail'].includes(commit.disposition)) throw new Error('FCA_DISPOSITION');
    if (commit.summary !== undefined) bounded(commit.summary, limits.text, 'SUMMARY', true);
    return this.authority.transaction(() => {
      if (!this.matches(step) || this.checkpoint(step.taskId).stop_requested
        || !this.options.leaseValid(step.scopeKey, step.taskId, step.lease, this.now())) return null;
      const task = this.required(step.scopeKey, step.taskId);
      if (task.status !== 'running') return null;
      const consumed = commit.consumedMessageIds ?? step.messageIds;
      if (consumed.some(id => !step.messageIds.includes(id))) throw new Error('FCA_MESSAGE_NOT_OBSERVED');
      if ((commit.disposition === 'fail' || (commit.disposition === 'complete' && task.kind !== 'root'))
        && this.children(task).some(child => !terminal(child))) {
        throw new Error('FCA_CHILDREN_ACTIVE');
      }
      for (const id of consumed) this.db.prepare('UPDATE fca_task_messages SET consumed_by=? WHERE scope_key=? AND message_id=? AND target_task_id=? AND consumed_by IS NULL')
        .run(step.id, step.scopeKey, id, step.taskId);
      this.db.prepare('INSERT INTO fca_task_segment_receipts(step_id,scope_key,task_id,lease_json,created_at) VALUES(?,?,?,?,?)')
        .run(step.id, step.scopeKey, step.taskId, JSON.stringify(step.lease), this.now());
      if (checkpoint !== undefined) this.db.prepare('UPDATE fca_task_checkpoints SET checkpoint_json=? WHERE task_id=?').run(checkpoint, step.taskId);
      const pending = this.messages(step.taskId).length > 0, awaitingSource = this.sources.hasPendingMessage(step.taskId);
      const complete = commit.disposition === 'complete' && task.kind !== 'root' && !pending && !awaitingSource;
      const waiting = !pending && (commit.disposition === 'wait' || (commit.disposition === 'complete' && (task.kind === 'root' || awaitingSource)));
      const status = commit.disposition === 'fail' ? 'failed' : complete ? 'completed' : waiting ? 'running' : 'queued';
      this.histories.append(step.taskId, step.id, history, this.now(), status, step.snapshot.sources);
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason=? WHERE task_id=?')
        .run(waiting ? awaitingSource && commit.disposition === 'complete' ? 'source' : 'message' : null, step.taskId);
      this.authority.event(step.scopeKey, step.taskId, 'fca_step_committed', this.now(), { status, summary: task.origin === 'maintenance' ? this.maintenance.summary(task) : commit.summary },
        { stepId: step.id, actionId: step.lease.id, generation: step.lease.generation, disposition: commit.disposition });
      if (terminal({ ...task, status }) && task.origin === 'maintenance') this.maintenance.report(task, status, step.id);
      else if (terminal({ ...task, status }) && task.parentId && task.origin !== 'own_time') {
        const parent = this.required(step.scopeKey, task.parentId);
        if (!terminal(parent)) this.sendInTransaction(step.scopeKey, step.taskId, task.parentId,
          commit.summary || `${task.title}: ${status}`, `result:${step.id}`);
        if (status === 'completed') this.progressStore.completion(step.scopeKey, task, step.id, commit.summary ?? '');
      }
      return this.snapshotInTransaction(step.scopeKey, step.taskId);
    });
  }
  recordStoppedStep(step: TaskStep): boolean {
    return this.authority.transaction(() => {
      if (!this.matches(step) || !this.checkpoint(step.taskId).stop_requested) return false;
      this.db.prepare(`INSERT OR IGNORE INTO fca_task_segment_receipts(step_id,scope_key,task_id,lease_json,created_at,state)
        VALUES(?,?,?,?,?,'cancelled')`).run(step.id, step.scopeKey, step.taskId, JSON.stringify(step.lease), this.now());
      return true;
    });
  }
  closeRejectedStep(step: TaskStep): boolean { return this.authority.transaction(() => this.inbox.closeRejected(step)); }
  wakePendingInboxes(scope: string): TaskView[] { return this.authority.transaction(() => this.inbox.wakePending(scope).map(id => this.get(scope, id)!)); }
  pendingReceipts(scopeKey: string): TaskSegmentReceipt[] {
    return this.db.prepare('SELECT * FROM fca_task_segment_receipts WHERE scope_key=? ORDER BY created_at,step_id').all(scopeKey)
      .map(row => ({ id: String(row.step_id), taskId: String(row.task_id), lease: JSON.parse(String(row.lease_json)) as ActionLease, state: String(row.state) as TaskSegmentReceipt['state'] }));
  }
  acknowledgeReceipt(scopeKey: string, id: string): boolean {
    return this.authority.transaction(() => {
      const receipt = this.db.prepare('SELECT * FROM fca_task_segment_receipts WHERE scope_key=? AND step_id=?').get(scopeKey, id);
      if (!receipt) return false;
      if (receipt.state === 'cancelled') {
        const taskId = String(receipt.task_id), checkpoint = this.checkpoint(taskId);
        if (checkpoint.step_id !== id || checkpoint.lease_json !== receipt.lease_json || !checkpoint.stop_requested) return false;
        this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL WHERE task_id=?').run(taskId);
        this.finishStops(this.required(scopeKey, taskId));
      }
      return this.db.prepare('DELETE FROM fca_task_segment_receipts WHERE scope_key=? AND step_id=?').run(scopeKey, id).changes > 0;
    });
  }
  /** Atomic version check and inbox inspection close the send-before-wait lost-wakeup window. */
  wait(scopeKey: string, taskId: string, expectedRevision: number): TaskView | null {
    return this.authority.transaction(() => {
      const task = this.get(scopeKey, taskId);
      if (!task || task.phase !== 'ready') return task;
      if (task.revision !== expectedRevision || this.messages(taskId).length) return task;
      this.db.prepare("UPDATE fca_task_checkpoints SET wait_reason='message' WHERE task_id=?").run(taskId);
      return this.view(this.authority.event(scopeKey, taskId, 'fca_wait_registered', this.now(), { status: 'running' }));
    });
  }
  stop(scopeKey: string, taskId: string, reason: string): TaskView[] {
    bounded(reason, limits.text, 'STOP_REASON');
    return this.authority.transaction(() => {
      const root = this.authority.get(scopeKey, taskId); if (!root) return [];
      const affected = this.descendants(root).reverse();
      for (const task of affected) {
        if (terminal(task)) continue;
        this.db.prepare('UPDATE fca_task_checkpoints SET stop_requested=1,wait_reason=NULL WHERE task_id=?').run(task.id);
        const uncertain = task.pauseReason === 'fca_unknown';
        const pending = this.checkpoint(task.id).step_id || this.children(task).some(child => ['executing', 'stopping', 'unknown'].includes(this.view(child).phase));
        this.authority.event(scopeKey, task.id, 'fca_stop_requested', this.now(),
          { status: uncertain ? 'paused' : pending ? 'running' : 'paused', pauseReason: uncertain ? 'fca_unknown' : pending ? null : 'fca_stopped' }, { reason });
      }
      return affected.map(task => this.get(scopeKey, task.id)!);
    });
  }
  /** Caller invokes only after the existing action owner confirms actual cancellation. */
  acknowledgeStop(step: TaskStep): TaskView | null {
    return this.authority.transaction(() => {
      if (!this.matches(step) || !this.checkpoint(step.taskId).stop_requested) return null;
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL WHERE task_id=?').run(step.taskId);
      this.finishStops(this.required(step.scopeKey, step.taskId));
      return this.get(step.scopeKey, step.taskId);
    });
  }
  resume(scopeKey: string, taskId: string): TaskView | null {
    return this.authority.transaction(() => {
      const task = this.get(scopeKey, taskId);
      if (!task || task.phase !== 'stopped' || (task.kind !== 'conversation' && this.sources.hasUnboundOrigin(taskId)) || (task.origin === 'maintenance' && !this.maintenance.resumable(scopeKey, taskId))) return null;
      if (this.ancestors(task).some(parent => ['stopped', 'stopping', 'unknown'].includes(this.view(parent).phase))) return null;
      this.db.prepare('UPDATE fca_task_checkpoints SET stop_requested=0,wait_reason=NULL WHERE task_id=?').run(taskId);
      return this.view(this.authority.event(scopeKey, taskId, 'fca_resumed', this.now(), { status: 'queued', pauseReason: null }));
    });
  }
  activeSteps(scopeKey: string): Array<{ taskId: string; lease: ActionLease }> {
    return this.all(scopeKey).flatMap(task => {
      const row = this.checkpoint(task.id); return row.step_id && row.lease_json ? [{ taskId: task.id, lease: JSON.parse(row.lease_json) as ActionLease }] : [];
    });
  }
  recover(scopeKey: string, actionState: (lease: ActionLease) => 'live' | 'safe' | 'unknown'): TaskView[] {
    return this.authority.transaction(() => this.recovery.recover(scopeKey, actionState));
  }
  unknownSince(scopeKey: string, taskId: string): string | null { return this.recovery.unknownSince(scopeKey, taskId); }
  retireUnknown(scopeKey: string, at: string): TaskView[] { return this.authority.transaction(() => this.recovery.retireUnknown(scopeKey, at)); }
  private initialize(id: string, waitReason: string | null): void {
    this.db.prepare('INSERT INTO fca_task_checkpoints(task_id,wait_reason) VALUES(?,?)').run(id, waitReason);
    this.authority.refresh?.(id, this.now());
  }
  private checkpoint(id: string): Checkpoint {
    const row = this.db.prepare('SELECT * FROM fca_task_checkpoints WHERE task_id=?').get(id);
    if (!row) throw new Error('FCA_CHECKPOINT_MISSING'); return row as unknown as Checkpoint;
  }
  private observedMessages(task: TaskRecord): string[] | undefined {
    return task.kind === 'conversation' ? JSON.parse(this.checkpoint(task.id).observed_messages_json ?? '[]') as string[] : undefined;
  }
  private required(scope: string, id: string): TaskRecord {
    const task = this.authority.get(scope, id); if (!task) throw new Error('FCA_TASK_NOT_FOUND'); return task;
  }
  private children(task: TaskRecord): TaskRecord[] {
    const children: TaskRecord[] = []; let page: TaskRecord[];
    do { page = this.authority.list(task.scopeKey, { parentId: task.id, limit: 100, offset: children.length }); children.push(...page); } while (page.length === 100);
    return children;
  }
  private ancestors(task: TaskRecord): TaskRecord[] {
    const parents: TaskRecord[] = []; let parent = task.parentId;
    while (parent) { const record = this.required(task.scopeKey, parent); parents.push(record); parent = record.parentId; }
    return parents;
  }
  private descendants(task: TaskRecord): TaskRecord[] { return [task, ...this.children(task).flatMap(child => this.descendants(child))]; }
  private all(scope: string): TaskRecord[] {
    const tasks: TaskRecord[] = []; let page: TaskRecord[];
    do { page = this.authority.list(scope, { limit: 100, offset: tasks.length }); tasks.push(...page); } while (page.length === 100);
    return tasks;
  }
  private view(task: TaskRecord): TaskView {
    if (task.origin === 'maintenance' && !this.maintenance.publicOnly(task)) throw new Error('FCA_MAINTENANCE_PROJECTION');
    const row = this.checkpoint(task.id);
    const phase = task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed'
      : task.pauseReason === 'fca_unknown' ? 'unknown' : task.status === 'paused' || task.status === 'cancelled' ? 'stopped'
      : row.stop_requested ? 'stopping' : row.step_id ? 'executing' : task.status === 'queued' ? 'ready' : 'waiting';
    return { ...task, phase, childIds: this.children(task).map(child => child.id) };
  }
  private messages(taskId: string): TaskMessage[] {
    return this.db.prepare('SELECT * FROM fca_task_messages WHERE target_task_id=? AND consumed_by IS NULL ORDER BY rowid').all(taskId)
      .filter(row => this.sources.messageVisible(taskId, String(row.message_id)) && !this.deliveries.reserved(taskId, String(row.message_id)))
      .map(row => ({ id: String(row.message_id), sourceTaskId: String(row.source_task_id), targetTaskId: String(row.target_task_id),
        text: String(row.text), receivedAt: String(row.received_at) }));
  }
  private snapshotInTransaction(scope: string, id: string): TaskSnapshot | null {
    const task = this.get(scope, id); if (!task) return null;
    const row = this.checkpoint(id), messages = this.messages(id);
    return { task, revision: task.revision, messages, sources: this.sources.refs(task, row.step_id, messages.map(message => message.id)), checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
      history: this.db.prepare('SELECT entries_json FROM fca_task_history WHERE task_id=? ORDER BY sequence').all(id)
        .flatMap(entry => JSON.parse(String(entry.entries_json)) as unknown[]) };
  }
  private matches(step: TaskStep): boolean {
    if (!this.authority.get(step.scopeKey, step.taskId)) return false;
    const row = this.checkpoint(step.taskId);
    if (row.step_id !== step.id || !row.lease_json) return false;
    const lease = JSON.parse(row.lease_json) as ActionLease;
    return lease.id === step.lease.id && lease.generation === step.lease.generation && lease.holder === step.lease.holder;
  }
  private sendInTransaction(scope: string, source: string, target: string, text: string, id: string):
    { accepted: true; duplicate: boolean; task: TaskView } {
    const sourceTask = this.required(scope, source), task = this.required(scope, target);
    if (task.origin === 'maintenance' || sourceTask.origin === 'maintenance') throw new Error('FCA_MAINTENANCE_INPUT');
    if (!insertTaskMessage(this.db, { scope, source, target, text, id, at: this.now(), finished: terminal(task) })) return { accepted: true, duplicate: true, task: this.view(task) };
    this.sources.inherit(sourceTask, this.checkpoint(source).step_id, target, id, this.observedMessages(sourceTask));
    const row = this.checkpoint(target), wake = !row.step_id && !row.stop_requested && task.status !== 'paused'
      && this.sources.messageVisible(target, id) && !this.sources.hasUnboundOrigin(target);
    if (wake) this.db.prepare('UPDATE fca_task_checkpoints SET wait_reason=NULL WHERE task_id=?').run(target);
    const updated = this.authority.event(scope, target, 'fca_message_received', this.now(), wake ? { status: 'queued' } : {}, { messageId: id, sourceTaskId: source });
    return { accepted: true, duplicate: false, task: this.view(updated) };
  }
  private finishStops(task: TaskRecord): void {
    for (const candidate of [task, ...this.ancestors(task)]) {
      const row = this.checkpoint(candidate.id);
      if (!row.stop_requested || row.step_id || this.children(candidate).some(child => ['executing', 'stopping', 'unknown'].includes(this.view(child).phase))) break;
      this.authority.event(candidate.scopeKey, candidate.id, 'fca_stop_acknowledged', this.now(), { status: 'paused', pauseReason: 'fca_stopped' });
    }
  }
}
