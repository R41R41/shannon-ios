import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { AgentHostConfig, AgentHostProject } from './agentHostConfig.js';
import { resolveAgentProject } from './agentHostConfig.js';
import type { PersistedAgentSession, AgentHostStateStore } from './agentHostState.js';
import type {
  AgentChangeSummary,
  AgentPlanItem,
  AgentTestResult,
  ClaimedAgentCommand,
  HostAgentEvent,
} from './agentTaskStore.js';
import type {
  CodexAppServerConnection,
  CodexNotification,
  CodexRequestID,
  CodexServerRequest,
} from './codexAppServerClient.js';

interface CodexThreadResult {
  thread?: {
    id?: string;
    status?: { type?: string };
    turns?: Array<Record<string, unknown>>;
  };
}

interface CodexTurnResult {
  turn?: Record<string, unknown>;
}

interface PendingCodexApproval {
  externalRequestID: string;
  requestID: CodexRequestID;
  method: string;
  params: Record<string, unknown>;
}

interface RuntimeTask {
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

interface ShannonTaskResult {
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
  private readonly runtimes = new Map<string, RuntimeTask>();
  private readonly tasksByThread = new Map<string, string>();
  private readonly now: () => string;
  private notificationQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: CodexTaskBridgeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
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
        await this.attach(session);
      } catch (error) {
        await this.emit(session.taskId, 'failed', '作業へ再接続できない', friendlyError(error));
      }
    }
  }

  async stop(): Promise<void> {
    await this.notificationQueue;
    await this.options.client.stop();
    this.started = false;
  }

  async handle(command: ClaimedAgentCommand): Promise<void> {
    if (!this.started) await this.start();
    try {
      switch (command.type) {
        case 'start': await this.startTask(command); break;
        case 'steer': await this.steerTask(command); break;
        case 'interrupt': await this.interruptTask(command); break;
        case 'resume': await this.resumeTask(command); break;
        case 'resolve_approval': await this.resolveApproval(command); break;
      }
    } catch (error) {
      await this.emit(command.taskId, 'failed', '作業を続けられない', friendlyError(error));
    } finally {
      await this.publish([this.event(command.taskId, 'command_completed', '命令を作業環境へ反映', undefined, {
        commandId: command.id,
      }, `command:${command.id}:completed`)]);
    }
  }

  async whenIdle(): Promise<void> {
    await this.notificationQueue;
  }

  private async startTask(command: ClaimedAgentCommand): Promise<void> {
    const existing = this.options.state.session(command.taskId);
    if (existing) {
      if (existing.startCommandId !== command.id) throw new Error('既存作業と開始命令が一致しません。');
      await this.ensureRuntime(command.taskId);
      await this.emit(command.taskId, 'progress', '既存の作業へ復帰', '二重に開始せず、保存済みのCodex作業を使う。', {
        currentAction: 'Codexの作業状態を確認中',
      });
      return;
    }

    const project = resolveAgentProject(this.options.config, command.payload.projectHint);
    const threadParams = this.threadParams(project);
    const threadResult = await this.options.client.request<CodexThreadResult>('thread/start', threadParams);
    const threadId = stringValue(threadResult.thread?.id);
    if (!threadId) throw new Error('Codexが作業スレッドを作成できませんでした。');

    const session: PersistedAgentSession = {
      taskId: command.taskId,
      startCommandId: command.id,
      threadId,
      goal: stringValue(command.payload.goal),
      projectKey: project.key,
      cwd: project.path,
      updatedAt: this.now(),
    };
    this.options.state.saveSession(session);
    const runtime = this.registerRuntime(session, project);
    const turn = await this.startTurn(runtime, taskPrompt(command, project, this.options.config));
    runtime.turnId = turn;
    this.saveRuntime(runtime);
    await this.emit(command.taskId, 'started', 'Codexが作業を開始', '依頼内容と対象プロジェクトを確認している。', {
      currentAction: '作業計画を組み立て中',
    });
  }

  private async steerTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    const instruction = stringValue(command.payload.instruction);
    if (!instruction) throw new Error('追加の指示が空です。');
    if (runtime.turnId) {
      await this.options.client.request('turn/steer', {
        threadId: runtime.threadId,
        expectedTurnId: runtime.turnId,
        input: [{ type: 'text', text: instruction }],
      });
    } else {
      runtime.turnId = await this.startTurn(runtime, instruction);
      this.saveRuntime(runtime);
    }
    await this.emit(command.taskId, 'progress', '追加の指示をCodexへ送信', instruction, {
      currentAction: '新しい条件を反映中',
    });
  }

  private async interruptTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    const cancel = command.payload.cancel === true || command.payload.cancel === 'true';
    runtime.suppressTerminalEvent = cancel;
    if (runtime.turnId) {
      await this.options.client.request('turn/interrupt', { threadId: runtime.threadId, turnId: runtime.turnId });
    }
    runtime.turnId = undefined;
    runtime.approvals.clear();
    runtime.pendingApprovalExternalRequestID = undefined;
    this.saveRuntime(runtime);
    if (!cancel) await this.emit(command.taskId, 'paused', '作業を一時停止', '止めた場所を保存し、再開を待っている。');
  }

  private async resumeTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    if (runtime.turnId) throw new Error('Codexの作業はすでに動いています。');
    runtime.suppressTerminalEvent = false;
    runtime.turnId = await this.startTurn(runtime, resumePrompt(runtime.project, this.options.config, runtime.taskId));
    this.saveRuntime(runtime);
    await this.emit(command.taskId, 'started', '作業を再開', '保存済みのCodexスレッドで続きを始めた。', {
      currentAction: '前回の続きから確認中',
    });
  }

  private async resolveApproval(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    const externalRequestID = stringValue(command.payload.externalRequestID);
    const pending = externalRequestID ? runtime.approvals.get(externalRequestID) : undefined;
    if (!pending) throw new Error('この承認要求は期限切れです。');
    if (!runtime.turnId || stringValue(pending.params.turnId) !== runtime.turnId) {
      throw new Error('この承認要求は現在の作業ターンと一致しません。');
    }
    const decision = String(command.payload.decision ?? 'deny');
    const forSession = decision === 'allow_session';
    const accepted = decision === 'allow_once' || forSession;

    if (pending.method === 'item/commandExecution/requestApproval'
      || pending.method === 'item/fileChange/requestApproval') {
      this.options.client.respond(pending.requestID, {
        decision: accepted ? (forSession ? 'acceptForSession' : 'accept') : 'decline',
      });
    } else if (pending.method === 'item/permissions/requestApproval') {
      this.options.client.respond(pending.requestID, {
        permissions: accepted ? grantedPermissions(pending.params.permissions) : {},
        scope: forSession ? 'session' : 'turn',
      });
    } else {
      this.options.client.respondError(pending.requestID, -32601, 'Unsupported approval request');
    }
    runtime.approvals.delete(pending.externalRequestID);

    if (accepted) {
      runtime.pendingApprovalExternalRequestID = undefined;
      this.saveRuntime(runtime);
      await this.emit(command.taskId, 'progress', '判断をCodexへ送信', '許可した範囲だけで作業を続ける。', {
        currentAction: '許可された操作を実行中',
      });
    } else {
      runtime.suppressTerminalEvent = true;
      if (runtime.turnId) {
        await this.options.client.request('turn/interrupt', {
          threadId: runtime.threadId,
          turnId: runtime.turnId,
        }).catch(() => undefined);
      }
      runtime.turnId = undefined;
      runtime.pendingApprovalExternalRequestID = undefined;
      this.saveRuntime(runtime);
    }
  }

  private async attach(session: PersistedAgentSession): Promise<RuntimeTask> {
    const project = this.options.config.projects.get(session.projectKey);
    if (!project || project.path !== session.cwd) throw new Error('保存済みプロジェクトが現在の許可一覧にありません。');
    if (session.pendingApprovalExternalRequestID) {
      // A Codex approval is tied to the live app-server request. Reusing a thread whose
      // approval request disappeared can leave an unmatched tool call in its history,
      // so recover the durable Shannon task in a clean Codex thread instead.
      const replacement = await this.options.client.request<CodexThreadResult>('thread/start', this.threadParams(project));
      const replacementThreadID = stringValue(replacement.thread?.id);
      if (!replacementThreadID) throw new Error('Codexが復旧用スレッドを作成できませんでした。');
      const recoverySession: PersistedAgentSession = {
        ...session,
        threadId: replacementThreadID,
        turnId: undefined,
        updatedAt: this.now(),
      };
      this.options.state.saveSession(recoverySession);
      const runtime = this.registerRuntime(recoverySession, project);
      runtime.turnId = await this.startTurn(runtime, recoveryPrompt(
        project, this.options.config, runtime.taskId, true, session.goal,
      ));
      runtime.pendingApprovalExternalRequestID = undefined;
      this.saveRuntime(runtime);
      await this.emit(runtime.taskId, 'started', '承認待ちから自動復旧', '期限切れの承認を破棄し、同じ作業を新しいCodexスレッドで再開した。', {
        currentAction: '中断箇所と必要な検証を確認中',
        clearPendingApproval: true,
      });
      return runtime;
    }
    const result = await this.options.client.request<CodexThreadResult>('thread/resume', {
      threadId: session.threadId,
      ...this.threadParams(project),
      excludeTurns: false,
    });
    const runtime = this.registerRuntime(session, project);
    const activeTurn = result.thread?.turns?.find(turn => turn.status === 'inProgress');
    const activeTurnID = stringValue(activeTurn?.id)
      ?? (result.thread?.status?.type === 'active' ? session.turnId : undefined);
    if (!activeTurnID && session.turnId) {
      runtime.turnId = await this.startTurn(runtime, recoveryPrompt(
        project, this.options.config, runtime.taskId, false, session.goal,
      ));
      this.saveRuntime(runtime);
      await this.emit(runtime.taskId, 'started', '中断した作業を自動復旧', '同じCodexスレッドで中断箇所から再開した。', {
        currentAction: '中断箇所と未完了の作業を確認中',
      });
      return runtime;
    }
    runtime.turnId = activeTurnID;
    this.saveRuntime(runtime);
    return runtime;
  }

  private async ensureRuntime(taskId: string): Promise<RuntimeTask> {
    const runtime = this.runtimes.get(taskId);
    if (runtime) return runtime;
    const session = this.options.state.session(taskId);
    if (!session) throw new Error('作業環境にセッションが見つかりません。');
    return await this.attach(session);
  }

  private registerRuntime(session: PersistedAgentSession, project: AgentHostProject): RuntimeTask {
    const runtime: RuntimeTask = {
      taskId: session.taskId,
      startCommandId: session.startCommandId,
      threadId: session.threadId,
      ...(session.turnId ? { turnId: session.turnId } : {}),
      project,
      changes: new Map(),
      tests: new Map(),
      approvals: new Map(),
      ...(session.pendingApprovalExternalRequestID
        ? { pendingApprovalExternalRequestID: session.pendingApprovalExternalRequestID }
        : {}),
      ...(session.goal ? { goal: session.goal } : {}),
      suppressTerminalEvent: false,
    };
    this.runtimes.set(runtime.taskId, runtime);
    this.tasksByThread.set(runtime.threadId, runtime.taskId);
    return runtime;
  }

  private async startTurn(runtime: RuntimeTask, text: string): Promise<string> {
    const result = await this.options.client.request<CodexTurnResult>('turn/start', {
      threadId: runtime.threadId,
      input: [{ type: 'text', text }],
      turnTrigger: 'shannon_ios',
      ...(this.options.config.codexEffort ? { effort: this.options.config.codexEffort } : {}),
    });
    const turnId = stringValue(result.turn?.id);
    if (!turnId) throw new Error('Codexが作業ターンを開始できませんでした。');
    return turnId;
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    const params = request.params ?? {};
    const runtime = this.runtimeFor(params);
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
    this.saveRuntime(runtime);
    const network = objectValue(params.networkApprovalContext);
    const kind = request.method === 'item/fileChange/requestApproval' ? 'file_change'
      : request.method === 'item/permissions/requestApproval' ? 'permission'
        : network ? 'network' : 'command';
    await this.emit(runtime.taskId, 'approval_requested', approvalTitle(kind), '作業を続ける前に確認が必要です。', {
      approval: {
        id: randomUUID(),
        externalRequestID,
        kind,
        title: approvalTitle(kind),
        reason: stringValue(params.reason) ?? approvalReason(kind),
        resource: approvalResource(kind, params),
        requestedAt: this.now(),
      },
    });
  }

  private async handleNotification(notification: CodexNotification): Promise<void> {
    const params = notification.params ?? {};
    const runtime = this.runtimeFor(params);
    if (!runtime) return;
    switch (notification.method) {
      case 'turn/started': {
        const turn = objectValue(params.turn);
        runtime.turnId = stringValue(turn?.id) ?? runtime.turnId;
        this.saveRuntime(runtime);
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
        await this.emit(runtime.taskId, 'progress', '作業計画を更新', stringValue(params.explanation), {
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
            this.saveRuntime(runtime);
          }
        }
        break;
      }
      case 'error':
        if (params.willRetry === true) {
          await this.emit(runtime.taskId, 'progress', '接続をやり直している', errorMessage(params), {
            currentAction: 'Codexへ再接続中',
          }, 'warning');
        } else if (!runtime.suppressTerminalEvent) {
          await this.emit(runtime.taskId, 'failed', 'Codexで問題が発生', errorMessage(params));
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
      const command = stringValue(item.command) ?? '';
      if (completed) {
        const test = testFromCommand(item, command);
        if (test) runtime.tests.set(test.id, test);
      }
      const commandFailed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      await this.emit(runtime.taskId, 'progress', completed ? commandCompletionTitle(item) : commandActivity(command), undefined, {
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
      await this.emit(runtime.taskId, 'progress', completed ? 'ファイル変更を反映' : 'ファイル変更を準備', undefined, {
        currentAction: completed ? '変更内容を確認中' : '安全な変更範囲を確認中',
      });
      return;
    }
    if (type === 'webSearch' && !completed) {
      await this.emit(runtime.taskId, 'progress', '必要な情報を確認', undefined, { currentAction: '関連情報を調査中' });
    }
  }

  private async completeTurn(runtime: RuntimeTask, turn: Record<string, unknown> | undefined): Promise<void> {
    const status = stringValue(turn?.status);
    runtime.turnId = undefined;
    runtime.approvals.clear();
    runtime.pendingApprovalExternalRequestID = undefined;
    this.saveRuntime(runtime);
    if (runtime.suppressTerminalEvent) {
      runtime.suppressTerminalEvent = false;
      return;
    }
    if (status === 'interrupted') return;
    if (status === 'failed') {
      await this.emit(runtime.taskId, 'failed', 'Codexの作業が停止', errorMessage(turn ?? {}));
      return;
    }
    if (status === 'completed') {
      const result = taskResult(runtime.lastAgentMessage);
      const tests = [...runtime.tests.values()];
      const payload = { changes: [...runtime.changes.values()], tests };
      const failedVerification = tests.find(test => test.status === 'failed');
      if (failedVerification) {
        await this.emit(runtime.taskId, 'paused', '検証が残っています',
          result?.summary ?? compact(runtime.lastAgentMessage) ?? '自動検証で問題が見つかりました。', {
            ...payload,
            currentAction: result?.remainingAction ?? `${failedVerification.name}を修正して再実行`,
          });
        return;
      }
      if (!result) {
        await this.emit(runtime.taskId, 'paused', '完了条件を確認できません',
          compact(runtime.lastAgentMessage) ?? 'Codexのターンは終了しましたが、作業の完了条件を確認できませんでした。', {
            ...payload,
            currentAction: '変更・検証・配備の残作業を確認',
          });
        return;
      }
      if (result.status === 'failed') {
        await this.emit(runtime.taskId, 'failed', '作業を完了できません', result.summary, payload);
        return;
      }
      if (result.status === 'paused') {
        await this.emit(runtime.taskId, 'paused', '続きが必要です', result.summary, {
          ...payload,
          currentAction: result.remainingAction ?? '残っている工程を確認',
        });
        return;
      }
      await this.emit(runtime.taskId, 'completed', '作業が完了', result.summary, payload);
    }
  }

  private runtimeFor(params: Record<string, unknown>): RuntimeTask | undefined {
    const threadId = stringValue(params.threadId);
    const taskId = threadId ? this.tasksByThread.get(threadId) : undefined;
    return taskId ? this.runtimes.get(taskId) : undefined;
  }

  private saveRuntime(runtime: RuntimeTask): void {
    this.options.state.saveSession({
      taskId: runtime.taskId,
      startCommandId: runtime.startCommandId,
      threadId: runtime.threadId,
      ...(runtime.turnId ? { turnId: runtime.turnId } : {}),
      ...(runtime.pendingApprovalExternalRequestID
        ? { pendingApprovalExternalRequestID: runtime.pendingApprovalExternalRequestID }
        : {}),
      ...(runtime.goal ? { goal: runtime.goal } : {}),
      projectKey: runtime.project.key,
      cwd: runtime.project.path,
      updatedAt: this.now(),
    });
  }

  private async emit(
    taskId: string,
    type: HostAgentEvent['type'],
    title: string,
    detail?: string,
    payload?: Record<string, unknown>,
    tone?: HostAgentEvent['tone'],
  ): Promise<void> {
    await this.publish([this.event(taskId, type, title, detail, payload, undefined, tone)]);
  }

  private event(
    taskId: string,
    type: HostAgentEvent['type'],
    title: string,
    detail?: string,
    payload?: Record<string, unknown>,
    eventId: string = randomUUID(),
    tone?: HostAgentEvent['tone'],
  ): HostAgentEvent {
    return {
      eventId, taskId, type, title,
      ...(detail ? { detail } : {}),
      ...(payload ? { payload } : {}),
      ...(tone ? { tone } : {}),
      occurredAt: this.now(),
    };
  }

  private async publish(events: readonly HostAgentEvent[]): Promise<void> {
    try {
      await this.options.publish(events);
    } catch (error) {
      this.diagnostic(error);
    }
  }

  private threadParams(project: AgentHostProject): Record<string, unknown> {
    return {
      cwd: project.path,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      serviceName: 'shannon_agent_host',
      ...(this.options.config.codexModel ? { model: this.options.config.codexModel } : {}),
    };
  }

  private diagnostic(error: unknown): void {
    this.options.diagnostic?.(error instanceof Error ? error.message : String(error));
  }
}

function taskPrompt(command: ClaimedAgentCommand, project: AgentHostProject, config: AgentHostConfig): string {
  const goal = stringValue(command.payload.goal) ?? '依頼された作業を安全に完了する';
  return [
    'Shannonから明示的に開始された作業です。',
    `目的: ${goal}`,
    `対象プロジェクト: ${project.key}`,
    ...deliveryInstructions(config, command.taskId),
    '作業前に対象リポジトリ直下のAGENTS.mdを最後まで読み、そこから案内される現行architectureとrunbookに従ってください。番号付きHTML資料は、ユーザーがその資料を明示しない限り設計履歴として扱ってください。',
    '最初にgit statusを確認し、依頼と無関係な既存変更を保持してください。',
    '対象プロジェクトを確認し、必要な変更と検証を最後まで行ってください。',
    '依頼中のUI上の主体（シャノン側の返答／ユーザー側の発言）を明示的に区別し、代名詞だけで判断しないでください。',
    '実機反映が完了条件に含まれる場合、ビルド成功だけを完了とせず、接続されたiPhoneへのインストールと起動確認まで行ってください。実機が使えない場合は完了と偽らず、その事実を残してください。',
    '判断が必要な操作では承認を求め、完了時は変更点・試験結果・残る課題を簡潔に報告してください。',
    ...taskResultInstructions(),
  ].join('\n');
}

function resumePrompt(project: AgentHostProject, config: AgentHostConfig, taskId: string): string {
  return [
    '前の作業を、安全に止めた箇所から再開してください。',
    `対象プロジェクト: ${project.key}`,
    ...deliveryInstructions(config, taskId),
    '再開時点のgit statusと未完了の検証を確認し、対象リポジトリ直下のAGENTS.mdおよび現行architecture・runbookを読み直してください。',
    '以前の説明だけで完了とせず、現在のファイル・試験・必要な配備結果を根拠に続行してください。',
    ...taskResultInstructions(),
  ].join('\n');
}

function recoveryPrompt(
  project: AgentHostProject,
  config: AgentHostConfig,
  taskId: string,
  approvalExpired: boolean,
  goal?: string,
): string {
  return [
    approvalExpired
      ? 'Agent Hostの再起動で前の承認要求が期限切れになりました。破損した承認履歴を持ち越さない新しいCodexスレッドです。許可されたとは扱わず、同じShannon作業を安全に復旧してください。'
      : 'Agent Hostの再起動で前のターンが中断されました。同じ作業を安全に復旧してください。',
    ...(goal ? [`目的: ${goal}`] : []),
    `対象プロジェクト: ${project.key}`,
    ...deliveryInstructions(config, taskId),
    'git statusとCodexスレッド内の完了済み作業を確認し、既存変更を重複させないでください。',
    '対象リポジトリ直下のAGENTS.md、現行architecture、runbookを読み直し、未完了の検証と配備だけを続けてください。',
    approvalExpired
      ? '同じ権限がまだ必要なら、新しい承認要求を出してください。古い承認結果を推測してはいけません。'
      : '完了済みと確認できる工程をやり直さず、残る工程から続けてください。',
    ...taskResultInstructions(),
  ].join('\n');
}

function taskResultInstructions(): string[] {
  return [
    '最終応答の末尾に、必ず次の機械可読行を1行だけ付けてください。',
    'SHANNON_TASK_RESULT: {"status":"completed|paused|failed","summary":"ユーザー向け要約","remainingAction":"未完了なら次に必要な一手"}',
    'Codexのターンが終わっただけではcompletedにしません。依頼の完了条件とrunbook上の該当工程がすべて検証済みの場合だけcompletedにしてください。検証・承認・配備・外部前提が残る場合はpaused、続行不能ならfailedにしてください。',
  ];
}

function deliveryInstructions(config: AgentHostConfig, taskId?: string): string[] {
  if (config.deliveryMode !== 'cloud-testflight') {
    return ['この作業ホストはMacのローカル実機配備モードです。'];
  }
  const suffix = taskId?.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'unknown';
  return [
    'この作業ホストはAzure上のクラウド配備モードです。iPhoneを直接操作せず、Xcode Cloudと内部TestFlightを配備先にします。',
    `コード変更は専用ブランチ shannon/task-${suffix} で行い、実行中の本番APIディレクトリを変更しないでください。`,
    'テスト成功前にmainへ統合またはpushしてはいけません。GitHubへのpushとmainへの統合は配布操作なので、ユーザーの明示的な依頼と、その操作時の承認が必要です。',
    '配布を依頼されていない場合は、変更・テスト結果・専用ブランチ名までを報告して止めてください。配布を依頼された場合だけ、承認後にGitHubへ反映し、Xcode Cloudと内部TestFlightの結果まで確認してください。',
  ];
}

function approvalID(threadId: string, requestId: CodexRequestID): string {
  return createHash('sha256').update(`${threadId}:${String(requestId)}`).digest('hex');
}

function stableID(namespace: string, value: string): string {
  return createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32);
}

function approvalTitle(kind: string): string {
  if (kind === 'network') return 'ネットワーク接続の許可';
  if (kind === 'file_change') return 'ファイル変更の許可';
  if (kind === 'command') return 'コマンド実行の許可';
  return '追加のアクセス許可';
}

function approvalReason(kind: string): string {
  if (kind === 'network') return '外部サービスへ接続する必要があります。';
  if (kind === 'file_change') return '許可範囲を越えてファイルを変更する必要があります。';
  if (kind === 'command') return '通常の安全範囲を越える操作が必要です。';
  return '現在の権限では完了できない操作があります。';
}

function approvalResource(kind: string, params: Record<string, unknown>): string | undefined {
  if (kind === 'network') {
    const network = objectValue(params.networkApprovalContext) ?? {};
    const host = stringValue(network.host);
    const protocol = stringValue(network.protocol);
    const port = typeof network.port === 'number' ? `:${network.port}` : '';
    return host ? `${protocol ? `${protocol}://` : ''}${host}${port}` : undefined;
  }
  if (kind === 'file_change') return stringValue(params.grantRoot);
  if (kind === 'command') return compact(stringValue(params.command), 180);
  const permissions = objectValue(params.permissions);
  if (permissions) {
    const labels: string[] = [];
    if (permissions.network) labels.push('ネットワーク');
    if (permissions.fileSystem) labels.push('ファイル');
    return labels.join('・') || undefined;
  }
  return undefined;
}

function grantedPermissions(value: unknown): Record<string, unknown> {
  const request = objectValue(value) ?? {};
  return {
    ...(request.network && typeof request.network === 'object' ? { network: request.network } : {}),
    ...(request.fileSystem && typeof request.fileSystem === 'object' ? { fileSystem: request.fileSystem } : {}),
  };
}

function commandActivity(command: string): string {
  if (isTestCommand(command)) return '自動テストを実行中';
  if (/xcodebuild|swift\s+build|npm\s+run\s+build|pnpm\s+build/i.test(command)) return 'ビルドを確認中';
  if (/git\s+(diff|status)/i.test(command)) return '変更内容を確認中';
  return '必要なコマンドを実行中';
}

function commandCompletionTitle(item: Record<string, unknown>): string {
  if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'コマンドで問題を検出';
  return 'コマンドの実行を完了';
}

function testFromCommand(item: Record<string, unknown>, command: string): AgentTestResult | undefined {
  if (!isTestCommand(command)) return undefined;
  const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  return {
    // The same verification rerun after a pause replaces its earlier result.
    id: stableID('verification', command.trim().replace(/\s+/g, ' ')),
    name: testName(command),
    status: failed ? 'failed' : 'passed',
    detail: failed ? '失敗を検出' : '成功',
  };
}

function isTestCommand(command: string): boolean {
  return /scripts\/verify\.sh(?:\s+(?:api|ios|app|all))?|(^|\s)(test|pytest|vitest|xctest)(\s|$)|swift\s+test|xcodebuild.*\b(?:test|build)\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|build)/i.test(command);
}

function testName(command: string): string {
  const verifyTarget = command.match(/scripts\/verify\.sh(?:\s+(api|ios|app|all))?/i)?.[1]?.toLocaleLowerCase('en-US');
  if (verifyTarget === 'api') return 'API検証';
  if (verifyTarget === 'ios') return 'iOSパッケージ検証';
  if (verifyTarget === 'app') return 'iOSアプリビルド';
  if (verifyTarget === 'all' || /scripts\/verify\.sh/i.test(command)) return '全体検証';
  if (/xcodebuild/i.test(command)) return 'Xcodeテスト';
  if (/swift\s+test/i.test(command)) return 'Swiftテスト';
  if (/vitest/i.test(command)) return 'Vitest';
  if (/pytest/i.test(command)) return 'Pytest';
  return '自動テスト';
}

function taskResult(message: string | undefined): ShannonTaskResult | undefined {
  if (!message?.trim()) return undefined;
  const lines = message.trim().split(/\r?\n/);
  let markerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().startsWith('SHANNON_TASK_RESULT:')) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return undefined;
  const raw = lines[markerIndex]!.trim().slice('SHANNON_TASK_RESULT:'.length).trim();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const status = value.status;
    if (status !== 'completed' && status !== 'paused' && status !== 'failed') return undefined;
    const visibleSummary = lines.filter((_, index) => index !== markerIndex).join('\n').trim();
    const summary = stringValue(value.summary)?.trim() || visibleSummary;
    if (!summary) return undefined;
    const remainingAction = stringValue(value.remainingAction)?.trim();
    return { status, summary, ...(remainingAction ? { remainingAction } : {}) };
  } catch {
    return undefined;
  }
}

function changeFromItem(value: unknown, namespace: string): AgentChangeSummary | undefined {
  const object = objectValue(value);
  const path = stringValue(object?.path);
  if (!path) return undefined;
  const diff = stringValue(object?.diff) ?? '';
  const counts = lineCounts(diff);
  return {
    id: stableID(namespace, path),
    displayName: basename(path),
    summary: object?.kind === 'add' ? '追加' : object?.kind === 'delete' ? '削除' : '変更',
    additions: counts.additions,
    deletions: counts.deletions,
  };
}

function changesFromUnifiedDiff(diff: string): AgentChangeSummary[] {
  const chunks = diff.split(/^diff --git /m).slice(1);
  return chunks.flatMap(chunk => {
    const header = chunk.match(/^a\/(.+?) b\/(.+?)\n/);
    if (!header) return [];
    const path = header[2]!;
    const counts = lineCounts(chunk);
    return [{
      id: stableID('diff', path),
      displayName: basename(path),
      summary: '変更',
      additions: counts.additions,
      deletions: counts.deletions,
    }];
  });
}

function lineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function errorMessage(value: Record<string, unknown>): string {
  const error = objectValue(value.error);
  return compact(stringValue(error?.message) ?? stringValue(value.message)) ?? 'Codexとの接続で問題が発生しました。';
}

function compact(value: string | undefined, limit = 1_200): string | undefined {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('AGENT_PROJECT_NOT_ALLOWLISTED')) return 'このプロジェクトは作業環境でまだ許可されていません。';
  if (message.includes('UsageLimitExceeded')) return 'Codexの利用上限に達しています。';
  if (message.includes('ContextWindowExceeded')) return '作業履歴が長くなりすぎました。';
  return compact(message, 500) ?? '不明な問題が発生しました。';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
