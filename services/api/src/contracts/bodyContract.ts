import type { ShannonEmotionKind, ShannonExpression, ShannonFeeling } from '@shannon/cognition';
import {
  BODY_TOUCH_PARTS, BODY_TOUCH_PART_WORDS, isBodySurface, isBodyTouchRegion, type BodySurface, type BodyTouchPart, type BodyTouchRegion,
} from '../bodyTouchWords.js';

/**
 * The wire contract between Shannon's mind (this server) and her body (the Live2D
 * desktop application on the owner's PC). `docs/body-contract.md` is the prose form.
 *
 * Everything the body sends is a closed vocabulary plus numbers and identifiers.
 * There is no free-text field, so nothing the body sends can become an instruction.
 */
export const BODY_SCHEMA_VERSION = 1;

export const BODY_TOUCH_EVENT_TYPES = ['pet', 'tickle', 'poke', 'carry', 'holdHand'] as const;

/**
 * Touch vocabulary 2 (Syzygy ADR-0005; `docs/body-contract.md`, "Touch vocabulary 2"): the optional finer facts of
 * a touch, beside `type` and `region`, which keep their meaning. The server says the number on
 * `PUT /v1/body/capabilities` and on presence; a body sends these fields only once it has seen it, because a server
 * from before them refuses an unknown field with `400`. Facts only. Since stage 1b the reaction prompt tells her them, and a
 * `part` of `BODY_TOUCH_REFLEX_PARTS` (`bodyTouchReflex.ts`) moves her by the reflex alone instead of the table.
 */
export const BODY_TOUCH_VOCABULARY = 2;
/** Left or right from her own view, not the screen's. */
export const BODY_TOUCH_SIDES = ['left', 'right'] as const;
/** Stroke, poke, tickle, a touch that rests, holding (the hand), carrying. */
export const BODY_TOUCH_GESTURES = ['stroke', 'poke', 'tickle', 'rest', 'hold', 'carry'] as const;
/** Pressed (dragged) or only passed over (the pointer over her without a press). */
export const BODY_TOUCH_INPUTS = ['press', 'hover'] as const;
/** What her body did by itself on the spot: a report of fact, not a judgement. */
export const BODY_TOUCH_REFLEXES = ['none', 'flinch', 'avoid'] as const;
export type BodyTouchSide = typeof BODY_TOUCH_SIDES[number];
export type BodyTouchGesture = typeof BODY_TOUCH_GESTURES[number];
export type BodyTouchInput = typeof BODY_TOUCH_INPUTS[number];
export type BodyTouchReflex = typeof BODY_TOUCH_REFLEXES[number];
export const BODY_TOUCH_DETAIL_FIELDS = ['part', 'side', 'gesture', 'input', 'reflex'] as const;

/** The fields of touch vocabulary 2, each present only when the body sent it (and `part` only when it is known). */
export interface BodyTouchDetail {
  part?: BodyTouchPart;
  side?: BodyTouchSide;
  gesture?: BodyTouchGesture;
  input?: BodyTouchInput;
  reflex?: BodyTouchReflex;
}

type BodyTouchType = typeof BODY_TOUCH_EVENT_TYPES[number];

/** The old `type` each gesture is sent with (`docs/body-contract.md`, "What the body must send"). */
const GESTURE_TYPES: Readonly<Record<BodyTouchGesture, readonly BodyTouchType[]>> = Object.freeze({
  stroke: ['pet'], poke: ['poke'], tickle: ['tickle'], rest: ['pet', 'holdHand'], hold: ['holdHand'], carry: ['carry'],
});
const known = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find(word => word === value);

/**
 * The detail of one touch as it is kept. Nothing here refuses a request, so that a body of a later vocabulary, or a
 * server rolled back to an earlier one, never loses a batch: a word outside its list is left out, as an unknown
 * `region` is, and the touch still counts. Where the new fields disagree with the old ones the old ones win, so that
 * no reader ever meets a contradiction: a `part` whose parent is not the `region` sent is left out, and so is a
 * `gesture` that is not sent with this `type`.
 */
export function validatedTouchDetail(item: Record<string, unknown>, type: BodyTouchType, region: BodyTouchRegion | undefined): BodyTouchDetail {
  const part = known(BODY_TOUCH_PARTS, item.part);
  const gesture = known(BODY_TOUCH_GESTURES, item.gesture);
  const side = known(BODY_TOUCH_SIDES, item.side);
  const input = known(BODY_TOUCH_INPUTS, item.input);
  const reflex = known(BODY_TOUCH_REFLEXES, item.reflex);
  return {
    ...(part && (region === undefined || BODY_TOUCH_PART_WORDS[part].region === region) ? { part } : {}),
    ...(side ? { side } : {}),
    ...(gesture && GESTURE_TYPES[gesture].includes(type) ? { gesture } : {}),
    ...(input ? { input } : {}),
    ...(reflex ? { reflex } : {}),
  };
}

/** Where a hover may be (owner decision 2026-10-05: passing over her strokes only the head and the hair). */
const HOVER_PARTS: readonly BodyTouchPart[] = ['head', 'hair'];

/**
 * A combination that cannot be a touch: holding anything but the hand, or a hover anywhere but the head or the
 * hair, or a hover that is not a stroke. Where the body named no `part`, its `region` stands in. Such a touch is
 * answered `ignored` with `not_a_touch`, item by item. Only the fields of vocabulary 2 can make one, so a touch in
 * the old shape is never impossible.
 */
export function isImpossibleTouch(touch: BodyTouchDetail & { region?: BodyTouchRegion }): boolean {
  const region = touch.part ? BODY_TOUCH_PART_WORDS[touch.part].region : touch.region;
  if (touch.gesture === 'hold' && region !== undefined && (touch.part ?? region) !== 'hand') return true;
  if (touch.input === 'hover') {
    if (touch.gesture !== undefined && touch.gesture !== 'stroke') return true;
    if (touch.part ? !HOVER_PARTS.includes(touch.part) : region !== undefined && region !== 'head') return true;
  }
  return false;
}

/** The detail fields in an idempotency digest: only those sent, each tagged, so a request without them hashes as before. */
export function touchDetailDigest(touch: BodyTouchDetail): string[] {
  return BODY_TOUCH_DETAIL_FIELDS.flatMap(field => touch[field] !== undefined ? [`${field}:${touch[field]}`] : []);
}
export const BODY_PRESENCE_EVENT_TYPES = ['ownerAway', 'ownerReturned'] as const;
export const BODY_PLAIN_EVENT_TYPES = ['callStarted', 'callEnded', 'windowHidden', 'windowShown', 'appStarted'] as const;
/**
 * What happened to her Minecraft body (`docs/minecraft-body-contract.md`). Taken only from the one device configured
 * as that body, in the owner's scope; a closed set, each with its own closed fields and no text.
 */
export const BODY_GAME_EVENT_TYPES = ['game.died'] as const;
export const BODY_EVENT_TYPES = [...BODY_TOUCH_EVENT_TYPES, ...BODY_PRESENCE_EVENT_TYPES, ...BODY_PLAIN_EVENT_TYPES, ...BODY_GAME_EVENT_TYPES] as const;
export type BodyGameEventType = typeof BODY_GAME_EVENT_TYPES[number];
export const isBodyGameEvent = (type: string): type is BodyGameEventType => (BODY_GAME_EVENT_TYPES as readonly string[]).includes(type);
/** A game's namespaced id, such as `minecraft:lava`. */
const GAME_ID = /^[a-z0-9_.-]{1,32}:[a-z0-9_./-]{1,64}$/u;

export type BodyEventType = typeof BODY_EVENT_TYPES[number];
export type BodyAudience = 'owner' | 'others';

/** What Shannon is doing right now, as the body may show it. */
export const BODY_DOING = ['idle', 'thinking', 'reading', 'noting', 'drafting', 'revising', 'showing'] as const;
export type BodyDoing = typeof BODY_DOING[number];

/**
 * What the body did with a message she started on her own (`POST /v1/body/reach-outs/{id}/delivery`):
 * shown and spoken, shown without sound, or not shown because the owner is away from the PC, her window is
 * hidden, or 「話しかける」 is switched off on the body.
 */
export const BODY_REACH_OUT_DELIVERY_OUTCOMES = ['shown_spoken', 'shown', 'away', 'hidden', 'muted'] as const;
export type BodyReachOutDeliveryOutcome = typeof BODY_REACH_OUT_DELIVERY_OUTCOMES[number];
export const BODY_REACH_OUT_REPORT_PREFIX = '/v1/body/reach-outs/';
const REACH_OUT_ID = /^[A-Za-z0-9-]{1,80}$/u;

/** The initiative id in `/v1/body/reach-outs/{id}/delivery`, or null. */
export function bodyReachOutReportId(path: string): string | null {
  const match = /^\/v1\/body\/reach-outs\/([^/]+)\/delivery$/u.exec(path);
  return match && REACH_OUT_ID.test(match[1]!) ? match[1]! : null;
}

/** The one field of a delivery report besides `scopeKey`, or why the request is refused. There is no text field. */
export function validatedBodyReachOutReport(body: Record<string, unknown>): { outcome: BodyReachOutDeliveryOutcome } | string {
  const unknown = Object.keys(body).find(key => key !== 'scopeKey' && key !== 'outcome');
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const outcome = BODY_REACH_OUT_DELIVERY_OUTCOMES.find(value => value === body.outcome);
  return outcome ? { outcome } : `outcome must be one of ${BODY_REACH_OUT_DELIVERY_OUTCOMES.join(', ')}`;
}

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
  /** Touch types only: which part of her was touched. */
  region?: BodyTouchRegion;
  /** Touch types only, touch vocabulary 2: the finer part, side, gesture, pressed or hovered, and her body's reflex. */
  part?: BodyTouchPart;
  side?: BodyTouchSide;
  gesture?: BodyTouchGesture;
  input?: BodyTouchInput;
  reflex?: BodyTouchReflex;
  /** `game.died` only: the game's id of what killed her body, such as `minecraft:lava`. */
  cause?: string;
}

export interface BodyCapabilities {
  expressions: readonly string[];
  gestures: readonly string[];
  flags: Readonly<Record<string, boolean>>;
  /** Where this body is: the Windows desktop, the Mac desktop, or the iPhone app. */
  surface?: BodySurface;
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
  if (includes(BODY_TOUCH_EVENT_TYPES, type)) return [...COMMON_EVENT_FIELDS, 'durationMs', 'strength', 'region', ...BODY_TOUCH_DETAIL_FIELDS];
  if (includes(BODY_PRESENCE_EVENT_TYPES, type)) return [...COMMON_EVENT_FIELDS, 'minutesAway'];
  if (type === 'game.died') return [...COMMON_EVENT_FIELDS, 'cause'];
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
    if (item.type === 'game.died' && (typeof item.cause !== 'string' || !GAME_ID.test(item.cause))) return `${at}.cause must be a namespaced id such as minecraft:lava`;
    const region = isBodyTouchRegion(item.region) ? item.region : undefined;
    // Touch vocabulary 2 on a touch type only (on any other type the fields were refused above).
    const detail = includes(BODY_TOUCH_EVENT_TYPES, item.type) ? validatedTouchDetail(item, item.type, region) : {};
    events.push({
      id: item.id, type: item.type, audience: item.audience, occurredAt: new Date(time).toISOString(),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.strength !== undefined ? { strength: Math.round(item.strength * 100) / 100 } : {}),
      ...(item.minutesAway !== undefined ? { minutesAway: item.minutesAway } : {}),
      // A part outside the vocabulary (a newer body) is left out, not refused: the touch itself still counts.
      ...(region ? { region } : {}),
      ...detail,
      ...(typeof item.cause === 'string' ? { cause: item.cause } : {}),
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
  const unknown = Object.keys(value).find(key => !['scopeKey', 'expressions', 'gestures', 'flags', 'surface'].includes(key));
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
  return {
    expressions, gestures, flags: Object.fromEntries(Object.entries(flags).sort(([left], [right]) => left.localeCompare(right))) as Record<string, boolean>,
    // A surface outside the vocabulary is left out, not refused.
    ...(isBodySurface(value.surface) ? { surface: value.surface } : {}),
  };
}

/** Stopping body-event ingestion needs only this variable and a restart, not a deployment. */
export function bodyIngestEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_BODY_INGEST?.trim().toLowerCase() ?? '');
}
