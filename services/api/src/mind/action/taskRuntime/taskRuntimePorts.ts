import type { TaskConversationDeliveryRuntime } from './taskConversationDeliveryPorts.js';
import type { TaskSleepTicket } from './taskMaintenancePorts.js';
export type { TaskSleepTicket } from './taskMaintenancePorts.js';
import type { TaskExternalEvent } from './taskExternalEventPorts.js';
export type { TaskExternalEvent } from './taskExternalEventPorts.js';
export type { TaskConversationDelivery, TaskConversationDeliveryInput, TaskConversationDeliveryStage } from './taskConversationDeliveryPorts.js';
import type { ActionLease } from '@shannon/mind';
import type { TaskHistoryCommit, TaskHistoryWindow } from './taskHistoryPorts.js';
import type { TaskProgress, TaskProgressEvent } from './taskProgressPorts.js';
export type { TaskHistoryCommit, TaskHistoryPublicRound, TaskHistoryRound, TaskHistorySummary, TaskHistoryWindow } from './taskHistoryPorts.js';

export type TaskKind = 'root' | 'conversation' | 'research' | 'generic' | 'sleep';
export type TaskOrigin = 'owner_request' | 'own_time' | 'maintenance';
export type TaskPhase = 'ready' | 'executing' | 'waiting' | 'stopping' | 'unknown' | 'stopped' | 'completed' | 'failed';
export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface TaskSpec {
  title: string; goal: string; completionCriteria?: string; context?: string;
  kind?: Exclude<TaskKind, 'root' | 'sleep'>; origin?: 'owner_request' | 'own_time';
}
export interface TaskRecord {
  id: string; scopeKey: string; parentId: string | null; kind: TaskKind;
  origin: TaskOrigin; title: string; goal: string; completionCriteria: string;
  status: TaskStatus; pauseReason: string | null; summary: string;
  revision: number; createdAt: string; updatedAt: string;
}
export interface TaskView extends TaskRecord { phase: TaskPhase; childIds: string[] }
export interface TaskMessage {
  id: string; sourceTaskId: string; targetTaskId: string; text: string; receivedAt: string;
}
export interface TaskConversationSource {
  experienceId: string; threadId: string; observedAt: string; recalledMemoryIds: readonly string[];
  readSourceIds?: readonly string[];
}
export type TaskSource = (Omit<TaskConversationSource, 'experienceId'> & {
  kind?: 'conversation'; stepId: string; experienceId: string | null;
}) | { kind: 'memory'; stepId: string; experienceId: null; threadId: null; observedAt: string; recalledMemoryIds: readonly string[]; readSourceIds?: readonly string[] };
export interface TaskSourceObservation { observationId: string; recalledMemoryIds: readonly string[]; readSourceIds?: readonly string[] }
export interface TaskSnapshot {
  task: TaskView; messages: TaskMessage[]; sources: TaskSource[]; history: unknown[]; checkpoint: unknown | null; revision: number;
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
export interface TaskQuery { parentId?: string | null; limit?: number; offset?: number; order?: 'recent' }
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
  /** Existing foreground respond lease. Absent validation refuses conversation attachment. */
  conversationLeaseValid?(scopeKey: string, lease: ActionLease, at: string): boolean;
  /** Trusted read-only schedule authority; absent means maintenance admission is disabled. */
  sleepTicket?(scopeKey: string, jobId: string): TaskSleepTicket | null;
  now?: () => string;
}
export interface TaskRuntime extends TaskConversationDeliveryRuntime {
  admitPlaceContext?(step: TaskStep, childId: string, context: import('../../../integrations/places/placeDiscovery.js').PlaceSearchContext): boolean;
  placeContext?(scopeKey: string, taskId: string): import('../../../integrations/places/placeDiscovery.js').PlaceSearchContext | undefined;
  progress?(scopeKey: string, taskId: string): TaskProgress | null;
  recordProgress?(step: TaskStep, event: TaskProgressEvent): boolean;
  /** Writes the spoken form of the task's current report; false once that report was replaced or already has one. */
  recordSpokenReport?(scopeKey: string, taskId: string, reportId: string, spoken: string): boolean;
  observeExternal(scopeKey: string, targetTaskId: string, event: TaskExternalEvent): { accepted: true; duplicate: boolean; task: TaskView };
  admitSleep(scopeKey: string, jobId: string): TaskView | null;
  sleepTicketForTask(scopeKey: string, taskId: string): TaskSleepTicket | null;
  ensureRoot(scopeKey: string): TaskView;
  createChild(scopeKey: string, parentId: string, spec: TaskSpec, requestId: string): TaskView;
  get(scopeKey: string, taskId: string): TaskView | null;
  list(scopeKey: string, query?: TaskQuery): TaskView[];
  /** Fair admission candidates, oldest successful admission first; canonical task status still determines readiness. */
  readyTasks(scopeKey: string, limit?: number): TaskView[];
  beginConversation(scopeKey: string, threadId: string, lease: ActionLease): TaskStep | null;
  observeConversationMessages(step: TaskStep, messageIds: readonly string[]): boolean;
  completeConversation(step: TaskStep, source: TaskConversationSource, consumedMessageIds?: readonly string[]): boolean;
  failConversation(step: TaskStep): void;
  taskSources(scopeKey: string, taskId: string, messageIds?: readonly string[]): TaskSource[];
  /** The running native segment observed these visible task projections; their lineage must follow its history and children. */
  inheritTaskSources(step: TaskStep, sourceTaskIds: readonly string[]): boolean;
  observeSources(step: TaskStep, observation: TaskSourceObservation): boolean;
  send(scopeKey: string, sourceTaskId: string, targetId: string, text: string, messageId: string):
    { accepted: true; duplicate: boolean; task: TaskView };
  /** Lightweight canonical inbox observation; excludes message bodies and native history. */
  pendingMessageIds?(scopeKey: string, taskId: string): readonly string[];
  snapshot(scopeKey: string, taskId: string): TaskSnapshot | null;
  history(scopeKey: string, taskId: string, messageIds?: readonly string[]): TaskHistoryWindow | null;
  /** Installs a derived summary only under the current segment's lease and fresh source visibility. */
  commitCompaction(step: TaskStep, request: TaskHistoryCommit, sourcesVisible: () => boolean): boolean;
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
  /** When the task entered `fca_unknown`; null when it is not unknown. */
  unknownSince?(scopeKey: string, taskId: string): string | null;
  /** Tasks unknown since `cutoff` or earlier leave `fca_unknown` without replaying anything (root/conversation keep running, others fail). */
  retireUnknown?(scopeKey: string, cutoff: string): TaskView[];
}
