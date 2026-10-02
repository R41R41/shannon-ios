import type { ShannonEmotionKind, ShannonExpression, ShannonFeeling } from '@shannon/cognition';

/**
 * The wire contract between Shannon's mind (this server) and her body (the Live2D
 * desktop application on the owner's PC). `docs/body-contract.md` is the prose form.
 *
 * Everything the body sends is a closed vocabulary plus numbers and identifiers.
 * There is no free-text field, so nothing the body sends can become an instruction.
 */
export const BODY_SCHEMA_VERSION = 1;

export const BODY_TOUCH_EVENT_TYPES = ['pet', 'tickle', 'poke', 'carry', 'holdHand'] as const;
export const BODY_PRESENCE_EVENT_TYPES = ['ownerAway', 'ownerReturned'] as const;
export const BODY_PLAIN_EVENT_TYPES = ['callStarted', 'callEnded', 'windowHidden', 'windowShown', 'appStarted'] as const;
export const BODY_EVENT_TYPES = [...BODY_TOUCH_EVENT_TYPES, ...BODY_PRESENCE_EVENT_TYPES, ...BODY_PLAIN_EVENT_TYPES] as const;

export type BodyEventType = typeof BODY_EVENT_TYPES[number];
export type BodyAudience = 'owner' | 'others';

/** What Shannon is doing right now, as the body may show it. */
export const BODY_DOING = ['idle', 'thinking', 'reading', 'noting', 'drafting', 'revising', 'showing'] as const;
export type BodyDoing = typeof BODY_DOING[number];

export const BODY_NUDGE_SCENES = ['ownerReturned', 'longQuiet', 'morning', 'lateNight', 'awaitingReaction'] as const;
export type BodyNudgeScene = typeof BODY_NUDGE_SCENES[number];

export const BODY_LIMITS = Object.freeze({
  eventsPerBatch: 50,
  eventIdCharacters: 80,
  durationMs: 10 * 60_000,
  minutesAway: 7 * 24 * 60,
  /** An event older than this is acknowledged and not stored. */
  eventMaximumAgeMilliseconds: 24 * 60 * 60_000,
  /** Clock skew allowed for an event stamped in the future. */
  eventFutureSkewMilliseconds: 5 * 60_000,
  /** Stored events per scope and owner-local day. */
  eventsPerDay: 2_000,
  retentionDays: 30,
  /** How long an owner event stays available to an owner conversation turn, and how much of it. */
  contextWindowMilliseconds: 30 * 60_000,
  contextEvents: 3,
  expressions: 64,
  gestures: 32,
  flags: 16,
  capabilityIdCharacters: 40,
  presencePollSeconds: 10,
  /** `audience` on a presence read says who can see or hear the body for this long; it is stored at most this often. */
  audienceFreshMilliseconds: 90_000,
  audienceWriteMilliseconds: 30_000,
  /** Without such a report, the audience of the newest event this recent stands in. */
  audienceEventWindowMilliseconds: 30 * 60_000,
  nudgeLifetimeMilliseconds: 30 * 60_000,
  /** Limits the body must respect when it shows a nudge. */
  nudgeQuietAfterConversationMinutes: 15,
  nudgeMaximumPerHour: 2,
  nudgeMaximumPerDay: 10,
});

export interface BodyEvent {
  id: string;
  type: BodyEventType;
  audience: BodyAudience;
  /** Canonical ISO 8601 (UTC). */
  occurredAt: string;
  durationMs?: number;
  strength?: number;
  minutesAway?: number;
}

export interface BodyCapabilities {
  expressions: readonly string[];
  gestures: readonly string[];
  flags: Readonly<Record<string, boolean>>;
}

export interface BodyNudge {
  id: string;
  scene: BodyNudgeScene;
  /** `owner`: only while nobody else can see or hear the body. */
  audience: 'owner' | 'any';
  text: string;
  expression: ShannonExpression;
  feeling?: ShannonFeeling;
  voice: { affect: ShannonEmotionKind; intensity: number; delivery: 'conversational' | 'quick' | 'gentle' | 'focused' | 'energetic' };
  expiresAt: string;
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const COMMON_EVENT_FIELDS = ['id', 'type', 'audience', 'occurredAt'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const includes = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const integerWithin = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;

function allowedEventFields(type: BodyEventType): readonly string[] {
  if (includes(BODY_TOUCH_EVENT_TYPES, type)) return [...COMMON_EVENT_FIELDS, 'durationMs', 'strength'];
  if (includes(BODY_PRESENCE_EVENT_TYPES, type)) return [...COMMON_EVENT_FIELDS, 'minutesAway'];
  return COMMON_EVENT_FIELDS;
}

/** The events of one request, or the reason the request is refused. A refused request stores nothing. */
export function validatedBodyEvents(value: unknown): readonly BodyEvent[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > BODY_LIMITS.eventsPerBatch) {
    return `events must contain 1..${BODY_LIMITS.eventsPerBatch} items`;
  }
  const events: BodyEvent[] = [];
  for (const [index, item] of value.entries()) {
    const at = `events[${index}]`;
    if (!isRecord(item)) return `${at} must be an object`;
    if (!includes(BODY_EVENT_TYPES, item.type)) return `${at}.type is invalid`;
    const allowed = allowedEventFields(item.type);
    const unknown = Object.keys(item).find(key => !allowed.includes(key));
    if (unknown) return `${at}.${unknown.slice(0, 40)} is not allowed for ${item.type}`;
    if (typeof item.id !== 'string' || item.id.length > BODY_LIMITS.eventIdCharacters || !EVENT_ID.test(item.id)) return `${at}.id is invalid`;
    if (item.audience !== 'owner' && item.audience !== 'others') return `${at}.audience must be owner or others`;
    const time = typeof item.occurredAt === 'string' && item.occurredAt.length <= 40 ? Date.parse(item.occurredAt) : Number.NaN;
    if (!Number.isFinite(time)) return `${at}.occurredAt must be an ISO 8601 timestamp`;
    if (item.durationMs !== undefined && !integerWithin(item.durationMs, BODY_LIMITS.durationMs)) return `${at}.durationMs is invalid`;
    if (item.strength !== undefined && !(typeof item.strength === 'number' && item.strength >= 0 && item.strength <= 1)) return `${at}.strength must be 0..1`;
    if (item.minutesAway !== undefined && !integerWithin(item.minutesAway, BODY_LIMITS.minutesAway)) return `${at}.minutesAway is invalid`;
    events.push({
      id: item.id, type: item.type, audience: item.audience, occurredAt: new Date(time).toISOString(),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.strength !== undefined ? { strength: Math.round(item.strength * 100) / 100 } : {}),
      ...(item.minutesAway !== undefined ? { minutesAway: item.minutesAway } : {}),
    });
  }
  return events;
}

function identifierList(value: unknown, maximum: number, name: string): readonly string[] | string {
  if (!Array.isArray(value) || value.length > maximum) return `${name} must be an array of at most ${maximum} ids`;
  for (const id of value) {
    if (typeof id !== 'string' || id.length > BODY_LIMITS.capabilityIdCharacters || !CAPABILITY_ID.test(id)) return `${name} contains an invalid id`;
  }
  if (new Set(value).size !== value.length) return `${name} contains a repeated id`;
  return value as string[];
}

/** What the body says it can express: identifiers and booleans only. */
export function validatedBodyCapabilities(value: Record<string, unknown>): BodyCapabilities | string {
  const unknown = Object.keys(value).find(key => !['scopeKey', 'expressions', 'gestures', 'flags'].includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const expressions = identifierList(value.expressions, BODY_LIMITS.expressions, 'expressions');
  if (typeof expressions === 'string') return expressions;
  const gestures = identifierList(value.gestures, BODY_LIMITS.gestures, 'gestures');
  if (typeof gestures === 'string') return gestures;
  const flags = value.flags ?? {};
  if (!isRecord(flags) || Object.keys(flags).length > BODY_LIMITS.flags) return `flags must be an object of at most ${BODY_LIMITS.flags} booleans`;
  for (const [key, flag] of Object.entries(flags)) {
    if (key.length > BODY_LIMITS.capabilityIdCharacters || !CAPABILITY_ID.test(key) || typeof flag !== 'boolean') return 'flags contains an invalid entry';
  }
  return { expressions, gestures, flags: Object.fromEntries(Object.entries(flags).sort(([left], [right]) => left.localeCompare(right))) as Record<string, boolean> };
}

/** Stopping body-event ingestion needs only this variable and a restart, not a deployment. */
export function bodyIngestEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_BODY_INGEST?.trim().toLowerCase() ?? '');
}
