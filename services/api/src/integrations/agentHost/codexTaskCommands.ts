import type { PersistedAgentSession } from './agentHostState.js';
import { resolveAgentProject } from './agentHostConfig.js';
import type { ClaimedAgentCommand } from '../../mind/action/agentTasks/agentTasksPorts.js';
import type { AgentReasoningEffort } from '../../mind/action/agentTasks/agentTasksPorts.js';
import type { CodexTaskBridgeOptions } from './codexTaskBridge.js';
import { CodexTaskEventPublisher } from './codexTaskEvents.js';
import { CodexTaskRuntimeRegistry, type RuntimeTask } from './codexTaskRuntime.js';
import type { CodexStartingTurnEvents } from './codexStartingTurnEvents.js';
import {
  codexThreadParams,
  friendlyError,
  grantedPermissions,
  recoveryPrompt,
  resumePrompt,
  stringValue,
  taskPrompt,
} from './codexTaskProjection.js';

interface CodexThreadResult {
  thread?: { id?: string; status?: { type?: string }; turns?: Array<Record<string, unknown>> };
}
interface CodexTurnResult { turn?: Record<string, unknown>; }

export class CodexTaskCommandController {
  constructor(
    private readonly options: CodexTaskBridgeOptions,
    private readonly runtimes: CodexTaskRuntimeRegistry,
    private readonly events: CodexTaskEventPublisher,
    private readonly now: () => string,
    private readonly startingEvents: CodexStartingTurnEvents,
    private readonly flushStartingEvents: (runtime:RuntimeTask,owner:string)=>Promise<void>,
  ) {}

  async handle(command: ClaimedAgentCommand): Promise<void> {
    try {
      if (command.actionLease) {
        this.options.state.updateSession(command.taskId,{actionLease:command.actionLease});
        const active=this.runtimes.get(command.taskId);
        if(active) active.actionLease=command.actionLease;
      }
      switch (command.type) {
        case 'start': await this.startTask(command); break;
        case 'steer': await this.steerTask(command); break;
        case 'interrupt': await this.interruptTask(command); break;
        case 'resume': await this.resumeTask(command); break;
        case 'resolve_approval': await this.resolveApproval(command); break;
      }
    } catch (error) {
      const runtime = this.runtimes.get(command.taskId);
      if (runtime?.actionLease && (runtime.turnId || runtime.executionUncertain)) {
        runtime.executionUncertain = true; this.runtimes.save(runtime);
        await this.events.emit(command.taskId, 'progress', '作業結果を確認できない', friendlyError(error), {
          currentAction: '作業環境の応答を確認中', executionUncertain: true,
        });
      } else await this.events.emit(command.taskId, 'failed', '作業を続けられない', friendlyError(error));
    } finally {
      const runtime=this.runtimes.get(command.taskId);
      if(runtime)await this.flushStartingEvents(runtime,command.id);
      await this.events.publish([this.events.event(command.taskId, 'command_completed', '命令を作業環境へ反映', undefined, {
        commandId: command.id,
      }, `command:${command.id}:completed`)]);
    }
  }

  private async startTask(command: ClaimedAgentCommand): Promise<void> {
    const existing = this.options.state.session(command.taskId);
    if (existing) {
      if (existing.startCommandId !== command.id) throw new Error('既存作業と開始命令が一致しません。');
      await this.ensureRuntime(command.taskId);
      await this.events.emit(command.taskId, 'progress', '既存の作業へ復帰', '二重に開始せず、保存済みのCodex作業を使う。', {
        currentAction: 'Codexの作業状態を確認中',
      });
      return;
    }

    const project = resolveAgentProject(this.options.config, command.payload.projectHint);
    const model = stringValue(command.payload.model);
    const reasoningEffort = parsedEffort(command.payload.reasoningEffort);
    const threadParams = codexThreadParams(project, this.options.config, { model, reasoningEffort });
    const threadResult = await this.options.client.request<CodexThreadResult>('thread/start', threadParams);
    const threadId = stringValue(threadResult.thread?.id);
    if (!threadId) throw new Error('Codexが作業スレッドを作成できませんでした。');

    const session: PersistedAgentSession = {
      actionLease: command.actionLease,
      taskId: command.taskId,
      startCommandId: command.id,
      threadId,
      goal: stringValue(command.payload.goal),
      projectKey: project.key,
      cwd: project.path,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      updatedAt: this.now(),
    };
    this.options.state.saveSession(session);
    const runtime = this.runtimes.register(session, project);
    const turn = await this.startTurn(runtime, taskPrompt(command, project, this.options.config),command.id);
    runtime.turnId = turn;
    this.runtimes.save(runtime);
    await this.events.emit(command.taskId, 'started', 'Codexが作業を開始', '依頼内容と対象プロジェクトを確認している。', {
      currentAction: '作業計画を組み立て中',
    });
  }

  private async steerTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    const instruction = stringValue(command.payload.instruction);
    if (!instruction) throw new Error('追加の指示が空です。');
    if (runtime.turnId) {
      if (runtime.actionLease && this.options.permit && !await this.options.permit(runtime.taskId)) throw new Error('ACTION_STOPPED');
      if (runtime.actionLease) { runtime.executionUncertain = true; this.runtimes.save(runtime); }
      await this.options.client.request('turn/steer', {
        threadId: runtime.threadId,
        expectedTurnId: runtime.turnId,
        input: [{ type: 'text', text: instruction }],
      });
      if (runtime.actionLease) { runtime.executionUncertain = false; this.runtimes.save(runtime); }
    } else {
      runtime.turnId = await this.startTurn(runtime, instruction,command.id);
      this.runtimes.save(runtime);
    }
    await this.events.emit(command.taskId, 'progress', '追加の指示をCodexへ送信', instruction, {
      currentAction: '新しい条件を反映中',
    });
  }

  private async interruptTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    const cancel = command.payload.cancel === true || command.payload.cancel === 'true';
    runtime.suppressTerminalEvent = cancel;
    if (runtime.actionLease && runtime.executionUncertain && !runtime.turnId) {
      runtime.stopRequested = true; this.runtimes.save(runtime);
      await this.events.emit(command.taskId, 'progress', '停止の応答を確認できない', undefined, {
        currentAction: '作業環境の応答を確認中', executionUncertain: true,
      });
      return;
    }
    if (runtime.turnId) {
      if(runtime.actionLease){runtime.stopRequested=true;this.runtimes.save(runtime);}
      await this.options.client.request('turn/interrupt', { threadId: runtime.threadId, turnId: runtime.turnId });
    }
    if(runtime.actionLease && runtime.turnId)return; // Wait for the turn/completed acknowledgement.
    runtime.turnId = undefined;
    runtime.approvals.clear();
    runtime.pendingApprovalExternalRequestID = undefined;
    this.runtimes.save(runtime);
    if (!cancel) {
      await this.events.emit(command.taskId, 'paused', '作業を一時停止', '止めた場所を保存し、再開を待っている。', {
        pauseReason: 'owner',
      });
    }
  }

  private async resumeTask(command: ClaimedAgentCommand): Promise<void> {
    const runtime = await this.ensureRuntime(command.taskId);
    if (runtime.turnId) throw new Error('Codexの作業はすでに動いています。');
    runtime.suppressTerminalEvent = false;
    runtime.turnId = await this.startTurn(runtime, resumePrompt(runtime.project, this.options.config, runtime.taskId),command.id);
    this.runtimes.save(runtime);
    await this.events.emit(command.taskId, 'started', '作業を再開', '保存済みのCodexスレッドで続きを始めた。', {
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
    const accepted = (decision === 'allow_once' || forSession)
      && (!this.options.permit || await this.options.permit(runtime.taskId));

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

    if (!accepted && command.payload.denyContinues !== true) {
      // The task store predates per-operation deny and has already cancelled the task: stop the turn too.
      runtime.suppressTerminalEvent = true;
      if (runtime.turnId) {
        if (runtime.actionLease) { runtime.stopRequested = true; this.runtimes.save(runtime); }
        await this.options.client.request('turn/interrupt', {
          threadId: runtime.threadId,
          turnId: runtime.turnId,
        }).catch(error => { if (runtime.actionLease) throw error; });
      }
      if (runtime.actionLease && (runtime.turnId || runtime.executionUncertain)) return;
      runtime.turnId = undefined;
      runtime.pendingApprovalExternalRequestID = undefined;
      this.runtimes.save(runtime);
      return;
    }
    runtime.pendingApprovalExternalRequestID = undefined;
    this.runtimes.save(runtime);
    if (accepted) {
      await this.events.emit(command.taskId, 'progress', '許可をCodexへ送信', '許可した範囲だけで作業を続ける。', {
        currentAction: '許可された操作を実行中',
      });
    } else {
      // Codex `decline` denies only this operation and keeps the turn, so the task is not cancelled.
      // The turn then continues another way, or ends with a result that pauses the task with a next action.
      await this.events.emit(command.taskId, 'progress', '許可しない判断をCodexへ送信', 'この操作は実行せず、別の進め方を確認している。', {
        currentAction: '許可されなかった操作を避けて続行中',
      });
    }
  }

  async attach(session: PersistedAgentSession): Promise<RuntimeTask> {
    const project = this.options.config.projects.get(session.projectKey);
    if (!project || project.path !== session.cwd) throw new Error('保存済みプロジェクトが現在の許可一覧にありません。');
    if (session.pendingApprovalExternalRequestID && !session.actionLease) {
      // A Codex approval is tied to the live app-server request. Reusing a thread whose
      // approval request disappeared can leave an unmatched tool call in its history,
      // so recover the durable Shannon task in a clean Codex thread instead.
      const replacement = await this.options.client.request<CodexThreadResult>('thread/start', codexThreadParams(
        project,
        this.options.config,
        { model: session.model, reasoningEffort: session.reasoningEffort },
      ));
      const replacementThreadID = stringValue(replacement.thread?.id);
      if (!replacementThreadID) throw new Error('Codexが復旧用スレッドを作成できませんでした。');
      const recoverySession: PersistedAgentSession = {
        ...session,
        threadId: replacementThreadID,
        turnId: undefined,
        updatedAt: this.now(),
      };
      this.options.state.saveSession(recoverySession);
      const runtime = this.runtimes.register(recoverySession, project);
      runtime.turnId = await this.startTurn(runtime, recoveryPrompt(
        project, this.options.config, runtime.taskId, true, session.goal,
      ));
      runtime.pendingApprovalExternalRequestID = undefined;
      this.runtimes.save(runtime);
      await this.events.emit(runtime.taskId, 'started', '承認待ちから自動復旧', '期限切れの承認を破棄し、同じ作業を新しいCodexスレッドで再開した。', {
        currentAction: '中断箇所と必要な検証を確認中',
        clearPendingApproval: true,
      });
      return runtime;
    }
    const result = await this.options.client.request<CodexThreadResult>('thread/resume', {
      threadId: session.threadId,
      ...codexThreadParams(project, this.options.config, {
        model: session.model,
        reasoningEffort: session.reasoningEffort,
      }),
      excludeTurns: false,
    });
    const runtime = this.runtimes.register(session, project);
    if (session.actionLease) {
      // Execution rights belong to the recorded turn, even if another actor has
      // since started a different turn on the same Codex thread.
      const original = session.turnId ? result.thread?.turns?.find(turn => turn.id === session.turnId) : undefined;
      if (original?.status === 'inProgress') {
        runtime.executionUncertain = false; this.runtimes.save(runtime);
      } else if (original && ['completed', 'failed', 'interrupted'].includes(String(original.status))) {
        runtime.recoveredTurn = original;
      } else if (session.turnId || session.executionUncertain || session.pendingApprovalExternalRequestID) {
        // Thread-level active status and an uncorrelated active turn cannot prove
        // what happened to the original execution or to a lost start response.
        runtime.executionUncertain = true; this.runtimes.save(runtime);
      }
      return runtime;
    }
    const activeTurn = result.thread?.turns?.find(turn => turn.status === 'inProgress');
    const activeTurnID = stringValue(activeTurn?.id)
      ?? (result.thread?.status?.type === 'active' ? session.turnId : undefined);
    if (!activeTurnID && session.turnId) {
      runtime.turnId = await this.startTurn(runtime, recoveryPrompt(
        project, this.options.config, runtime.taskId, false, session.goal,
      ));
      this.runtimes.save(runtime);
      await this.events.emit(runtime.taskId, 'started', '中断した作業を自動復旧', '同じCodexスレッドで中断箇所から再開した。', {
        currentAction: '中断箇所と未完了の作業を確認中',
      });
      return runtime;
    }
    runtime.turnId = activeTurnID;
    this.runtimes.save(runtime);
    return runtime;
  }

  private async ensureRuntime(taskId: string): Promise<RuntimeTask> {
    const runtime = this.runtimes.get(taskId);
    if (runtime) return runtime;
    const session = this.options.state.session(taskId);
    if (!session) throw new Error('作業環境にセッションが見つかりません。');
    return await this.attach(session);
  }

  private async startTurn(runtime: RuntimeTask, text: string, owner?:string): Promise<string> {
    if(this.options.permit && !await this.options.permit(runtime.taskId))throw new Error('ACTION_STOPPED');
    // Persist the uncertainty before crossing the process boundary. Losing only
    // the response must not turn a paid, still-running turn into a known failure.
    if (runtime.actionLease) { runtime.executionUncertain = true; this.runtimes.save(runtime); }
    this.startingEvents.begin(runtime,owner);
    const result = await this.options.client.request<CodexTurnResult>('turn/start', {
      threadId: runtime.threadId,
      input: [{ type: 'text', text }],
      turnTrigger: 'shannon_ios',
      ...(runtime.reasoningEffort ?? this.options.config.codexEffort
        ? { effort: runtime.reasoningEffort ?? this.options.config.codexEffort }
        : {}),
    }).catch(error=>{this.startingEvents.failed(runtime);throw error;});
    const turnId = stringValue(result.turn?.id);
    if (!turnId) {this.startingEvents.failed(runtime);throw new Error('Codexが作業ターンを開始できませんでした。');}
    if (runtime.actionLease) { runtime.turnId = turnId; runtime.executionUncertain = false; this.runtimes.save(runtime); }
    this.startingEvents.correlate(runtime,turnId);
    return turnId;
  }
}

function parsedEffort(value: unknown): AgentReasoningEffort | undefined {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value : undefined;
}
