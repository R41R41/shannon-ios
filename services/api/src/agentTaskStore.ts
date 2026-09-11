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

import { SQLiteAgentTaskStore } from './agentTaskPersistence.js';
export { SQLiteAgentTaskStore, migrateAgentTasks } from './agentTaskPersistence.js';

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
