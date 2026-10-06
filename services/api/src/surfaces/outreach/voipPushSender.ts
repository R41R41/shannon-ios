import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { incomingCallPushBody, type IncomingCallPayload, type VoipEnvironment } from '../../contracts/incomingCallContract.js';
import { parseReason, postHTTP2, signAPNsProviderToken } from './pushNotificationSender.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * Sends the one VoIP push that rings the owner's iPhone (`incomingCallContract.ts`).
 *
 * APNs token-based authentication, with the same key as the ordinary notifications: an ES256 provider
 * token signed with the team's `.p8` key. The key is read from the file an environment variable names, held in
 * memory only, and never logged; so is the device token. The body is built by `incomingCallPushBody`: identifiers
 * and a time, never her words.
 */
export interface VoipPushTarget { deviceToken: string; environment: VoipEnvironment; bundleId: string }

export interface VoipPushResult {
  delivered: boolean;
  /** APNs says the token is gone or not this app's: it is dropped. */
  invalidToken: boolean;
  status: number;
  reason: string | null;
}

export interface VoipPushSender {
  /** False without credentials: nothing can be rung, and the app's settings say so. */
  readonly enabled: boolean;
  send(target: VoipPushTarget, payload: IncomingCallPayload): Promise<VoipPushResult>;
}

/** One HTTP/2 POST to APNs. Tests hand in a fake; nothing in them reaches the network. */
export type APNsTransport = (origin: string, headers: Readonly<Record<string, string>>, body: string) => Promise<{ status: number; body: string }>;

export interface APNsVoipSenderOptions {
  keyId: string;
  teamId: string;
  privateKey: string;
  transport?: APNsTransport;
  now?: () => number;
}

const INVALID_TOKEN_REASONS = ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'];

export class APNsVoipPushSender implements VoipPushSender {
  readonly enabled = true;
  private readonly now: () => number;
  private readonly transport: APNsTransport;
  private readonly key: ReturnType<typeof createPrivateKey>;
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(private readonly options: APNsVoipSenderOptions) {
    if (!/^[A-Z0-9]{10}$/u.test(options.keyId)) throw new Error('SHANNON_APNS_KEY_ID_INVALID');
    if (!/^[A-Z0-9]{10}$/u.test(options.teamId)) throw new Error('SHANNON_APNS_TEAM_ID_INVALID');
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? postHTTP2;
    this.key = createPrivateKey(options.privateKey);
    if (this.key.asymmetricKeyType !== 'ec' || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('SHANNON_APNS_PRIVATE_KEY_INVALID');
    }
  }

  async send(target: VoipPushTarget, payload: IncomingCallPayload): Promise<VoipPushResult> {
    const origin = target.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const response = await this.transport(origin, {
      ':method': 'POST',
      ':path': `/3/device/${target.deviceToken}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': `${target.bundleId}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      // A ring that could not be delivered while it would still ring is not delivered later.
      'apns-expiration': String(Math.max(Math.floor(this.now() / 1_000) + 1, Math.floor(Date.parse(payload.expiresAt) / 1_000))),
      'content-type': 'application/json',
    }, incomingCallPushBody(payload));
    const reason = response.body ? parseReason(response.body) : null;
    return Object.freeze({
      delivered: response.status === 200,
      invalidToken: response.status === 410 || (reason !== null && INVALID_TOKEN_REASONS.includes(reason)),
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

export class DisabledVoipPushSender implements VoipPushSender {
  readonly enabled = false;
  async send(): Promise<VoipPushResult> {
    return { delivered: false, invalidToken: false, status: 0, reason: 'APNS_DISABLED' };
  }
}

/**
 * The sender the environment allows: `SHANNON_APNS_KEY_ID`, `SHANNON_APNS_TEAM_ID` and the key file
 * `SHANNON_APNS_PRIVATE_KEY_FILE`, the same three the ordinary notifications use. Without all of them, or with
 * a key that cannot be read, nothing can be rung: the API keeps running and the settings say the server is not
 * ready. What went wrong is logged as a code, never a value.
 */
export function createConfiguredVoipPushSender(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  options: { transport?: APNsTransport; warn?: (code: string) => void } = {},
): VoipPushSender {
  const keyFile = environment.SHANNON_APNS_PRIVATE_KEY_FILE?.trim();
  const keyId = environment.SHANNON_APNS_KEY_ID?.trim();
  const teamId = environment.SHANNON_APNS_TEAM_ID?.trim();
  if (!keyFile || !keyId || !teamId) return new DisabledVoipPushSender();
  try {
    return new APNsVoipPushSender({ keyId, teamId, privateKey: readFileSync(keyFile, 'utf8'), ...(options.transport ? { transport: options.transport } : {}) });
  } catch (error) {
    // The message of a key that could not be parsed may quote it: only a code of our own is passed on.
    const code = error instanceof Error && /^SHANNON_APNS_[A-Z_]+$/u.test(error.message) ? error.message
      : (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'SHANNON_APNS_PRIVATE_KEY_FILE_MISSING' : 'SHANNON_APNS_PRIVATE_KEY_UNREADABLE';
    (options.warn ?? (value => console.warn(`Shannon incoming calls are unavailable: ${value}`)))(code);
    return new DisabledVoipPushSender();
  }
}
