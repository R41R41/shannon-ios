import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteAgentTaskStore } from '../src/agentTaskStore.js';
import {
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
  SQLitePushNotificationStore,
  type PushNotificationSender,
} from '../src/surfaces/outreach/pushNotifications.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteWorldStore } from '../src/integrations/world/store/worldStore.js';
import { SQLiteTestFlightDeliveryStore } from '../src/integrations/testflight/store/testflightDeliveryStore.js';

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

  it('keeps what she saw in the room out of the banner', () => {
    const path = createInitiative();
    const database = new DatabaseSync(path);
    const before = String((database.prepare('SELECT content FROM initiative_messages').get() as { content: string }).content);
    database.prepare("UPDATE initiative_messages SET source_item_id = 'body-look:look-1', content = '机の上にマグカップが見えます。'").run();
    database.close();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
    push.register({ deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' }, 'ab'.repeat(32), 'sandbox');
    const [notification] = push.pending();
    expect(notification?.content).toBe('ライ氏、部屋のことでひとことあります。');
    expect(notification?.content).not.toBe(before);
  });

  it('marks every message about the room in the inbox, so the Mac notification does not quote it either', () => {
    for (const [source, roomLook] of [
      ['body-look:look-1', true], ['reach-out:saw:a', true], ['reach-out:follow_up:seen:b', true],
      ['reach-out:follow_up:c', false], ['reach-out:share:d', false], ['world:story', false],
    ] as const) {
      const path = createInitiative();
      const database = new DatabaseSync(path);
      database.prepare('UPDATE initiative_messages SET source_item_id = ?').run(source);
      database.close();
      const inbox = new SQLiteInitiativeStore(path);
      const [message] = inbox.unreadMessages('owner');
      inbox.close();
      expect(message?.roomLook).toBe(roomLook);
      const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
      push.register({ deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' }, 'ab'.repeat(32), 'sandbox');
      expect(push.pending()[0]?.content === 'ライ氏、部屋のことでひとことあります。').toBe(roomLook);
      push.close();
    }
  });

  it('leases a notification before sending so overlapping workers do not duplicate it', async () => {
    const path = createInitiative();
    const firstStore = new SQLitePushNotificationStore(path);
    const secondStore = new SQLitePushNotificationStore(path);
    firstStore.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'bc'.repeat(32),
      'sandbox',
      '2026-09-03T03:01:00.000Z',
    );
    let releaseSend!: () => void;
    let reportStarted!: () => void;
    const sendStarted = new Promise<void>(resolve => { reportStarted = resolve; });
    const sendReleased = new Promise<void>(resolve => { releaseSend = resolve; });
    const sent: string[] = [];
    const sender: PushNotificationSender = {
      enabled: true,
      async send(notification) {
        sent.push(notification.initiativeId);
        reportStarted();
        await sendReleased;
        return { delivered: true, permanentFailure: false, status: 200, reason: null };
      },
    };

    const firstDelivery = deliverPendingPushNotifications(firstStore, sender, '2026-09-03T03:01:00.000Z');
    await sendStarted;
    expect(await deliverPendingPushNotifications(secondStore, sender, '2026-09-03T03:01:00.000Z'))
      .toEqual({ attempted: 0, delivered: 0 });
    releaseSend();
    expect(await firstDelivery).toEqual({ attempted: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    firstStore.close();
    secondStore.close();
  });

  it('adds leases to an existing delivery table and prunes expired transport state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-push-migration-test-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE push_delivery_state (
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_status INTEGER,
        last_error TEXT,
        PRIMARY KEY (initiative_id, device_id)
      );
      INSERT INTO push_delivery_state VALUES
        ('old', 'iphone-1', 1, '2026-07-01T00:05:00.000Z', '2026-07-01T00:00:00.000Z', 200, NULL);
    `);
    database.close();

    const push = new SQLitePushNotificationStore(path);
    expect(push.prune('2026-09-03T03:01:00.000Z')).toBe(1);
    push.close();
    const inspected = new DatabaseSync(path);
    const columns = inspected.prepare('PRAGMA table_info(push_delivery_state)').all() as unknown as Array<{ name: string }>;
    expect(columns.some(column => column.name === 'leased_until')).toBe(true);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM push_delivery_state').get()).toMatchObject({ count: 0 });
    inspected.close();
  });

  it('retains old TestFlight delivery state only while bounded dashboard history references it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-push-retention-test-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE testflight_delivery_runs (
        run_id TEXT PRIMARY KEY,
        notification_key TEXT
      );
      INSERT INTO testflight_delivery_runs VALUES ('run-1', 'testflight:episode-1');
    `);
    database.close();
    const push = new SQLitePushNotificationStore(path);
    const inspected = new DatabaseSync(path);
    inspected.prepare(`
      INSERT INTO push_delivery_state
        (initiative_id, device_id, attempts, next_attempt_at, delivered_at, last_status, last_error, leased_until)
      VALUES ('testflight:episode-1', 'iphone-1', 1, '2026-07-01T00:05:00.000Z',
              '2026-07-01T00:00:00.000Z', 200, NULL, NULL)
    `).run();
    expect(push.prune('2026-09-03T03:01:00.000Z')).toBe(0);
    inspected.prepare(`DELETE FROM testflight_delivery_runs WHERE run_id = 'run-1'`).run();
    expect(push.prune('2026-09-03T03:01:00.000Z')).toBe(1);
    inspected.close();
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

  it('stops notifications immediately when device access is revoked', () => {
    const path = createInitiative();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'ce'.repeat(32),
      'production',
    );
    expect(push.pending()).toHaveLength(1);
    push.invalidateDevice('iphone-1');
    expect(push.pending()).toEqual([]);
    push.close();
  });

  it('cancels a transient retry after that initiative thread has been read', async () => {
    const path = createInitiative();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-03T03:01:00.000Z');
    push.register(
      { deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' },
      'de'.repeat(32),
      'sandbox',
    );
    const pending = push.pending()[0]!;
    push.record(pending, {
      delivered: false, permanentFailure: false, status: 503, reason: 'ServiceUnavailable',
    }, '2026-09-03T03:01:00.000Z');
    expect(push.pending('2026-09-03T03:05:59.000Z')).toEqual([]);
    expect(push.pending('2026-09-03T03:06:00.000Z')).toHaveLength(1);

    const initiatives = new SQLiteInitiativeStore(path);
    expect(initiatives.markRead('owner', pending.threadId)).toBe(1);
    expect(push.pending('2026-09-03T03:06:00.000Z')).toEqual([]);
    initiatives.close();
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

  it('notifies when work stops and needs the owner, but not when the owner paused it', () => {
    const { path, taskId } = createAgentTask('started');
    const tasks = new SQLiteAgentTaskStore(path);
    tasks.recordHostEvents('mac-1', [{
      eventId: 'owner-pause', taskId, type: 'paused', title: '作業を一時停止',
      occurredAt: '2026-09-04T04:00:04.000Z', payload: { pauseReason: 'owner' },
    }, {
      eventId: 'resumed', taskId, type: 'started', title: '作業を再開', occurredAt: '2026-09-04T04:00:05.000Z',
    }, {
      eventId: 'approval', taskId, type: 'approval_requested', title: 'コマンド実行の許可',
      occurredAt: '2026-09-04T04:00:06.000Z', payload: { approval: {
        externalRequestID: 'request-1', kind: 'command', title: 'コマンド実行の許可', reason: '必要',
      } },
    }, {
      eventId: 'needs-owner', taskId, type: 'paused', title: '続きが必要です', detail: '実機確認が残っています。',
      occurredAt: '2026-09-04T04:00:07.000Z', payload: { pauseReason: 'needs_owner', currentAction: '実機で起動を確認' },
    }, {
      eventId: 'legacy-needs-owner', taskId, type: 'paused', title: '検証が残っています',
      occurredAt: '2026-09-04T04:00:08.000Z', payload: { currentAction: '全体検証を修正して再実行' },
    }], '2026-09-04T04:00:08.000Z');
    tasks.close();
    const push = new SQLitePushNotificationStore(path, () => '2026-09-04T04:01:00.000Z');
    push.register({ deviceId: 'iphone-1', scopeKey: 'owner', displayName: 'RyoのiPhone' }, 'ef'.repeat(32), 'sandbox');

    expect(push.pending().map(item => [item.initiativeId, item.title, item.content])).toEqual([
      ['agent:approval', 'シャノン · 許可待ち', '「リンク表示を直す」を続けるには、コマンド実行の許可が必要です。'],
      ['agent:needs-owner', 'シャノン · 続きが必要', 'ライ氏、「リンク表示を直す」は続きが必要です。次：実機で起動を確認'],
      ['agent:legacy-needs-owner', 'シャノン · 続きが必要', 'ライ氏、「リンク表示を直す」は続きが必要です。次：全体検証を修正して再実行'],
    ]);
    push.close();
  });

  it('delivers only the first push for one TestFlight failure episode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-testflight-push-test-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const initiatives = new SQLiteInitiativeStore(path);
    initiatives.close();
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

function createAgentTask(until: 'completed' | 'started' = 'completed'): { path: string; taskId: string } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-agent-push-test-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const tasks = new SQLiteAgentTaskStore(path);
  const created = tasks.create('owner', {
    idempotencyKey: 'push-task', conversationThreadID: 'talk-1', title: 'リンク表示を直す',
    goal: 'シャノン側のリンクをタップ可能にする', summary: '作業を開始する',
  }, '2026-09-04T04:00:00.000Z');
  tasks.heartbeat({
    hostId: 'mac-1', displayName: 'Mac', kind: 'local', capabilities: ['codex'], projects: [], models: [],
  }, '2026-09-04T04:00:01.000Z');
  tasks.claim('mac-1', '2026-09-04T04:00:02.000Z');
  tasks.recordHostEvents('mac-1', [until === 'completed' ? {
    eventId: 'completed-event', taskId: created.task.id, type: 'completed', title: '完了',
    detail: 'リンク表示を修正した。', occurredAt: '2026-09-04T04:00:03.000Z',
  } : {
    eventId: 'started-event', taskId: created.task.id, type: 'started', title: '作業を開始',
    occurredAt: '2026-09-04T04:00:03.000Z',
  }], '2026-09-04T04:00:03.000Z');
  tasks.close();
  return { path, taskId: created.task.id };
}
