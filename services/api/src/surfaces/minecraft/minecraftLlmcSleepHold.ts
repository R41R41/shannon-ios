import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readinessOf } from './minecraftLlmcReadiness.js';
import { AFLOAT_NO_SLEEP, BED, BED_FROM, canSleepNow, dayTick, enemyNear, noSleepSpot, minutes, NIGHT_FROM, NIGHT_TO, thunderstorm } from './minecraftNightArms.js';
import { deathCounterOf } from './minecraftControlState.js';
import { SLEEP_COST, SLEEP_RESUME, SLEEP_SKIP } from '../../contracts/minecraftSleepWords.js';

/**
 * Sleep before the evening's work (the whole-run audit of 11/4, order 1; run60 took planks from a village's houses for three minutes as the night
 * came and died to four zombies; the fact lines of the night and the bed moved no choice in the replays of 11/4). In the overworld from tick
 * 12,542 (a bed can be slept in) until 23,000, with a bed in the pack and no hostile within 8 m, the first work hand of an act (`WORK`) is held
 * unless a `use` or the `place` of a bed comes before it: the sleep comes first. Digging (room for the bed), moving, fighting, eating and getting
 * into cover go through. Bounded: at most `SLEEP_HOLDS` holds of a task in `SLEEP_WINDOW_MS` (a night is about 8 minutes); past them the work goes,
 * for the sleep did not come (no place for the bed, a hostile the frame does not list). A fact with the hand held, as the other gates say theirs;
 * it moves no node (its code is not `gate_required`).
 * The same bounded hold applies during an overworld thunderstorm at any hour; ordinary rain does not enable daytime sleep.
 */
export const SLEEP_HOLDS = 3;
export const SLEEP_WINDOW_MS = 10 * 60_000;
const WORK: ReadonlySet<string> = new Set(['mine', 'make', 'craft', 'smelt', 'furnace', 'obsidian', 'fill', 'chest']);
const holds = new Map<string, number[]>();
/**
 * Run 6 (2026-11-11): a `sleep` hand sent by day is a booking the body keeps (it lies down before the first hand once it is dark), so the night's first work hand
 * of a task that booked is not held for "sleep first": the body does that itself. The booking is remembered for `BOOKING_MS` (the body drops it after 25 minutes).
 */
const BOOKING_MS = 15 * 60_000;
/**
 * Review of run 6's fixes: the head never hears whether the body kept the booking (a no_bed, a held hand, three misses, a death, a lost abort: the body drops it and says so
 * only in a result). So the booking excuses the night's work for `BOOKING_GRACE_MS` from the first night act that sees it: the body lies down at the first hand's start (up to
 * 10 s of waiting for the dusk and the sleep itself), and a night still running after that means it did not (a morning ends it: the hold is for a night only). Then the
 * booking is forgotten and the hold is back.
 */
const BOOKING_GRACE_MS = 90_000;
const bookings = new Map<string, { at: number; night?: number }>();

/**
 * A run's night: a sleep came at night in the middle of the request twice, once by a booking made by day that the body kept for 25 minutes
 * (the head could not take it back and its input never showed it), once by the head's own sleep hand written for "the night's skeletons". The head now says "not tonight" with a
 * `sleep` hand of `on=false` (and `seconds` 60–300, else the morning): the body drops its booking, and this module stops holding the night's work for a sleep. A skip ends by
 * itself at the morning, at its time, at a death, and when the head sends a sleep (`mode` now or none) or `resume`: it is never left on by forgetting. The skip's reason is the act's `why`.
 */
const SKIP_CAP_MS = 30 * 60_000;
interface Skip { at: number; until: number | null; why: string; sawNight: boolean; death: string }
const skips = new Map<string, Skip>();
const deathOf = (frame: BodyObservation | null): string => {
  const life = frame ? deathCounterOf(frame) : {};
  return `${String(life.deathEpoch ?? '')}:${String(life.deathSeq ?? '')}`;
};

/** For tests: no task has held a sleep. */
export function forgetSleepHolds(): void { holds.clear(); bookings.clear(); skips.clear(); }

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;
const sleeps = (hand: Record<string, unknown>): boolean => hand.do === 'sleep' || hand.do === 'use'
  || (hand.do === 'place' && typeof hand.block === 'string' && BED.test(hand.block));

function sleepWhen(world: Record<string, unknown>): string {
  if (thunderstorm(world)) return '雷雨（時刻に関係なく寝られる）';
  const tick = dayTick(world)!;
  return tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夕方（夜まで ${minutes(NIGHT_FROM - tick)}。もう寝られる）`;
}

/** The skip of a task if it is on: the morning, its time, a death and its cap end it (and it is forgotten). */
function activeSkip(taskId: string, frame: BodyObservation | null, clock: number): Skip | null {
  const skip = skips.get(taskId);
  if (!skip) return null;
  const facts = readinessOf(frame);
  const tick = facts ? dayTick(facts.world) : null;
  const dark = !!facts && (thunderstorm(facts.world) || (tick !== null && tick >= BED_FROM && tick < NIGHT_TO));
  if (dark) skip.sawNight = true;
  const over = deathOf(frame) !== skip.death || (skip.until !== null ? clock > skip.until : clock - skip.at > SKIP_CAP_MS)
    || (skip.sawNight && !dark && !!facts && facts.dimension === 'overworld');
  if (over) { skips.delete(taskId); return null; }
  return skip;
}

/**
 * The sleep hands of an act, read in order: `on=false` starts a skip (and takes the head's own memory of a booking away: the body drops its booking on the same hand),
 * `on=true` ends it, a sleep with no `on` is the head's decision to sleep and ends it too.
 */
function noteSleepModes(hands: readonly unknown[], input: unknown, frame: BodyObservation | null, taskId: string, clock: number): void {
  const why = typeof (input as { why?: unknown } | null)?.why === 'string' ? String((input as { why: string }).why).replace(/\s+/gu, ' ').slice(0, 60) : '';
  for (const raw of hands) {
    const hand = objectOf(raw);
    if (hand?.do !== 'sleep') continue;
    if (hand.on === false) {
      const until = typeof hand.seconds === 'number' && Number.isFinite(hand.seconds) ? clock + Math.min(Math.max(hand.seconds, 60), 300) * 1000 : null;
      skips.set(taskId, { at: clock, until, why, sawNight: false, death: deathOf(frame) });
      if (skips.size > 32) skips.delete(skips.keys().next().value as string);
      bookings.delete(taskId);
    } else skips.delete(taskId);
  }
}

/**
 * The night's sleep as the head's input says it, one line (or null): a skip that is on (with its reason and how long), a booking the body may still keep (the head sent a sleep by
 * day and never hears whether it stands: said with how to take it back), or, at dusk and at night with a bed in the pack, what a sleep costs and when not to sleep, beside the
 * plan's now. `nodeTitle` is the plan's current node (the purpose the sleep is weighed against).
 */
export function sleepStateLine(frame: BodyObservation | null, taskId: string, nodeTitle: string | null, now: () => number = Date.now): string | null {
  const facts = readinessOf(frame);
  if (!facts || facts.dimension !== 'overworld') return null;
  const clock = now();
  const skip = activeSkip(taskId, frame, clock);
  if (skip) {
    const left = skip.until === null ? '朝まで' : `あと ${minutes(Math.max(0, skip.until - clock) / 1000 * 20)}`;
    return `夜の睡眠: 今夜は寝ない（見送り中・${left}。理由: ${skip.why || '書いていない'}）。体の寝る予約は消してある。`
      + `寝る気になったら sleep（on は省く）か ${SLEEP_RESUME}。朝・期限・死亡で自動で戻る`;
  }
  const afloat = noSleepSpot(facts.world);
  const booked = bookings.get(taskId);
  if (booked && clock - booked.at < BOOKING_MS && afloat) {
    return `夜の睡眠: ${AFLOAT_NO_SLEEP}。体に寝る予約が残っているかもしれない（${Math.max(1, Math.round((clock - booked.at) / 60_000))} 分前に sleep の手を送った）。要らなければ ${SLEEP_SKIP} で消す`;
  }
  if (booked && clock - booked.at < BOOKING_MS) {
    return `夜の睡眠: 体に寝る予約が残っているかもしれない（${Math.max(1, Math.round((clock - booked.at) / 60_000))} 分前に sleep の手を送った。体は 25 分まで持ち、夜になり次第、次の手の前で寝る。`
      + `体の側の今の有無は入力に出ない）。${SLEEP_COST}。今夜を使う作業（夜に湧く敵を倒す・夜に急ぐ）か、人が寝ないと言った時は ${SLEEP_SKIP} で予約を消す。寝てよいならそのまま`;
  }
  const tick = dayTick(facts.world), storm = thunderstorm(facts.world);
  if (!storm && (tick === null || tick >= NIGHT_TO || tick < BED_FROM - 1_200)) return null;
  if (![...facts.counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  if (afloat) return null; // the bed's line beside the plan's now says it (`AFLOAT_NO_SLEEP`)
  const effect = storm ? '寝ると雷雨が止む' : SLEEP_COST;
  return `夜の睡眠: ベッドを持っていて、寝る予定になる。${effect}。${nodeTitle ? `今の節「${nodeTitle}」が` : '今の節が'}夜そのもの（夜に湧く敵を倒す・夜のうちに急ぐ）か、人が寝ないと言った時は、${SLEEP_SKIP} を先に出す。`
    + 'ファントムが近い・装備か食料が足りない地上の夜で、夜が目的でなければ寝る';
}

/**
 * The hold (the hand, 1-based, and its line) of an act sent at night with a bed in the pack, or null. `commit` counts it against the bound: the
 * caller calls it when this hold is the one that stops the act (another guard may stop an earlier hand).
 */
export function sleepFirstHold(input: unknown, frame: BodyObservation | null, taskId: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const facts = readinessOf(frame);
  if (!Array.isArray(hands) || !facts || facts.dimension !== 'overworld') return null;
  const clock = now();
  noteSleepModes(hands, input, frame, taskId, clock);
  if (!canSleepNow(facts.world)) {
    if (hands.some(raw => objectOf(raw)?.do === 'sleep' && objectOf(raw)?.on === undefined)) { bookings.set(taskId, { at: clock }); if (bookings.size > 32) bookings.delete(bookings.keys().next().value as string); }
    return null;
  }
  // 11/26: afloat with no floor beside her, no sleep can come: the work (a furnace's take) is not held for it.
  if (noSleepSpot(facts.world) || enemyNear(facts.world) || activeSkip(taskId, frame, clock)) return null;
  const booked = bookings.get(taskId);
  if (booked && clock - booked.at < BOOKING_MS) {
    booked.night ??= clock;
    if (clock - booked.night < BOOKING_GRACE_MS) return null;
    bookings.delete(taskId);
  }
  const bed = [...facts.counts].find(([name, count]) => BED.test(name) && count > 0)?.[0];
  if (!bed) return null;
  const at = hands.findIndex(raw => WORK.has(String(objectOf(raw)?.do ?? '')));
  if (at < 0 || hands.slice(0, at).some(raw => sleeps(objectOf(raw) ?? {}))) return null;
  const recent = (holds.get(taskId) ?? []).filter(when => clock - when < SLEEP_WINDOW_MS);
  if (recent.length >= SLEEP_HOLDS) return null;
  const when = sleepWhen(facts.world);
  const effect = thunderstorm(facts.world) ? '雷雨が止む' : '夜が飛び、朝になる';
  const line = `${when}・ベッドを持っている（${bed.replace(/^minecraft:/u, '')}）・8m 内に敵はいない。`
    + `今夜は寝る場面か、寝ない場面かを先に決めて送り直す（${recent.length + 1}/${SLEEP_HOLDS} 回目。${SLEEP_HOLDS} 回止めた後は通す）。`
    + `寝る場面: 寝る前の作業（掘る・作る・焼く・箱）は送らず、sleep の手（ベッドを置いて寝て、朝に拾い直す）で${effect}（地下でも寝られる。ネザー・エンドでは爆発する）。`
    + '寝られなかった時は返った理由（置けない・敵が近い）を直す手（dig で 2 マス空ける・離れる・囲う）を出す。作業は寝た後にもう一度出す。'
    + `寝ない場面: ${thunderstorm(facts.world) ? '人が寝ないと言った時や、今の節が雷雨の中そのものの時' : `今の節や依頼が夜そのもの（夜に湧く骸骨・ゾンビ・エンダーマンを倒す・夜のうちに急ぐ）の時と、人が寝ずにと言った時（理由: ${SLEEP_COST}）`}。この作業を送り直す act の先頭に ${SLEEP_SKIP} を入れる（この止めはその場で外れる）`;
  return { hand: at + 1, kind: String(objectOf(hands[at])?.do), line, commit: () => { holds.set(taskId, [...recent, clock]); } };
}
