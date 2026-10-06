import { randomUUID } from 'node:crypto';
import type { ClaimedAgentCommand, HostAgentEvent } from './mind/action/agentTasks/agentTaskStore.js';

const baseURL = (process.env.SHANNON_API_BASE_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const token = process.env.SHANNON_AGENT_HOST_TOKEN?.trim() ?? '';
const hostId = process.env.SHANNON_AGENT_HOST_ID?.trim() || 'fake-mac';

if (token.length < 32) throw new Error('SHANNON_AGENT_HOST_TOKEN must contain at least 32 characters');

console.log(`Fake Shannon Agent Host: ${hostId}`);
console.log(`Broker: ${baseURL}`);

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

while (!stopping) {
  await post('/v1/agent/host/heartbeat', {
    hostId,
    displayName: 'Fake Mac Agent',
    capabilities: ['fixture', 'approval', 'steer', 'interrupt'],
  });
  const response = await post<{ command: ClaimedAgentCommand | null }>('/v1/agent/host/commands/claim', { hostId });
  if (response.command) {
    console.log(`Claimed ${response.command.type}: ${response.command.taskId}`);
    await execute(response.command);
  }
  await delay(response.command ? 250 : 1_500);
}

async function execute(command: ClaimedAgentCommand): Promise<void> {
  const occurredAt = () => new Date().toISOString();
  const event = (
    type: HostAgentEvent['type'],
    title: string,
    detail?: string,
    payload?: Record<string, unknown>,
  ): HostAgentEvent => ({
    eventId: randomUUID(), taskId: command.taskId, type, title,
    ...(detail ? { detail } : {}), occurredAt: occurredAt(), ...(payload ? { payload } : {}),
  });
  const completedCommand = event('command_completed', '命令を反映', undefined, { commandId: command.id });

  switch (command.type) {
    case 'start':
      await sendEvents([
        event('started', '作業を開始', '依頼と対象を確認している。', { currentAction: '対象ファイルを確認中' }),
        event('progress', '調査方針を整理', '安全な変更範囲を確認した。', {
          currentAction: '接続テストの準備中',
          plan: [
            { id: 'inspect', title: '現状を確認', status: 'completed' },
            { id: 'change', title: '修正を適用', status: 'running' },
            { id: 'verify', title: '回帰試験', status: 'pending' },
          ],
        }),
        event('approval_requested', '接続テストの判断待ち', '外部接続の前で待っている。', { approval: {
          id: randomUUID(), externalRequestID: randomUUID(), kind: 'network',
          title: '接続テストを実行', reason: '修正後の接続を確認するため', resource: 'テスト用ネットワーク',
          requestedAt: occurredAt(),
        } }),
        completedCommand,
      ]);
      break;
    case 'resolve_approval':
      if (command.payload.decision === 'deny') {
        await sendEvents([completedCommand]);
        break;
      }
      await sendEvents([
        event('progress', '許可を受け取った', '接続テストを実行した。', { currentAction: '最終確認中' }),
        event('completed', '作業を完了', '接続を確認し、変更内容をまとめた。', {
          changes: [{ id: randomUUID(), displayName: 'FixtureConnection.swift', summary: '接続復元順序を修正', additions: 6, deletions: 2 }],
          tests: [{ id: randomUUID(), name: 'Fake Host E2E', status: 'passed', detail: '成功' }],
        }),
        completedCommand,
      ]);
      break;
    case 'steer':
      await sendEvents([
        event('progress', '追加の指示を反映', String(command.payload.instruction ?? ''), {
          currentAction: String(command.payload.instruction ?? '追加の指示を確認中'),
        }),
        completedCommand,
      ]);
      break;
    case 'interrupt':
      await sendEvents(command.payload.cancel === true || command.payload.cancel === 'true'
        ? [completedCommand]
        : [event('paused', '作業を一時停止', '再開の指示を待っている。'), completedCommand]);
      break;
    case 'resume':
      await sendEvents([
        event('started', '作業を再開', '止めた箇所から再開した。', { currentAction: '作業を再開中' }),
        completedCommand,
      ]);
      break;
  }
}

async function sendEvents(events: readonly HostAgentEvent[]): Promise<void> {
  await post('/v1/agent/host/events', { hostId, events });
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fake Host request failed: ${response.status} ${path}`);
  return await response.json() as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
