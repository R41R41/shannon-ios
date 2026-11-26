/**
 * Run 43 (2026-10-27): the pack's food was 39.6 points; the plan's condition `food>=40` judged it short, and the live said 「食料 40/40 点」 (the
 * meter, the plan's now) beside 「食料 39.6 点」 (recovery). The node of the preparation stayed the now for 2,126 s, its meter 「1,801 秒遅れ」, while
 * the model read the food as met. Every line says the food points as the conditions judge them (one decimal, the same value), and what is short
 * with what fills it.
 */
import { COOKED_FOOD } from './minecraftFoodPreparation.js';
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** One food that fills a gap of points (the smallest that does, of foods a village or a hunt gives; the pack's own food is already counted). */
const FILLERS: ReadonlyArray<readonly [string, number]> = [['potato', 1.6], ['sweet_berries', 2.4], ['apple', 6.4], ['bread', 11], ['cooked_beef', 20.8]];
/** A gap this small (an apple's worth) is filled by any one food: the meat is named only for a larger one. */
const TRIVIAL_GAP = 6.4;
/** What cooking the raw meat she carries would add (`cookingOf`): the points gained and the seconds in one furnace. */
export interface CookingGain { gain: number; seconds: number }
export function foodFill(gap: number, cook?: CookingGain | null): string {
  // (a request to fight: 12.8 points carried as raw mutton, 62 if cooked, and the line said bread 3): the meat she carries comes first, since cooking it
  // costs 10 seconds a piece in a furnace and needs no hunt.
  if (cook && gap > TRIVIAL_GAP && cook.gain >= gap - 1e-9) return `持っている生肉を焼く（+${round1(cook.gain)} 点・かまど 1 基で ${cook.seconds} 秒）`;
  const one = FILLERS.find(([, points]) => points >= gap - 1e-9);
  const rest = one ? `${one[0]} 1 個` : `bread ${Math.ceil(gap / 11 - 1e-9)} 個`;
  return cook && gap > TRIVIAL_GAP && cook.gain > 0 ? `持っている生肉を焼いて +${round1(cook.gain)} 点（${cook.seconds} 秒）、足りない分は ${rest}` : rest;
}

/**
 * The safe amount beside a least (2026-11-11, run 7: the least was all the plan said): the preparation's 40 is safe at 100, the gate's 100 at 150, the Nether's depth
 * 200 at 300 and the End's 330 at 400. Said only once the least is met (below it the line is as it was). Null for a need that is not one of the gates'.
 */
export function foodComfort(need: number): number | null {
  if (need === 40) return 100;
  if (need === 100) return 150;
  if (need === 200) return 300;
  return need === 330 ? 400 : null;
}

/**
 * The village's hay as a fact beside the points (run 8, 2026-11-13: hay stood near and only the least was taken): said only while the body counts hay near.
 * One hay block is three bread, about 33 points; the hand and the amount are the model's.
 */
export function villageHayWords(hay: number | null | undefined): string {
  if (hay === null || hay === undefined || hay <= 0) return '';
  return `村の干し草 ${hay} 個＝約 ${Math.round(hay * 33)} 点（1 個 2〜3 秒・下りると戻らない・必要は ネザー奥 100〜200・エンド 330）`;
}

/** The food points as every line says them: 「食料 39.6 点」, or against a need 「食料 39.6/40 点（あと 0.4 点: potato 1 個）」; the village's hay (when near) after the safe amount. */
export function foodPointsWords(food: number, need?: number, hay?: number | null, cook?: CookingGain | null): string {
  const have = round1(food);
  if (need === undefined) return `食料 ${have} 点`;
  if (have >= need) {
    const comfort = foodComfort(need);
    if (comfort === null || have >= comfort) return `食料 ${have}/${need} 点`;
    const hayWords = villageHayWords(hay);
    return `食料 ${have}/${need} 点・安心 ${comfort} 点まであと ${round1(comfort - have)} 点${hayWords ? `（${hayWords}）` : ''}`;
  }
  const gap = round1(need - have);
  return `食料 ${have}/${need} 点（あと ${gap} 点: ${foodFill(gap, cook)}）`;
}

/**
 * Run 7 of 11/26 (the food line said 「食料 0 点」 while 20 raw porkchops burned in a furnace for 84 more seconds, about 416 points; the head swam on for fish and came back 170 m):
 * what a furnace holds is food too, and it is not in the pack, so the pack's points do not count it. The reading of the frame's jobs (`world.jobs`: `status`, `input`, `count`,
 * `expects`, `remainingEstimateMs`); the points are those of the cooked food. A fact beside the points; what to do with it stays the decision's.
 */
export interface FurnaceFood { points: number; leftSeconds: number; words: string }
const COOKED_WORD: Readonly<Record<string, string>> = {
  cooked_porkchop: '焼き豚肉', cooked_beef: '焼き牛肉', cooked_mutton: '焼き羊肉', cooked_chicken: '焼き鶏肉', cooked_rabbit: '焼き兎肉',
  cooked_cod: '焼き鱈', cooked_salmon: '焼き鮭', baked_potato: '焼きじゃがいも',
};
const COOKED_NAMES: ReadonlySet<string> = new Set(Object.values(COOKED_FOOD));
export function furnaceFoodOf(jobs: unknown, values: Readonly<Record<string, number>>): FurnaceFood | null {
  if (!Array.isArray(jobs)) return null;
  const parts: string[] = [];
  let points = 0, left = 0;
  for (const item of jobs) {
    const job = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!job || job.status !== 'waiting_external' || typeof job.remainingEstimateMs !== 'number' || !Number.isFinite(job.remainingEstimateMs)) continue;
    const expects = typeof job.expects === 'string' ? /^([a-z_]+)(?:\s*[×x]\s*(\d+))?/u.exec(job.expects.replace(/^minecraft:/u, '')) : null;
    const input = typeof job.input === 'string' ? job.input.replace(/^minecraft:/u, '') : '';
    const cooked = expects?.[1] ?? COOKED_FOOD[input];
    const total = expects?.[2] ? Number(expects[2]) : typeof job.count === 'number' ? job.count : 0;
    // the ones the fuel does not reach are not cooking (the ledger says so): not counted as food coming
    const count = total - (typeof job.unfueledInputCount === 'number' && job.unfueledInputCount > 0 ? job.unfueledInputCount : 0);
    const each = cooked ? values[cooked] : undefined;
    if (!cooked || !COOKED_NAMES.has(cooked) || each === undefined || !Number.isFinite(each) || !(count > 0)) continue;
    const gain = round1(each * count), seconds = Math.max(0, Math.round(job.remainingEstimateMs / 1000));
    points += gain;
    left = Math.max(left, seconds);
    const name = `${COOKED_WORD[cooked] ?? cooked} ${count}`;
    parts.push(seconds > 0 ? `かまどに${name}が焼き途中、あと ${seconds} 秒で約 ${Math.round(gain)} 点` : `かまどに${name}が焼き上がり（取れば約 ${Math.round(gain)} 点）`);
  }
  return parts.length ? { points: round1(points), leftSeconds: left, words: parts.join('／') } : null;
}

/** Below this fullness she cannot sprint (and at 0 she starves). */
const NO_SPRINT_BELOW = 6;
/**
 * How long the fullness lasts, from the loss measured in the last five minutes (the state's `fullnessLostIn5min`), as minutes: the pack's food is not needed before that.
 * Null with no measure. A reading, not a promise (the hidden saturation moves it).
 */
export function fullnessMarginWords(fullness: number, lostIn5min: number | null, health?: number | null): string | null {
  if (!Number.isFinite(fullness) || lostIn5min === null || !Number.isFinite(lostIn5min)) return null;
  const have = round1(fullness);
  if (lostIn5min <= 0) return `満腹 ${have}/20・この 5 分は減っていない（目安）`;
  const to = (level: number): number => Math.max(5, Math.round(Math.max(0, fullness - level) * 5 / lostIn5min / 5) * 5);
  const regen = health !== null && health !== undefined && health < 20 && fullness < 18;
  const tail = regen ? '体力が戻っていない（満腹 18 未満）ので食べる' : fullness > NO_SPRINT_BELOW + 2 ? '今は食べなくてよい' : '食べる時が近い';
  return `満腹 ${have}/20・${round1(lostIn5min)} 減るのに約 5 分 → ${fullness > NO_SPRINT_BELOW ? `走れなくなる ${NO_SPRINT_BELOW} まで約 ${to(NO_SPRINT_BELOW)} 分・` : '走れない値・'}0 まで約 ${to(0)} 分（目安）。${tail}`;
}
