import { BEFORE_END, BEFORE_END_FALLBACK, END_GATHER_MS, END_MIN_FOOD, endGatherSince } from './minecraftLlmcPrepRules.js';
export { END_GATHER_MS, forgetEndGather } from './minecraftLlmcPrepRules.js';
import { lackOfTable, type readinessOf } from './minecraftLlmcReadiness.js';

/**
 * The end of the beds' gathering at the End's gate (the pre-deploy review of 11/5, item 8: the beds 8 and the fight obsidian 8 were required with
 * no end, and a world short of them kept her looking into the night; the fallback, crystals with the bow and the sword on the perched dragon, could
 * not pass). The first time the gate holds the entry of a task for the beds' way, a clock starts (`endGatherSince`; the End's check,
 * `preparationShortage`, only reads it); after `END_GATHER_MS` the entry passes with the fallback's kit (`BEFORE_END_FALLBACK`: blocks, water,
 * food, an iron sword; the bow and 30 arrows are aims since thru-1110, 11/9). The line says the time left and what the fallback still lacks.
 * Kept per process (a restart gives the gathering its time again).
 *
 * The review of 11/10, G12: the food of the beds' way (330) alone holds nothing. She leaves the surface with 330 and eats on the way, so a full
 * kit came to the frames a few points short, and the hold started ten minutes in a room where no food can be added. With the fallback's food
 * (`END_MIN_FOOD`) and the rest of the beds' way she goes in; the beds, the fight obsidian, the blocks and the water hold as before.
 */
type Facts = NonNullable<ReturnType<typeof readinessOf>>;

/** What the first entry lacks in words, or null when it may go in (the beds' way, or the fallback after the gathering's time). */
export function firstEntryLack(facts: Facts, taskId: string | undefined, now: () => number = Date.now): string | null {
  const main = lackOfTable(facts, BEFORE_END);
  if (!main || !lackOfTable(facts, { ...BEFORE_END, food: END_MIN_FOOD })) return null;
  if (!taskId) return main;
  const fallback = lackOfTable(facts, BEFORE_END_FALLBACK);
  const clock = now(), since = endGatherSince(taskId, clock, true) ?? clock;
  const left = END_GATHER_MS - (clock - since);
  if (!fallback && left <= 0) return null;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  const after = fallback ? '予備の手（止まり木の竜を剣・あれば弓でクリスタル）の必須もそろっていない（鉄以上の剣・積める物・水入りバケツ・食料）'
    : `ベッド・戦い用の黒曜石・食料を集めるのは、最初に止めてから ${END_GATHER_MS / 60_000} 分まで（残り約 ${minutes} 分）。過ぎると、そろっている予備の手`
      + '（鉄以上の剣・食料 80 点。弓と矢はあれば使う）で入れる。地上へ取りに戻る往復はこの残りより長い: 近くで足せなければ、ここで待って入る方が速い';
  return `${main}。${after}`;
}
