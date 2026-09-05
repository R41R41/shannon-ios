import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLiteAgentTaskStore } from '../src/agentTaskStore.js';
import {
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
  SQLitePushNotificationStore,
  type PushNotificationSender,
} from '../src/pushNotifications.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { SQLiteWorldStore } from '../src/worldStore.js';
import { SQLiteTestFlightDeliveryStore } from '../src/testflightDeliveryStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('push notification delivery', () => {
  it('registers an authenticated device and delivers each initiative once', async () => {
    const path = createInitiative();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'ab'.repeat(32),
      'sandbox',
    );
    expect(push.pending()).toEqual([
      expect.objectContaining({
        deviceId: 'iphone-1',
        threadId: expect.any(String),
        badgeCount: 1,
        environment: 'sandbox',
      }),
    ]);

    const sent: string[] = [];
    const sender: PushNotificationSender = {
      enabled: true,
      async send(notification) {
        sent.push(notification.initiativeId);
        return { delivered: true, permanentFailure: false, status: 200, reason: null };
      },
    };
    expect(await deliverPendingPushNotifications(push, sender, '2026-09-03T03:01:00.000Z'))
      .toEqual({ attempted: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(push.pending()).toEqual([]);
    push.close();
  });

  it('invalidates a token after APNs reports a permanent device error', async () => {
    const path = createInitiative();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'cd'.repeat(32),
      'production',
    );
    const sender: PushNotificationSender = {
      enabled: true,
      async send() {
        return { delivered: false, permanentFailure: true, status: 410, reason: 'Unregistered' };
      },
    };

    expect(await deliverPendingPushNotifications(push, sender, '2026-09-03T03:01:00.000Z'))
      .toEqual({ attempted: 1, delivered: 0 });
    expect(push.pending('2026-09-03T05:01:00.000Z')).toEqual([]);
    push.close();
  });

  it('delivers terminal agent task events only once', async () => {
    const { path, taskId } = createAgentTask();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-04T04:01:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'ef'.repeat(32),
      'sandbox',
    );
    expect(push.pending()).toEqual([
      expect.objectContaining({
        kind: 'agent_task', taskId, threadId: 'talk-1', expression: 'joyful', badgeCount: 1,
      }),
    ]);

    const sent: string[] = [];
    const sender: PushNotificationSender = {
      enabled: true,
      async send(notification) {
        sent.push(notification.initiativeId);
        return { delivered: true, permanentFailure: false, status: 200, reason: null };
      },
    };
    expect(await deliverPendingPushNotifications(push, sender, '2026-09-04T04:01:00.000Z'))
      .toEqual({ attempted: 1, delivered: 1 });
    expect(sent).toEqual(['agent:completed-event']);
    expect(push.pending()).toEqual([]);
    push.close();
  });

  it('delivers only the first push for one TestFlight failure episode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-testflight-push-test-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const delivery = new SQLiteTestFlightDeliveryStore(path);
    delivery.recordFailure(new Error('APP_STORE_CONNECT_403'), '2026-09-05T04:00:00.000Z');
    delivery.recordFailure(new Error('APP_STORE_CONNECT_403'), '2026-09-05T04:10:00.000Z');
    const push = new SQLitePushNotificationStore(path, () => '2026-09-05T04:11:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'fa'.repeat(32),
      'production',
    );
    expect(push.pending()).toEqual([
      expect.objectContaining({
        kind: 'testflight_failure',
        title: 'シャノン · アプリの更新',
        expression: 'concerned',
      }),
    ]);
    const sender: PushNotificationSender = {
      enabled: true,
      async send() {
        return { delivered: true, permanentFailure: false, status: 200, reason: null };
      },
    };
    expect(await deliverPendingPushNotifications(push, sender, '2026-09-05T04:11:00.000Z'))
      .toEqual({ attempted: 1, delivered: 1 });
    expect(push.pending()).toEqual([]);
    expect(delivery.dashboard().history[1]?.notificationStatus).toBe('sent');
    push.close();
    delivery.close();
  });

  it('stays disabled until the complete APNs credential set exists', () => {
    expect(createConfiguredPushNotificationSender({}).enabled).toBe(false);
    expect(() => createConfiguredPushNotificationSender({ SHANNON_APNS_KEY_ID: 'ABCDEFGHIJ' }))
      .toThrow('SHANNON_APNS_CONFIG_INCOMPLETE');
  });
});

function createInitiative(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-push-test-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const at = '2026-09-03T03:00:00.000Z';
  const state = new SQLiteShannonStore({ path, now: () => at });
  state.snapshot('owner');
  state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
  state.createThread('owner', 'いつものトーク');
  const world = new SQLiteWorldStore(path, () => at);
  const source = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
  world.recordSuccess(source, [{
    externalId: 'push-story',
    title: 'AI agents that learn from daily work',
    url: 'https://example.com/agents',
  }], '2026-09-03T02:00:00.000Z');
  const initiatives = new SQLiteInitiativeStore(path, () => at);
  expect(initiatives.runOnce()).toMatchObject({ sent: 1 });
  initiatives.close();
  world.close();
  state.close();
  return path;
}

function createAgentTask(): { path: string; taskId: string } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-agent-push-test-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const tasks = new SQLiteAgentTaskStore(path);
  const created = tasks.create('owner', {
    idempotencyKey: 'push-task', conversationThreadID: 'talk-1', title: 'リンク表示を直す',
    goal: 'シャノン側のリンクをタップ可能にする', summary: '作業を開始する',
  }, '2026-09-04T04:00:00.000Z');
  tasks.heartbeat('mac-1', 'Mac', ['codex'], '2026-09-04T04:00:01.000Z');
  tasks.claim('mac-1', '2026-09-04T04:00:02.000Z');
  tasks.recordHostEvents('mac-1', [{
    eventId: 'completed-event', taskId: created.task.id, type: 'completed', title: '完了',
    detail: 'リンク表示を修正した。', occurredAt: '2026-09-04T04:00:03.000Z',
  }], '2026-09-04T04:00:03.000Z');
  tasks.close();
  return { path, taskId: created.task.id };
}
