import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import type {
  PendingPushNotification,
  PushDeliveryResult,
  PushNotificationSender,
  SQLitePushNotificationStore,
} from './pushNotifications.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

export interface APNsSenderOptions {
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
    const value = signAPNsProviderToken(this.key, this.options.keyId, this.options.teamId, now);
    this.cachedToken = { value, issuedAt: now };
    return value;
  }
}

/** The ES256 provider token of APNs token-based authentication. The VoIP sender (`voipPushSender.ts`) signs the same way. */
export function signAPNsProviderToken(key: ReturnType<typeof createPrivateKey>, keyId: string, teamId: string, now: number): string {
  const encodedHeader = base64URL(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const encodedClaims = base64URL(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1_000) }));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export class DisabledPushNotificationSender implements PushNotificationSender {
  readonly enabled = false;
  async send(_notification: PendingPushNotification): Promise<PushDeliveryResult> {
    return { delivered: false, permanentFailure: false, status: 0, reason: 'APNS_DISABLED' };
  }
}

export function createConfiguredPushNotificationSender(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
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

export function postHTTP2(
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

export function base64URL(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function parseReason(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const reason = (parsed as Record<string, unknown>).reason;
    return typeof reason === 'string' ? reason.slice(0, 160) : null;
  } catch {
    return null;
  }
}

export function notificationBody(value: string): string {
  const firstParagraph = value.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  const compact = firstParagraph || '少し話したいことがあります。';
  return compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`;
}

export function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'APNS_UNKNOWN';
  return `${error.name}:${error.message}`.replace(/[^A-Za-z0-9_:. -]/gu, '_').slice(0, 160);
}
