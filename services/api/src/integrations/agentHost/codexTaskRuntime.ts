import type { ActionLease } from '../../contracts/actionThreadContract.js';
import type { AgentChangeSummary, AgentReasoningEffort, AgentTestResult, HostAgentEvent } from '../../mind/action/agentTasks/agentTasksPorts.js';
import type { AgentHostConfig, AgentHostProject } from './agentHostConfig.js';
import type { AgentHostStateStore, PersistedAgentSession } from './agentHostState.js';
import { stringValue } from './codexTaskProjection.js';
import type { CodexRequestID } from './codexAppServerClient.js';

export interface PendingCodexApproval {
  externalRequestID: string;
  requestID: CodexRequestID;
  method: string;
  params: Record<string, unknown>;
}

export interface RuntimeTask {
  actionLease?: ActionLease;
  taskId: string;
  startCommandId: string;
  threadId: string;
  turnId?: string;
  project: AgentHostProject;
  lastAgentMessage?: string;
  changes: Map<string, AgentChangeSummary>;
  tests: Map<string, AgentTestResult>;
  approvals: Map<string, PendingCodexApproval>;
  pendingApprovalExternalRequestID?: string;
  goal?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  suppressTerminalEvent: boolean;
  stopRequested?: boolean;
  executionUncertain?: boolean;
  recoveredTurn?: Record<string, unknown>;
  pendingTerminalEvent?: HostAgentEvent;
}

export class CodexTaskRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeTask>();
  private readonly tasksByThread = new Map<string, string>();

  constructor(
    private readonly config: AgentHostConfig,
    private readonly state: AgentHostStateStore,
    private readonly now: () => string,
  ) {}

  get(taskId: string): RuntimeTask | undefined { return this.runtimes.get(taskId); }

  register(session: PersistedAgentSession, project: AgentHostProject): RuntimeTask {
    const runtime: RuntimeTask = {
      actionLease: session.actionLease,
      taskId: session.taskId,
      startCommandId: session.startCommandId,
      threadId: session.threadId,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      ...(session.stopRequested ? { stopRequested: true } : {}),
      ...(session.executionUncertain ? { executionUncertain: true } : {}),
      ...(session.pendingTerminalEvent ? { pendingTerminalEvent: session.pendingTerminalEvent } : {}),
      project,
      changes: new Map(),
      tests: new Map(),
      approvals: new Map(),
      ...(session.pendingApprovalExternalRequestID ? { pendingApprovalExternalRequestID: session.pendingApprovalExternalRequestID } : {}),
      ...(session.goal ? { goal: session.goal } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      suppressTerminalEvent: false,
    };
    this.runtimes.set(runtime.taskId, runtime);
    this.tasksByThread.set(runtime.threadId, runtime.taskId);
    return runtime;
  }

  fromParams(params: Record<string, unknown>): RuntimeTask | undefined {
    const threadId = stringValue(params.threadId);
    const taskId = threadId ? this.tasksByThread.get(threadId) : undefined;
    return taskId ? this.runtimes.get(taskId) : undefined;
  }

  save(runtime: RuntimeTask): void {
    this.state.saveSession({
      actionLease: runtime.actionLease,
      taskId: runtime.taskId,
      startCommandId: runtime.startCommandId,
      threadId: runtime.threadId,
      ...(runtime.turnId ? { turnId: runtime.turnId } : {}),
      ...(runtime.stopRequested ? { stopRequested: true } : {}),
      ...(runtime.executionUncertain ? { executionUncertain: true } : {}),
      ...(runtime.pendingTerminalEvent ? { pendingTerminalEvent: runtime.pendingTerminalEvent } : {}),
      ...(runtime.pendingApprovalExternalRequestID ? { pendingApprovalExternalRequestID: runtime.pendingApprovalExternalRequestID } : {}),
      ...(runtime.goal ? { goal: runtime.goal } : {}),
      ...(runtime.model ? { model: runtime.model } : {}),
      ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
      projectKey: runtime.project.key,
      cwd: runtime.project.path,
      updatedAt: this.now(),
    });
  }
}
