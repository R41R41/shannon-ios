import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `返答${this.requests.length}` };
  }
}

describe('Shannon local API kernel', () => {
  it('reports the configured LLM in health', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect(await api.dispatch({ method: 'GET', path: '/health' })).toEqual({
      status: 200,
      body: {
        ok: true,
        service: 'shannon-ios-api',
        mode: 'local',
        llm: { mode: 'local-stub', model: 'local-stub' },
        background: { mode: 'in-process' },
      },
    });
  });

  it('captures one immutable state version for a chat turn', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:0${tick++}.000Z`);
    const first = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'こんにちは' },
    });
    await api.waitForBackground('owner-a');
    await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'interest-observed', interest: '脳科学' },
    } });
    const second = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '続き' },
    });
    expect(first).toMatchObject({
      status: 200,
      body: { mode: 'local-stub', snapshotVersion: 0, messageEmotion: { expression: 'calm' } },
    });
    expect(second).toMatchObject({ status: 200, body: { mode: 'local-stub', snapshotVersion: 2 } });
    expect(JSON.stringify(first.body)).not.toContain('脳科学');
    expect(JSON.stringify(second.body)).toContain('脳科学');
  });

  it('passes bounded history and the latest state prompt to the LLM', async () => {
    let tick = 0;
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => `2026-08-31T00:00:0${tick++}.000Z`,
      { chatModel: model },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '最初' } });
    await api.waitForBackground('owner-a');
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '次' } });
    expect(model.requests[0]?.history).toEqual([]);
    expect(model.requests[1]?.history).toEqual([
      { role: 'user', content: '最初' },
      { role: 'assistant', content: '返答1' },
    ]);
    expect(model.requests[1]?.systemPrompt).toContain('[Shannon shared state v1]');
  });

  it('renames a thread and exposes the saved title in the thread list', async () => {
    const api = createLocalApiKernel(() => '2026-09-04T00:00:00.000Z');
    const created = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '仮のタイトル',
    } });
    const threadId = String((created.body as { threadId: string }).threadId);

    expect(await api.dispatch({ method: 'POST', path: '/v1/threads/title', body: {
      scopeKey: 'owner-a', threadId, title: '保存したタイトル',
    } })).toEqual({ status: 200, body: { renamed: true } });
    expect(await api.dispatch({ method: 'GET', path: '/v1/threads', query: new URLSearchParams({ scopeKey: 'owner-a' }) }))
      .toMatchObject({ status: 200, body: { threads: [expect.objectContaining({ threadId, title: '保存したタイトル' })] } });
    expect(await api.dispatch({ method: 'POST', path: '/v1/threads/title', body: {
      scopeKey: 'owner-a', threadId, title: '   ',
    } })).toMatchObject({ status: 400 });
  });

  it('adds only the relevant Aether projection without another model call', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-03T00:00:00.000Z',
      {
        chatModel: model,
        aetherContext: {
          promptFor(scopeKey, message) {
            expect(scopeKey).toBe('owner-a');
            expect(message).toBe('設計の続きを話したい');
            return '[Aetherから明示的に共有された文脈]\n- 設計メモ';
          },
        },
      },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '設計の続きを話したい' } });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.systemPrompt).toContain('設計メモ');
  });

  it('projects the authoritative agent task status across conversations', async () => {
    const model = new RecordingChatModel();
    const now = '2026-09-04T04:50:00.000Z';
    const api = createLocalApiKernel(() => now, { chatModel: model });
    const taskThread = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '改修相談',
    } });
    const taskThreadId = String((taskThread.body as { threadId: string }).threadId);
    const questionThread = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '別のトーク',
    } });
    const questionThreadId = String((questionThread.body as { threadId: string }).threadId);
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: {
      scopeKey: 'owner-a', idempotencyKey: 'task-status-test', conversationThreadID: taskThreadId,
      title: 'リンク表示を直す', goal: 'シャノン側のリンクをタップ可能にする', summary: '作業を始める',
    } });
    const taskId = String((created.body as { task: { id: string } }).task.id);
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/heartbeat', body: {
      hostId: 'mac-1', displayName: 'Mac', capabilities: ['codex'],
    } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: { hostId: 'mac-1' } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'mac-1', events: [{
        eventId: 'approval-status-test', taskId, type: 'approval_requested', title: '許可待ち',
        detail: '検証を続ける前に確認が必要です。', occurredAt: now,
        payload: { approval: {
          id: 'approval-1', externalRequestID: 'external-1', kind: 'command',
          title: 'iOS検証の実行', reason: 'SwiftPMの検証にsandbox-execが必要です。',
          resource: "scripts/verify.sh ios", requestedAt: now,
        } },
      }],
    } });

    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', threadId: questionThreadId, message: 'どうなった？まだ作業途中？',
    } });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.systemPrompt).toContain('[Codex作業の現在状態 — Azure DB上の事実・会話履歴より優先]');
    expect(model.requests[0]?.systemPrompt).toContain('リンク表示を直す [waiting_approval]');
    expect(model.requests[0]?.systemPrompt).toContain('SwiftPMの検証にsandbox-execが必要です。');
    expect(model.requests[0]?.systemPrompt).toContain('scripts/verify.sh ios');
    expect(model.requests[0]?.systemPrompt).toContain('別トークから尋ねられても');
    expect(model.requests[0]?.systemPrompt).toContain('completedを作業中、cancelledを再開中、runningを未開始とは言わない');
  });

  it('routes tasks from older clients to the configured default Agent Host', async () => {
    const api = createLocalApiKernel(
      () => '2026-09-05T03:45:00.000Z',
      { defaultAgentHost: 'shannon-cloud' },
    );
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: {
      scopeKey: 'owner-a', idempotencyKey: 'cloud-default-test', conversationThreadID: 'thread-a',
      title: 'クラウド作業', goal: '旧版クライアントから依頼する', summary: 'クラウドへ送る',
    } });
    expect(created.status).toBe(201);

    const macClaim = await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: {
      hostId: 'shannon-mac',
    } });
    expect(macClaim).toMatchObject({ status: 200, body: { command: null } });

    const cloudClaim = await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: {
      hostId: 'shannon-cloud',
    } });
    expect(cloudClaim).toMatchObject({
      status: 200,
      body: { command: { payload: { hostHint: 'shannon-cloud' } } },
    });
  });

  it('queues an explicit Aether proposal without calling the chat model', async () => {
    const model = new RecordingChatModel();
    const created: unknown[] = [];
    const api = createLocalApiKernel(
      () => '2026-09-03T00:00:00.000Z',
      {
        chatModel: model,
        aetherProposals: {
          configured: true,
          create(scopeKey, input) {
            created.push({ scopeKey, input });
            return {
              id: 'proposal-1', operation: 'new-note', title: input.title ?? '提案', content: input.content,
              reason: input.reason ?? '会話から', createdAt: '2026-09-03T00:00:00.000Z',
            };
          },
        },
      },
    );
    const response = await api.dispatch({ method: 'POST', path: '/v1/aether/proposals', body: {
      scopeKey: 'owner-a', title: '設計案', content: 'Aetherへ残す内容', reason: 'Shannonの返答',
    } });
    expect(response).toMatchObject({ status: 201, body: { id: 'proposal-1', operation: 'new-note' } });
    expect(created).toEqual([{ scopeKey: 'owner-a', input: { title: '設計案', content: 'Aetherへ残す内容', reason: 'Shannonの返答' } }]);
    expect(model.requests).toEqual([]);
  });

  it('updates emotion and recalled memories only behind the response lane', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:0${tick++}.000Z`);
    const first = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '創作を進められて嬉しい！' },
    });
    expect(first).toMatchObject({ body: { snapshotVersion: 0 } });
    const durableBeforeBackground = await api.dispatch({
      method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(durableBeforeBackground).toMatchObject({
      status: 200,
      body: { messages: [{ role: 'user' }, { role: 'assistant' }], state: { version: 0 } },
    });
    await api.waitForBackground('owner-a');

    const second = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '創作の続きを考えたい' },
    });
    expect(second).toMatchObject({ body: { snapshotVersion: 1 } });
    await api.waitForBackground('owner-a');
    const state = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(state).toMatchObject({
      status: 200,
      body: {
        version: 4,
        interests: ['創作'],
        activeMemories: [{ summary: expect.stringContaining('創作を進められて嬉しい') }],
      },
    });
  });

  it('keeps scope state isolated', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'emotion-adjusted', delta: { valence: 0.5 } },
    } });
    const a = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    const b = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-b' }),
    });
    expect(a).toMatchObject({ status: 200, body: { version: 1, emotion: { valence: 0.5 } } });
    expect(b).toMatchObject({ status: 200, body: { version: 0, emotion: { valence: 0 } } });
  });

  it('rejects missing scope, malformed events, and long messages', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect((await api.dispatch({ method: 'GET', path: '/v1/state' })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'a', event: { type: 'prediction' },
    } })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'a', message: 'x'.repeat(8_001),
    } })).status).toBe(400);
  });

  it('exposes and acknowledges proactive messages without involving the chat model', async () => {
    let acknowledged = false;
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-03T03:00:00.000Z',
      {
        chatModel: model,
        initiativeInbox: {
          unreadMessages: scopeKey => acknowledged ? [] : [{
            id: 'initiative-1', threadId: 'thread-1', content: 'これが気になった。',
            expression: 'curious', sourceTitle: 'Hacker News', sourceURL: 'https://example.com',
            createdAt: '2026-09-03T02:00:00.000Z',
          }],
          markAllRead: scopeKey => {
            expect(scopeKey).toBe('owner-a');
            acknowledged = true;
            return 1;
          },
        },
      },
    );
    expect(await api.dispatch({
      method: 'GET', path: '/v1/initiatives', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toMatchObject({ status: 200, body: { unreadCount: 1 } });
    expect(await api.dispatch({
      method: 'POST', path: '/v1/initiatives/read', body: { scopeKey: 'owner-a' },
    })).toEqual({ status: 200, body: { markedRead: 1 } });
    expect(model.requests).toEqual([]);
  });

  it('runs a fake agent task from an idempotent start through approval to completion', async () => {
    let tick = 0;
    const clock = () => `2026-09-04T00:00:${String(tick++).padStart(2, '0')}.000Z`;
    const api = createLocalApiKernel(clock);
    const input = {
      scopeKey: 'owner-a', idempotencyKey: 'device-start-1', conversationThreadID: 'thread-a',
      sourceMessageID: 'message-a', title: '接続障害を直す', goal: '履歴を残したまま直す', summary: '安全に調べて直す。',
    };
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: input });
    const duplicate = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: input });
    expect(created).toMatchObject({ status: 201, body: { created: true, task: { status: 'queued' } } });
    expect(duplicate).toMatchObject({ status: 200, body: { created: false } });
    const taskId = (created.body as { task: { id: string } }).task.id;

    const claimed = await api.dispatch({
      method: 'POST', path: '/v1/agent/host/commands/claim', body: { hostId: 'fake-mac' },
    });
    expect(claimed).toMatchObject({ status: 200, body: { command: { taskId, type: 'start' } } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'fake-mac', events: [{
        eventId: 'fake-started', taskId, type: 'started', title: '調査開始',
        detail: '関連箇所を確認中', occurredAt: clock(), payload: { currentAction: '接続処理を確認中' },
      }, {
        eventId: 'fake-approval', taskId, type: 'approval_requested', title: '判断待ち', occurredAt: clock(),
        payload: { approval: {
          externalRequestID: 'approval-1', kind: 'network', title: '接続試験', reason: '外部接続が必要',
        } },
      }],
    } });
    const waiting = await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(waiting).toMatchObject({ status: 200, body: { task: { status: 'waiting_approval' } } });

    const approval = {
      scopeKey: 'owner-a', idempotencyKey: 'approval-command-1', type: 'resolve_approval',
      payload: { decision: 'allow_once', externalRequestID: 'approval-1' },
    };
    expect(await api.dispatch({
      method: 'POST', path: `/v1/agent/tasks/${taskId}/commands`, body: approval,
    })).toMatchObject({ status: 202, body: { created: true, task: { status: 'starting' } } });
    expect(await api.dispatch({
      method: 'POST', path: `/v1/agent/tasks/${taskId}/commands`, body: approval,
    })).toMatchObject({ status: 200, body: { created: false } });

    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'fake-mac', events: [{
        eventId: 'fake-complete', taskId, type: 'completed', title: '修正完了', detail: '接続を復旧した。',
        occurredAt: clock(), payload: {
          changes: [{ id: 'change-1', displayName: 'SessionStore.swift', summary: '復元順序を修正', additions: 4, deletions: 2 }],
          tests: [{ id: 'test-1', name: '接続回帰試験', status: 'passed', detail: '成功' }],
        },
      }],
    } });
    const completed = await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(completed).toMatchObject({
      status: 200,
      body: { task: { status: 'completed', changes: [{ displayName: 'SessionStore.swift' }], tests: [{ status: 'passed' }] } },
    });
    const sequence = (completed.body as { task: { latestSequence: number } }).task.latestSequence;
    expect(await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a', afterSequence: String(sequence) }),
    })).toEqual({ status: 304, body: null });
  });
});
