import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease } from '@shannon/mind';
import type { TaskAuthority, TaskCommit, TaskMessage, TaskQuery, TaskRecord, TaskRuntime, TaskRuntimeOptions,
  TaskSegmentReceipt, TaskSnapshot, TaskSpec, TaskStep, TaskView } from '../taskRuntimePorts.js';

interface Checkpoint {
  checkpoint_json: string | null; wait_reason: string | null; stop_requested: number;
  step_id: string | null; lease_json: string | null;
}
const terminal = (task: TaskRecord): boolean => ['completed', 'failed', 'cancelled'].includes(task.status);
const limits = { depth: 8, children: 64, activeTasks: 256, text: 16_000, historyBytes: 1_000_000 };

/** Subordinate inbox/history/checkpoints. The injected authority alone owns task status and its event sequence. */
export class SQLiteTaskRuntimeStore implements TaskRuntime {
  private readonly authority: TaskAuthority;
  private readonly now: () => string;
  constructor(private readonly db: DatabaseSync, private readonly options: TaskRuntimeOptions) {
    this.authority = options.authority;
    this.now = options.now ?? (() => new Date().toISOString());
    db.exec(`CREATE TABLE IF NOT EXISTS fca_task_checkpoints (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      checkpoint_json TEXT, wait_reason TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
      step_id TEXT, lease_json TEXT);
      CREATE TABLE IF NOT EXISTS fca_task_messages (
      scope_key TEXT NOT NULL, message_id TEXT NOT NULL, source_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      target_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), text TEXT NOT NULL, received_at TEXT NOT NULL,
      consumed_by TEXT, PRIMARY KEY(scope_key,message_id));
      CREATE INDEX IF NOT EXISTS fca_task_inbox ON fca_task_messages(target_task_id,consumed_by);
      CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_segment_receipts (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      lease_json TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'completed');`);
    this.authority.transaction(() => {
      if (!db.prepare('PRAGMA table_info(fca_task_segment_receipts)').all().some(row => row.name === 'state')) {
        db.exec("ALTER TABLE fca_task_segment_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'");
      }
    });
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
      this.initialize(child.id, null);
      if (spec.context) this.sendInTransaction(scopeKey, parentId, child.id, spec.context, `context:${child.id}`);
      this.authority.event(scopeKey, parentId, 'fca_child_created', this.now(), {}, { childId: child.id });
      return this.get(scopeKey, child.id)!;
    });
  }
  get(scopeKey: string, taskId: string): TaskView | null {
    const task = this.authority.get(scopeKey, taskId); return task ? this.view(task) : null;
  }
  list(scopeKey: string, query: TaskQuery = {}): TaskView[] {
    if (!Number.isInteger(query.limit ?? 100) || (query.limit ?? 100) < 1 || (query.limit ?? 100) > 100
      || !Number.isInteger(query.offset ?? 0) || (query.offset ?? 0) < 0) throw new Error('FCA_PAGE');
    return this.authority.list(scopeKey, query).map(task => this.view(task));
  }
  send(scopeKey: string, sourceTaskId: string, targetId: string, text: string, messageId: string):
    { accepted: true; duplicate: boolean; task: TaskView } {
    bounded(text, limits.text, 'MESSAGE'); bounded(messageId, 160, 'MESSAGE_ID');
    return this.authority.transaction(() => this.sendInTransaction(scopeKey, sourceTaskId, targetId, text, messageId));
  }
  snapshot(scopeKey: string, taskId: string): TaskSnapshot | null {
    return this.authority.transaction(() => this.snapshotInTransaction(scopeKey, taskId));
  }
  beginStep(scopeKey: string, taskId: string, lease: ActionLease, expectedRevision?: number): TaskStep | null {
    return this.authority.transaction(() => {
      const task = this.get(scopeKey, taskId);
      if (!task || task.phase !== 'ready' || (expectedRevision !== undefined && task.revision !== expectedRevision)
        || !this.options.leaseValid(scopeKey, taskId, lease, this.now()) || this.checkpoint(taskId).step_id
        || this.db.prepare('SELECT 1 FROM fca_task_segment_receipts WHERE task_id=?').get(taskId)) return null;
      const id = randomUUID();
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=?,lease_json=?,wait_reason=NULL WHERE task_id=?')
        .run(id, JSON.stringify(lease), taskId);
      this.authority.event(scopeKey, taskId, 'fca_step_started', this.now(), { status: 'running', pauseReason: null },
        { stepId: id, actionId: lease.id, generation: lease.generation });
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
      this.db.prepare('INSERT INTO fca_task_history(task_id,step_id,entries_json,committed_at) VALUES(?,?,?,?)')
        .run(step.taskId, step.id, history, this.now());
      this.db.prepare('INSERT INTO fca_task_segment_receipts(step_id,scope_key,task_id,lease_json,created_at) VALUES(?,?,?,?,?)')
        .run(step.id, step.scopeKey, step.taskId, JSON.stringify(step.lease), this.now());
      if (checkpoint !== undefined) this.db.prepare('UPDATE fca_task_checkpoints SET checkpoint_json=? WHERE task_id=?').run(checkpoint, step.taskId);
      const pending = this.messages(step.taskId).length > 0;
      const complete = commit.disposition === 'complete' && task.kind !== 'root' && !pending;
      const waiting = !pending && (commit.disposition === 'wait' || (commit.disposition === 'complete' && task.kind === 'root'));
      const status = commit.disposition === 'fail' ? 'failed' : complete ? 'completed' : waiting ? 'running' : 'queued';
      this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason=? WHERE task_id=?')
        .run(waiting ? 'message' : null, step.taskId);
      this.authority.event(step.scopeKey, step.taskId, 'fca_step_committed', this.now(), { status, summary: commit.summary },
        { stepId: step.id, actionId: step.lease.id, generation: step.lease.generation, disposition: commit.disposition });
      if (terminal({ ...task, status }) && task.parentId) {
        const parent = this.required(step.scopeKey, task.parentId);
        if (!terminal(parent)) this.sendInTransaction(step.scopeKey, step.taskId, task.parentId,
          commit.summary || `${task.title}: ${status}`, `result:${step.id}`);
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
      const task = this.get(scopeKey, taskId); if (!task || task.phase !== 'stopped') return null;
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
    return this.authority.transaction(() => {
      const changed: TaskView[] = [];
      const receipted = new Set(this.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
      for (const { taskId, lease } of this.activeSteps(scopeKey)) {
        if (receipted.has(taskId)) continue; // The original durable receipt owns reconciliation, even during IPC failure.
        const outcome = actionState(lease); if (outcome === 'live') continue;
        const task = this.required(scopeKey, taskId), row = this.checkpoint(taskId);
        if (outcome === 'unknown') {
          if (task.pauseReason !== 'fca_unknown') this.authority.event(scopeKey, taskId, 'fca_recovery_unknown', this.now(),
            { status: 'paused', pauseReason: 'fca_unknown' }, { actionId: lease.id, generation: lease.generation });
        } else {
          this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL WHERE task_id=?').run(taskId);
          this.authority.event(scopeKey, taskId, 'fca_recovered_safe', this.now(),
            { status: row.stop_requested ? 'paused' : 'queued', pauseReason: row.stop_requested ? 'fca_stopped' : null }, { actionId: lease.id });
          if (row.stop_requested) this.finishStops(this.required(scopeKey, taskId));
        }
        changed.push(this.get(scopeKey, taskId)!);
      }
      return changed;
    });
  }
  private initialize(id: string, waitReason: string | null): void {
    this.db.prepare('INSERT INTO fca_task_checkpoints(task_id,wait_reason) VALUES(?,?)').run(id, waitReason);
  }
  private checkpoint(id: string): Checkpoint {
    const row = this.db.prepare('SELECT * FROM fca_task_checkpoints WHERE task_id=?').get(id);
    if (!row) throw new Error('FCA_CHECKPOINT_MISSING'); return row as unknown as Checkpoint;
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
    const row = this.checkpoint(task.id);
    const phase = task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed'
      : task.pauseReason === 'fca_unknown' ? 'unknown' : task.status === 'paused' || task.status === 'cancelled' ? 'stopped'
      : row.stop_requested ? 'stopping' : row.step_id ? 'executing' : task.status === 'queued' ? 'ready' : 'waiting';
    return { ...task, phase, childIds: this.children(task).map(child => child.id) };
  }
  private messages(taskId: string): TaskMessage[] {
    return this.db.prepare('SELECT * FROM fca_task_messages WHERE target_task_id=? AND consumed_by IS NULL ORDER BY rowid').all(taskId)
      .map(row => ({ id: String(row.message_id), sourceTaskId: String(row.source_task_id), targetTaskId: String(row.target_task_id),
        text: String(row.text), receivedAt: String(row.received_at) }));
  }
  private snapshotInTransaction(scope: string, id: string): TaskSnapshot | null {
    const task = this.get(scope, id); if (!task) return null;
    const row = this.checkpoint(id);
    return { task, revision: task.revision, messages: this.messages(id), checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
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
    this.required(scope, source); const task = this.required(scope, target);
    const known = this.db.prepare('SELECT * FROM fca_task_messages WHERE scope_key=? AND message_id=?').get(scope, id);
    if (known) {
      if (known.source_task_id !== source || known.target_task_id !== target || known.text !== text) throw new Error('FCA_MESSAGE_CONFLICT');
      return { accepted: true, duplicate: true, task: this.view(task) };
    }
    if (terminal(task)) throw new Error('FCA_TARGET_FINISHED');
    this.db.prepare('INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at) VALUES(?,?,?,?,?,?)')
      .run(scope, id, source, target, text, this.now());
    const row = this.checkpoint(target), wake = !row.step_id && !row.stop_requested && task.status !== 'paused';
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
function bounded(value: string, maximum: number, code: string, empty = false): void {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum) throw new Error(`FCA_${code}`);
}
function json(value: unknown): string {
  const result = JSON.stringify(value); if (result === undefined) throw new Error('FCA_JSON'); return result;
}
