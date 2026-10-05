import { MINECRAFT_INTENT_GOAL_CHARACTERS, type MinecraftIntent } from './minecraftIntent.js';
import { validatedMinecraftBodyState, type MinecraftBodyState } from './minecraftBodyState.js';
import { composedPlatformBridgeConfiguration, type PlatformBridgeBinding, type PlatformBridgeConfiguration } from './platformBridge.js';

/**
 * Shannon's Minecraft body (Minebot), phase 1: the wire contract of a game-chat turn and the server's
 * configuration. `docs/minecraft-body-contract.md` is the prose form.
 *
 * The Minebot is a paired device like her Live2D body. Exactly one device may speak as this body, and
 * only in the owner's scope. Who the owner is in a world comes from the server's configuration (his
 * Minecraft account UUID on an online-mode server), never from a name in the chat.
 */
export const MINECRAFT_BODY_TURN_PATH = '/v1/body/minecraft/turns';
export const MINECRAFT_PLATFORM = 'minecraft' as const;

export type { MinecraftIntent } from './minecraftIntent.js';

export const MINECRAFT_BODY_LIMITS = Object.freeze({
  messageCharacters: 600,
  /** Her reply as the body receives it; the body splits it for the game's 256-character chat lines. */
  replyCharacters: 600,
  goalCharacters: MINECRAFT_INTENT_GOAL_CHARACTERS,
  requestIdCharacters: 120,
  servers: 16,
  /** Turns per minute from the one device. Every turn is a model call. */
  turnsPerMinute: 20,
  /** A stored answer is replayed for a repeated requestId for this long. */
  replayDays: 30,
});

export interface MinecraftServerBinding {
  serverId: string;
  /** The owner's Minecraft account UUID, lowercase with dashes. */
  ownerUuid: string;
  title: string;
  /**
   * Only an online-mode server proves who a player is. On an offline-mode server anyone can take any
   * name and UUID, so nobody there is the owner and nobody there is remembered.
   */
  onlineMode: boolean;
}

export interface MinecraftBodyConfiguration {
  deviceId: string;
  /** The owner's scope (`SHANNON_OWNER_SCOPE_KEY`, default `owner`). The body speaks only there. */
  ownerScopeKey: string;
  servers: ReadonlyMap<string, MinecraftServerBinding>;
}

export type MinecraftConversationKind = 'channel' | 'dm';

export interface MinecraftTurnRequest {
  /** What the body is doing now (`minecraftBodyState.ts`). Prompt only; not stored and not part of the idempotency hash. */
  body?: MinecraftBodyState;
  requestId: string;
  serverId: string;
  conversation: { kind: MinecraftConversationKind };
  speaker: { uuid: string; name: string };
  message: string;
  observedAt: string;
}

export interface MinecraftTurnResponse {
  reply: string;
  /**
   * Present on a turn of the owner only. `request`: phase 4, a task that was queued as a request to her body (the body
   * claims it like any other request, `/v1/body/minecraft/claim`); absent when no body was claiming, as before.
   */
  intent?: MinecraftIntent & { request?: { id: string } };
  threadId: string;
  duplicate: boolean;
  /** Why the turn was answered and not remembered: `offline_server`, `people_disabled`, `rate_limited`, or a platform-people reason. */
  ignored?: string;
}

export class MinecraftBodyError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'MINECRAFT_BODY_NOT_CONFIGURED' | 'MINECRAFT_BODY_DEVICE_DENIED' | 'MINECRAFT_BODY_SCOPE_DENIED'
      | 'MINECRAFT_SERVER_DENIED' | 'MINECRAFT_TURN_CONFLICT' | 'RATE_LIMITED',
    readonly status: 400 | 403 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'MinecraftBodyError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
/** A Java Edition name, and the `.` that Bedrock players carry through a proxy. */
const PLAYER_NAME = /^[.A-Za-z0-9_]{1,17}$/u;
const TURN_FIELDS = ['requestId', 'serverId', 'conversation', 'speaker', 'message', 'observedAt', 'body', 'scopeKey'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value);

/** `SHANNON_MINECRAFT_BODY_JSON`. Unset: the route answers 503 and game events are not taken. Invalid: the server does not start. */
export function configuredMinecraftBody(environment: Readonly<Record<string, string | undefined>>): MinecraftBodyConfiguration | null {
  const raw = environment.SHANNON_MINECRAFT_BODY_JSON?.trim() ?? '';
  if (!raw) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error('SHANNON_MINECRAFT_BODY_JSON must be valid JSON'); }
  if (!isRecord(decoded) || typeof decoded.deviceId !== 'string' || !DEVICE_ID.test(decoded.deviceId)) {
    throw new Error('SHANNON_MINECRAFT_BODY_JSON needs a deviceId');
  }
  if (!Array.isArray(decoded.servers) || decoded.servers.length < 1 || decoded.servers.length > MINECRAFT_BODY_LIMITS.servers) {
    throw new Error(`SHANNON_MINECRAFT_BODY_JSON must list 1..${MINECRAFT_BODY_LIMITS.servers} servers`);
  }
  const servers = new Map<string, MinecraftServerBinding>();
  for (const server of decoded.servers as unknown[]) {
    if (!isRecord(server) || typeof server.serverId !== 'string' || !SERVER_ID.test(server.serverId)
      || typeof server.ownerUuid !== 'string' || !UUID.test(server.ownerUuid.toLowerCase())
      || !boundedText(server.title, 80) || typeof server.onlineMode !== 'boolean') {
      throw new Error('SHANNON_MINECRAFT_BODY_JSON contains an invalid server');
    }
    if (servers.has(server.serverId)) throw new Error('SHANNON_MINECRAFT_BODY_JSON contains a duplicate server');
    servers.set(server.serverId, Object.freeze({
      serverId: server.serverId, ownerUuid: server.ownerUuid.toLowerCase(), title: server.title.trim(), onlineMode: server.onlineMode,
    }));
  }
  return Object.freeze({
    deviceId: decoded.deviceId,
    ownerScopeKey: environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner',
    servers,
  });
}

/** A turn as the body sent it, or why it is refused. Unknown fields refuse it: nothing else is read from the body. */
export function validatedMinecraftTurn(value: unknown): MinecraftTurnRequest | string {
  if (!isRecord(value)) return 'JSON object body is required';
  const unknown = Object.keys(value).find(key => !TURN_FIELDS.includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (typeof value.requestId !== 'string' || value.requestId.length > MINECRAFT_BODY_LIMITS.requestIdCharacters || !REQUEST_ID.test(value.requestId)) {
    return 'requestId is invalid';
  }
  if (typeof value.serverId !== 'string' || !SERVER_ID.test(value.serverId)) return 'serverId is invalid';
  if (!isRecord(value.conversation) || Object.keys(value.conversation).some(key => key !== 'kind')
    || (value.conversation.kind !== 'channel' && value.conversation.kind !== 'dm')) return 'conversation.kind must be channel or dm';
  if (!isRecord(value.speaker) || Object.keys(value.speaker).some(key => key !== 'uuid' && key !== 'name')) return 'speaker must be { uuid, name }';
  if (typeof value.speaker.uuid !== 'string' || !UUID.test(value.speaker.uuid.toLowerCase())) return 'speaker.uuid is invalid';
  if (typeof value.speaker.name !== 'string' || !PLAYER_NAME.test(value.speaker.name)) return 'speaker.name is invalid';
  if (!boundedText(value.message, MINECRAFT_BODY_LIMITS.messageCharacters)) return `message must be 1..${MINECRAFT_BODY_LIMITS.messageCharacters} characters of text`;
  const observed = typeof value.observedAt === 'string' && value.observedAt.length <= 40 ? Date.parse(value.observedAt) : Number.NaN;
  if (!Number.isFinite(observed)) return 'observedAt must be an ISO 8601 timestamp';
  const body = value.body === undefined ? undefined : validatedMinecraftBodyState(value.body);
  if (typeof body === 'string') return body;
  return {
    requestId: value.requestId,
    serverId: value.serverId,
    conversation: { kind: value.conversation.kind },
    speaker: { uuid: value.speaker.uuid.toLowerCase(), name: value.speaker.name },
    message: value.message.trim(),
    observedAt: new Date(observed).toISOString(),
    ...(body ? { body } : {}),
  };
}

/** The platform conversation of a turn: the server's chat as a whole, or a whisper with one player. */
export function minecraftConversationId(serverId: string, kind: MinecraftConversationKind, speakerUuid: string): string {
  return kind === 'channel' ? `minecraft:${serverId}` : `minecraft:${serverId}:dm:${speakerUuid}`;
}

export const minecraftSourceUserId = (uuid: string) => `mc:${uuid}`;

/**
 * The platform-bridge bindings of the online-mode servers: the chat is shared with everyone on it; a whisper
 * with the owner is the owner's alone; a whisper with anyone else is that conversation. Offline-mode servers
 * have no binding, so nothing of theirs can reach the bridge. The caller is the paired device, never the
 * bridge's service token, so the configuration has no token.
 */
export function minecraftBridgeConfiguration(configuration: MinecraftBodyConfiguration): PlatformBridgeConfiguration {
  const bindings: PlatformBridgeBinding[] = [...configuration.servers.values()].filter(server => server.onlineMode).flatMap(server => {
    const ownerUserId = minecraftSourceUserId(server.ownerUuid);
    return [
      { platform: MINECRAFT_PLATFORM, conversationId: minecraftConversationId(server.serverId, 'channel', ''), ownerUserId, title: server.title, audience: 'shared' as const },
      { platform: MINECRAFT_PLATFORM, conversationId: minecraftConversationId(server.serverId, 'dm', server.ownerUuid), ownerUserId, title: server.title, audience: 'owner-private' as const },
      { platform: MINECRAFT_PLATFORM, conversationIdPrefix: `minecraft:${server.serverId}:dm:`, ownerUserId, title: server.title },
    ];
  });
  return composedPlatformBridgeConfiguration('', configuration.ownerScopeKey, bindings, 'SHANNON_MINECRAFT_BODY_JSON', { exactInsidePrefix: true });
}
