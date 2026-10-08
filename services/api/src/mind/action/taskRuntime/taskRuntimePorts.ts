import type { ActionLease } from '@shannon/mind';

export type TaskKind = 'root' | 'conversation' | 'research' | 'generic';
export type TaskPhase = 'ready' | 'executing' | 'waiting' | 'stopping' | 'unknown' | 'stopped' | 'completed' | 'failed';
export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface TaskSpec {
  title: string; goal: string; completionCriteria?: string; context?: string;
  kind?: Exclude<TaskKind, 'root'>; origin?: 'owner_request' | 'own_time';
}
export interface TaskRecord {
  id: string; scopeKey: string; parentId: string | null; kind: TaskKind;
  origin: 'owner_request' | 'own_time'; title: string; goal: string; completionCriteria: string;
  status: TaskStatus; pauseReason: string | null; summary: string;
  revision: number; createdAt: string; updatedAt: string;
}
export interface TaskView extends TaskRecord { phase: TaskPhase; childIds: string[] }
export interface TaskMessage {
  id: string; sourceTaskId: string; targetTaskId: string; text: string; receivedAt: string;
}
export interface TaskSnapshot {
  task: TaskView; messages: TaskMessage[]; history: unknown[]; checkpoint: unknown | null; revision: number;
}
export interface TaskStep {
  id: string; scopeKey: string; taskId: string; lease: ActionLease;
  revision: number; messageIds: string[]; snapshot: TaskSnapshot;
}
export interface TaskCommit {
  history?: readonly unknown[]; checkpoint?: unknown;
  disposition: 'continue' | 'wait' | 'complete' | 'fail'; summary?: string;
  consumedMessageIds?: readonly string[];
}
/** Delivery outbox for an already committed segment; retry only its original execution acknowledgement. */
export interface TaskSegmentReceipt { id: string; taskId: string; lease: ActionLease; state: 'completed' | 'cancelled' }
export interface TaskQuery { parentId?: string | null; limit?: number; offset?: number }
/** Implemented by agentTasks; all mutations participate in this authority's synchronous transaction. */
export interface TaskAuthority {
  transaction<T>(work: () => T): T;
  get(scopeKey: string, id: string): TaskRecord | null;
  list(scopeKey: string, query?: TaskQuery): TaskRecord[];
  root(scopeKey: string): TaskRecord | null;
  byRequest(scopeKey: string, requestKey: string): TaskRecord | null;
  create(input: Omit<TaskRecord, 'revision' | 'updatedAt'> & { requestKey: string }): TaskRecord;
  event(scopeKey: string, id: string, type: string, at: string,
    change?: { status?: TaskStatus; pauseReason?: string | null; summary?: string }, payload?: Record<string, unknown>): TaskRecord;
}
export interface TaskRuntimeOptions {
  authority: TaskAuthority;
  /** Wiring validates the existing action lease, scope, origin and source task synchronously, on the same database. */
  leaseValid(scopeKey: string, taskId: string, lease: ActionLease, at: string): boolean;
  now?: () => string;
}
export interface TaskRuntime {
  ensureRoot(scopeKey: string): TaskView;
  createChild(scopeKey: string, parentId: string, spec: TaskSpec, requestId: string): TaskView;
  get(scopeKey: string, taskId: string): TaskView | null;
  list(scopeKey: string, query?: TaskQuery): TaskView[];
  send(scopeKey: string, sourceTaskId: string, targetId: string, text: string, messageId: string):
    { accepted: true; duplicate: boolean; task: TaskView };
  snapshot(scopeKey: string, taskId: string): TaskSnapshot | null;
  beginStep(scopeKey: string, taskId: string, lease: ActionLease, expectedRevision?: number): TaskStep | null;
  commitStep(step: TaskStep, commit: TaskCommit): TaskSnapshot | null;
  /** Record local cancellation only after model/tool promises have actually unwound. */
  recordStoppedStep(step: TaskStep): boolean;
  pendingReceipts(scopeKey: string): TaskSegmentReceipt[];
  /** Wiring removes a receipt only after proving that its original lease reached the matching terminal action state. */
  acknowledgeReceipt(scopeKey: string, id: string): boolean;
  wait(scopeKey: string, taskId: string, expectedRevision: number): TaskView | null;
  stop(scopeKey: string, taskId: string, reason: string): TaskView[];
  acknowledgeStop(step: TaskStep): TaskView | null;
  resume(scopeKey: string, taskId: string): TaskView | null;
  activeSteps(scopeKey: string): Array<{ taskId: string; lease: ActionLease }>;
  recover(scopeKey: string, actionState: (lease: ActionLease) => 'live' | 'safe' | 'unknown'): TaskView[];
}
