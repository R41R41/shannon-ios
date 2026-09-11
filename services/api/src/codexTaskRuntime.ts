import type { AgentChangeSummary, AgentTestResult } from './agentTaskStore.js';
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
  suppressTerminalEvent: boolean;
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
      taskId: session.taskId,
      startCommandId: session.startCommandId,
      threadId: session.threadId,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      project,
      changes: new Map(),
      tests: new Map(),
      approvals: new Map(),
      ...(session.pendingApprovalExternalRequestID ? { pendingApprovalExternalRequestID: session.pendingApprovalExternalRequestID } : {}),
      ...(session.goal ? { goal: session.goal } : {}),
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
      taskId: runtime.taskId,
      startCommandId: runtime.startCommandId,
      threadId: runtime.threadId,
      ...(runtime.turnId ? { turnId: runtime.turnId } : {}),
      ...(runtime.pendingApprovalExternalRequestID ? { pendingApprovalExternalRequestID: runtime.pendingApprovalExternalRequestID } : {}),
      ...(runtime.goal ? { goal: runtime.goal } : {}),
      projectKey: runtime.project.key,
      cwd: runtime.project.path,
      updatedAt: this.now(),
    });
  }
}
