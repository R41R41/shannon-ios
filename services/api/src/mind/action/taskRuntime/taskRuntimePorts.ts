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
  /** The turn of this source is still in progress (not bound, not failed) and the task is conversation work, which runs on it. */
  pending?: true;
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
  /**
   * The task's plan tree changed in this step (`fcaPlanTools.ts`): its flat copy for the app's task list (`agent_tasks.plan_json`),
   * written with the step, and an event `fca_plan_updated`. Absent: the plan is as it was.
   */
  plan?: readonly { id: string; title: string; status: 'pending' | 'running' | 'completed' }[];
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
  create(input: Omit<TaskRecord, 'revision' | 'updatedAt'> & { requestKey: string; capability?: string }): TaskRecord;
  event(scopeKey: string, id: string, type: string, at: string,
    change?: { status?: TaskStatus; pauseReason?: string | null; summary?: string; proof?: boolean; lateReport?: boolean }, payload?: Record<string, unknown>): TaskRecord;
  /** Writes the state a task's checkpoint now means after a change without an event (ADR-0009 stage 1, S4). */
  refresh?(id: string, at: string): void;
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
  /**
   * Whether `retireUnknown` must leave this unknown task alone for now: a Minecraft request waiting for its body to return, whose
   * lost step the Minecraft recovery closes (`fcaBodyRecovery.ts`). Absent: none, and every unknown task retires at its exit.
   */
  holdUnknown?(task: TaskRecord): boolean;
  /**
   * Whether a task's summary is one a pause wrote ("paused, can be resumed"): `resume` clears it, and so does the first commit of a task
   * that is running again, so that a task that goes on does not keep saying it is paused. Absent: no summary is cleared.
   */
  pausedSummary?(summary: string): boolean;
  /**
   * Whether a child's result is sent to its parent's inbox when it ends. Minecraft run 17 (2026-10-19): an operator's request ended,
   * its result woke the root's common task, and that one decision read 117k tokens ($0.47) and blocked the event loop for 22.7 s to
   * answer nobody: the operator reads the result from the audit. Absent: every child reports, as before.
   */
  reportsToParent?(task: TaskRecord): boolean;
  /**
   * `SHANNON_FCA_PROVENANCE_REFS` (owner decision 2026-10-15): a body task asked for with `{ sources: 'asking' }` inherits only the
   * asking conversation's sources, and step records store their sources by reference (`infra/sqlite/fcaProvenanceSets.ts`).
   * Absent or false: the parent's whole source set and a copy in each record, as before. Records by reference are read either way.
   */
  provenanceRefs?: boolean;
}
/**
 * What a child inherits at creation. `parent` (the default): the parent's whole source set. `asking` (a Minecraft request, with
 * `provenanceRefs` on): only the conversation that asked; from a conversation task, its current turn and the reports that turn
 * read (its `refs`, as before); from the root, nothing (an in-game request brings its own turn, `observeExternal`; an operator
 * request has none). Sources the task reads later are added as before.
 */
export interface TaskChildOptions { sources?: 'parent' | 'asking' }
export interface TaskRuntime extends TaskConversationDeliveryRuntime {
  admitPlaceContext?(step: TaskStep, childId: string, context: import('../../../integrations/places/placeDiscovery.js').PlaceSearchContext): boolean;
  placeContext?(scopeKey: string, taskId: string): import('../../../integrations/places/placeDiscovery.js').PlaceSearchContext | undefined;
  progress?(scopeKey: string, taskId: string): TaskProgress | null;
  recordProgress?(step: TaskStep, event: TaskProgressEvent): boolean;
  /**
   * The owner-visible report that the runtime paused a task by itself (resumable, not failed), written once per `key` (a step or a
   * pause): false when there is no such task or this report is already there. It needs no step, so it also serves a pause made while
   * the task is stopping or has no step. Resuming the task takes the report away again and puts back the one it replaced. `spoken` is
   * the fixed sentence a call says for it (no model words a pause).
   */
  recordPauseNotice?(scopeKey: string, taskId: string, key: string, text: string, spoken?: string): boolean;
  /** Writes the spoken form of the task's current report; false once that report was replaced or already has one. */
  /** `heard`: the report was said in the voice turn that asked for it (`TaskProgressStore.hear`), so it is never said again (its card stays). */
  recordSpokenReport?(scopeKey: string, taskId: string, reportId: string, spoken: string, heard?: true): boolean;
  observeExternal(scopeKey: string, targetTaskId: string, event: TaskExternalEvent): { accepted: true; duplicate: boolean; task: TaskView };
  admitSleep(scopeKey: string, jobId: string): TaskView | null;
  sleepTicketForTask(scopeKey: string, taskId: string): TaskSleepTicket | null;
  ensureRoot(scopeKey: string): TaskView;
  createChild(scopeKey: string, parentId: string, spec: TaskSpec, requestId: string, options?: TaskChildOptions): TaskView;
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
  /**
   * The one unknown exit of FCA tasks at `at` (ADR-0009 stage 1, S5): tasks whose unknown reached it leave `fca_unknown` without
   * replaying anything (root/conversation run again, others fail as `unknown_retired`).
   */
  retireUnknown?(scopeKey: string, at: string): TaskView[];
  /**
   * A task that `retireUnknown` failed (`fca_unknown_retired`, then failed with its unknown time kept) is paused again as stopped, resumable, when the one who holds it asks (A-17:
   * the operator's resume of a hold that was open when the exit came). Null: it is not such a task (any other failed task stays failed).
   */
  reopenRetired?(scopeKey: string, taskId: string, summary: string): TaskView | null;
  /**
   * The internal root's step the provider refused before anything ran (deterministic 4xx, history limit): closed as a known
   * failure; the root returns to its inbox and the messages the step saw are delivered once more, then consumed (fix 2026-10-14).
   */
  closeRejectedStep?(step: TaskStep): boolean;
  /** Every task waiting on messages while a delivered one is pending becomes ready (the tick's lost-wakeup sweep). */
  wakePendingInboxes?(scopeKey: string): TaskView[];
}
