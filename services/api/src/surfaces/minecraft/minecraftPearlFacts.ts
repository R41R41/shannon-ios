import { carried } from './minecraftConditions.js';

/**
 * The pearls still to find, said as numbers beside the choices (the pearl forest scenes of 11/3: with 18 gold and 2 endermen in 10 minutes the
 * model fought on and never set the trade against the wait): how many are carried (pearls and eyes, an eye was a pearl), how many are
 * missing of the 13 the road aims at (run 9, 11/13: 12 eyes for the frames, one more for the one in five that breaks), and what the gold carried gives at a piglin's 15.6 ingots to one pearl on average (S6 read the 1.21.11
 * barter table: weight 10 of 469, 2 to 4 pearls). Only numbers the body
 * reported; it names no way to get them.
 */
export const PEARL_TARGET = 13;
export const GOLD_PER_PEARL = 15.6;

/** The line for a decision in the Nether with rods in hand and pearls missing, or null. Both ways are set side by side in the same units
 * (end1108c and h28 in a warped forest: with no gold the line still named only the trade, and Haiku twice left the endermen to dig nether
 * gold ore and chase nuggets). An enderman drops 0 or 1 pearl evenly (0.5 on average); a nether gold ore drops 2 to 6 nuggets, 9 nuggets
 * make an ingot, so one pearl by trade is about 140 nuggets or 35 ores. */
const PEARLS_PER_ENDERMAN = 0.5;
const NUGGETS_PER_INGOT = 9;
const NUGGETS_PER_ORE = 4;
/** What leaving with 12, 13 or 14 eyes risks: the frames take 12 and one in five thrown breaks (S9's counts of the frames lacking an eye). */
const PEARL_ODDS = `${PEARL_TARGET} で出る：アイ 12 だと枠が足りない見込み約 1 割強、13 で約 3%、14 で約 0.2%`;
export function pearlLine(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'the_nether') return null;
  const have = carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
  const rods = carried(counts, 'blaze_rod') + carried(counts, 'blaze_powder');
  if (have >= PEARL_TARGET || (rods === 0 && have === 0)) return null;
  const missing = PEARL_TARGET - have;
  const gold = carried(counts, 'gold_ingot');
  const trade = Math.round(gold / GOLD_PER_PEARL * 10) / 10;
  const nuggets = Math.round(GOLD_PER_PEARL * NUGGETS_PER_INGOT);
  const ores = Math.round(nuggets / NUGGETS_PER_ORE);
  return `パール ${have}/${PEARL_TARGET}（あと ${missing} 個・約 ${Math.ceil(missing / PEARLS_PER_ENDERMAN)} 体）。`
    + `${PEARL_ODDS}。エンダーマン 1 体で平均 ${PEARLS_PER_ENDERMAN} 個。`
    + `ピグリンとの交換は金の延べ棒 ${GOLD_PER_PEARL} 個（金塊 約 ${nuggets} 個・ネザー金鉱石 約 ${ores} 個）で平均 1 個、`
    + `持っている金の延べ棒 ${gold} 個では平均 約 ${trade} 個`;
}

/**
 * The search for a warped forest, as lines beside the pearl line (run 9, 11/12: after the 7 rods she scanned 0 times, never saw the biomes she
 * had passed, took the way back for the pearls and found none in about 1,100 s). Only while she is in the Nether with the rods in hand and the
 * pearls missing: the biomes the body reports (`world.biomesSeen`), where a warped forest was seen or none, how many times she searched and
 * scanned, the way back to the gate, and the two hunts' numbers side by side. Numbers and what the body said; nothing here stops a way.
 */
export const RODS_FOR_EYES = 7;
/** How fast a go covers the Nether's ground (it says so beside the way to the gate). */
export const WALK_BLOCKS_PER_SECOND = 1.2;
export const SEARCH_GO_BLOCKS = 90;
/** The eyes (a pearl is an eye to be) at which the plan leaves for the overworld; below it the search for pearls goes on in the Nether. */
export const EYES_TO_LEAVE = 13;
/** Rods in hand as the plan counts them: two powder make one rod's worth. */
const rodsCarried = (counts: ReadonlyMap<string, number>): number => carried(counts, 'blaze_rod') + Math.floor(carried(counts, 'blaze_powder') / 2);
export const searchingForPearls = (counts: ReadonlyMap<string, number>, dimension: string | null): boolean =>
  dimension === 'the_nether' && rodsCarried(counts) >= RODS_FOR_EYES
  && carried(counts, 'ender_pearl') + carried(counts, 'ender_eye') < EYES_TO_LEAVE;
/** Searches (a scan, then a go) after which a forest still unseen sends the plan on to its last way. */
const SEARCHES_BEFORE_LAST_WAY = 6;
const LAST_WAY = 'エンダーパールの節の探す節を skip と理由で閉じ、地上の夜の手へ';

export interface PearlSearch { scans: number; goes: number }
const textOf = (value: unknown): string => typeof value === 'string' ? value : '';
const placeRow = (world: Record<string, unknown>, kind: string): string => {
  const places = world.rememberedPlaces;
  return places && typeof places === 'object' && !Array.isArray(places) ? textOf((places as Record<string, unknown>)[kind]) : '';
};

export function pearlSearchLines(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null,
  search: PearlSearch): string[] {
  if (!searchingForPearls(counts, dimension)) return [];
  const biomes = textOf(world.biomesSeen).slice(0, 300);
  const entry = biomes.split(/[・,、]/u).map(item => item.trim()).find(item => /^warped_forest(?!\s*未見)/u.test(item));
  const place = placeRow(world, 'warped_forest');
  const forest = place ? `歪んだ森 ${place.slice(0, 60)}` : entry ? entry : null;
  const gate = /^(\d+)m/u.exec(placeRow(world, 'nether_portal'));
  const toGate = gate ? `ゲートまで ${gate[1]}m（歩いて 約 ${Math.round(Number(gate[1]) / WALK_BLOCKS_PER_SECOND)} 秒）。` : '';
  const lines = [`ネザーでロッド ${RODS_FOR_EYES} 本・パールが足りない間の歪んだ森: ${forest ?? '未見'}。探した回数（走査→go の組） ${search.goes}（走査 ${search.scans} 回）。${toGate}`
    + `探すなら 1 回 ${SEARCH_GO_BLOCKS}m ≈ ${SEARCH_GO_BLOCKS} 秒（${SEARCH_GO_BLOCKS}m の go は seconds 100〜120。ネザーは走りが切れるので既定の 60 秒を超える）。`
    + '歪んだ森の狩り：場所を手で決めたラボで 25 分 11 個、頭が場所を選んだ実走は 26〜30 分で 3〜8 個（平均約 5）。囲まれた所を抜けた後は 5 分で 4 個。'
    + '現世の夜：9 回目は約 1,100 秒で 0 個'];
  if (biomes) lines.push(`通ったバイオーム: ${biomes}`);
  // The body's place row for a warped forest is a stand cell read from a far column (round 12): its y is a rough guide, not a height to trust.
  if (place) lines.push('歪んだ森の控え: y は目安。控えの座標は方角として使い、go の行き先は scan の幹（warped_stem）の位置から選ぶ');
  lines.push(forest
    ? `歪んだ森が見えている: 90m ごとの go で寄り、屋根の場所を読んで fight target=enderman。パールとアイがそろってから現世へ戻る（黒曜石 12 はピグリンとの交換でも出る）。着けない・狩りが進まない時: ${LAST_WAY}`
    : search.goes >= SEARCHES_BEFORE_LAST_WAY
      ? `探した回数 ${search.goes}。1 回は約 ${SEARCH_GO_BLOCKS} 秒。現世の夜は 9 回目で約 1,100 秒・0 個。歪んだ森はまだ見えない: ネザーで探し続けるか、${LAST_WAY} か、選ぶのは頭`
      : '次の手: mc_probe kind=scan → 見えていない向きへ 90m の go → 走査。ネザーに居たまま集め、パールとアイがそろってから現世へ戻る（黒曜石 12 はピグリンとの交換でも出る）');
  return lines;
}

/** What a rod and a pearl cost to collect again, in seconds (run 9: 6 rods in 250 s; pearls by a head that chose the place, about 5 in 28 minutes). */
export const SECONDS_PER_ROD = 42;
export const SECONDS_PER_PEARL = 300;
/**
 * The cost of dying here, as a material and no gate: in the Nether with rods or pearls in the pack, what a death drops and about how long collecting it again
 * takes. Null with neither, or outside the Nether.
 */
export function deathLossLine(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'the_nether') return null;
  const rods = rodsCarried(counts), pearls = carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
  if (rods <= 0 && pearls <= 0) return null;
  const seconds = Math.round((rods * SECONDS_PER_ROD + pearls * SECONDS_PER_PEARL) / 10) * 10;
  return `ここで死ぬとロッド ${rods}・パール ${pearls} を落とす（集め直しに約 ${seconds} 秒）`;
}
