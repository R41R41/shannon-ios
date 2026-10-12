/**
 * The foreground text turns as the cache plan is judged (Syzygy ADR-0009 stage 1, M4; plan §3 row 5: "of the follow-up turns
 * within an hour, at least 70% read the cache"). In this process only, content-free, and empty again after a restart: a Talk is
 * known by a short hash and the model, a turn by its first request (round 0). Per day and per lane (`plan` under
 * `SHANNON_CLAUDE_CACHE_PLAN` with the common schema, `plan_exception` for a plan turn that sent its own schema because it
 * offered a rarer field, `base` without the plan):
 *
 * - `turns`: the text turns that named their Talk.
 * - `warmTurns`: those that started within an hour of the previous turn of the same Talk and model. Of them,
 *   `warmTurnsWithCacheRead` read anything, and `warmTurnsWithHistoryRead` read more than the static prefix (tools, system):
 *   the history the previous turn wrote. Reading the static prefix alone proves nothing about the history, so only the
 *   second count is the canary's measure. The static prefix's size is learned per prefix fingerprint from a first request
 *   without history that read the cache (`staticPrefixes`); until one was seen, a warm turn counts in `warmTurnsPrefixUnknown`.
 * - `warmCacheRead`, `warmCacheCreation`, `warmInput` and `warmReadShare` (read / all input): the tokens of the warm turns.
 * - `firstTokenMs`: the turn's first word or call, from the start of its first request, apart for turns that read the history,
 *   and turns that did not (p50 and p80 of the day's latest samples; a non-streamed turn has none).
 *
 * Beside them, per surface: the plan's events (`events`: a fallback to the shape without the plan, a tool-less recovery,
 * the bridge after a grammar refusal, a declined call, and `recovered` turns that answered after such a refusal) and how often
 * an offered feeling was answered (`feeling`, per lane).
 */
export const WARM_TURN_LIMITS = Object.freeze({ warmMilliseconds: 3_600_000, threads: 500, prefixes: 50, samples: 500, days: 2 });

export interface WarmTurnInput {
  at: string;
  thread: string;
  model: string;
  cachePlan: boolean;
  /** A plan turn that sent its own schema (a rarer field offered): counted in the lane `plan_exception`. */
  exception?: boolean;
  /** The fingerprint of the static prefix (tools, system, schema, effort). */
  staticPrefix: string;
  /** History messages before the turn's words. */
  historyMessages: number;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  firstTokenMs?: number;
}

interface LatencySamples {
  history: number[];
  other: number[];
}

interface WarmLane {
  turns: number;
  warmTurns: number;
  warmTurnsWithCacheRead: number;
  warmTurnsWithHistoryRead: number;
  warmTurnsPrefixUnknown: number;
  warmInput: number;
  warmCacheRead: number;
  warmCacheCreation: number;
  latency: LatencySamples;
}

type Lane = 'plan' | 'plan_exception' | 'base';

function laneName(turn: Pick<WarmTurnInput, 'cachePlan' | 'exception'>): Lane {
  if (!turn.cachePlan) return 'base';
  return turn.exception ? 'plan_exception' : 'plan';
}

const lastTurnAt = new Map<string, number>();
const staticPrefixes = new Map<string, number>();
const days = new Map<string, Map<Lane, WarmLane>>();
const events = new Map<string, number>();
const feeling = new Map<Lane, { offered: number; answered: number }>();

function emptyLane(): WarmLane {
  return { turns: 0, warmTurns: 0, warmTurnsWithCacheRead: 0, warmTurnsWithHistoryRead: 0, warmTurnsPrefixUnknown: 0, warmInput: 0,
    warmCacheRead: 0, warmCacheCreation: 0, latency: { history: [], other: [] } };
}

function laneOf(day: string, lane: Lane): WarmLane {
  const lanes = days.get(day) ?? new Map<Lane, WarmLane>();
  days.set(day, lanes);
  const total = lanes.get(lane) ?? emptyLane();
  lanes.set(lane, total);
  return total;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Whether this turn follows the Talk's previous turn on the same model within the hour; remembers this one as its latest. */
function followsWithinHour(turn: WarmTurnInput, at: number): boolean {
  const key = `${turn.model}\n${turn.thread}`;
  const previous = lastTurnAt.get(key);
  remember(lastTurnAt, key, at, WARM_TURN_LIMITS.threads);
  return previous !== undefined && at >= previous && at - previous <= WARM_TURN_LIMITS.warmMilliseconds;
}

/** A first request without history that read the cache read the static prefix alone: its size, per fingerprint. */
function learnStaticPrefix(turn: WarmTurnInput): void {
  if (turn.historyMessages !== 0 || turn.cacheRead <= 0) return;
  const known = staticPrefixes.get(turn.staticPrefix);
  remember(staticPrefixes, turn.staticPrefix, known === undefined ? turn.cacheRead : Math.min(known, turn.cacheRead), WARM_TURN_LIMITS.prefixes);
}

/** Whether the turn read history beyond the static prefix: true, false, or null while the prefix's size is unknown. */
function readHistory(turn: WarmTurnInput): boolean | null {
  const size = staticPrefixes.get(turn.staticPrefix);
  if (size === undefined) return turn.cacheRead > 0 ? null : false;
  return turn.cacheRead > size;
}

function sample(samples: number[], value: number): void {
  samples.push(Math.max(0, Math.round(value)));
  if (samples.length > WARM_TURN_LIMITS.samples) samples.shift();
}

function forgetOldDays(): void {
  const kept = new Set([...days.keys()].sort().slice(-WARM_TURN_LIMITS.days));
  for (const day of [...days.keys()]) if (!kept.has(day)) days.delete(day);
}

function countWarm(total: WarmLane, turn: WarmTurnInput, history: boolean | null): void {
  total.warmTurns += 1;
  total.warmInput += turn.input;
  total.warmCacheRead += turn.cacheRead;
  total.warmCacheCreation += turn.cacheCreation;
  if (turn.cacheRead > 0) total.warmTurnsWithCacheRead += 1;
  if (history === true) total.warmTurnsWithHistoryRead += 1;
  if (history === null) total.warmTurnsPrefixUnknown += 1;
}

/** One foreground text turn (its first request). Never throws. */
export function recordWarmTurn(turn: WarmTurnInput): void {
  const at = Date.parse(turn.at);
  if (!Number.isFinite(at)) return;
  learnStaticPrefix(turn);
  const total = laneOf(turn.at.slice(0, 10), laneName(turn));
  const history = readHistory(turn);
  total.turns += 1;
  if (turn.firstTokenMs !== undefined) sample(history ? total.latency.history : total.latency.other, turn.firstTokenMs);
  if (followsWithinHour(turn, at)) countWarm(total, turn, history);
  forgetOldDays();
}

/** One event of a plan turn on a surface (`text`). */
export function notePlanEvent(surface: string, event: string): void {
  const key = `${surface}:${event}`;
  events.set(key, (events.get(key) ?? 0) + 1);
}

/** A text turn that offered her reply's feeling, and whether the answer carried one. */
export function noteFeelingAnswer(cachePlan: boolean, answered: boolean): void {
  const lane: Lane = cachePlan ? 'plan' : 'base';
  const total = feeling.get(lane) ?? { offered: 0, answered: 0 };
  feeling.set(lane, total);
  total.offered += 1;
  if (answered) total.answered += 1;
}

function percentile(samples: readonly number[], share: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;
}

function latencyView(samples: readonly number[]) {
  return { count: samples.length, p50: percentile(samples, 0.5), p80: percentile(samples, 0.8) };
}

function share(part: number, whole: number, digits = 1_000): number | null {
  return whole ? Math.round((part / whole) * digits) / digits : null;
}

function laneView(lane: WarmLane) {
  const { latency, ...counts } = lane;
  const known = lane.warmTurns - lane.warmTurnsPrefixUnknown;
  return { ...counts, historyReadRate: share(lane.warmTurnsWithHistoryRead, known), cacheReadRate: share(lane.warmTurnsWithCacheRead, lane.warmTurns),
    warmReadShare: share(lane.warmCacheRead, lane.warmInput + lane.warmCacheRead + lane.warmCacheCreation),
    creationPerWarmTurn: lane.warmTurns ? Math.round(lane.warmCacheCreation / lane.warmTurns) : null,
    firstTokenMs: { historyRead: latencyView(latency.history), noHistoryRead: latencyView(latency.other) } };
}

/** What `GET /v1/ops` shows under `modelCache.foregroundText`: per day and lane, the plan's events and the feeling's answers. */
export function warmTurnsView() {
  const byDay = Object.fromEntries([...days].map(([day, lanes]) => [day, Object.fromEntries([...lanes].map(([lane, total]) => [lane, laneView(total)]))]));
  const answers = Object.fromEntries([...feeling].map(([lane, total]) => [lane, { ...total, rate: share(total.answered, total.offered) }]));
  return { days: byDay, events: Object.fromEntries(events), feeling: answers, staticPrefixesKnown: staticPrefixes.size };
}

/** The compact daily log line: warm turns that read the history, per lane. */
export function warmDayLine(day: string): string {
  const lanes = days.get(day);
  if (!lanes) return 'none';
  return [...lanes].map(([lane, total]) => `${lane}=${total.warmTurnsWithHistoryRead}/${total.warmTurns}`).join(',');
}

/** Tests only. */
export function resetWarmTurns(): void {
  lastTurnAt.clear();
  staticPrefixes.clear();
  days.clear();
  events.clear();
  feeling.clear();
}
