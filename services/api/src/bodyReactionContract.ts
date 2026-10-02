import { createHash } from 'node:crypto';
import type { ShannonExpression, ShannonFeeling, ShannonTouchKind } from '@shannon/cognition';
import { BODY_LIMITS, BODY_TOUCH_EVENT_TYPES, type BodyAudience } from './bodyContract.js';

/**
 * When she is touched (`docs/body-contract.md`): the wire contract of `POST /v1/body/reactions`
 * and the bounds of everything that follows from a touch. The request is a closed vocabulary
 * and numbers, like a body event: there is no text field, so nothing in it can be an instruction.
 */
export const BODY_REACTION_PATH = '/v1/body/reactions';
/** The activity record's tool name for a line she said because she was touched. */
export const BODY_REACTION_TOOL = 'body.reaction';
/** The source label of a touch memory in `experience_events`. */
export const BODY_TOUCH_SOURCE = 'body.touch';

export const BODY_REACTION_LIMITS = Object.freeze({
  /** One sentence, at most this many characters. */
  textCharacters: 60,
  listenSecondsDefault: 6,
  listenSecondsMaximum: 30,
  /** The answer is given by this time whatever the model does. The body waits 4.5 seconds. */
  deadlineMillisecondsDefault: 3_800,
  deadlineMillisecondsMaximum: 4_000,
  /** The first voice turn that carries `reactionId` must arrive within `listenSeconds` plus this (he may speak for a while). */
  linkMarginMilliseconds: 60_000,
  /** Once a voice turn linked the line, its stored turn must follow within this. */
  linkedMilliseconds: 10 * 60_000,
  /** A stored answer is returned for the same `id` this long. */
  answerRetentionMilliseconds: 24 * 60 * 60_000,
  /** A request about a touch older than this, or stamped further ahead than the events' skew, is felt and remembered but not answered in words. */
  requestMaximumAgeMilliseconds: 2 * 60_000,
  /** A technical limit per scope, not a count of how often she may be touched: the body asks at most once in about 45 seconds. */
  requestsPerMinute: 12,
  /** Touches of one kind belong to one memory while each follows the last within the gap, for at most the span. */
  burstGapMilliseconds: 5 * 60_000,
  burstSpanMilliseconds: 30 * 60_000,
  /** A touch reported later than this after it happened is remembered and moves no feeling. */
  feelingFreshMilliseconds: 10 * 60_000,
  /** What the reaction prompt is told of this sitting. */
  sittingMilliseconds: 30 * 60_000,
  sittingKinds: 4,
  saidLines: 3,
  /** Lines she said that one touch memory keeps. */
  memorySaidLines: 5,
  /** The current conversation, only while one is in progress and only with the owner alone. */
  conversationFreshMilliseconds: 10 * 60_000,
  contextMessages: 3,
  contextCharacters: 120,
  touchRetentionDays: BODY_LIMITS.retentionDays,
});

export interface BodyReactionTouch {
  type: ShannonTouchKind;
  durationMs: number;
  strength?: number;
  /** True while the touch is still going on (the body asks about 1.5 seconds into it). */
  ongoing: boolean;
}

export interface BodyReactionRequest {
  /** The body's idempotency key. The finished touch is later reported through `POST /v1/body/events` with the same id. */
  id: string;
  touch: BodyReactionTouch;
  audience: BodyAudience;
  /** Canonical ISO 8601 (UTC). */
  occurredAt: string;
}

export interface BodyReactionMessage {
  id: string;
  text: string;
  expression: ShannonExpression;
  feeling?: ShannonFeeling;
  /** The Talk a spoken answer would continue; null when she has no Talk yet. */
  threadId: string | null;
  /** How long the body keeps its microphone open for his answer. */
  listenSeconds: number;
}

export interface BodyReactionAnswer {
  schemaVersion: 1;
  id: string;
  status: 'said' | 'quiet';
  message: BodyReactionMessage | null;
  /** Her face after the touch (and after her line, when she said one). */
  mood: { expression: ShannonExpression; feeling?: ShannonFeeling };
}

export interface BodyReactionConfig {
  /** `SHANNON_BODY_REACTIONS`; unset means on. Off, a touch produces no word, no feeling and no memory. */
  enabled: boolean;
  listenSeconds: number;
  deadlineMilliseconds: number;
  /** `SHANNON_OWNER_SCOPE_KEY` when configured: only that scope's body may ask. Absent, any scope (local runs, tests). */
  ownerScopeKey?: string;
}

const REACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).find(key => !allowed.includes(key));

/** A reaction id as the body sends it on a request and later on its first voice turn. */
export function validBodyReactionId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= BODY_LIMITS.eventIdCharacters && REACTION_ID.test(value);
}

/** The request, or the reason it is refused. No field outside the vocabulary is accepted, and none carries text. */
export function validatedBodyReactionRequest(body: Record<string, unknown>): BodyReactionRequest | string {
  const unknown = only(body, ['scopeKey', 'id', 'touch', 'audience', 'occurredAt']);
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (!validBodyReactionId(body.id)) return 'id is invalid';
  if (!isRecord(body.touch)) return 'touch must be an object';
  const touch = body.touch;
  const unknownTouch = only(touch, ['type', 'durationMs', 'strength', 'ongoing']);
  if (unknownTouch) return `touch.${unknownTouch.slice(0, 40)} is not allowed`;
  const type = BODY_TOUCH_EVENT_TYPES.find(value => value === touch.type);
  if (!type) return `touch.type must be one of ${BODY_TOUCH_EVENT_TYPES.join(', ')}`;
  if (typeof touch.durationMs !== 'number' || !Number.isInteger(touch.durationMs) || touch.durationMs < 0 || touch.durationMs > BODY_LIMITS.durationMs) {
    return 'touch.durationMs is invalid';
  }
  if (touch.strength !== undefined && !(typeof touch.strength === 'number' && touch.strength >= 0 && touch.strength <= 1)) return 'touch.strength must be 0..1';
  if (typeof touch.ongoing !== 'boolean') return 'touch.ongoing must be a boolean';
  if (body.audience !== 'owner' && body.audience !== 'others') return 'audience must be owner or others';
  const time = typeof body.occurredAt === 'string' && body.occurredAt.length <= 40 ? Date.parse(body.occurredAt) : Number.NaN;
  if (!Number.isFinite(time)) return 'occurredAt must be an ISO 8601 timestamp';
  return {
    id: body.id, audience: body.audience, occurredAt: new Date(time).toISOString(),
    touch: { type, durationMs: touch.durationMs, ongoing: touch.ongoing, ...(touch.strength !== undefined ? { strength: Math.round(touch.strength * 100) / 100 } : {}) },
  };
}

/** The same id with other content is a bug in the sender and is answered `409`. */
export function bodyReactionContentHash(request: BodyReactionRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.touch.type, request.touch.durationMs, request.touch.strength ?? null, request.touch.ongoing, request.audience, request.occurredAt,
  ])).digest('hex').slice(0, 32);
}

const OFF = ['off', 'false', '0', 'disabled'];
const boundedInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

/** Stopping reactions needs only `SHANNON_BODY_REACTIONS=off` and a restart, not a deployment. */
export function configuredBodyReactions(environment: Readonly<Record<string, string | undefined>> = process.env): BodyReactionConfig {
  const ownerScopeKey = environment.SHANNON_OWNER_SCOPE_KEY?.trim();
  return {
    enabled: !OFF.includes(environment.SHANNON_BODY_REACTIONS?.trim().toLowerCase() ?? ''),
    listenSeconds: boundedInteger(environment.SHANNON_BODY_REACTION_LISTEN_SECONDS, BODY_REACTION_LIMITS.listenSecondsDefault, 0, BODY_REACTION_LIMITS.listenSecondsMaximum),
    deadlineMilliseconds: boundedInteger(environment.SHANNON_BODY_REACTION_DEADLINE_MS, BODY_REACTION_LIMITS.deadlineMillisecondsDefault, 200, BODY_REACTION_LIMITS.deadlineMillisecondsMaximum),
    ...(ownerScopeKey ? { ownerScopeKey } : {}),
  };
}
