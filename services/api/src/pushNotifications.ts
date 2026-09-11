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

interface APNsSenderOptions {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  now?: () => number;
}

export class APNsNotificationSender implements PushNotificationSender {
  readonly enabled = true;
  private readonly now: () => number;
  private readonly key: ReturnType<typeof createPrivateKey>;
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(private readonly options: APNsSenderOptions) {
    if (!/^[A-Z0-9]{10}$/u.test(options.keyId)) throw new Error('SHANNON_APNS_KEY_ID_INVALID');
    if (!/^[A-Z0-9]{10}$/u.test(options.teamId)) throw new Error('SHANNON_APNS_TEAM_ID_INVALID');
    if (!/^[A-Za-z0-9.-]{3,160}$/u.test(options.bundleId)) throw new Error('SHANNON_APNS_BUNDLE_ID_INVALID');
    this.now = options.now ?? Date.now;
    this.key = createPrivateKey(options.privateKey);
    if (this.key.asymmetricKeyType !== 'ec'
      || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('SHANNON_APNS_PRIVATE_KEY_INVALID');
    }
  }

  async send(notification: PendingPushNotification): Promise<PushDeliveryResult> {
    const origin = notification.environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';
    const body = JSON.stringify({
      aps: {
        alert: { title: notification.title ?? 'シャノン', body: notificationBody(notification.content) },
        sound: 'default',
        badge: notification.badgeCount,
        'thread-id': notification.threadId,
      },
      initiativeId: notification.initiativeId,
      threadId: notification.threadId,
      expression: notification.expression,
      kind: notification.kind,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
    });
    const response = await postHTTP2(origin, {
      ':method': 'POST',
      ':path': `/3/device/${notification.deviceToken}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.options.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(this.now() / 1_000) + 6 * 60 * 60),
      'apns-collapse-id': notification.initiativeId,
      'content-type': 'application/json',
    }, body);
    const reason = response.body ? parseReason(response.body) : null;
    const permanentFailure = response.status === 410
      || reason === 'BadDeviceToken'
      || reason === 'DeviceTokenNotForTopic'
      || reason === 'Unregistered';
    return Object.freeze({
      delivered: response.status === 200,
      permanentFailure,
      status: response.status,
      reason,
    });
  }

  private providerToken(): string {
    const now = this.now();
    if (this.cachedToken && now - this.cachedToken.issuedAt < 45 * 60_000) return this.cachedToken.value;
    const encodedHeader = base64URL(JSON.stringify({ alg: 'ES256', kid: this.options.keyId }));
    const encodedClaims = base64URL(JSON.stringify({ iss: this.options.teamId, iat: Math.floor(now / 1_000) }));
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    });
    const value = `${signingInput}.${signature.toString('base64url')}`;
    this.cachedToken = { value, issuedAt: now };
    return value;
  }
}

export class DisabledPushNotificationSender implements PushNotificationSender {
  readonly enabled = false;
  async send(_notification: PendingPushNotification): Promise<PushDeliveryResult> {
    return { delivered: false, permanentFailure: false, status: 0, reason: 'APNS_DISABLED' };
  }
}

export function createConfiguredPushNotificationSender(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PushNotificationSender {
  const keyFile = environment.SHANNON_APNS_PRIVATE_KEY_FILE?.trim();
  const keyId = environment.SHANNON_APNS_KEY_ID?.trim();
  const teamId = environment.SHANNON_APNS_TEAM_ID?.trim();
  const bundleId = environment.SHANNON_APNS_BUNDLE_ID?.trim();
  if (!keyFile && !keyId && !teamId && !bundleId) return new DisabledPushNotificationSender();
  if (!keyFile || !keyId || !teamId || !bundleId) throw new Error('SHANNON_APNS_CONFIG_INCOMPLETE');
  return new APNsNotificationSender({
    keyId,
    teamId,
    bundleId,
    privateKey: readFileSync(keyFile, 'utf8'),
  });
}

export async function deliverPendingPushNotifications(
  store: SQLitePushNotificationStore,
  sender: PushNotificationSender,
  at = new Date().toISOString(),
): Promise<{ attempted: number; delivered: number }> {
  if (!sender.enabled) return { attempted: 0, delivered: 0 };
  let attempted = 0;
  let delivered = 0;
  for (const notification of store.pending(at)) {
    if (!store.claim(notification, at)) continue;
    attempted += 1;
    try {
      const result = await sender.send(notification);
      store.record(notification, result, at);
      if (result.delivered) delivered += 1;
    } catch (error) {
      store.record(notification, {
        delivered: false,
        permanentFailure: false,
        status: 0,
        reason: safeError(error),
      }, at);
    }
  }
  return { attempted, delivered };
}

function postHTTP2(
  origin: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = connect(origin);
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      session.close();
      operation();
    };
    session.once('error', error => finish(() => reject(error)));
    const request = session.request(headers);
    let status = 0;
    let responseBody = '';
    request.setEncoding('utf8');
    request.on('response', responseHeaders => { status = Number(responseHeaders[':status'] ?? 0); });
    request.on('data', chunk => { responseBody += String(chunk).slice(0, 2_000); });
    request.once('end', () => finish(() => resolve({ status, body: responseBody })));
    request.once('error', error => finish(() => reject(error)));
    request.setTimeout(15_000, () => request.destroy(new Error('APNS_TIMEOUT')));
    request.end(body);
  });
}

function base64URL(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function parseReason(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const reason = (parsed as Record<string, unknown>).reason;
    return typeof reason === 'string' ? reason.slice(0, 160) : null;
  } catch {
    return null;
  }
}

function notificationBody(value: string): string {
  const firstParagraph = value.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  const compact = firstParagraph || '少し話したいことがあるよ。';
  return compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'APNS_UNKNOWN';
  return `${error.name}:${error.message}`.replace(/[^A-Za-z0-9_:. -]/gu, '_').slice(0, 160);
}
