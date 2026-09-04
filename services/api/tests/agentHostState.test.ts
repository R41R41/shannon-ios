import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentHostStateStore } from '../src/agentHostState.js';

describe('AgentHostStateStore', () => {
  it('persists resumable sessions and an idempotent durable event outbox', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shannon-host-state-')), 'state.json');
    const store = new AgentHostStateStore(path);
    store.saveSession({
      taskId: 'task-1', startCommandId: 'command-1', threadId: 'thread-1', turnId: 'turn-1',
      pendingApprovalExternalRequestID: 'approval-1',
      goal: 'Recover a title edit',
      projectKey: 'fixture', cwd: '/fixture', updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const event = {
      eventId: 'event-1', taskId: 'task-1', type: 'progress' as const,
      title: '進行中', occurredAt: '2026-09-04T00:00:01.000Z',
    };
    store.enqueueEvents([event, event]);

    const restored = new AgentHostStateStore(path);
    expect(restored.resumableSessions()).toHaveLength(1);
    expect(restored.session('task-1')?.pendingApprovalExternalRequestID).toBe('approval-1');
    expect(restored.session('task-1')?.goal).toBe('Recover a title edit');
    expect(restored.pendingEvents()).toEqual([event]);
    restored.acknowledgeEvents(['event-1']);
    expect(restored.pendingEvents()).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });
});
