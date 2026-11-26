import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readActResult, type ActHand } from '../../contracts/minecraftActContract.js';
import { carried } from './minecraftConditions.js';
import { endermenNear } from './minecraftEnderHunt.js';
import { carriedItemCounts } from './minecraftItems.js';
import { world } from './minecraftLlmcHealth.js';
import { GOLD_PER_PEARL, PEARL_TARGET } from './minecraftPearlFacts.js';

/**
 * One fact for the head, said as a fact; what to do with it is the model's (no hand is changed or refused).
 *
 * The end run of 11/26 (Haiku): for about 14 minutes the head sent `fight target=enderman` at the same enderman again and again, each time from a roof
 * that could not reach it (the roof's lid hid its eyes; it was 3 to 23 below with no way to walk there). Nine or more stops in a row, no blow, no pearl, and
 * no other individual or other way tried. Each stop's own words already said "pick the place or the target again"; what no line said was the count:
 * how many times in a row, how long, what the pearls did, who else was near, and what else carried pearls. The body's own tally
 * (`#58 へは N 回目の fight`, read by `minecraftEnderHunt.ts`) is only in some of the body's words and only said while that one is near, in the
 * lines an urgent decision drops. This one is counted by the head from the results it saw, and rides with the failure facts.
 */

/** Stops in a row at one target before the line is said (earlier, one try is a try). */
export const REPEAT_MIN = 3;
/** The line is not said once the last fight is older than this (ms): a new situation, not the same hunt. */
const STALE_MS = 10 * 60_000;

interface Streak {
  key: string;
  label: string;
  stops: number;
  firstAt: number;
  lastAt: number;
  pearls0: number | null;
  landed: number;
  landedSeen: boolean;
  code: string | null;
  codeCount: number;
}
const tasks = new Map<string, Streak>();

export function forgetFightRepeats(): void { tasks.clear(); }

const pearlsOf = (observation: BodyObservation | null): number | null => {
  if (!observation) return null;
  const counts = carriedItemCounts(world(observation), observation.facts ?? {});
  return carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
};

/** The hand a result line belongs to: by `i` (0- or 1-based, whichever is a fight), else the only fight hand. */
function handOf(hands: readonly Partial<ActHand>[], i: number): Partial<ActHand> | undefined {
  const at = [hands[i], hands[i - 1]].find(hand => hand?.do === 'fight');
  return at ?? (hands.filter(hand => hand?.do === 'fight').length === 1 ? hands.find(hand => hand?.do === 'fight') : undefined);
}

/** Who a fight line was at: the `#id` its words name (the body names the one it chose), else the hand's own target. */
function targetOf(text: string, hand: Partial<ActHand> | undefined): { key: string; label: string } {
  const kind = /\b([a-z_]+) #(\d+)/u.exec(text);
  if (kind) return { key: `#${kind[2]}`, label: `${kind[1]} #${kind[2]}` };
  const asked = typeof hand?.target === 'string' ? hand.target.trim() : '';
  return asked ? { key: asked, label: asked } : { key: 'fight', label: '相手' };
}

/**
 * The same target? Two ids are the same only when equal. A line that names no id (the body's 「届かない（元: …」 words do not always carry one) is
 * the same hunt as the id of its own kind: the 11/26 run's stops alternated between the two shapes, and a reset per switch kept the count under the line.
 */
function sameTarget(streak: Streak, target: { key: string; label: string }): boolean {
  if (streak.key === target.key) return true;
  const isId = (key: string): boolean => key.startsWith('#');
  if (isId(streak.key) === isId(target.key)) return false;
  const [named, bare] = isId(streak.key) ? [streak.label, target.key] : [target.label, streak.key];
  // The 11/26 run's stops (a missing_item among them) carry no id in their words, so the label was the hand's own `#18`; the head then called by kind
  // (`enderman`) and back by id, and each switch started the count again under the line. A label that is a bare id has no kind to compare: a kind
  // call counts as the same hunt (the body picks the last individual again when no other is in sight). `fight` alone names nothing.
  return named.startsWith(`${bare} #`) || (/^#\d+$/u.test(named) && bare !== 'fight');
}

/**
 * An act of the task ended: its fight lines, in order, counted as a streak at one target. A kill or a done fight, or a fight at another target, starts
 * the count again; a line that did not run (cut before it started) is not a try.
 */
export function noteFights(taskId: string, input: unknown, resultJson: string | undefined, observation: BodyObservation | null, now: number): void {
  const result = readActResult(resultJson);
  const hands = (input as { hands?: readonly Partial<ActHand>[] } | null | undefined)?.hands;
  if (!result || !Array.isArray(hands)) return;
  for (const line of result.lines) {
    if (line.do !== 'fight' || line.end === 'not_run' || line.goal === 'not_started' || line.status === 'skipped') continue;
    if (line.status === 'done' || line.code === 'target_killed') { tasks.delete(taskId); continue; }
    const target = targetOf(line.line, handOf(hands, line.i));
    let streak = tasks.get(taskId);
    if (!streak || !sameTarget(streak, target) || now - streak.lastAt > STALE_MS) {
      streak = { ...target, stops: 0, firstAt: now, lastAt: now, pearls0: pearlsOf(observation), landed: 0, landedSeen: false, code: null, codeCount: 0 };
      tasks.set(taskId, streak);
      if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
    }
    streak.stops += 1;
    streak.lastAt = now;
    if (target.key.startsWith('#') || !streak.key.startsWith('#')) {
      const keepLabel = target.key === streak.key && streak.label.length > target.label.length;
      streak.key = target.key;
      if (!keepLabel) streak.label = target.label;
    }
    const hit = /与えた打撃 (\d+)/u.exec(line.line);
    if (hit) { streak.landed += Number(hit[1]); streak.landedSeen = true; }
    const code = line.code ?? null;
    if (code === streak.code) streak.codeCount += 1; else { streak.code = code; streak.codeCount = 1; }
  }
}

/** The line, or none: said once `REPEAT_MIN` stops in a row at one target are counted and the last is not stale. */
export function fightRepeatLines(taskId: string, observation: BodyObservation | null, now: number): string[] {
  const streak = tasks.get(taskId);
  if (!streak || streak.stops < REPEAT_MIN || now - streak.lastAt > STALE_MS) return [];
  const minutes = Math.max(1, Math.round((now - streak.firstAt) / 60_000));
  const pearls = pearlsOf(observation);
  const gain = pearls !== null && streak.pearls0 !== null ? `パール ${pearls >= streak.pearls0 ? '+' : ''}${pearls - streak.pearls0}（${pearls}/${PEARL_TARGET}）` : null;
  const byId = streak.key.startsWith('#');
  const near = byId ? endermenNear(world(observation)).filter(item => `#${String(item.id)}` !== streak.key) : endermenNear(world(observation));
  const others = near.length ? `近くの別のエンダーマン ${near.length} 体（最寄り ${Math.round(near[0]!.distance)}m）` : '近くに別のエンダーマンは見えていない';
  const gold = carried(carriedItemCounts(world(observation), observation?.facts ?? {}), 'gold_ingot');
  const parts = [`${streak.label} への fight が ${streak.stops} 回続けて止まった（最初から ${minutes} 分`
    + `${gain ? `・${gain}` : ''}${streak.landedSeen ? `・与えた打撃 計 ${streak.landed}` : ''}）`];
  if (streak.code) parts.push(`直近の止まりの code: ${streak.code}（${streak.codeCount} 回続き）`);
  parts.push(others);
  // The body's pick for `fight target=enderman` goes back to the individual it missed in a row when no other one is in sight (11/26: the head wrote "call
  // by kind to pick another" and the body chose the same #18 for about 20 calls). Said as the body's rule with its reason; no call is refused.
  if (byId && observation) {
    parts.push(`種類（fight target=enderman）で呼んでも、目の見える別の個体が居なければ体は同じ ${streak.key} を選び直す（連続で外した個体は、他に選べる個体が無い時だけ戻るため）。`
      + `いま近くの別の個体は ${near.length} 体（壁や屋根で目が見えない個体は選ばれない）`);
  }
  parts.push('この回数は、種類で呼んだ fight と、missing_item など個体の名前が結果に無い止まりも、同じ相手への 1 回に数えた、この実走の結果の数');
  parts.push(`パールの別の手: ピグリンとの交換（金の延べ棒 ${GOLD_PER_PEARL} 個で平均 1 個。いま持っている金の延べ棒 ${gold} 個）、別の場所の屋根、屋根なしの戦い`);
  return [`${parts.join('。')}。同じ相手は、相手と自分の位置が変わらない限り何度呼んでも届かない。同じ手を続けるか、別の個体・場所・手に変えるかは、この回数と時間を見て決める`];
}
