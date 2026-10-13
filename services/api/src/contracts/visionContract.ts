/**
 * The common vision contract (Syzygy ADR-0011 §3.2, stage 1): one shape for every source that sees. A frame's pixels are never
 * part of these records: `vision.frame.v1` describes a frame held in memory only (by `frameId`), `vision.session.v1` one bounded
 * run of decisions, and `vision.decision.v1` one Decisions answer with its candidates, probabilities, timings and cost.
 *
 * There is no field that keeps an image: no `persist`, no bytes, no base64, no URL. A record that carries one of those keys is
 * refused (`VISION_FORBIDDEN_KEYS`), so no store, log or Observer row built from these shapes can hold a picture.
 * The Swift mirror is `apps/ios/Sources/ShannonAppCore/API/ShannonVisionContract.swift`; the fixture both sides read is
 * `services/api/tests/fixtures/vision-contract-v1.json`.
 */
export const VISION_FRAME_SCHEMA = 'vision.frame.v1';
export const VISION_SESSION_SCHEMA = 'vision.session.v1';
export const VISION_DECISION_SCHEMA = 'vision.decision.v1';
export const VISION_FRAME_REPLY_SCHEMA = 'vision.frame.reply.v1';
export const VISION_STATUS_SCHEMA = 'vision.status.v1';

/** Where a frame came from. Stage 1 accepts `app_camera` (watching while the app is open) and the looks ported onto the contract. */
export const VISION_SOURCE_KINDS = Object.freeze(['app_camera', 'app_look', 'body_look', 'photo', 'minecraft', 'screen', 'stream'] as const);
export type VisionSourceKind = typeof VISION_SOURCE_KINDS[number];

/** §3.2 privacy of what a frame shows. */
export const VISION_PRIVACY = Object.freeze(['owner_private', 'shared_room', 'world_shared', 'stream_public'] as const);
export type VisionPrivacy = typeof VISION_PRIVACY[number];

/** The listener when a frame was captured (ADR-0002's audience classes). */
export const VISION_AUDIENCES = Object.freeze(['owner_alone', 'others', 'stream'] as const);
export type VisionAudience = typeof VISION_AUDIENCES[number];

/** Why the device's edge gate let a frame through (§4.4: difference, the person count, the owner's 「見て」). */
export const VISION_GATE_REASONS = Object.freeze(['difference', 'owner_asked', 'first_frame'] as const);
export type VisionGateReason = typeof VISION_GATE_REASONS[number];

/** The reactions registered on the device (`react:<id>`): each is an expression the app can show at once. */
export const VISION_REACTIONS = Object.freeze(['smile', 'surprised', 'curious', 'tender', 'concerned'] as const);
export type VisionReaction = typeof VISION_REACTIONS[number];

/** The kinds of topic a camera notice may raise (`notice:<category>`). Decisions picks a kind only; the voice path makes the words. */
export const VISION_NOTICE_CATEGORIES = Object.freeze(['owner_returned', 'owner_waved', 'showing_something', 'new_object', 'owner_looks_tired'] as const);
export type VisionNoticeCategory = typeof VISION_NOTICE_CATEGORIES[number];

export const VISION_CANDIDATE_KINDS = Object.freeze(['quiet', 'react', 'notice', 'escalate', 'other'] as const);
export type VisionCandidateKind = typeof VISION_CANDIDATE_KINDS[number];

/** Keys that would carry a picture or a way to keep one. Refused anywhere in these records. */
export const VISION_FORBIDDEN_KEYS = Object.freeze(['persist', 'image', 'images', 'bytes', 'base64', 'data', 'jpeg', 'png', 'url', 'imageUrl', 'pixels']);

/** §4.4 and §7.2 initial limits (to be revised from measurement). */
export const VISION_LIMITS = Object.freeze({
  /** The long side of a frame sent to the worker. */
  longSide: 512,
  /** A frame body larger than this is refused (a 512px JPEG is far below it). */
  frameBytes: 200_000,
  /** How often the device may judge a frame on the device. */
  judgeFramesPerSecond: 2,
  /** At most one frame to the worker per this interval, per device. */
  sendIntervalMs: 2_000,
  /** Decisions in flight per device (and per body or output). */
  concurrentDecisions: 1,
  /** A camera frame older than this is not used for a decision. */
  cameraTtlMs: 4_000,
  /** The longest TTL a source may give a frame or a percept. */
  maxTtlMs: 60_000,
  /** Owner-time yen per US dollar for the daily vision cap (§7.1 uses 150). */
  yenPerUsd: 150,
  /** §7.2: the daily cap of paid vision calls, in yen. */
  dailyCapYen: 300,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isUnit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const one = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** The first forbidden key anywhere in a value (depth-bounded), or null. */
export function forbiddenVisionKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = forbiddenVisionKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((VISION_FORBIDDEN_KEYS as readonly string[]).includes(key)) return key;
    const found = forbiddenVisionKey(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function closedKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): string | null {
  const forbidden = forbiddenVisionKey(row);
  if (forbidden) return `${label}.${forbidden} is not allowed: no vision record may keep a picture`;
  const unknown = Object.keys(row).find(key => !allowed.includes(key));
  return unknown ? `${label}.${unknown} is not allowed` : null;
}

export interface VisionSource { kind: VisionSourceKind; bodyId: string | null; deviceId: string | null }
export interface VisionEncoding { width: number; height: number; format: 'jpeg' | 'png'; byteLength: number }
export interface VisionGate { reason: VisionGateReason; difference: number | null; personCount: number | null }

/** `vision.frame.v1`: one frame, described. The pixels stay in the memory of the process that holds `frameId`. */
export interface VisionFrameV1 {
  schema: typeof VISION_FRAME_SCHEMA;
  frameId: string;
  capturedAt: string;
  receivedAt: string | null;
  source: VisionSource;
  sessionId: string | null;
  generation: number | null;
  privacy: VisionPrivacy;
  audienceAtCapture: VisionAudience;
  ttlMs: number;
  encoding: VisionEncoding;
  gate: VisionGate | null;
  /** Structured observation at the same instant (closed scalars only). */
  state: Readonly<Record<string, string | number | boolean>> | null;
}

const FRAME_KEYS = ['schema', 'frameId', 'capturedAt', 'receivedAt', 'source', 'sessionId', 'generation', 'privacy', 'audienceAtCapture',
  'ttlMs', 'encoding', 'gate', 'state'];

function checkedSource(value: unknown): VisionSource | string {
  if (!isRecord(value)) return 'source must be an object';
  const keys = closedKeys(value, ['kind', 'bodyId', 'deviceId'], 'source');
  if (keys) return keys;
  if (!one(VISION_SOURCE_KINDS, value.kind)) return 'source.kind is invalid';
  if (value.bodyId !== null && !isId(value.bodyId)) return 'source.bodyId is invalid';
  if (value.deviceId !== null && !isId(value.deviceId)) return 'source.deviceId is invalid';
  return { kind: value.kind, bodyId: value.bodyId, deviceId: value.deviceId };
}

function checkedEncoding(value: unknown): VisionEncoding | string {
  if (!isRecord(value)) return 'encoding must be an object';
  const keys = closedKeys(value, ['width', 'height', 'format', 'byteLength'], 'encoding');
  if (keys) return keys;
  if (!isCount(value.width) || !isCount(value.height) || value.width < 1 || value.height < 1) return 'encoding size is invalid';
  if (value.format !== 'jpeg' && value.format !== 'png') return 'encoding.format must be jpeg or png';
  if (!isCount(value.byteLength) || value.byteLength < 1) return 'encoding.byteLength is invalid';
  return { width: value.width, height: value.height, format: value.format, byteLength: value.byteLength };
}

function checkedGate(value: unknown): VisionGate | null | string {
  if (value === null) return null;
  if (!isRecord(value)) return 'gate must be an object or null';
  const keys = closedKeys(value, ['reason', 'difference', 'personCount'], 'gate');
  if (keys) return keys;
  if (!one(VISION_GATE_REASONS, value.reason)) return 'gate.reason is invalid';
  if (value.difference !== null && !isUnit(value.difference)) return 'gate.difference must be in [0, 1]';
  if (value.personCount !== null && !isCount(value.personCount)) return 'gate.personCount is invalid';
  return { reason: value.reason, difference: value.difference, personCount: value.personCount };
}

function checkedState(value: unknown): VisionFrameV1['state'] | string {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length > 16) return 'state must be a small object or null';
  const forbidden = forbiddenVisionKey(value);
  if (forbidden) return `state.${forbidden} is not allowed`;
  const scalar = (item: unknown) => typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
    || (typeof item === 'string' && item.length <= 80);
  return Object.values(value).every(scalar) ? Object.freeze({ ...value }) as VisionFrameV1['state'] : 'state holds closed scalars only';
}

const nullableId = (value: unknown) => value === null || isId(value);
const nullableGeneration = (value: unknown) => value === null || (isCount(value) && value >= 1);

/** The scalar fields of a frame, or what is wrong with them. */
function frameScalarsError(value: Record<string, unknown>): string | null {
  if (value.schema !== VISION_FRAME_SCHEMA) return `schema must be ${VISION_FRAME_SCHEMA}`;
  if (!isId(value.frameId)) return 'frameId is invalid';
  if (!isTime(value.capturedAt) || (value.receivedAt !== null && !isTime(value.receivedAt))) return 'times are invalid';
  if (!nullableId(value.sessionId)) return 'sessionId is invalid';
  if (!nullableGeneration(value.generation)) return 'generation is invalid';
  if (!one(VISION_PRIVACY, value.privacy)) return 'privacy is invalid';
  if (!one(VISION_AUDIENCES, value.audienceAtCapture)) return 'audienceAtCapture is invalid';
  const ttl = value.ttlMs;
  return isCount(ttl) && ttl >= 1 && ttl <= VISION_LIMITS.maxTtlMs ? null : 'ttlMs is invalid';
}

/** Checks a frame record (closed keys, closed vocabularies, no picture). Answers a frozen copy, or what is wrong. */
export function checkedVisionFrame(value: unknown): VisionFrameV1 | string {
  if (!isRecord(value)) return 'frame must be an object';
  const error = closedKeys(value, FRAME_KEYS, 'frame') ?? frameScalarsError(value);
  if (error) return error;
  const source = checkedSource(value.source);
  const encoding = checkedEncoding(value.encoding);
  const gate = checkedGate(value.gate);
  const state = checkedState(value.state);
  for (const part of [source, encoding, gate, state]) if (typeof part === 'string') return part;
  const row = value as unknown as VisionFrameV1;
  return Object.freeze({
    schema: VISION_FRAME_SCHEMA, frameId: row.frameId, capturedAt: row.capturedAt, receivedAt: row.receivedAt,
    source: Object.freeze(source as VisionSource), sessionId: row.sessionId, generation: row.generation,
    privacy: row.privacy, audienceAtCapture: row.audienceAtCapture, ttlMs: row.ttlMs,
    encoding: Object.freeze(encoding as VisionEncoding), gate: gate as VisionGate | null, state: state as VisionFrameV1['state'],
  });
}

/** Whether a frame may still be used at `now` (§3.2: freshness from `capturedAt`, never past its TTL). */
export function visionFrameFresh(frame: Pick<VisionFrameV1, 'capturedAt' | 'ttlMs'>, now: number): boolean {
  const captured = Date.parse(frame.capturedAt);
  return Number.isFinite(captured) && captured <= now + 1_000 && now - captured <= frame.ttlMs;
}

export const VISION_SESSION_GOALS = Object.freeze(['notice', 'reflex', 'look'] as const);
export const VISION_END_REASONS = Object.freeze([
  'completed', 'hazard_cleared', 'target_lost', 'no_progress', 'no_candidates', 'observation_unavailable', 'cancelled', 'deadline',
  'decision_limit', 'action_limit', 'stale_generation', 'audience_changed', 'budget', 'degraded', 'returned', 'unknown',
] as const);
export type VisionEndReason = typeof VISION_END_REASONS[number];

/** `vision.session.v1`: one bounded run of decisions for one source, under a generation (§4.1, §4.2). */
export interface VisionSessionV1 {
  schema: typeof VISION_SESSION_SCHEMA;
  sessionId: string;
  generation: number;
  source: VisionSource;
  goal: typeof VISION_SESSION_GOALS[number];
  parentTaskId: string | null;
  startedAt: string;
  deadlineAt: string;
  budget: { maxDecisions: number; maxDurationMs: number };
  state: 'open' | 'ended';
  endReason: VisionEndReason | null;
  endedAt: string | null;
}

const SESSION_KEYS = ['schema', 'sessionId', 'generation', 'source', 'goal', 'parentTaskId', 'startedAt', 'deadlineAt', 'budget', 'state',
  'endReason', 'endedAt'];

function checkedSessionBudget(value: unknown): VisionSessionV1['budget'] | string {
  if (!isRecord(value)) return 'budget must be an object';
  const keys = closedKeys(value, ['maxDecisions', 'maxDurationMs'], 'budget');
  if (keys) return keys;
  if (!isCount(value.maxDecisions) || value.maxDecisions < 1 || !isCount(value.maxDurationMs) || value.maxDurationMs < 1) return 'budget is invalid';
  return { maxDecisions: value.maxDecisions, maxDurationMs: value.maxDurationMs };
}

/** The scalar fields of a session, or what is wrong with them. */
function sessionScalarsError(value: Record<string, unknown>): string | null {
  if (value.schema !== VISION_SESSION_SCHEMA) return `schema must be ${VISION_SESSION_SCHEMA}`;
  if (!isId(value.sessionId) || !isCount(value.generation) || value.generation < 1) return 'session id or generation is invalid';
  if (!one(VISION_SESSION_GOALS, value.goal)) return 'goal is invalid';
  if (!nullableId(value.parentTaskId)) return 'parentTaskId is invalid';
  if (!isTime(value.startedAt) || !isTime(value.deadlineAt) || Date.parse(value.deadlineAt) < Date.parse(value.startedAt)) return 'times are invalid';
  return null;
}

/** An ended session names its reason and time; an open one names neither. */
function sessionEndError(value: Record<string, unknown>): string | null {
  const ended = value.state === 'ended';
  if (value.state !== 'open' && !ended) return 'state must be open or ended';
  if (ended) return one(VISION_END_REASONS, value.endReason) && isTime(value.endedAt) ? null : 'an ended session names its reason and time';
  return value.endReason === null && value.endedAt === null ? null : 'an open session has no end';
}

/** Checks a session record. An ended session names why; an open one names nothing. */
export function checkedVisionSession(value: unknown): VisionSessionV1 | string {
  if (!isRecord(value)) return 'session must be an object';
  const error = closedKeys(value, SESSION_KEYS, 'session') ?? sessionScalarsError(value) ?? sessionEndError(value);
  if (error) return error;
  const source = checkedSource(value.source);
  if (typeof source === 'string') return source;
  const budget = checkedSessionBudget(value.budget);
  if (typeof budget === 'string') return budget;
  return Object.freeze({ ...value, source, budget } as unknown as VisionSessionV1);
}

export interface VisionCandidate {
  id: string;
  kind: VisionCandidateKind;
  reaction: VisionReaction | null;
  category: VisionNoticeCategory | null;
}

/** The candidate id of a kind and argument: `quiet`, `react:<id>`, `notice:<category>`, `escalate`, `other`. */
export function visionCandidateId(candidate: Pick<VisionCandidate, 'kind' | 'reaction' | 'category'>): string {
  if (candidate.kind === 'react') return `react:${candidate.reaction}`;
  if (candidate.kind === 'notice') return `notice:${candidate.category}`;
  return candidate.kind;
}

/** Parses a candidate id back, or null for one outside the closed vocabulary. */
export function visionCandidateOf(id: string): VisionCandidate | null {
  if (id === 'quiet' || id === 'escalate' || id === 'other') return { id, kind: id, reaction: null, category: null };
  const [kind, argument] = id.split(':', 2);
  if (kind === 'react' && one(VISION_REACTIONS, argument)) return { id, kind, reaction: argument, category: null };
  if (kind === 'notice' && one(VISION_NOTICE_CATEGORIES, argument)) return { id, kind, reaction: null, category: argument };
  return null;
}

export const VISION_DECISION_OUTCOMES = Object.freeze(['chosen', 'quiet', 'discarded', 'refused', 'failed', 'skipped'] as const);
export type VisionDecisionOutcome = typeof VISION_DECISION_OUTCOMES[number];
export const VISION_DISCARD_REASONS = Object.freeze([
  'stale_generation', 'expired', 'audience_changed', 'below_gate', 'low_confidence', 'budget', 'degraded', 'busy', 'disabled',
  'repeated', 'timeout', 'http_error', 'usage_unknown', 'invalid_answer',
] as const);
export type VisionDiscardReason = typeof VISION_DISCARD_REASONS[number];

/** `vision.decision.v1`: one Decisions call (predicate and choice in one request), what it chose and what it cost. */
export interface VisionDecisionV1 {
  schema: typeof VISION_DECISION_SCHEMA;
  decisionId: string;
  frameId: string;
  sessionId: string;
  generation: number;
  source: VisionSource;
  candidates: readonly string[];
  /** The predicate 「反応が要るか」 and the threshold it had to pass. */
  gate: { probability: number | null; threshold: number };
  choice: { candidateId: string | null; confidence: number | null; probabilities: readonly { id: string; probability: number }[] };
  outcome: VisionDecisionOutcome;
  discardReason: VisionDiscardReason | null;
  timings: { queuedMs: number; decisionMs: number | null; totalMs: number };
  cost: { reservedUsd: number; estimatedUsd: number | null; inputTokens: number | null; usageComplete: boolean };
  degrade: 0 | 1 | 2 | 3;
  decidedAt: string;
}

/** Builds and freezes a decision record; refuses a forbidden key or an id outside the candidates. */
export function visionDecisionRecord(value: Omit<VisionDecisionV1, 'schema'>): VisionDecisionV1 {
  const record: VisionDecisionV1 = { schema: VISION_DECISION_SCHEMA, ...value };
  const forbidden = forbiddenVisionKey(record);
  if (forbidden) throw new Error('VISION_DECISION_FORBIDDEN_KEY');
  if (record.choice.candidateId !== null && !record.candidates.includes(record.choice.candidateId)) throw new Error('VISION_DECISION_CANDIDATE');
  if (!record.candidates.every(id => visionCandidateOf(id) !== null)) throw new Error('VISION_DECISION_VOCABULARY');
  return Object.freeze(record);
}

/** Checks a decision record read back (for the Swift mirror and the fixture). */
export function checkedVisionDecision(value: unknown): VisionDecisionV1 | string {
  if (!isRecord(value)) return 'decision must be an object';
  const keys = closedKeys(value, ['schema', 'decisionId', 'frameId', 'sessionId', 'generation', 'source', 'candidates', 'gate', 'choice', 'outcome',
    'discardReason', 'timings', 'cost', 'degrade', 'decidedAt'], 'decision');
  if (keys) return keys;
  if (value.schema !== VISION_DECISION_SCHEMA) return `schema must be ${VISION_DECISION_SCHEMA}`;
  if (!isId(value.decisionId) || !isId(value.frameId) || !isId(value.sessionId)) return 'ids are invalid';
  if (!one(VISION_DECISION_OUTCOMES, value.outcome)) return 'outcome is invalid';
  if (value.discardReason !== null && !one(VISION_DISCARD_REASONS, value.discardReason)) return 'discardReason is invalid';
  if (![0, 1, 2, 3].includes(value.degrade as number) || !isTime(value.decidedAt)) return 'degrade or decidedAt is invalid';
  const source = checkedSource(value.source);
  if (typeof source === 'string') return source;
  try {
    return visionDecisionRecord({ ...(value as unknown as VisionDecisionV1), source });
  } catch (error) {
    return error instanceof Error ? error.message : 'decision is invalid';
  }
}

/** What the worker answers a frame with. `react` and `notice` name the chosen candidate; the device shows a reaction at once. */
export interface VisionFrameReply {
  schema: typeof VISION_FRAME_REPLY_SCHEMA;
  frameId: string;
  watch: 'continue' | 'stop';
  stopReason: 'audience' | 'degraded' | 'disabled' | 'budget' | null;
  outcome: VisionDecisionOutcome;
  candidateId: string | null;
  reaction: VisionReaction | null;
  degrade: 0 | 1 | 2 | 3;
  nextFrameNotBefore: string;
}

/** `GET /v1/vision/status`: whether the device may watch now, and the limits it must keep. */
export interface VisionStatus {
  schema: typeof VISION_STATUS_SCHEMA;
  watchAllowed: boolean;
  reason: VisionFrameReply['stopReason'];
  degrade: 0 | 1 | 2 | 3;
  limits: { judgeFramesPerSecond: number; sendIntervalMs: number; longSide: number; frameBytes: number; ttlMs: number };
}

export const VISION_ROUTE_PREFIX = '/v1/vision/';
export const VISION_FRAME_HEADER = 'x-shannon-vision-frame';
