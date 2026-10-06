import { randomUUID } from 'node:crypto';
import type { AgentHostConfig, AgentHostProject } from './agentHostConfig.js';
import { resolveAgentProject } from './agentHostConfig.js';
import type { PersistedAgentSession, AgentHostStateStore } from './agentHostState.js';
import type {
  AgentChangeSummary,
  AgentPlanItem,
  AgentTestResult,
  ClaimedAgentCommand,
  HostAgentEvent,
} from '../../agentTaskStore.js';
import type {
  CodexAppServerConnection,
  CodexNotification,
  CodexRequestID,
  CodexServerRequest,
} from './codexAppServerClient.js';
import { CodexTaskCommandController } from './codexTaskCommands.js';
import { CodexTaskEventPublisher } from './codexTaskEvents.js';
import {
  CodexTaskRuntimeRegistry,
  type PendingCodexApproval,
  type RuntimeTask,
} from './codexTaskRuntime.js';
import {
  approvalID,
  approvalReason,
  approvalResource,
  approvalTitle,
  arrayValue,
  changeFromItem,
  changesFromUnifiedDiff,
  commandActivity,
  commandCompletionTitle,
  compact,
  deliveryInstructions,
  errorMessage,
  friendlyError,
  grantedPermissions,
  objectValue,
  recoveryPrompt,
  resumePrompt,
  stableID,
  stringValue,
  taskPrompt,
  codexThreadParams,
  taskResult,
  taskResultInstructions,
  testFromCommand,
} from './codexTaskProjection.js';

interface CodexThreadResult {
  thread?: {
    id?: string;
    status?: { type?: string };
    turns?: Array<Record<string, unknown>>;
  };
}

function safeCommandOutput(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/gu, '')
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
    .replace(/[^\n\t\x20-\x7E\u00A0-\u{10FFFF}]/gu, '');
}

interface CodexTurnResult {
  turn?: Record<string, unknown>;
}

export interface ShannonTaskResult {
  status: 'completed' | 'paused' | 'failed';
  summary: string;
  remainingAction?: string;
}

export interface CodexTaskBridgeOptions {
  config: AgentHostConfig;
  client: CodexAppServerConnection;
  state: AgentHostStateStore;
  publish: (events: readonly HostAgentEvent[]) => Promise<void>;
  now?: () => string;
  diagnostic?: (message: string) => void;
}

export class CodexTaskBridge {
  private readonly runtimes: CodexTaskRuntimeRegistry;
  private readonly events: CodexTaskEventPublisher;
  private readonly commands: CodexTaskCommandController;
  private readonly now: () => string;
  private notificationQueue: Promise<void> = Promise.resolve();
  private started = false;
  private readonly outputBuffers = new Map<string, { runtime: RuntimeTask; text: string; timer: NodeJS.Timeout }>();

  constructor(private readonly options: CodexTaskBridgeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimes = new CodexTaskRuntimeRegistry(options.config, options.state, this.now);
    this.events = new CodexTaskEventPublisher(options.publish, this.now, error => this.diagnostic(error));
    this.commands = new CodexTaskCommandController(options, this.runtimes, this.events, this.now);
    options.client.onNotification(notification => {
      this.notificationQueue = this.notificationQueue
        .then(() => this.handleNotification(notification))
        .catch(error => this.diagnostic(error));
    });
    options.client.onServerRequest(request => {
      this.notificationQueue = this.notificationQueue
        .then(() => this.handleServerRequest(request))
        .catch(error => this.diagnostic(error));
    });
    options.client.onDiagnostic(message => this.options.diagnostic?.(message));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.client.start();
    this.started = true;
    for (const session of this.options.state.resumableSessions()) {
      try {
        await this.commands.attach(session);
      } catch (error) {
        await this.events.emit(session.taskId, 'failed', '作業へ再接続できない', friendlyError(error));
      }
    }
  }

  async stop(): Promise<void> {
    for (const taskId of [...this.outputBuffers.keys()]) await this.flushCommandOutput(taskId);
    await this.notificationQueue;
    await this.options.client.stop();
    this.started = false;
  }

  async handle(command: ClaimedAgentCommand): Promise<void> {
    if (!this.started) await this.start();
    await this.commands.handle(command);
  }

  async whenIdle(): Promise<void> {
    await this.notificationQueue;
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    const params = request.params ?? {};
    const runtime = this.runtimes.fromParams(params);
    if (!runtime) {
      this.options.client.respondError(request.id, -32602, 'Unknown Shannon task');
      return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']
      .includes(request.method)) {
      this.options.client.respondError(request.id, -32601, 'Unsupported request');
      return;
    }

    const externalRequestID = approvalID(runtime.threadId, request.id);
    const pending: PendingCodexApproval = { externalRequestID, requestID: request.id, method: request.method, params };
    runtime.approvals.set(externalRequestID, pending);
    runtime.pendingApprovalExternalRequestID = externalRequestID;
    this.runtimes.save(runtime);
    const network = objectValue(params.networkApprovalContext);
    const kind = request.method === 'item/fileChange/requestApproval' ? 'file_change'
      : request.method === 'item/permissions/requestApproval' ? 'permission'
        : network ? 'network' : 'command';
    await this.events.emit(runtime.taskId, 'approval_requested', approvalTitle(kind), '作業を続ける前に許可が必要です。', {
      approval: {
        id: randomUUID(),
        externalRequestID,
        kind,
        title: approvalTitle(kind),
        reason: stringValue(params.reason) ?? approvalReason(kind),
        resource: approvalResource(kind, params),
        // This host declines only the one operation; Codex keeps the turn and looks for another way.
        denyContinues: true,
        requestedAt: this.now(),
      },
    });
  }

  private async handleNotification(notification: CodexNotification): Promise<void> {
    const params = notification.params ?? {};
    const runtime = this.runtimes.fromParams(params);
    if (!runtime) return;
    switch (notification.method) {
      case 'turn/started': {
        const turn = objectValue(params.turn);
        runtime.turnId = stringValue(turn?.id) ?? runtime.turnId;
        this.runtimes.save(runtime);
        break;
      }
      case 'turn/plan/updated': {
        const plan = arrayValue(params.plan).map((step, index): AgentPlanItem => {
          const object = objectValue(step) ?? {};
          return {
            id: stableID(runtime.turnId ?? runtime.threadId, `${index}:${String(object.step ?? '')}`),
            title: stringValue(object.step) ?? `手順 ${index + 1}`,
            status: object.status === 'completed' ? 'completed' : object.status === 'inProgress' ? 'running' : 'pending',
          };
        });
        await this.events.emit(runtime.taskId, 'progress', '作業計画を更新', stringValue(params.explanation), {
          currentAction: plan.find(item => item.status === 'running')?.title ?? '計画を確認中',
          plan,
        });
        break;
      }
      case 'item/started':
        await this.handleItem(runtime, objectValue(params.item), false);
        break;
      case 'item/completed':
        await this.handleItem(runtime, objectValue(params.item), true);
        break;
      case 'item/commandExecution/outputDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : undefined;
        if (delta) this.bufferCommandOutput(runtime, delta);
        break;
      }
      case 'turn/diff/updated': {
        const diff = stringValue(params.diff);
        if (diff) for (const change of changesFromUnifiedDiff(diff)) runtime.changes.set(change.id, change);
        break;
      }
      case 'serverRequest/resolved': {
        const requestId = params.requestId;
        const external = requestId === undefined ? undefined : approvalID(runtime.threadId, requestId as CodexRequestID);
        if (external) {
          runtime.approvals.delete(external);
          if (runtime.pendingApprovalExternalRequestID === external) {
            runtime.pendingApprovalExternalRequestID = undefined;
            this.runtimes.save(runtime);
          }
        }
        break;
      }
      case 'error':
        if (params.willRetry === true) {
          await this.events.emit(runtime.taskId, 'progress', '接続をやり直している', errorMessage(params), {
            currentAction: 'Codexへ再接続中',
          }, 'warning');
        } else if (!runtime.suppressTerminalEvent) {
          await this.events.emit(runtime.taskId, 'failed', 'Codexで問題が発生', errorMessage(params));
        }
        break;
      case 'turn/completed':
        await this.completeTurn(runtime, objectValue(params.turn));
        break;
    }
  }

  private async handleItem(runtime: RuntimeTask, item: Record<string, unknown> | undefined, completed: boolean): Promise<void> {
    if (!item) return;
    const type = stringValue(item.type);
    if (type === 'agentMessage' && completed) {
      runtime.lastAgentMessage = stringValue(item.text);
      return;
    }
    if (type === 'commandExecution') {
      if (completed) await this.flushCommandOutput(runtime.taskId);
      const command = stringValue(item.command) ?? '';
      if (completed) {
        const test = testFromCommand(item, command);
        if (test) runtime.tests.set(test.id, test);
      }
      const commandFailed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      await this.events.emit(runtime.taskId, 'progress', completed ? commandCompletionTitle(item) : commandActivity(command), undefined, {
        currentAction: completed ? '実行結果を確認中' : commandActivity(command),
        activity: {
          kind: 'command',
          status: completed ? (commandFailed ? 'failed' : 'completed') : 'running',
        },
      }, commandFailed ? 'warning' : 'progress');
      return;
    }
    if (type === 'fileChange') {
      if (completed) {
        for (const value of arrayValue(item.changes)) {
          const change = changeFromItem(value, runtime.turnId ?? runtime.threadId);
          if (change) runtime.changes.set(change.id, change);
        }
      }
      await this.events.emit(runtime.taskId, 'progress', completed ? 'ファイル変更を反映' : 'ファイル変更を準備', undefined, {
        currentAction: completed ? '変更内容を確認中' : '安全な変更範囲を確認中',
      });
      return;
    }
    if (type === 'webSearch' && !completed) {
      await this.events.emit(runtime.taskId, 'progress', '必要な情報を確認', undefined, { currentAction: '関連情報を調査中' });
    }
  }

  private bufferCommandOutput(runtime: RuntimeTask, delta: string): void {
    const sanitized = safeCommandOutput(delta);
    if (!sanitized) return;
    const existing = this.outputBuffers.get(runtime.taskId);
    if (existing) {
      existing.text = `${existing.text}${sanitized}`.slice(-4_000);
      return;
    }
    const timer = setTimeout(() => {
      this.notificationQueue = this.notificationQueue
        .then(() => this.flushCommandOutput(runtime.taskId))
        .catch(error => this.diagnostic(error));
    }, 750);
    this.outputBuffers.set(runtime.taskId, { runtime, text: sanitized.slice(-4_000), timer });
  }

  private async flushCommandOutput(taskId: string): Promise<void> {
    const buffered = this.outputBuffers.get(taskId);
    if (!buffered) return;
    clearTimeout(buffered.timer);
    this.outputBuffers.delete(taskId);
    const detail = buffered.text.trimEnd();
    if (!detail) return;
    await this.events.emit(buffered.runtime.taskId, 'output', '実行出力', detail, {
      activity: { kind: 'command', status: 'running' },
    });
  }

  private async completeTurn(runtime: RuntimeTask, turn: Record<string, unknown> | undefined): Promise<void> {
    const status = stringValue(turn?.status);
    runtime.turnId = undefined;
    runtime.approvals.clear();
    runtime.pendingApprovalExternalRequestID = undefined;
    this.runtimes.save(runtime);
    if (runtime.suppressTerminalEvent) {
      runtime.suppressTerminalEvent = false;
      return;
    }
    if (status === 'interrupted') return;
    if (status === 'failed') {
      await this.events.emit(runtime.taskId, 'failed', 'Codexの作業が停止', errorMessage(turn ?? {}));
      return;
    }
    if (status === 'completed') {
      const result = taskResult(runtime.lastAgentMessage);
      const tests = [...runtime.tests.values()];
      const payload = { changes: [...runtime.changes.values()], tests };
      const failedVerification = tests.find(test => test.status === 'failed');
      if (failedVerification) {
        await this.events.emit(runtime.taskId, 'paused', '検証が残っています',
          result?.summary ?? compact(runtime.lastAgentMessage) ?? '自動検証で問題が見つかりました。', {
            ...payload, pauseReason: 'needs_owner',
            currentAction: result?.remainingAction ?? `${failedVerification.name}を修正して再実行`,
          });
        return;
      }
      if (!result) {
        await this.events.emit(runtime.taskId, 'paused', '完了条件を確認できません',
          compact(runtime.lastAgentMessage) ?? 'Codexのターンは終了しましたが、作業の完了条件を確認できませんでした。', {
            ...payload, pauseReason: 'needs_owner',
            currentAction: '変更・検証・配備の残作業を確認',
          });
        return;
      }
      if (result.status === 'failed') {
        await this.events.emit(runtime.taskId, 'failed', '作業を完了できません', result.summary, payload);
        return;
      }
      if (result.status === 'paused') {
        await this.events.emit(runtime.taskId, 'paused', '続きが必要です', result.summary, {
          ...payload, pauseReason: 'needs_owner',
          currentAction: result.remainingAction ?? '残っている工程を確認',
        });
        return;
      }
      await this.events.emit(runtime.taskId, 'completed', '作業が完了', result.summary, payload);
    }
  }

  private diagnostic(error: unknown): void {
    this.options.diagnostic?.(error instanceof Error ? error.message : String(error));
  }
}
