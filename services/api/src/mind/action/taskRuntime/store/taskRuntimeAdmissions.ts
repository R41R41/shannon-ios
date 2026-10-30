import { TaskRuntimeRecovery } from './taskRuntimeRecovery.js';
import { bounded, taskRuntimeLimits as limits } from './taskRuntimeValidation.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease } from '@shannon/mind';
import type {
  TaskAuthority,
  TaskChildOptions,
  TaskRecord,
  TaskRuntimeOptions,
  TaskSegmentReceipt,
  TaskSnapshot,
  TaskSpec,
  TaskStep,
  TaskView,
} from '../taskRuntimePorts.js';
import { TaskSourceStore } from './taskSourceStore.js';
import type { Checkpoint } from './taskCheckpointRow.js';
const terminal = (task: TaskRecord): boolean => ['completed', 'failed', 'cancelled'].includes(task.status);
export interface RuntimeAdmissionPorts {
  authority: TaskAuthority;
  view(task: TaskRecord): TaskView;
  now: () => string;
  initialize(id: string, waitReason: string | null): void;
  required(scope: string, id: string): TaskRecord;
  db: DatabaseSync;
  children(task: TaskRecord): TaskRecord[];
  all(scope: string): TaskRecord[];
  checkAdmissionCapacity(scopeKey: string, parent: TaskRecord | null): void;
  options: TaskRuntimeOptions;
  sources: TaskSourceStore;
  checkpoint(id: string): Checkpoint;
  observedMessages(task: TaskRecord): string[] | undefined;
  sendInTransaction(
    scope: string,
    source: string,
    target: string,
    text: string,
    id: string,
    inherits?: boolean,
  ): { accepted: true; duplicate: boolean; task: TaskView };
  get(scopeKey: string, taskId: string): TaskView | null;
  pendingReceipts(scopeKey: string): TaskSegmentReceipt[];
  ensureRoot(scopeKey: string): TaskView;
  recovery: TaskRuntimeRecovery;
  snapshotInTransaction(scope: string, id: string): TaskSnapshot | null;
}

export function admitRuntimeEnsureRoot(ports: RuntimeAdmissionPorts, scopeKey: string): TaskView {
  bounded(scopeKey, 160, 'SCOPE');
  return ports.authority.transaction(() => {
    const known = ports.authority.root(scopeKey);
    if (known) return ports.view(known);
    const root = ports.authority.create({
      id: randomUUID(),
      scopeKey,
      parentId: null,
      kind: 'root',
      origin: 'owner_request',
      title: '共通タスク',
      goal: '入力を受け取り、目的ごとのタスクを進める',
      completionCriteria: '',
      status: 'running',
      pauseReason: null,
      summary: '',
      requestKey: 'fca:root',
      createdAt: ports.now(),
    });
    ports.initialize(root.id, 'message');
    return ports.view(root);
  });
}

export function admitRuntimeCreateChild(
  ports: RuntimeAdmissionPorts,
  scopeKey: string,
  parentId: string,
  spec: TaskSpec,
  requestId: string,
  options: TaskChildOptions = {},
): TaskView {
  bounded(requestId, 160, 'REQUEST');
  bounded(spec.title, 240, 'TITLE');
  bounded(spec.goal, limits.text, 'GOAL');
  if (spec.completionCriteria !== undefined) bounded(spec.completionCriteria, limits.text, 'CRITERIA', true);
  if (spec.context !== undefined) bounded(spec.context, limits.text, 'CONTEXT', true);
  if (spec.origin && spec.origin !== 'owner_request') throw new Error('FCA_OWN_TIME_NOT_ADMITTED');
  if (spec.kind && !['conversation', 'research', 'generic'].includes(spec.kind)) throw new Error('FCA_KIND');
  return ports.authority.transaction(() => {
    const parent = ports.required(scopeKey, parentId);
    if (parent.origin !== 'owner_request') throw new Error('FCA_PARENT_ORIGIN');
    const requestKey = `fca:child:${parentId}:${requestId}`;
    const known = ports.authority.byRequest(scopeKey, requestKey);
    const existingChild = (known: TaskRecord): TaskView => {
      const context = ports.db
        .prepare('SELECT text FROM fca_task_messages WHERE scope_key=? AND message_id=?')
        .get(scopeKey, `context:${known.id}`);
      if (
        (context?.text ?? '') !== (spec.context ?? '') ||
        known.title !== spec.title ||
        known.goal !== spec.goal ||
        known.kind !== (spec.kind ?? 'generic') ||
        known.completionCriteria !== (spec.completionCriteria ?? '')
      )
        throw new Error('FCA_REQUEST_CONFLICT');
      return ports.view(known);
    };
    if (known) return existingChild(known);
    if (['stopped', 'stopping', 'unknown', 'completed', 'failed'].includes(ports.view(parent).phase))
      throw new Error('FCA_PARENT_INACTIVE');
    const checkChildCapacity = () => {
      let ancestor: TaskRecord | null = parent;
      for (let depth = 0; ancestor; depth++) {
        if (depth >= limits.depth) throw new Error('FCA_DEPTH_LIMIT');
        ancestor = ancestor.parentId ? ports.required(scopeKey, ancestor.parentId) : null;
      }
      ports.checkAdmissionCapacity(scopeKey, parent);

    };
    checkChildCapacity();
    const child = ports.authority.create({
      id: randomUUID(),
      scopeKey,
      parentId,
      kind: spec.kind ?? 'generic',
      origin: parent.origin,
      title: spec.title,
      goal: spec.goal,
      completionCriteria: spec.completionCriteria ?? '',
      status: 'queued',
      pauseReason: null,
      summary: '',
      requestKey,
      createdAt: ports.now(),
    });
    const inherits = options.sources !== 'asking' || !ports.options.provenanceRefs || parent.kind === 'conversation';
    if (inherits) ports.sources.inherit(parent, ports.checkpoint(parentId).step_id, child.id, '', ports.observedMessages(parent));
    ports.initialize(child.id, null);
    if (spec.context) ports.sendInTransaction(scopeKey, parentId, child.id, spec.context, `context:${child.id}`, inherits);
    ports.authority.event(scopeKey, parentId, 'fca_child_created', ports.now(), {}, { childId: child.id });
    return ports.get(scopeKey, child.id)!;
  });
}

export function admitRuntimeReadyTasks(ports: RuntimeAdmissionPorts, scopeKey: string, limit = 100): TaskView[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.activeTasks) throw new Error('FCA_PAGE');
  return ports.authority.transaction(() => {
    const pending = new Set(ports.pendingReceipts(scopeKey).map((receipt) => receipt.taskId));
    return ports
      .all(scopeKey)
      .filter(
        (task) =>
          task.status === 'queued' && task.kind !== 'conversation' && !pending.has(task.id) && !ports.sources.hasUnboundOrigin(task.id),
      )
      .map((task) => ({ task, checkpoint: ports.checkpoint(task.id) }))
      .filter(({ checkpoint }) => !checkpoint.step_id && !checkpoint.stop_requested)
      .sort(
        (left, right) =>
          left.checkpoint.last_admission - right.checkpoint.last_admission ||
          left.task.createdAt.localeCompare(right.task.createdAt) ||
          left.task.id.localeCompare(right.task.id),
      )
      .slice(0, limit)
      .map(({ task }) => ports.view(task));
  });
}

export function admitRuntimeBeginConversation(
  ports: RuntimeAdmissionPorts,
  scopeKey: string,
  threadId: string,
  lease: ActionLease,
  onBegin?: (step: TaskStep) => void,
): TaskStep | null {
  bounded(threadId, 160, 'THREAD');
  if (!ports.options.conversationLeaseValid?.(scopeKey, lease, ports.now())) return null;
  const root = ports.ensureRoot(scopeKey);
  return ports.authority.transaction(() => {
    if (!ports.options.conversationLeaseValid?.(scopeKey, lease, ports.now())) return null;
    const requestKey = `fca:conversation:${threadId}`;
    // The owner speaking again revives her internal root and this thread's conversation after a stop-all or a lost turn.
    ports.recovery.revive(ports.required(scopeKey, root.id), 'owner_turn');
    const existing = ports.authority.byRequest(scopeKey, requestKey);
    if (existing) ports.recovery.revive(existing, 'owner_turn');
    if (['stopped', 'stopping', 'unknown'].includes(ports.get(scopeKey, root.id)!.phase)) return null;
    let task = ports.authority.byRequest(scopeKey, requestKey);
    if (!task) {
      if (ports.all(scopeKey).filter((candidate) => !terminal(candidate)).length >= limits.activeTasks) return null;
      task = ports.authority.create({
        id: randomUUID(),
        scopeKey,
        parentId: root.id,
        kind: 'conversation',
        origin: 'owner_request',
        title: '会話',
        goal: 'このトークの会話を続ける',
        completionCriteria: '',
        status: 'running',
        pauseReason: null,
        summary: '',
        requestKey,
        createdAt: ports.now(),
      });
      ports.initialize(task.id, 'message');
    }
    if (
      task.kind !== 'conversation' ||
      terminal(task) ||
      ports.checkpoint(task.id).step_id ||
      ['stopped', 'stopping', 'unknown'].includes(ports.view(task).phase)
    )
      return null;
    const id = randomUUID();
    ports.db
      .prepare('UPDATE fca_task_checkpoints SET step_id=?,lease_json=?,wait_reason=NULL,observed_messages_json=NULL WHERE ' + 'task_id=?')
      .run(id, JSON.stringify(lease), task.id);
    ports.sources.begin(task, id, threadId, ports.now());
    ports.authority.event(
      scopeKey,
      task.id,
      'fca_conversation_started',
      ports.now(),
      { status: 'running', pauseReason: null },
      { stepId: id, actionId: lease.id, generation: lease.generation },
    );
    const snapshot = ports.snapshotInTransaction(scopeKey, task.id)!;
    const step = {
      id,
      scopeKey,
      taskId: task.id,
      lease,
      revision: snapshot.revision,
      messageIds: snapshot.messages.map((message) => message.id),
      snapshot,
    };
    onBegin?.(step);
    return step;
  });
}
