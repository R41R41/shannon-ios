import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentHostConfig } from '../src/integrations/agentHost/agentHostConfig.js';
import { AgentHostStateStore } from '../src/integrations/agentHost/agentHostState.js';
import type {
  CodexAppServerConnection,
  CodexNotification,
  CodexRequestID,
  CodexServerRequest,
} from '../src/integrations/agentHost/codexAppServerClient.js';
import { CodexTaskBridge } from '../src/integrations/agentHost/codexTaskBridge.js';
import type { ClaimedAgentCommand, HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';

describe('CodexTaskBridge', () => {
  it('maps a real task lifecycle, approval, changes, and tests without exposing raw output', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({
      ...fixture,
      publish: async batch => { events.push(...batch); },
      now: sequenceClock(),
    });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Fix login', projectHint: 'fixture' }));

    const threadStart = fixture.client.requests.find(request => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: fixture.project, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    });
    const turnStart = fixture.client.requests.find(request => request.method === 'turn/start');
    const taskText = ((turnStart?.params.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    expect(taskText).toContain('対象プロジェクト: fixture');
    expect(taskText).toContain('AGENTS.md');
    expect(taskText).toContain('番号付きHTML資料');
    expect(taskText).toContain('git status');
    expect(taskText).toContain('SHANNON_TASK_RESULT');
    expect(fixture.state.session('task-1')?.goal).toBe('Fix login');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'started', taskId: 'task-1' }),
      expect.objectContaining({ type: 'command_completed', eventId: 'command:start-1:completed' }),
    ]));

    fixture.client.notify({ method: 'turn/plan/updated', params: {
      threadId: 'thread-1', turnId: 'turn-1', explanation: 'Plan',
      plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Verify', status: 'inProgress' }],
    } });
    fixture.client.notify({ method: 'item/started', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'commandExecution', id: 'command-item', command: 'npm test -- --run', status: 'inProgress',
      },
    } });
    fixture.client.notify({ method: 'item/commandExecution/outputDelta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-item',
      delta: 'SHANNON_API_TOKEN=super-secret\nTest Suite started\n',
    } });
    await bridge.whenIdle();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'progress', title: '自動テストを実行中', payload: expect.objectContaining({
        activity: { kind: 'command', status: 'running' },
      }),
    }));
    fixture.client.serverRequest({
      id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-item', reason: 'Test network',
        command: 'npm test -- --run', networkApprovalContext: { host: 'example.com', protocol: 'https', port: 443 },
      },
    });
    await bridge.whenIdle();

    const approval = events.find(event => event.type === 'approval_requested');
    expect(approval?.payload?.approval).toMatchObject({
      kind: 'network', title: 'ネットワーク接続の許可', resource: 'https://example.com:443',
    });
    const externalRequestID = (approval?.payload?.approval as { externalRequestID: string }).externalRequestID;
    expect(fixture.state.session('task-1')?.pendingApprovalExternalRequestID).toBe(externalRequestID);
    await bridge.handle(command('approve-1', 'resolve_approval', {
      externalRequestID, decision: 'allow_once',
    }));
    expect(fixture.client.responses).toContainEqual({ id: 'approval-1', result: { decision: 'accept' } });
    expect(fixture.state.session('task-1')?.pendingApprovalExternalRequestID).toBeUndefined();

    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'commandExecution', id: 'command-item', command: 'npm test -- --run',
        status: 'completed', exitCode: 0, aggregatedOutput: 'SECRET RAW OUTPUT',
      },
    } });
    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'fileChange', id: 'file-item', status: 'completed', changes: [{
          path: `${fixture.project}/Login.swift`, kind: 'update', diff: '@@\n-old\n+new',
        }],
      },
    } });
    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'message-1',
        text: 'ログイン処理を直してテストした。\nSHANNON_TASK_RESULT: {"status":"completed","summary":"ログイン処理を直してテストした。"}',
      },
    } });
    fixture.client.notify({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    await bridge.whenIdle();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'progress', title: 'コマンドの実行を完了', payload: expect.objectContaining({
        activity: { kind: 'command', status: 'completed' },
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output', title: '実行出力', detail: expect.stringContaining('Test Suite started'),
    }));
    expect(JSON.stringify(events)).not.toContain('super-secret');

    const completed = events.find(event => event.type === 'completed');
    expect(completed).toMatchObject({
      detail: 'ログイン処理を直してテストした。',
      payload: {
        changes: [{ displayName: 'Login.swift', additions: 1, deletions: 1 }],
        tests: [{ name: '自動テスト', status: 'passed' }],
      },
    });
    expect(JSON.stringify(events)).not.toContain('SECRET RAW OUTPUT');
    await bridge.stop();
  });

  it('keeps a task paused when Codex ends without a verified task result', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Build the iOS app', projectHint: 'fixture' }));

    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'commandExecution', id: 'verify-item', command: 'scripts/verify.sh all',
        status: 'failed', exitCode: 1,
      },
    } });
    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'message-1', text: 'iOSビルドを確認できなかった。',
      },
    } });
    fixture.client.notify({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    await bridge.whenIdle();

    expect(events.some(event => event.type === 'completed')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'paused', title: '検証が残っています', payload: expect.objectContaining({
        currentAction: '全体検証を修正して再実行',
        tests: [expect.objectContaining({ name: '全体検証', status: 'failed' })],
      }),
    }));
    await bridge.stop();
  });

  it('publishes the remaining action when Codex reports a deliberate pause', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Deliver to TestFlight', projectHint: 'fixture' }));
    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'message-1',
        text: '実装とテストは完了した。\nSHANNON_TASK_RESULT: {"status":"paused","summary":"配信承認を待っています。","remainingAction":"GitHubへの反映を承認"}',
      },
    } });
    fixture.client.notify({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    await bridge.whenIdle();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'paused', title: '続きが必要です', detail: '配信承認を待っています。',
      payload: expect.objectContaining({ currentAction: 'GitHubへの反映を承認' }),
    }));
    await bridge.stop();
  });

  it('lets a successful verification rerun replace an earlier failure', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Fix and verify', projectHint: 'fixture' }));
    for (const [status, exitCode] of [['failed', 1], ['completed', 0]] as const) {
      fixture.client.notify({ method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-1', item: {
          type: 'commandExecution', id: `verify-${exitCode}`, command: 'scripts/verify.sh all', status, exitCode,
        },
      } });
    }
    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'message-1',
        text: '修正後の全体検証に成功した。\nSHANNON_TASK_RESULT: {"status":"completed","summary":"修正と全体検証が完了しました。"}',
      },
    } });
    fixture.client.notify({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    await bridge.whenIdle();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'completed', payload: expect.objectContaining({
        tests: [expect.objectContaining({ name: '全体検証', status: 'passed' })],
      }),
    }));
    await bridge.stop();
  });

  it('steers, pauses, resumes, and cancels the saved Codex thread', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Work', projectHint: 'fixture' }));
    await bridge.handle(command('steer-1', 'steer', { instruction: 'Tests first' }));
    expect(fixture.client.requests.find(request => request.method === 'turn/steer')?.params)
      .toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1' });

    await bridge.handle(command('pause-1', 'interrupt', {}));
    expect(events.some(event => event.type === 'paused')).toBe(true);
    await bridge.handle(command('resume-1', 'resume', {}));
    expect(fixture.client.requests.filter(request => request.method === 'turn/start')).toHaveLength(2);
    const resumedTurn = fixture.client.requests.filter(request => request.method === 'turn/start')[1];
    const resumedText = ((resumedTurn?.params.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    expect(resumedText).toContain('AGENTS.md');
    expect(resumedText).toContain('未完了の検証');
    await bridge.handle(command('cancel-1', 'interrupt', { cancel: true }));
    expect(fixture.state.session('task-1')?.turnId).toBeUndefined();
    await bridge.stop();
  });

  it('reattaches a persisted in-flight session after a host restart', async () => {
    const fixture = makeFixture();
    fixture.state.saveSession({
      taskId: 'task-1', startCommandId: 'start-1', threadId: 'thread-1', turnId: 'turn-9',
      projectKey: 'fixture', cwd: fixture.project, updatedAt: new Date().toISOString(),
    });
    fixture.client.resumeActiveTurnID = 'turn-9';
    const bridge = new CodexTaskBridge({ ...fixture, publish: async () => {} });
    await bridge.start();

    expect(fixture.client.requests.some(request => request.method === 'thread/resume')).toBe(true);
    expect(fixture.state.session('task-1')?.turnId).toBe('turn-9');
    await bridge.stop();
  });

  it('invalidates a stale approval and automatically continues the same task in a clean thread after restart', async () => {
    const fixture = makeFixture();
    fixture.state.saveSession({
      taskId: 'task-1', startCommandId: 'start-1', threadId: 'thread-old', turnId: 'turn-old',
      pendingApprovalExternalRequestID: 'approval-old', projectKey: 'fixture', cwd: fixture.project,
      goal: 'Rename talk titles',
      updatedAt: new Date().toISOString(),
    });
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({
      ...fixture,
      publish: async batch => { events.push(...batch); },
    });

    await bridge.start();

    expect(fixture.client.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'thread/start' }),
      expect.objectContaining({ method: 'turn/start' }),
    ]));
    expect(fixture.client.requests.some(request => request.method === 'thread/resume')).toBe(false);
    const recoveryTurn = fixture.client.requests.find(request => request.method === 'turn/start');
    const recoveryText = ((recoveryTurn?.params.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    expect(recoveryText).toContain('前の承認要求が期限切れ');
    expect(recoveryText).toContain('目的: Rename talk titles');
    expect(recoveryText).toContain('新しい承認要求');
    expect(fixture.state.session('task-1')).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(fixture.state.session('task-1')?.pendingApprovalExternalRequestID).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'started', title: '承認待ちから自動復旧', taskId: 'task-1',
    }));
    await bridge.stop();
  });

  it('automatically continues an interrupted in-flight turn after restart', async () => {
    const fixture = makeFixture();
    fixture.state.saveSession({
      taskId: 'task-1', startCommandId: 'start-1', threadId: 'thread-1', turnId: 'turn-interrupted',
      projectKey: 'fixture', cwd: fixture.project, updatedAt: new Date().toISOString(),
    });
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({
      ...fixture,
      publish: async batch => { events.push(...batch); },
    });

    await bridge.start();

    const recoveryTurn = fixture.client.requests.find(request => request.method === 'turn/start');
    const recoveryText = ((recoveryTurn?.params.input as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    expect(recoveryText).toContain('前のターンが中断');
    expect(fixture.state.session('task-1')?.turnId).toBe('turn-1');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'started', title: '中断した作業を自動復旧', taskId: 'task-1',
    }));
    await bridge.stop();
  });

  it('declines only the denied operation and keeps the turn, then leaves a next action when Codex stops', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Clean build', projectHint: 'fixture' }));
    fixture.client.serverRequest({
      id: 'approval-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-item', command: 'rm -rf build' },
    });
    await bridge.whenIdle();
    const approval = events.find(event => event.type === 'approval_requested')?.payload?.approval as {
      externalRequestID: string; denyContinues?: boolean; resource?: string;
    };
    expect(approval).toMatchObject({ denyContinues: true, resource: 'rm -rf build' });

    await bridge.handle(command('deny-1', 'resolve_approval', {
      externalRequestID: approval.externalRequestID, decision: 'deny', denyContinues: true,
    }));
    expect(fixture.client.responses).toContainEqual({ id: 'approval-1', result: { decision: 'decline' } });
    expect(fixture.client.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
    expect(fixture.state.session('task-1')?.turnId).toBe('turn-1');
    expect(events).toContainEqual(expect.objectContaining({ type: 'progress', title: '許可しない判断をCodexへ送信' }));

    fixture.client.notify({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'message-1',
        text: '削除せずに進められなかった。\nSHANNON_TASK_RESULT: {"status":"paused","summary":"buildの削除が必要です。","remainingAction":"buildを手動で消して再開"}',
      },
    } });
    fixture.client.notify({ method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    await bridge.whenIdle();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'paused', payload: expect.objectContaining({ pauseReason: 'needs_owner', currentAction: 'buildを手動で消して再開' }),
    }));
    await bridge.stop();
  });

  it('stops the turn on deny when the task store has already cancelled the task', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Clean build', projectHint: 'fixture' }));
    fixture.client.serverRequest({
      id: 'approval-1', method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-item' },
    });
    await bridge.whenIdle();
    const approval = events.find(event => event.type === 'approval_requested')?.payload?.approval as {
      externalRequestID: string;
    };

    await bridge.handle(command('deny-1', 'resolve_approval', {
      externalRequestID: approval.externalRequestID, decision: 'deny',
    }));
    expect(fixture.client.responses).toContainEqual({ id: 'approval-1', result: { decision: 'decline' } });
    expect(fixture.client.requests.some(request => request.method === 'turn/interrupt')).toBe(true);
    expect(fixture.state.session('task-1')?.turnId).toBeUndefined();
    expect(events.some(event => event.type === 'progress' && event.title === '許可しない判断をCodexへ送信')).toBe(false);
    await bridge.stop();
  });

  it('marks a pause the owner asked for as the owner\'s', async () => {
    const fixture = makeFixture();
    const events: HostAgentEvent[] = [];
    const bridge = new CodexTaskBridge({ ...fixture, publish: async batch => { events.push(...batch); } });
    await bridge.start();
    await bridge.handle(command('start-1', 'start', { goal: 'Work', projectHint: 'fixture' }));
    await bridge.handle(command('pause-1', 'interrupt', {}));
    expect(events.find(event => event.type === 'paused')?.payload).toEqual({ pauseReason: 'owner' });
    await bridge.stop();
  });
});

class FakeCodexConnection implements CodexAppServerConnection {
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  responses: Array<{ id: CodexRequestID; result: Record<string, unknown> }> = [];
  resumeActiveTurnID?: string;
  private notificationHandler?: (notification: CodexNotification) => void;
  private requestHandler?: (request: CodexServerRequest) => void;

  onNotification(handler: (notification: CodexNotification) => void) { this.notificationHandler = handler; return () => {}; }
  onServerRequest(handler: (request: CodexServerRequest) => void) { this.requestHandler = handler; return () => {}; }
  onDiagnostic() { return () => {}; }
  async start() {}
  async stop() {}
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } } as T;
    if (method === 'thread/resume') return { thread: {
      id: params.threadId, status: { type: this.resumeActiveTurnID ? 'active' : 'idle' },
      turns: this.resumeActiveTurnID ? [{ id: this.resumeActiveTurnID, status: 'inProgress' }] : [],
    } } as T;
    if (method === 'turn/start') {
      const count = this.requests.filter(request => request.method === 'turn/start').length;
      return { turn: { id: `turn-${count}`, status: 'inProgress', items: [] } } as T;
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId } as T;
    return {} as T;
  }
  respond(id: CodexRequestID, result: Record<string, unknown>) { this.responses.push({ id, result }); }
  respondError() {}
  notify(notification: CodexNotification) { this.notificationHandler?.(notification); }
  serverRequest(request: CodexServerRequest) { this.requestHandler?.(request); }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'shannon-codex-bridge-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const projects = new Map([['fixture', { key: 'fixture', path: project }]]);
  const config: AgentHostConfig = {
    apiBaseURL: 'https://sh4nnon.com/companion', token: 'x'.repeat(32), hostId: 'test-mac', displayName: 'Test Mac',
    stateFile: join(root, 'state.json'), workspaceRoot: join(root, 'workspaces'),
    codexExecutable: 'codex', projects, defaultProjectKey: 'fixture',
    deliveryMode: 'local-device',
    pollIntervalMs: 250, heartbeatIntervalMs: 5_000,
  };
  return { config, state: new AgentHostStateStore(config.stateFile), client: new FakeCodexConnection(), project };
}

function command(id: string, type: ClaimedAgentCommand['type'], payload: Record<string, unknown>): ClaimedAgentCommand {
  return {
    id, taskId: 'task-1', scopeKey: 'owner', type, payload, attempts: 1,
    createdAt: '2026-09-04T00:00:00.000Z', leaseUntil: '2026-09-04T00:01:00.000Z',
  };
}

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-09-04T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}
