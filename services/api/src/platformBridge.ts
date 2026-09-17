import { createHash } from 'node:crypto';
import {
  createShannonMessageEmotion,
  projectEmotionReaction,
  type CompanionClock,
  type CompanionStateStore,
} from '@shannon/cognition';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';

export const SHANNON_PLATFORM_TURN_PATH = '/v1/platform/turns';

const platforms = ['discord', 'line', 'minecraft', 'x', 'youtube'] as const;
export type ShannonPlatform = typeof platforms[number];

export interface PlatformBridgeBinding {
  platform: ShannonPlatform;
  conversationId: string;
  ownerUserId: string;
  title: string;
}

export interface PlatformBridgeConfiguration {
  token: string;
  scopeKey: string;
  bindings: ReadonlyMap<string, PlatformBridgeBinding>;
}

export interface PlatformTurnRequest {
  platform: ShannonPlatform;
  requestId: string;
  conversationId: string;
  sourceUserId: string;
  userMessage: string;
  shannonReply: string;
  observedAt: string;
}

export interface PlatformTurnResponse {
  duplicate: boolean;
  threadId: string;
  experienceId: string;
}

export class PlatformBridgeError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'PLATFORM_CONVERSATION_DENIED' | 'PLATFORM_ACTOR_DENIED' | 'PLATFORM_TURN_CONFLICT',
    readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformBridgeError';
  }
}

export class PlatformBridgeService {
  constructor(
    private readonly configuration: PlatformBridgeConfiguration,
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly background: TurnBackgroundService,
    private readonly now: CompanionClock,
  ) {}

  ingest(value: unknown): PlatformTurnResponse {
    const request = validatedPlatformTurn(value, this.now());
    const binding = this.configuration.bindings.get(bindingKey(request.platform, request.conversationId));
    if (!binding) {
      throw new PlatformBridgeError(
        'PLATFORM_CONVERSATION_DENIED',
        403,
        'This platform conversation is not allowlisted.',
      );
    }
    if (request.sourceUserId !== binding.ownerUserId) {
      throw new PlatformBridgeError(
        'PLATFORM_ACTOR_DENIED',
        403,
        'This external actor is not bound to the Shannon owner.',
      );
    }

    const threadId = platformBridgeThreadId(request.platform, request.conversationId);
    const capturedState = this.stateStore.snapshot(this.configuration.scopeKey);
    const messageEmotion = createShannonMessageEmotion(
      projectEmotionReaction(capturedState, request.userMessage),
      capturedState.temperament,
      { userMessage: request.userMessage, shannonReply: request.shannonReply },
    );
    const completedTurn = {
      scopeKey: this.configuration.scopeKey,
      threadId,
      capturedState,
      userMessage: request.userMessage,
      shannonReply: request.shannonReply,
      messageEmotion,
      completedAt: request.observedAt,
    };
    let persisted;
    try {
      persisted = this.conversationStore.ingestPlatformTurn({
        ...completedTurn,
        platform: request.platform,
        requestId: request.requestId,
        payloadHash: platformTurnPayloadHash(request),
        observedAt: request.observedAt,
        context: {
          threadTitle: binding.title,
          messageEmotion,
          capturedStateVersion: capturedState.version,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TURN_CONFLICT') {
        throw new PlatformBridgeError(
          'PLATFORM_TURN_CONFLICT',
          409,
          'The requestId was already used for different platform turn content.',
        );
      }
      throw error;
    }
    if (!persisted.duplicate) this.background.schedule(completedTurn, persisted.experience.id);
    return {
      duplicate: persisted.duplicate,
      threadId,
      experienceId: persisted.experience.id,
    };
  }
}

export function configuredPlatformBridge(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PlatformBridgeConfiguration | null {
  const token = environment.SHANNON_PLATFORM_BRIDGE_TOKEN?.trim() ?? '';
  const scopeKey = environment.SHANNON_PLATFORM_BRIDGE_SCOPE_KEY?.trim() ?? '';
  const rawBindings = environment.SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON?.trim() ?? '';
  if (!token && !scopeKey && !rawBindings) return null;
  if (token.length < 32) throw new Error('SHANNON_PLATFORM_BRIDGE_TOKEN must contain at least 32 characters');
  if (!boundedIdentifier(scopeKey, 160)) throw new Error('SHANNON_PLATFORM_BRIDGE_SCOPE_KEY is invalid');
  if (!rawBindings) throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON is required');

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBindings);
  } catch {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON must be valid JSON');
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 64) {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON must contain 1..64 bindings');
  }
  const bindings = new Map<string, PlatformBridgeBinding>();
  for (const candidate of decoded) {
    const binding = validatedBinding(candidate);
    const key = bindingKey(binding.platform, binding.conversationId);
    if (bindings.has(key)) throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON contains a duplicate conversation');
    bindings.set(key, Object.freeze(binding));
  }
  return Object.freeze({ token, scopeKey, bindings });
}

export function platformBridgeThreadId(platform: ShannonPlatform, conversationId: string): string {
  const digest = createHash('sha256').update(`${platform}\u0000${conversationId}`).digest('hex').slice(0, 32);
  return `platform:${platform}:${digest}`;
}

function platformTurnPayloadHash(request: PlatformTurnRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.platform,
    request.conversationId,
    request.sourceUserId,
    request.userMessage,
    request.shannonReply,
    request.observedAt,
  ])).digest('hex');
}

function validatedPlatformTurn(value: unknown, now: string): PlatformTurnRequest {
  if (!recordValue(value)) throw badRequest('JSON object body is required.');
  if (!isPlatform(value.platform)) throw badRequest('platform is invalid.');
  if (!boundedIdentifier(value.requestId, 160)) throw badRequest('requestId is invalid.');
  if (!boundedIdentifier(value.conversationId, 240)) throw badRequest('conversationId is invalid.');
  if (!boundedIdentifier(value.sourceUserId, 160)) throw badRequest('sourceUserId is invalid.');
  if (!boundedText(value.userMessage, 8_000)) throw badRequest('userMessage is invalid.');
  if (!boundedText(value.shannonReply, 12_000)) throw badRequest('shannonReply is invalid.');
  if (typeof value.observedAt !== 'string' || !validObservedAt(value.observedAt, now)) {
    throw badRequest('observedAt is invalid or outside the 30-day ingestion window.');
  }
  return {
    platform: value.platform,
    requestId: value.requestId.trim(),
    conversationId: value.conversationId.trim(),
    sourceUserId: value.sourceUserId.trim(),
    userMessage: value.userMessage.trim(),
    shannonReply: value.shannonReply.trim(),
    observedAt: new Date(value.observedAt).toISOString(),
  };
}

function validatedBinding(value: unknown): PlatformBridgeBinding {
  if (!recordValue(value) || !isPlatform(value.platform)
    || !boundedIdentifier(value.conversationId, 240)
    || !boundedIdentifier(value.ownerUserId, 160)
    || !boundedText(value.title, 80)) {
    throw new Error('SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON contains an invalid binding');
  }
  return {
    platform: value.platform,
    conversationId: value.conversationId.trim(),
    ownerUserId: value.ownerUserId.trim(),
    title: value.title.trim(),
  };
}

function validObservedAt(value: string, now: string): boolean {
  const observed = Date.parse(value);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return false;
  const maximumFutureSkew = 5 * 60 * 1_000;
  const maximumAge = 30 * 24 * 60 * 60 * 1_000;
  return observed <= current + maximumFutureSkew && observed >= current - maximumAge;
}

function bindingKey(platform: ShannonPlatform, conversationId: string): string {
  return `${platform}\u0000${conversationId}`;
}

function isPlatform(value: unknown): value is ShannonPlatform {
  return typeof value === 'string' && (platforms as readonly string[]).includes(value);
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(message: string): PlatformBridgeError {
  return new PlatformBridgeError('BAD_REQUEST', 400, message);
}
