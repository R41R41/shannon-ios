import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAgentTaskStore } from '../src/agentTaskStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite Agent Task Store', () => {
  it('deduplicates start requests and restores the same task after reopen', () => {
    const path = databasePath();
    new SQLiteShannonStore({ path, now: () => '2026-09-04T00:00:00.000Z' }).close();
    const first = new SQLiteAgentTaskStore(path);
    const input = {
      idempotencyKey: 'device:start:one',
      conversationThreadID: 'thread-a',
      sourceMessageID: 'message-a',
      title: '接続障害を直す',
      goal: '履歴を消さずに接続を直す',
      summary: '原因を調べて安全に直す。',
    };

    const created = first.create('owner-a', input, '2026-09-04T00:00:01.000Z');
    const duplicate = first.create('owner-a', input, '2026-09-04T00:00:02.000Z');

    expect(created.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.task.id).toBe(created.task.id);
    expect(first.list('owner-a')).toHaveLength(1);
    expect(first.list('owner-b')).toEqual([]);
    first.close();

    const reopened = new SQLiteAgentTaskStore(path);
    expect(reopened.get('owner-a', created.task.id)).toMatchObject({ status: 'queued', latestSequence: 1 });
    reopened.close();
  });

  it('leases one command and projects idempotent host events in sequence', () => {
    const path = databasePath();
    const store = new SQLiteAgentTaskStore(path);
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '調査', goal: '原因を知る', summary: '調べる。',
    }, '2026-09-04T00:00:00.000Z');

    const command = store.claim('mac-a', '2026-09-04T00:00:01.000Z');
    expect(command).toMatchObject({ taskId: created.task.id, type: 'start', attempts: 1 });
    expect(store.claim('mac-b', '2026-09-04T00:00:02.000Z')).toBeNull();

    const started = {
      eventId: 'event-started', taskId: created.task.id, type: 'started' as const,
      title: '作業開始', detail: 'リポジトリを確認中', occurredAt: '2026-09-04T00:00:03.000Z',
      payload: { currentAction: '関連コードを読んでいる' },
    };
    expect(() => store.recordHostEvents('mac-b', [started], '2026-09-04T00:00:02.500Z'))
      .toThrow('AGENT_HOST_TASK_MISMATCH');
    store.recordHostEvents('mac-a', [started], '2026-09-04T00:00:03.000Z');
    store.recordHostEvents('mac-a', [started], '2026-09-04T00:00:04.000Z');
    expect(store.get('owner-a', created.task.id)).toMatchObject({
      status: 'running', currentAction: '関連コードを読んでいる', latestSequence: 3,
    });

    store.recordHostEvents('mac-a', [{
      eventId: 'event-approval', taskId: created.task.id, type: 'approval_requested',
      title: '許可待ち', occurredAt: '2026-09-04T00:00:05.000Z',
      payload: { approval: {
        externalRequestID: 'codex-approval-1', kind: 'network', title: '接続テスト',
        reason: '外部APIへ接続するため', resource: 'https://example.com',
      } },
    }], '2026-09-04T00:00:05.000Z');
    expect(store.get('owner-a', created.task.id)).toMatchObject({
      status: 'waiting_approval', pendingApproval: { externalRequestID: 'codex-approval-1' }, latestSequence: 4,
    });
    store.recordHostEvents('mac-a', [{
      eventId: 'event-recovered', taskId: created.task.id, type: 'started',
      title: '承認待ちから自動復旧', detail: '同じスレッドで再開した。',
      occurredAt: '2026-09-04T00:00:06.000Z', payload: { currentAction: '中断箇所を確認中' },
    }], '2026-09-04T00:00:06.000Z');
    const recovered = store.get('owner-a', created.task.id);
    expect(recovered).toMatchObject({ status: 'running', latestSequence: 5 });
    expect(recovered?.pendingApproval).toBeUndefined();
    store.close();
  });

  it('routes an explicitly targeted task only to that host', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'cloud-start', conversationThreadID: 'thread-a', title: 'クラウド改修',
      goal: 'TestFlightへ届ける', summary: 'クラウドで作業する。', hostHint: 'shannon-cloud',
      projectHint: 'shannon-ios',
    }, '2026-09-04T00:00:00.000Z');

    expect(store.claim('shannon-mac', '2026-09-04T00:00:01.000Z')).toBeNull();
    expect(store.claim('shannon-cloud', '2026-09-04T00:00:02.000Z')).toMatchObject({
      taskId: created.task.id,
      payload: { hostHint: 'shannon-cloud', projectHint: 'shannon-ios' },
    });
    store.close();
  });

  it('prefers an available local host, queues code work on it while it is busy, and sends other work to cloud', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const models = [{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
      supportedReasoningEfforts: ['low', 'medium', 'high'] as const,
      defaultReasoningEffort: 'high' as const,
    }];
    store.heartbeat({
      hostId: 'local-mac', displayName: 'このMac', kind: 'local',
      capabilities: ['workspace-files', 'diff', 'git', 'build'],
      projects: ['shannon-ios', 'aether'], models,
    }, '2026-09-04T00:00:00.000Z');
    store.heartbeat({
      hostId: 'cloud-agent', displayName: 'Cloud Agent', kind: 'cloud',
      capabilities: ['workspace-files', 'diff', 'git', 'build'],
      projects: ['shannon-ios', 'aether', 'voyager'], models,
    }, '2026-09-04T00:00:00.000Z');

    expect(store.resolveHost('shannon-ios', 'auto', '2026-09-04T00:00:10.000Z', 'legacy-cloud'))
      .toBe('local-mac');
    const task = store.create('owner-a', {
      idempotencyKey: 'local-first', conversationThreadID: 'thread-a', title: 'Shannonを改善',
      goal: '開発画面を作る', summary: 'このMacで開始する。', hostHint: 'local-mac',
      projectHint: 'shannon-ios', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    }, '2026-09-04T00:00:11.000Z');
    expect(task.task).toMatchObject({
      assignedHostID: 'local-mac', projectHint: 'shannon-ios',
      model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    // A task with a project changes code: it waits for the busy Mac instead of going to cloud.
    expect(store.resolveHost('shannon-ios', 'auto', '2026-09-04T00:00:12.000Z', 'legacy-cloud'))
      .toBe('local-mac');
    // Work without a project keeps the earlier routing: a busy Mac sends it to cloud.
    expect(store.resolveHost(undefined, 'auto', '2026-09-04T00:00:12.000Z', 'legacy-cloud'))
      .toBe('cloud-agent');
    // The busy Mac does not carry this project, so there is no line to join.
    expect(store.resolveHost('voyager', 'auto', '2026-09-04T00:00:12.000Z', 'legacy-cloud'))
      .toBe('cloud-agent');
    expect(store.resolveHost('shannon-ios', 'cloud', '2026-09-04T00:00:12.000Z', 'legacy-cloud'))
      .toBe('cloud-agent');
    const catalog = store.workspaceCatalog('shannon-ios', '2026-09-04T00:00:12.000Z', 'legacy-cloud');
    expect(catalog.routing).toMatchObject({
      resolvedHostId: 'local-mac',
      explanation: 'このMacは別の作業中のため、前の作業が終わってから順番に実行します。',
    });
    expect(store.workspaceCatalog(undefined, '2026-09-04T00:00:12.000Z', 'legacy-cloud').routing)
      .toMatchObject({ resolvedHostId: 'cloud-agent', explanation: 'このMacが利用できないため、クラウドで実行します。' });
    expect(catalog.hosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: 'local-mac', status: 'busy' }),
      expect.objectContaining({ hostId: 'cloud-agent', status: 'available' }),
    ]));
    expect(catalog.projects).toContainEqual(expect.objectContaining({
      key: 'shannon-ios', availableHostIds: ['local-mac', 'cloud-agent'],
    }));

    // A Mac that is asleep has no line to wait in: code work goes to cloud as before.
    store.heartbeat({
      hostId: 'cloud-agent', displayName: 'Cloud Agent', kind: 'cloud',
      capabilities: ['workspace-files', 'diff', 'git', 'build'],
      projects: ['shannon-ios', 'aether', 'voyager'], models,
    }, '2026-09-04T00:05:00.000Z');
    expect(store.resolveHost('shannon-ios', 'auto', '2026-09-04T00:05:10.000Z', 'legacy-cloud'))
      .toBe('cloud-agent');
    store.close();
  });

  it('does not silently route an explicit local request to cloud', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    store.heartbeat({
      hostId: 'cloud-agent', displayName: 'Cloud Agent', kind: 'cloud',
      capabilities: [], projects: ['voyager'], models: [],
    }, '2026-09-04T00:00:00.000Z');

    expect(store.resolveHost('voyager', 'local', '2026-09-04T00:00:10.000Z', 'cloud-agent')).toBeNull();
    expect(store.resolveHost('voyager', 'cloud', '2026-09-04T00:00:10.000Z', 'cloud-agent'))
      .toBe('cloud-agent');
    store.close();
  });

  it('queues an explicit local preference for code work on a busy local host, and only there', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    store.heartbeat({
      hostId: 'local-mac', displayName: 'このMac', kind: 'local',
      capabilities: [], projects: ['shannon-ios'], models: [],
    }, '2026-09-04T00:00:00.000Z');
    const task = store.create('owner-a', {
      idempotencyKey: 'busy-local', conversationThreadID: 'thread-a', title: '進行中',
      goal: 'ローカルを使用中にする', summary: '作業中', hostHint: 'local-mac', projectHint: 'shannon-ios',
    }, '2026-09-04T00:00:01.000Z');

    expect(task.task.assignedHostID).toBe('local-mac');
    // Code work joins the line of the busy Mac, whether the owner asked for the Mac or left it to routing.
    expect(store.resolveHost('shannon-ios', 'local', '2026-09-04T00:00:02.000Z', 'cloud-agent'))
      .toBe('local-mac');
    expect(store.resolveHost('shannon-ios', 'auto', '2026-09-04T00:00:02.000Z', null))
      .toBe('local-mac');
    // Work without a project, or for a project this Mac does not carry, is still not queued on it.
    expect(store.resolveHost(undefined, 'local', '2026-09-04T00:00:02.000Z', 'cloud-agent'))
      .toBeNull();
    expect(store.resolveHost('voyager', 'local', '2026-09-04T00:00:02.000Z', 'cloud-agent'))
      .toBeNull();
    // An offline Mac is not a line to wait in.
    expect(store.resolveHost('shannon-ios', 'local', '2026-09-04T00:02:00.000Z', 'cloud-agent'))
      .toBeNull();
    store.close();
  });

  it('uses the resolved host workspace snapshot in the project catalog', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    store.heartbeat({
      hostId: 'local-mac', displayName: 'このMac', kind: 'local', capabilities: [],
      projects: ['shannon-ios'], models: [], workspaces: [{
        key: 'shannon-ios', isGitRepository: true, currentBranch: 'local-branch',
        files: ['local.swift'], changes: [],
      }],
    }, '2026-09-04T00:00:00.000Z');
    store.heartbeat({
      hostId: 'cloud-agent', displayName: 'Cloud', kind: 'cloud', capabilities: [],
      projects: ['shannon-ios'], models: [], workspaces: [{
        key: 'shannon-ios', isGitRepository: true, currentBranch: 'cloud-branch',
        files: ['cloud.swift'], changes: [],
      }],
    }, '2026-09-04T00:00:00.000Z');

    expect(store.workspaceCatalog('shannon-ios', '2026-09-04T00:00:10.000Z', null).projects[0])
      .toMatchObject({ currentBranch: 'local-branch', files: ['local.swift'] });
    store.create('owner-a', {
      idempotencyKey: 'make-local-busy', conversationThreadID: 'thread-a', title: '進行中',
      goal: 'ローカルを使用中にする', summary: '作業中', hostHint: 'local-mac', projectHint: 'shannon-ios',
    }, '2026-09-04T00:00:11.000Z');
    // Code work still resolves to the busy Mac, so the catalog keeps showing the Mac's checkout.
    expect(store.workspaceCatalog('shannon-ios', '2026-09-04T00:00:12.000Z', null).projects[0])
      .toMatchObject({ currentBranch: 'local-branch', files: ['local.swift'] });
    store.heartbeat({
      hostId: 'cloud-agent', displayName: 'Cloud', kind: 'cloud', capabilities: [],
      projects: ['shannon-ios'], models: [], workspaces: [{
        key: 'shannon-ios', isGitRepository: true, currentBranch: 'cloud-branch',
        files: ['cloud.swift'], changes: [],
      }],
    }, '2026-09-04T00:05:00.000Z');
    expect(store.workspaceCatalog('shannon-ios', '2026-09-04T00:05:10.000Z', null).projects[0])
      .toMatchObject({ currentBranch: 'cloud-branch', files: ['cloud.swift'] });
    store.close();
  });

  it('queues one idempotent approval command and rejects an old-state command', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '調査', goal: '原因を知る', summary: '調べる。',
    }, '2026-09-04T00:00:00.000Z');
    store.claim('mac-a', '2026-09-04T00:00:01.000Z');
    store.recordHostEvents('mac-a', [{
      eventId: 'approval', taskId: created.task.id, type: 'approval_requested', title: '許可待ち',
      occurredAt: '2026-09-04T00:00:02.000Z', payload: { approval: {
        externalRequestID: 'approval-1', kind: 'permission', title: '操作許可', reason: '続行に必要',
      } },
    }], '2026-09-04T00:00:02.000Z');

    const input = {
      idempotencyKey: 'approval-command-1', type: 'resolve_approval' as const,
      payload: { decision: 'allow_once', externalRequestID: 'approval-1' },
    };
    expect(() => store.enqueue('owner-a', created.task.id, {
      idempotencyKey: 'stale-approval', type: 'resolve_approval',
      payload: { decision: 'allow_once', externalRequestID: 'older-request' },
    }, '2026-09-04T00:00:02.500Z')).toThrow('AGENT_COMMAND_STALE_APPROVAL');
    expect(store.enqueue('owner-a', created.task.id, input, '2026-09-04T00:00:03.000Z').created).toBe(true);
    expect(store.enqueue('owner-a', created.task.id, input, '2026-09-04T00:00:04.000Z').created).toBe(false);
    expect(() => store.enqueue('owner-a', created.task.id, {
      idempotencyKey: 'old-approval', type: 'resolve_approval',
      payload: { decision: 'allow_once', externalRequestID: 'approval-1' },
    }, '2026-09-04T00:00:05.000Z')).toThrow('AGENT_COMMAND_INVALID_STATE');
    store.close();
  });

  it('does not resurrect a cancelled task with late host progress', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '調査', goal: '原因を知る', summary: '調べる。',
    }, '2026-09-04T00:00:00.000Z');
    store.claim('mac-a', '2026-09-04T00:00:01.000Z');
    store.enqueue('owner-a', created.task.id, {
      idempotencyKey: 'cancel-key', type: 'interrupt', payload: { cancel: true },
    }, '2026-09-04T00:00:02.000Z');
    store.recordHostEvents('mac-a', [{
      eventId: 'late-progress', taskId: created.task.id, type: 'progress', title: '遅れて届いた進捗',
      occurredAt: '2026-09-04T00:00:03.000Z', payload: { currentAction: '続行中' },
    }], '2026-09-04T00:00:03.000Z');
    expect(store.get('owner-a', created.task.id)).toMatchObject({ status: 'cancelled', latestSequence: 3 });
    store.close();
  });

  it('keeps command activity state in the task timeline without retaining command output', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '調査', goal: '原因を知る', summary: '調べる。',
    }, '2026-09-04T00:00:00.000Z');
    store.claim('mac-a', '2026-09-04T00:00:01.000Z');

    store.recordHostEvents('mac-a', [{
      eventId: 'command-running', taskId: created.task.id, type: 'progress', title: '自動テストを実行中',
      occurredAt: '2026-09-04T00:00:02.000Z', payload: {
        currentAction: '自動テストを実行中', activity: { kind: 'command', status: 'running' }, rawOutput: 'do not expose',
      },
    }, {
      eventId: 'command-completed', taskId: created.task.id, type: 'progress', title: 'コマンドの実行を完了',
      occurredAt: '2026-09-04T00:00:03.000Z', payload: {
        currentAction: '実行結果を確認中', activity: { kind: 'command', status: 'completed' }, rawOutput: 'still do not expose',
      },
    }], '2026-09-04T00:00:03.000Z');

    const timeline = store.get('owner-a', created.task.id)?.timeline;
    expect(timeline?.slice(-2)).toEqual([
      expect.objectContaining({ title: '自動テストを実行中', activity: { kind: 'command', status: 'running' } }),
      expect.objectContaining({ title: 'コマンドの実行を完了', activity: { kind: 'command', status: 'completed' } }),
    ]);
    expect(JSON.stringify(timeline)).not.toContain('do not expose');
    store.close();
  });

  it('keeps the concrete remaining action when the host pauses an unfinished task', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '配信',
      goal: 'TestFlightへ配信する', summary: '配信を始める。', hostHint: 'cloud-a',
    }, '2026-09-04T00:00:00.000Z');
    store.claim('cloud-a', '2026-09-04T00:00:01.000Z');

    store.recordHostEvents('cloud-a', [{
      eventId: 'paused-with-next-action', taskId: created.task.id, type: 'paused',
      title: '続きが必要です', detail: 'ビルド前の承認を待っています。',
      occurredAt: '2026-09-04T00:00:02.000Z', payload: { currentAction: 'GitHubへの反映を承認' },
    }], '2026-09-04T00:00:02.000Z');

    expect(store.get('owner-a', created.task.id)).toMatchObject({
      status: 'paused', summary: 'ビルド前の承認を待っています。', currentAction: 'GitHubへの反映を承認',
    });
    store.close();
  });

  it('persists pin and archive metadata without allowing an active task to disappear', () => {
    const path = databasePath();
    const store = new SQLiteAgentTaskStore(path);
    const created = store.create('owner-a', {
      idempotencyKey: 'managed-task', conversationThreadID: 'thread-a', title: '配信準備',
      goal: '配信できる状態にする', summary: '準備を始める。', hostHint: 'mac-a',
    }, '2026-09-04T00:00:00.000Z');

    expect(store.updateMetadata('owner-a', created.task.id, { isPinned: true }, '2026-09-04T00:00:01.000Z'))
      .toMatchObject({ isPinned: true, isArchived: false });
    expect(() => store.updateMetadata(
      'owner-a', created.task.id, { isArchived: true }, '2026-09-04T00:00:02.000Z',
    )).toThrow('AGENT_TASK_ARCHIVE_ACTIVE');

    store.claim('mac-a', '2026-09-04T00:00:03.000Z');
    store.recordHostEvents('mac-a', [{
      eventId: 'managed-complete', taskId: created.task.id, type: 'completed', title: '完了',
      detail: '配信準備が完了した。', occurredAt: '2026-09-04T00:00:04.000Z',
    }], '2026-09-04T00:00:04.000Z');
    store.updateMetadata('owner-a', created.task.id, { isArchived: true }, '2026-09-04T00:00:05.000Z');
    store.close();

    const reopened = new SQLiteAgentTaskStore(path);
    expect(reopened.get('owner-a', created.task.id)).toMatchObject({ isPinned: true, isArchived: true });
    reopened.close();
  });

  it('tells a pause that needs the owner from one the owner asked for, and each new pause apart', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '配信', goal: '配信する', summary: '始める。',
    }, '2026-09-04T00:00:00.000Z');
    const taskId = created.task.id;
    store.claim('mac-a', '2026-09-04T00:00:01.000Z');
    const hostPause = (eventId: string, at: string, payload: Record<string, unknown>) => store.recordHostEvents('mac-a', [{
      eventId, taskId, type: 'paused', title: '続きが必要です', detail: '検証が残っています。', occurredAt: at, payload,
    }], at);

    hostPause('pause-1', '2026-09-04T00:00:02.000Z', { pauseReason: 'needs_owner', currentAction: '実機で確認' });
    const first = store.get('owner-a', taskId)!;
    expect(first).toMatchObject({ status: 'paused', pauseReason: 'needs_owner', currentAction: '実機で確認' });
    expect(first.pauseSequence).toBe(first.latestSequence);

    store.enqueue('owner-a', taskId, { idempotencyKey: 'resume-1', type: 'resume' }, '2026-09-04T00:00:03.000Z');
    expect(store.get('owner-a', taskId)).not.toHaveProperty('pauseReason');
    store.recordHostEvents('mac-a', [{
      eventId: 'resumed', taskId, type: 'started', title: '作業を再開', occurredAt: '2026-09-04T00:00:04.000Z',
    }], '2026-09-04T00:00:04.000Z');

    // An older host does not tag the pause; a next action still marks it as waiting for the owner.
    hostPause('pause-2', '2026-09-04T00:00:05.000Z', { currentAction: 'もう一度実機で確認' });
    const second = store.get('owner-a', taskId)!;
    expect(second.pauseReason).toBe('needs_owner');
    expect(second.pauseSequence).toBeGreaterThan(first.pauseSequence!);

    store.enqueue('owner-a', taskId, { idempotencyKey: 'steer-1', type: 'steer', payload: { instruction: '続けて' } },
      '2026-09-04T00:00:06.000Z');
    store.enqueue('owner-a', taskId, { idempotencyKey: 'pause-by-owner', type: 'interrupt' }, '2026-09-04T00:00:07.000Z');
    expect(store.get('owner-a', taskId)).toMatchObject({ status: 'paused', pauseReason: 'owner' });
    hostPause('pause-3', '2026-09-04T00:00:08.000Z', { pauseReason: 'owner' });
    expect(store.get('owner-a', taskId)).toMatchObject({ status: 'paused', pauseReason: 'owner' });
    store.close();
  });

  it('keeps changes and failed checks when work stops or fails', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const evidence = {
      changes: [{ id: 'change-1', displayName: 'Login.swift', summary: '変更', additions: 3, deletions: 1 }],
      tests: [{ id: 'test-1', name: '全体検証', status: 'failed', detail: '失敗を検出' }],
    };
    for (const type of ['paused', 'failed'] as const) {
      const created = store.create('owner-a', {
        idempotencyKey: `start-${type}`, conversationThreadID: 'thread-a', title: '修正', goal: '直す', summary: '始める。',
        hostHint: `host-${type}`,
      }, '2026-09-04T00:00:00.000Z');
      store.claim(`host-${type}`, '2026-09-04T00:00:01.000Z');
      store.recordHostEvents(`host-${type}`, [{
        eventId: `stopped-${type}`, taskId: created.task.id, type, title: '止まった', detail: '検証で問題が見つかった。',
        occurredAt: '2026-09-04T00:00:02.000Z', payload: { ...evidence, currentAction: '全体検証を修正して再実行' },
      }], '2026-09-04T00:00:02.000Z');
      expect(store.get('owner-a', created.task.id)).toMatchObject({ status: type, ...evidence });
    }
    store.close();
  });

  it('denies only the one operation when the host supports it, and cancels the task otherwise', () => {
    const store = new SQLiteAgentTaskStore(databasePath());
    const requestApproval = (key: string, host: string, denyContinues: boolean) => {
      const created = store.create('owner-a', {
        idempotencyKey: key, conversationThreadID: 'thread-a', title: '調査', goal: '原因を知る', summary: '調べる。',
        hostHint: host,
      }, '2026-09-04T00:00:00.000Z');
      store.claim(host, '2026-09-04T00:00:01.000Z');
      store.recordHostEvents(host, [{
        eventId: `approval-${key}`, taskId: created.task.id, type: 'approval_requested', title: 'コマンド実行の許可',
        occurredAt: '2026-09-04T00:00:02.000Z', payload: { approval: {
          externalRequestID: `request-${key}`, kind: 'command', title: 'コマンド実行の許可', reason: '必要',
          resource: 'rm -rf build', ...(denyContinues ? { denyContinues: true } : {}),
        } },
      }], '2026-09-04T00:00:02.000Z');
      return store.enqueue('owner-a', created.task.id, {
        idempotencyKey: `deny-${key}`, type: 'resolve_approval',
        payload: { decision: 'deny', externalRequestID: `request-${key}` },
      }, '2026-09-04T00:00:03.000Z');
    };

    const continued = requestApproval('new-host', 'mac-new', true);
    expect(continued.task).toMatchObject({ status: 'starting' });
    expect(continued.task.pendingApproval).toBeUndefined();
    expect(continued.command?.payload).toMatchObject({ decision: 'deny', denyContinues: true });
    // The task is still alive, so the host's next event moves it on instead of being dropped.
    store.recordHostEvents('mac-new', [{
      eventId: 'after-deny', taskId: continued.task.id, type: 'progress', title: '許可しない判断をCodexへ送信',
      occurredAt: '2026-09-04T00:00:04.000Z', payload: { currentAction: '別の進め方を確認中' },
    }], '2026-09-04T00:00:04.000Z');
    expect(store.get('owner-a', continued.task.id)).toMatchObject({ status: 'running' });

    const cancelled = requestApproval('old-host', 'mac-old', false);
    expect(cancelled.task).toMatchObject({ status: 'cancelled', summary: '許可されなかったので、作業を中止した。' });
    expect(cancelled.command?.payload).not.toHaveProperty('denyContinues');
    store.close();
  });

  it('adds the pause columns to an existing database without losing tasks', () => {
    const path = databasePath();
    let store = new SQLiteAgentTaskStore(path);
    const created = store.create('owner-a', {
      idempotencyKey: 'start-key', conversationThreadID: 'thread-a', title: '配信', goal: '配信する', summary: '始める。',
    }, '2026-09-04T00:00:00.000Z');
    store.claim('mac-a', '2026-09-04T00:00:01.000Z');
    store.recordHostEvents('mac-a', [{
      eventId: 'legacy-pause', taskId: created.task.id, type: 'paused', title: '続きが必要です',
      occurredAt: '2026-09-04T00:00:02.000Z', payload: { currentAction: 'GitHubへの反映を承認' },
    }], '2026-09-04T00:00:02.000Z');
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE agent_tasks DROP COLUMN pause_reason; ALTER TABLE agent_tasks DROP COLUMN pause_sequence;');
    legacy.close();

    store = new SQLiteAgentTaskStore(path);
    const restored = store.get('owner-a', created.task.id)!;
    expect(restored).toMatchObject({ status: 'paused', pauseReason: 'needs_owner', currentAction: 'GitHubへの反映を承認' });
    expect(restored).not.toHaveProperty('pauseSequence');
    store.close();
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-agent-task-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'shannon.sqlite');
}
