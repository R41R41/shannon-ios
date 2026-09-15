export type AgentTaskStatus = 'proposed' | 'queued' | 'starting' | 'running'
  | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentCommandType = 'start' | 'steer' | 'interrupt' | 'resume' | 'resolve_approval';
export type AgentCommandStatus = 'pending' | 'leased' | 'completed' | 'failed';
export type AgentEventTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error';
export type AgentActivityKind = 'command';
export type AgentActivityStatus = 'running' | 'completed' | 'failed';
export type AgentHostKind = 'local' | 'cloud';
export type AgentRoutingPreference = 'auto' | 'local' | 'cloud';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

import type {
  AgentProjectProvisioningEvent,
  AgentProjectProvisioningRequest,
  ClaimedAgentProjectProvisioning,
  CreateAgentProjectProvisioningInput,
} from './agentProjectProvisioning.js';
import type {
  AgentWorkspaceResourceEvent,
  AgentWorkspaceResourceRequest,
  ClaimedAgentWorkspaceResource,
  CreateAgentWorkspaceResourceInput,
} from './agentWorkspaceResources.js';

export interface AgentModelDescriptor {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: readonly AgentReasoningEffort[];
  defaultReasoningEffort?: AgentReasoningEffort;
}

export interface AgentHostHeartbeat {
  hostId: string;
  displayName: string;
  kind: AgentHostKind;
  capabilities: readonly string[];
  projects: readonly string[];
  models: readonly AgentModelDescriptor[];
  workspaces?: readonly AgentWorkspaceProjectState[];
}

export interface AgentWorkspaceChangeDescriptor {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface AgentWorkspaceProjectState {
  key: string;
  isGitRepository: boolean;
  currentBranch?: string;
  files: readonly string[];
  changes: readonly AgentWorkspaceChangeDescriptor[];
}

export interface AgentHostDescriptor extends AgentHostHeartbeat {
  status: 'available' | 'busy' | 'offline';
  lastSeenAt: string;
}

export interface AgentProjectDescriptor {
  key: string;
  availableHostIds: readonly string[];
  isGitRepository: boolean;
  currentBranch?: string;
  files: readonly string[];
  changes: readonly AgentWorkspaceChangeDescriptor[];
}

export interface AgentWorkspaceCatalog {
  routing: {
    defaultPreference: AgentRoutingPreference;
    resolvedHostId: string | null;
    explanation: string;
  };
  hosts: readonly AgentHostDescriptor[];
  projects: readonly AgentProjectDescriptor[];
  models: readonly AgentModelDescriptor[];
}

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
  path?: string;
  summary: string;
  additions: number;
  deletions: number;
  diffPreview?: string;
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
  assignedHostID?: string;
  projectHint?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  status: AgentTaskStatus;
  summary: string;
  currentAction?: string;
  plan: AgentPlanItem[];
  timeline: AgentTimelineEvent[];
  pendingApproval?: AgentApproval;
  changes: AgentChangeSummary[];
  tests: AgentTestResult[];
  isPinned: boolean;
  isArchived: boolean;
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
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
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
  type: 'started' | 'progress' | 'output' | 'approval_requested' | 'paused' | 'completed' | 'failed' | 'command_completed';
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
  updateMetadata(
    scopeKey: string,
    taskId: string,
    metadata: { isPinned?: boolean; isArchived?: boolean },
    now: string,
  ): AgentTask;
  enqueue(scopeKey: string, taskId: string, input: CreateAgentCommandInput, now: string): {
    task: AgentTask;
    command: ClaimedAgentCommand | null;
    created: boolean;
  };
  claim(hostId: string, now: string, leaseSeconds?: number): ClaimedAgentCommand | null;
  recordHostEvents(hostId: string, events: readonly HostAgentEvent[], now: string): readonly AgentTask[];
  heartbeat(heartbeat: AgentHostHeartbeat, now: string): void;
  resolveHost(
    projectHint: string | undefined,
    preference: string | undefined,
    now: string,
    fallbackHost: string | null,
  ): string | null;
  workspaceCatalog(projectHint: string | undefined, now: string, fallbackHost: string | null): AgentWorkspaceCatalog;
  resolveProvisioningHost(preference: string | undefined, now: string): string | null;
  resolveProvisioningHosts(preference: string | undefined, now: string): readonly string[];
  createProjectProvisioning(scopeKey: string, input: CreateAgentProjectProvisioningInput, now: string): {
    request: AgentProjectProvisioningRequest;
    created: boolean;
  };
  listProjectProvisioning(scopeKey: string): readonly AgentProjectProvisioningRequest[];
  claimProjectProvisioning(hostId: string, now: string): ClaimedAgentProjectProvisioning | null;
  recordProjectProvisioning(
    hostId: string,
    event: AgentProjectProvisioningEvent,
  ): AgentProjectProvisioningRequest;
  createWorkspaceResource(scopeKey: string, input: CreateAgentWorkspaceResourceInput, now: string): {
    request: AgentWorkspaceResourceRequest;
    created: boolean;
  };
  getWorkspaceResource(scopeKey: string, requestId: string): AgentWorkspaceResourceRequest | null;
  claimWorkspaceResource(hostId: string, now: string): ClaimedAgentWorkspaceResource | null;
  recordWorkspaceResource(hostId: string, event: AgentWorkspaceResourceEvent): AgentWorkspaceResourceRequest;
}

import { SQLiteAgentTaskStore } from './agentTaskPersistence.js';
export { SQLiteAgentTaskStore, migrateAgentTasks } from './agentTaskPersistence.js';

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly delegate = new SQLiteAgentTaskStore(':memory:');
  create(scopeKey: string, input: CreateAgentTaskInput, now: string) { return this.delegate.create(scopeKey, input, now); }
  list(scopeKey: string) { return this.delegate.list(scopeKey); }
  get(scopeKey: string, taskId: string) { return this.delegate.get(scopeKey, taskId); }
  updateMetadata(scopeKey: string, taskId: string, metadata: { isPinned?: boolean; isArchived?: boolean }, now: string) {
    return this.delegate.updateMetadata(scopeKey, taskId, metadata, now);
  }
  enqueue(scopeKey: string, taskId: string, input: CreateAgentCommandInput, now: string) {
    return this.delegate.enqueue(scopeKey, taskId, input, now);
  }
  claim(hostId: string, now: string, leaseSeconds?: number) { return this.delegate.claim(hostId, now, leaseSeconds); }
  recordHostEvents(hostId: string, events: readonly HostAgentEvent[], now: string) {
    return this.delegate.recordHostEvents(hostId, events, now);
  }
  heartbeat(heartbeat: AgentHostHeartbeat, now: string) {
    this.delegate.heartbeat(heartbeat, now);
  }
  resolveHost(projectHint: string | undefined, preference: string | undefined, now: string, fallbackHost: string | null) {
    return this.delegate.resolveHost(projectHint, preference, now, fallbackHost);
  }
  workspaceCatalog(projectHint: string | undefined, now: string, fallbackHost: string | null) {
    return this.delegate.workspaceCatalog(projectHint, now, fallbackHost);
  }
  resolveProvisioningHost(preference: string | undefined, now: string) {
    return this.delegate.resolveProvisioningHost(preference, now);
  }
  resolveProvisioningHosts(preference: string | undefined, now: string) {
    return this.delegate.resolveProvisioningHosts(preference, now);
  }
  createProjectProvisioning(scopeKey: string, input: CreateAgentProjectProvisioningInput, now: string) {
    return this.delegate.createProjectProvisioning(scopeKey, input, now);
  }
  listProjectProvisioning(scopeKey: string) { return this.delegate.listProjectProvisioning(scopeKey); }
  claimProjectProvisioning(hostId: string, now: string) {
    return this.delegate.claimProjectProvisioning(hostId, now);
  }
  recordProjectProvisioning(hostId: string, event: AgentProjectProvisioningEvent) {
    return this.delegate.recordProjectProvisioning(hostId, event);
  }
  createWorkspaceResource(scopeKey: string, input: CreateAgentWorkspaceResourceInput, now: string) {
    return this.delegate.createWorkspaceResource(scopeKey, input, now);
  }
  getWorkspaceResource(scopeKey: string, requestId: string) {
    return this.delegate.getWorkspaceResource(scopeKey, requestId);
  }
  claimWorkspaceResource(hostId: string, now: string) {
    return this.delegate.claimWorkspaceResource(hostId, now);
  }
  recordWorkspaceResource(hostId: string, event: AgentWorkspaceResourceEvent) {
    return this.delegate.recordWorkspaceResource(hostId, event);
  }
}
