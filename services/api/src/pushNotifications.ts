import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import { DatabaseSync } from 'node:sqlite';
import type { ShannonDevicePrincipal } from './deviceAuth.js';

export type APNsEnvironment = 'sandbox' | 'production';

export interface PendingPushNotification {
  kind: 'initiative' | 'agent_task' | 'testflight_failure';
  initiativeId: string;
  deviceId: string;
  deviceToken: string;
  environment: APNsEnvironment;
  threadId: string;
  content: string;
  expression: string;
  createdAt: string;
  badgeCount: number;
  taskId?: string;
  title?: string;
}

export interface PushDeliveryResult {
  delivered: boolean;
  permanentFailure: boolean;
  status: number;
  reason: string | null;
}

export interface PushNotificationSender {
  readonly enabled: boolean;
  send(notification: PendingPushNotification): Promise<PushDeliveryResult>;
}

const DEVICE_TOKEN_PATTERN = /^[a-f0-9]{64,200}$/iu;
const MAXIMUM_PUSH_AGE_MILLISECONDS = 12 * 60 * 60_000;
const MAXIMUM_ATTEMPTS = 3;
const DELIVERY_LEASE_MILLISECONDS = 5 * 60_000;
const DELIVERY_STATE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;

export class SQLitePushNotificationStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS push_registrations (
        device_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        device_token TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
        updated_at TEXT NOT NULL,
        invalidated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS push_registrations_scope
        ON push_registrations (scope_key, invalidated_at);

      CREATE TABLE IF NOT EXISTS push_delivery_state (
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_status INTEGER,
        last_error TEXT,
        leased_until TEXT,
        PRIMARY KEY (initiative_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS push_delivery_state_retry
        ON push_delivery_state (delivered_at, next_attempt_at, attempts);
    `);
    this.ensureDeliveryLeaseColumn();
    this.secureFiles();
  }

  register(
    principal: ShannonDevicePrincipal,
    deviceToken: string,
    environment: APNsEnvironment,
    at = this.now(),
  ): void {
    const normalized = deviceToken.trim().toLowerCase();
    if (!DEVICE_TOKEN_PATTERN.test(normalized)) throw new Error('PUSH_DEVICE_TOKEN_INVALID');
    if (environment !== 'sandbox' && environment !== 'production') throw new Error('PUSH_ENVIRONMENT_INVALID');
    this.database.prepare(`
      INSERT INTO push_registrations
        (device_id, scope_key, device_token, environment, updated_at, invalidated_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(device_id) DO UPDATE SET
        scope_key = excluded.scope_key,
        device_token = excluded.device_token,
        environment = excluded.environment,
        updated_at = excluded.updated_at,
        invalidated_at = NULL
    `).run(principal.deviceId, principal.scopeKey, normalized, environment, at);
    this.secureFiles();
  }

  invalidateDevice(deviceId: string, at = this.now()): void {
    this.database.prepare(`
      UPDATE push_registrations SET invalidated_at = ?
      WHERE device_id = ? AND invalidated_at IS NULL
    `).run(at, deviceId);
    this.secureFiles();
  }

  pending(at = this.now(), limit = 20): readonly PendingPushNotification[] {
    const cutoff = new Date(Date.parse(at) - MAXIMUM_PUSH_AGE_MILLISECONDS).toISOString();
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const initiativeRows = !this.tableExists('initiative_messages') ? [] : this.database.prepare(`
      SELECT
        im.initiative_id, im.thread_id, im.content, im.expression, im.created_at,
        pr.device_id, pr.device_token, pr.environment,
        (SELECT COUNT(*) FROM initiative_messages unread
          WHERE unread.scope_key = im.scope_key AND unread.read_at IS NULL) AS badge_count
      FROM initiative_messages im
      JOIN push_registrations pr
        ON pr.scope_key = im.scope_key AND pr.invalidated_at IS NULL
      LEFT JOIN push_delivery_state delivery
        ON delivery.initiative_id = im.initiative_id AND delivery.device_id = pr.device_id
      WHERE im.read_at IS NULL
        AND im.created_at >= ?
        AND (delivery.initiative_id IS NULL OR (
          delivery.delivered_at IS NULL
          AND delivery.attempts < ?
          AND delivery.next_attempt_at <= ?
          AND (delivery.leased_until IS NULL OR delivery.leased_until <= ?)
        ))
      ORDER BY im.created_at ASC
      LIMIT ?
    `).all(cutoff, MAXIMUM_ATTEMPTS, at, at, boundedLimit) as unknown as Array<Record<string, unknown>>;
    const initiatives: PendingPushNotification[] = initiativeRows.map(row => ({
      kind: 'initiative',
      initiativeId: String(row.initiative_id),
      deviceId: String(row.device_id),
      deviceToken: String(row.device_token),
      environment: String(row.environment) as APNsEnvironment,
      threadId: String(row.thread_id),
      content: String(row.content),
      expression: String(row.expression),
      createdAt: String(row.created_at),
      badgeCount: Math.max(1, Math.min(99, Number(row.badge_count))),
    }));

    const initiativeBadgeExpression = this.tableExists('initiative_messages')
      ? `(SELECT COUNT(*) FROM initiative_messages unread
            WHERE unread.scope_key = t.scope_key AND unread.read_at IS NULL)`
      : '0';
    const agentRows = !this.tableExists('agent_task_events') || !this.tableExists('agent_tasks')
      ? []
      : this.database.prepare(`
        SELECT
          e.event_id, e.event_type, e.detail, e.occurred_at,
          t.task_id, t.conversation_thread_id AS thread_id, t.title, t.scope_key,
          pr.device_id, pr.device_token, pr.environment,
          ${initiativeBadgeExpression} AS initiative_badge_count
        FROM agent_task_events e
        JOIN agent_tasks t ON t.task_id = e.task_id
        JOIN push_registrations pr
          ON pr.scope_key = t.scope_key AND pr.invalidated_at IS NULL
        LEFT JOIN push_delivery_state delivery
          ON delivery.initiative_id = ('agent:' || e.event_id) AND delivery.device_id = pr.device_id
        WHERE e.event_type IN ('host.approval_requested','host.completed','host.failed')
          AND e.occurred_at >= ?
          AND (delivery.initiative_id IS NULL OR (
            delivery.delivered_at IS NULL
            AND delivery.attempts < ?
            AND delivery.next_attempt_at <= ?
            AND (delivery.leased_until IS NULL OR delivery.leased_until <= ?)
          ))
        ORDER BY e.occurred_at ASC
        LIMIT ?
      `).all(cutoff, MAXIMUM_ATTEMPTS, at, at, boundedLimit) as unknown as Array<Record<string, unknown>>;
    const agentTasks: PendingPushNotification[] = agentRows.map(row => {
      const eventType = String(row.event_type);
      const taskTitle = String(row.title);
      const detail = typeof row.detail === 'string' ? row.detail : '';
      const content = eventType === 'host.approval_requested'
        ? `「${taskTitle}」を続けるため、確認が必要です。`
        : eventType === 'host.completed'
          ? (detail || `「${taskTitle}」が完了しました。`)
          : (detail || `「${taskTitle}」を完了できませんでした。`);
      return {
        kind: 'agent_task',
        initiativeId: `agent:${String(row.event_id)}`,
        taskId: String(row.task_id),
        title: eventType === 'host.approval_requested' ? 'シャノン · 確認待ち' : 'シャノン · 作業',
        deviceId: String(row.device_id),
        deviceToken: String(row.device_token),
        environment: String(row.environment) as APNsEnvironment,
        threadId: String(row.thread_id),
        content,
        expression: eventType === 'host.completed' ? 'joyful' : eventType === 'host.failed' ? 'wry' : 'concerned',
        createdAt: String(row.occurred_at),
        badgeCount: Math.max(1, Math.min(99, Number(row.initiative_badge_count) + 1)),
      };
    });
    const testFlightBadgeExpression = this.tableExists('initiative_messages')
      ? `(SELECT COUNT(*) FROM initiative_messages unread
            WHERE unread.scope_key = pr.scope_key AND unread.read_at IS NULL)`
      : '0';
    const testFlightRows = !this.tableExists('testflight_failure_episodes')
      ? []
      : this.database.prepare(`
        SELECT
          e.episode_id, e.opened_at,
          pr.device_id, pr.device_token, pr.environment,
          ${testFlightBadgeExpression} AS initiative_badge_count
        FROM testflight_failure_episodes e
        JOIN push_registrations pr ON pr.invalidated_at IS NULL
        LEFT JOIN push_delivery_state delivery
          ON delivery.initiative_id = ('testflight:' || e.episode_id) AND delivery.device_id = pr.device_id
        WHERE e.closed_at IS NULL
          AND e.opened_at >= ?
          AND (delivery.initiative_id IS NULL OR (
            delivery.delivered_at IS NULL
            AND delivery.attempts < ?
            AND delivery.next_attempt_at <= ?
            AND (delivery.leased_until IS NULL OR delivery.leased_until <= ?)
          ))
        ORDER BY e.opened_at ASC
        LIMIT ?
      `).all(cutoff, MAXIMUM_ATTEMPTS, at, at, boundedLimit) as unknown as Array<Record<string, unknown>>;
    const testFlightFailures: PendingPushNotification[] = testFlightRows.map(row => ({
      kind: 'testflight_failure',
      initiativeId: `testflight:${String(row.episode_id)}`,
      title: 'シャノン · アプリの更新',
      deviceId: String(row.device_id),
      deviceToken: String(row.device_token),
      environment: String(row.environment) as APNsEnvironment,
      threadId: 'testflight-delivery',
      content: '新しいビルドの配信で少しつまずいてる。設定から確認できるよ。',
      expression: 'concerned',
      createdAt: String(row.opened_at),
      badgeCount: Math.max(1, Math.min(99, Number(row.initiative_badge_count) + 1)),
    }));
    return Object.freeze([...initiatives, ...agentTasks, ...testFlightFailures]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, boundedLimit)
      .map(notification => Object.freeze(notification)));
  }

  claim(notification: PendingPushNotification, at = this.now()): boolean {
    const leasedUntil = new Date(Date.parse(at) + DELIVERY_LEASE_MILLISECONDS).toISOString();
    const result = this.database.prepare(`
      INSERT INTO push_delivery_state
        (initiative_id, device_id, attempts, next_attempt_at, delivered_at, last_status, last_error, leased_until)
      VALUES (?, ?, 0, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(initiative_id, device_id) DO UPDATE SET
        leased_until = excluded.leased_until
      WHERE push_delivery_state.delivered_at IS NULL
        AND push_delivery_state.attempts < ?
        AND push_delivery_state.next_attempt_at <= ?
        AND (push_delivery_state.leased_until IS NULL OR push_delivery_state.leased_until <= ?)
    `).run(
      notification.initiativeId,
      notification.deviceId,
      at,
      leasedUntil,
      MAXIMUM_ATTEMPTS,
      at,
      at,
    );
    this.secureFiles();
    return Number(result.changes) === 1;
  }

  record(notification: PendingPushNotification, result: PushDeliveryResult, at = this.now()): void {
    const existing = this.database.prepare(`
      SELECT attempts FROM push_delivery_state WHERE initiative_id = ? AND device_id = ?
    `).get(notification.initiativeId, notification.deviceId) as unknown as { attempts: number } | undefined;
    const attempts = Number(existing?.attempts ?? 0) + 1;
    const retryDelay = attempts === 1 ? 5 * 60_000 : attempts === 2 ? 30 * 60_000 : 2 * 60 * 60_000;
    const nextAttemptAt = new Date(Date.parse(at) + retryDelay).toISOString();
    this.database.prepare(`
      INSERT INTO push_delivery_state
        (initiative_id, device_id, attempts, next_attempt_at, delivered_at, last_status, last_error, leased_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(initiative_id, device_id) DO UPDATE SET
        attempts = excluded.attempts,
        next_attempt_at = excluded.next_attempt_at,
        delivered_at = excluded.delivered_at,
        last_status = excluded.last_status,
        last_error = excluded.last_error,
        leased_until = NULL
    `).run(
      notification.initiativeId,
      notification.deviceId,
      attempts,
      nextAttemptAt,
      result.delivered ? at : null,
      result.status,
      result.reason?.slice(0, 160) ?? null,
    );
    if (result.permanentFailure) {
      this.database.prepare(`
        UPDATE push_registrations SET invalidated_at = ? WHERE device_id = ?
      `).run(at, notification.deviceId);
    }
    this.secureFiles();
  }

  prune(at = this.now()): number {
    const cutoff = new Date(Date.parse(at) - DELIVERY_STATE_RETENTION_MILLISECONDS).toISOString();
    const retainedTestFlightState = this.tableExists('testflight_delivery_runs')
      ? `AND NOT (
          initiative_id LIKE 'testflight:%'
          AND EXISTS (
            SELECT 1 FROM testflight_delivery_runs run
            WHERE run.notification_key = push_delivery_state.initiative_id
          )
        )`
      : '';
    const result = this.database.prepare(`
      DELETE FROM push_delivery_state
      WHERE COALESCE(delivered_at, next_attempt_at) < ?
        AND (leased_until IS NULL OR leased_until <= ?)
        ${retainedTestFlightState}
    `).run(cutoff, at);
    this.secureFiles();
    return Number(result.changes);
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }

  private ensureDeliveryLeaseColumn(): void {
    const columns = this.database.prepare(`PRAGMA table_info(push_delivery_state)`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'leased_until')) {
      this.database.exec(`ALTER TABLE push_delivery_state ADD COLUMN leased_until TEXT;`);
    }
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}

export {
  APNsNotificationSender,
  DisabledPushNotificationSender,
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
} from './pushNotificationSender.js';
