/**
 * mb-llmc v2 (mb-llmc-cand 9, run 37): two numbers of her state said in the words a person reads. `time` was the world's ticks with no unit
 * ("99", "4439"); `oxygen` was 400 early in the run and 20 later (mineflayer's air supply is 0 to 20 under water, and the body's frame reports 400 on dry land
 * in 1.21.11: `GoalVerifier` of the body reads above 20 as full air). Facts only; what to do with them is the decision's.
 */
const TICKS_PER_SECOND = 20;
/** The world's day: tick 0 is sunrise, the night (hostiles spawn) 13,000 to 23,000, sunrise again at 24,000. */
const NIGHT_FROM = 13_000, NIGHT_TO = 23_000, DAY_LENGTH = 24_000;

/** The frame's weather string (fixtures: clear, thunder); rain alone is not a thunderstorm. */
export const thunderstorm = (world: Record<string, unknown>): boolean => typeof world.weather === 'string'
  && /thunder|雷/u.test(world.weather);

/** The world's clock that reads the same this long (in the body's own time) is stopped: the day cycle is off, or a command set it. */
export const CLOCK_STALLED_SECONDS = 30;
const lastClock = new Map<string, { raw: string; since: number }>();
/**
 * How long the clock has read `raw` (ms of the observation's own time, `stateAt`) for this body, 0 when it moved or is first seen. Play 1124: the
 * world's time did not move for 14 minutes (「夜まで 約 10 分」 in every decision) and the work waited for a night that could not come.
 */
export function clockStalledSeconds(key: string, raw: string, at: number): number {
  if (!/^[0-9]+$/u.test(raw.trim()) || !Number.isFinite(at)) return 0;
  const last = lastClock.get(key);
  if (!last || last.raw !== raw.trim() || at < last.since) { lastClock.set(key, { raw: raw.trim(), since: at }); if (lastClock.size > 8) lastClock.delete(lastClock.keys().next().value as string); return 0; }
  return (at - last.since) / 1_000;
}
export const forgetClocks = (): void => { lastClock.clear(); };

function span(ticks: number): string {
  const seconds = Math.max(0, Math.round(ticks / TICKS_PER_SECOND));
  return seconds < 120 ? `${seconds} 秒` : `約 ${Math.round(seconds / 60)} 分`;
}

/**
 * The time of day in words, from the body's `world.time` (the ticks as a string) and the dimension: 「朝（日の出から 5 秒、夜まで 約 11 分）」,
 * 「夜（朝まで 約 7 分）」. The Nether and the End have no time of day: 「（時刻なし）」. A time that is not a plain number (the body's own words) is
 * null, kept as it is.
 */
export function timeWords(raw: string, dimension: string | undefined, weather?: unknown, stalledSeconds = 0): string | null {
  if (dimension !== undefined && /nether|end/u.test(dimension)) return '（時刻なし）';
  const base = clockWords(raw);
  const clock = base && stalledSeconds >= CLOCK_STALLED_SECONDS ? `${base}・時刻が止まっている（${Math.round(stalledSeconds)} 秒 動かない。「夜まで」「朝まで」は進まないので、待っても夜も朝も来ない）` : base;
  if (!thunderstorm({ weather })) return clock;
  const storm = '雷雨（時刻に関係なく寝られる・昼でも地上に敵が湧く）';
  return clock ? `${clock}・${storm}` : storm;
}

function clockWords(raw: string): string | null {
  if (!/^\d+$/u.test(raw.trim())) return null;
  const tick = Number(raw.trim()) % DAY_LENGTH;
  if (tick >= NIGHT_TO) return `明け方（日の出まで ${span(DAY_LENGTH - tick)}）`;
  if (tick >= NIGHT_FROM) return `夜（朝まで ${span(NIGHT_TO - tick)}）`;
  const untilNight = `夜まで ${span(NIGHT_FROM - tick)}`;
  if (tick < 6_000) return `朝（日の出から ${span(tick)}、${untilNight}）`;
  return tick < 12_000 ? `昼（${untilNight}）` : `夕方（${untilNight}）`;
}

/** The air as one scale: 「息 20/20」. Above 20 is the body's full air on dry land (400); below 0 is 0. Null when there is no number. */
export function breathWords(raw: number | null): string | null {
  if (raw === null) return null;
  return `息 ${Math.round(Math.min(20, Math.max(0, raw)))}/20`;
}
