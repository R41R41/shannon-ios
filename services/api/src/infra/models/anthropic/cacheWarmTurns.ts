/**
 * The foreground text turns as the cache plan is judged (Syzygy ADR-0009 stage 1, M4; plan §3 row 5: "of the follow-up turns
 * within an hour, at least 70% read the cache"). In this process only, content-free: a Talk is known by a short hash, a turn
 * by its first request (round 0). Per day and per lane (`plan` under `SHANNON_CLAUDE_CACHE_PLAN`, `base` otherwise):
 *
 * - `turns`: the text turns that named their Talk.
 * - `warmTurns`: those that started within an hour of the previous turn of the same Talk; `warmTurnsWithCacheRead` of them
 *   read the cache, with their summed `warmCacheRead` and `warmCacheCreation` tokens (the creation a warm turn still paid).
 * - `firstTokenMs`: the turn's first word or call, from the start of its first request, apart for turns that read the cache
 *   and turns that did not (p50 and p80 of the day's latest samples; a non-streamed turn has none).
 */
export const WARM_TURN_LIMITS = Object.freeze({ warmMilliseconds: 3_600_000, threads: 500, samples: 500, days: 2 });

export interface WarmTurnInput {
  at: string;
  thread: string;
  cachePlan: boolean;
  cacheRead: number;
  cacheCreation: number;
  firstTokenMs?: number;
}

interface LatencySamples {
  read: number[];
  unread: number[];
}

interface WarmLane {
  turns: number;
  warmTurns: number;
  warmTurnsWithCacheRead: number;
  warmCacheRead: number;
  warmCacheCreation: number;
  latency: LatencySamples;
}

type Lane = 'plan' | 'base';

const lastTurnAt = new Map<string, number>();
const days = new Map<string, Map<Lane, WarmLane>>();

function emptyLane(): WarmLane {
  return { turns: 0, warmTurns: 0, warmTurnsWithCacheRead: 0, warmCacheRead: 0, warmCacheCreation: 0, latency: { read: [], unread: [] } };
}

function laneOf(day: string, lane: Lane): WarmLane {
  const lanes = days.get(day) ?? new Map<Lane, WarmLane>();
  days.set(day, lanes);
  const total = lanes.get(lane) ?? emptyLane();
  lanes.set(lane, total);
  return total;
}

/** Whether this turn follows the Talk's previous turn within the hour; remembers this one as the Talk's latest. */
function followsWithinHour(thread: string, at: number): boolean {
  const previous = lastTurnAt.get(thread);
  lastTurnAt.delete(thread);
  lastTurnAt.set(thread, at);
  if (lastTurnAt.size > WARM_TURN_LIMITS.threads) lastTurnAt.delete(lastTurnAt.keys().next().value!);
  return previous !== undefined && at >= previous && at - previous <= WARM_TURN_LIMITS.warmMilliseconds;
}

function sample(samples: number[], value: number): void {
  samples.push(Math.max(0, Math.round(value)));
  if (samples.length > WARM_TURN_LIMITS.samples) samples.shift();
}

function forgetOldDays(): void {
  const kept = new Set([...days.keys()].sort().slice(-WARM_TURN_LIMITS.days));
  for (const day of [...days.keys()]) if (!kept.has(day)) days.delete(day);
}

/** One foreground text turn (its first request). Never throws. */
export function recordWarmTurn(turn: WarmTurnInput): void {
  const at = Date.parse(turn.at);
  if (!Number.isFinite(at)) return;
  const total = laneOf(turn.at.slice(0, 10), turn.cachePlan ? 'plan' : 'base');
  total.turns += 1;
  if (turn.firstTokenMs !== undefined) sample(turn.cacheRead > 0 ? total.latency.read : total.latency.unread, turn.firstTokenMs);
  if (followsWithinHour(turn.thread, at)) {
    total.warmTurns += 1;
    total.warmCacheRead += turn.cacheRead;
    total.warmCacheCreation += turn.cacheCreation;
    if (turn.cacheRead > 0) total.warmTurnsWithCacheRead += 1;
  }
  forgetOldDays();
}

function percentile(samples: readonly number[], share: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;
}

function latencyView(samples: readonly number[]) {
  return { count: samples.length, p50: percentile(samples, 0.5), p80: percentile(samples, 0.8) };
}

function laneView(lane: WarmLane) {
  const { latency, ...counts } = lane;
  const rate = lane.warmTurns ? Math.round((lane.warmTurnsWithCacheRead / lane.warmTurns) * 1_000) / 1_000 : null;
  const creationPerWarmTurn = lane.warmTurns ? Math.round(lane.warmCacheCreation / lane.warmTurns) : null;
  return { ...counts, warmReadRate: rate, creationPerWarmTurn,
    firstTokenMs: { cacheRead: latencyView(latency.read), noCacheRead: latencyView(latency.unread) } };
}

/** Per day and lane, what `GET /v1/ops` shows under `modelCache.foregroundText`. */
export function warmTurnsView() {
  return Object.fromEntries([...days].map(([day, lanes]) => [day, Object.fromEntries([...lanes].map(([lane, total]) => [lane, laneView(total)]))]));
}

/** The compact daily log line: warm turns that read the cache, per lane. */
export function warmDayLine(day: string): string {
  const lanes = days.get(day);
  if (!lanes) return 'none';
  return [...lanes].map(([lane, total]) => `${lane}=${total.warmTurnsWithCacheRead}/${total.warmTurns}`).join(',');
}

/** Tests only. */
export function resetWarmTurns(): void {
  lastTurnAt.clear();
  days.clear();
}
