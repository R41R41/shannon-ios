import type { ItemCounts } from './minecraftItems.js';

/** Drops worth a walk back for: tools of iron or better, a bucket, a bed, a shield or a bow, cooked food, and what the End asks for. */
const WORTH_FETCHING = /^(?:(?:iron|diamond|netherite)_[a-z]+|diamond|ender_eye|ender_pearl|blaze_rod|blaze_powder|bucket|water_bucket|lava_bucket|[a-z_]+_bed|shield|bow|flint_and_steel|cooked_[a-z]+)$/u;
/** Those that take a trip to have again (the diamonds' depth, a fortress, the endermen): tens of minutes, where iron takes a few. */
const SLOW_TO_REMAKE = /^(?:(?:diamond|netherite)_[a-z]+|diamond|ender_eye|ender_pearl|blaze_rod|blaze_powder)$/u;
/** About how fast she covers ground on her way to the place she died (run 20: 117 m in 50 s and 91 m in 25 s). */
const WALK_METRES_PER_SECOND = 2.5;
/** A fetch farther than this is said to be far (the caves on the way, the night). */
const FAR_FETCH_METRES = 150;
/** The body's row for a remembered place: `178m 南 (-125,75,839)`. */
const DEATH_ROW = /^(\d{1,5})m\s+\S{1,4}\s+\(/u;

/** The first few of what she dropped, as `name×n・…`, or null. */
export function dropsList(drops: ItemCounts | null): string | null {
  return drops ? [...drops].slice(0, 4).map(([name, count]) => `${name}×${count}`).join('・') : null;
}

/** The decision's line about the drops left at her death: what they are, and `advice` (or the old words when there is none). */
export function dropsReminder(list: string, advice: string | null): string {
  return `死んだ所に落とし物が残っている（${list}）。${advice ?? '消える前に拾いに戻る'}（recall-places の死亡地点、pickup-nearest-item）`;
}

/**
 * What the drops of her death are worth beside the walk to them (mb-r20): run 20 went 400 m for stone tools and an iron pickaxe after a
 * respawn at the world's first spawn, and the body fell out of the server on the way. The distance and the walk's time, the drops that
 * are worth fetching (those that take tens of minutes to have again are said so), and what is quicker to make again. Fixed words
 * with closed facts; null without a death place or any drops.
 * `drops` are those she can still pick up (`recoverableDrops`, `minecraftSkillPointers.ts`).
 */
export function dropsAdvice(world: Record<string, unknown>, drops: ItemCounts | null): string | null {
  const places = world.rememberedPlaces && typeof world.rememberedPlaces === 'object' ? world.rememberedPlaces as Record<string, unknown> : null;
  const row = places?.death;
  const found = typeof row === 'string' ? DEATH_ROW.exec(row.trim()) : null;
  if (!drops || !found) return null;
  const metres = Number(found[1]), seconds = Math.round(metres / WALK_METRES_PER_SECOND);
  const fetchable = [...drops.keys()].filter(name => WORTH_FETCHING.test(name));
  // The slow ones first, so that the four that are named keep them.
  const slow = fetchable.filter(name => SLOW_TO_REMAKE.test(name)).slice(0, 4);
  const worth = [...slow, ...fetchable.filter(name => !SLOW_TO_REMAKE.test(name))].slice(0, 4);
  // The body ages the drops only within 160 m of her (their chunk is ticked there); its last-death row says the minutes left.
  const head = `死んだ所まで${metres}m（歩いて約${seconds}秒）。落とし物が消えるまでの5分は、約160m以内にいる間だけ減る（離れている間は残る）。`;
  if (!worth.length) return `${head}拾う値打ちのある物（鉄以上の道具や防具・バケツ・ベッド・エンダーアイ・パール・ブレイズロッドなど）は無い。その場で作り直すほうが早い`;
  const far = metres > FAR_FETCH_METRES ? '。遠い（途中の洞窟や夜に注意）' : '';
  if (slow.length) return `${head}拾う値打ちのある物: ${worth.join('・')}。${slow.join('・')}は作り直しに数十分かかる（ダイヤ探し・ネザー・エンダーマン狩りのやり直し）ので、戻る値打ちが高い${far}`;
  return `${head}拾う値打ちのある物: ${worth.join('・')}。往復の時間と、作り直す時間（鉄の精錬を含めて数分）を比べて決める${far}`;
}
