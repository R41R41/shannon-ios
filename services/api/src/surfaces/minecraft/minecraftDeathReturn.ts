import type { DoneFacts } from './minecraftConditions.js';
import { carried } from './minecraftConditions.js';
import { WALK_METRES_PER_SECOND } from './minecraftDropsAdvice.js';
import { PEARL_TARGET, RODS_FOR_EYES, SECONDS_PER_PEARL, SECONDS_PER_ROD, WALK_BLOCKS_PER_SECOND as NETHER_WALK_BLOCKS_PER_SECOND } from './minecraftPearlFacts.js';

/**
 * The way back to the drops of a death in another dimension, as one block for the decision (11/15c: c1 burned at the blaze spawner at 417 s and
 * w1109r at 649 s, both woke in the overworld, and neither went back nor gathered the rods again: c1's d0094, an urgent decision, said 「the portal
 * location unknown」 (the 控え line of the remembered gate is not in the urgent version), d0137 took the drops for gone after 5 minutes, and r's
 * d0361 knew they wait but not where its gate was, 1,056 m off). The body ages a death's drops only while their chunk is loaded (it counts the
 * time she is within 160 m of them in that dimension), so the block says that as a condition, not that they stay.
 *
 * While the newest death is in another dimension than hers, the body still says its drops can be picked up (`world.lastDeath` 「…→拾いに戻れる」),
 * it is at most `SHOWN_MINUTES` old, it was not in lava or the void (what falls there is gone), and she has not given it up (`givenUp`, the act
 * whose why says 「落とし物は捨てる」), the block says: where the drops are and what (the death's dimension and place), the way back by the gate
 * the body remembers in this dimension (`rememberedPlaces`: its place and distance, its other end, and from there to the drops), the condition of
 * their lifetime, what the road's targets lack now (the rods and the pearls, with what lies in the drops and what gathering it again takes), and
 * her health, hunger and food. Fixed words with closed facts: whether to go back or leave them is the decision's; the body goes nowhere by itself.
 */
export const SHOWN_MINUTES = 20;
/** The words of an act's why that give the drops up (the block says the first). */
export const GIVE_UP_WORDS = '落とし物は捨てる';
const GIVE_UP = /落とし物(?:は|を)?(?:捨て|諦め|あきらめ|拾わない|取りに戻らない|放棄)/u;
/** The body's line of the last death: 「3分前 the_nether (149,74,75)「…」 落とした物: …。消えるまで最長約5分（近くにいる間だけ減る）→拾いに戻れる」. */
const DEATH_HEAD = /^(\d+)\s*(分|秒)前 (?:minecraft:)?([a-z_]+) \((-?\d+),(-?\d+),(-?\d+)\)/u;
/** A remembered place's row: 「87m 北 (138,79,102) ↔nether(17,70,12)」 (the pair is the body's note of a gate gone through). */
const PLACE_ROW = /^(\d{1,6})m\s+\S{1,4}\s+\((-?\d+),(-?\d+),(-?\d+)\)/u;
const PAIR_NOTE = /↔([a-z_]+)\((-?\d+),(-?\d+),(-?\d+)\)/u;
const GONE_IN = /lava|溶岩|void|虚空|out of the world/iu;

type Cell = { x: number; y: number; z: number };
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const bare = (dimension: string): string => dimension.replace(/^minecraft:/u, '').replace(/^the_/u, '');
const metres = (a: Cell, b: Cell): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
const walk = (distance: number, dimension: string): number =>
  Math.round(distance / (bare(dimension) === 'nether' ? NETHER_WALK_BLOCKS_PER_SECOND : WALK_METRES_PER_SECOND));

/** The newest death the block is for: its dimension, place, age, the minutes its drops have left and its key; null when there is no block. */
export function deathAway(world: Rec, here: string | null): { dimension: string; at: Cell; minutes: number; left: number | null; key: string } | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath.trim() : '';
  const head = DEATH_HEAD.exec(said);
  if (!head || !said.includes('拾いに戻れる') || !here) return null;
  const dimension = head[3]!, minutes = head[2] === '秒' ? 0 : Number(head[1]);
  if (bare(dimension) === bare(here) || minutes > SHOWN_MINUTES) return null;
  const last = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1));
  if (GONE_IN.test(`${/「([^」]*)」/u.exec(said)?.[1] ?? ''} ${typeof last?.cause === 'string' ? last.cause : ''}`)) return null;
  const at = { x: Number(head[4]), y: Number(head[5]), z: Number(head[6]) };
  const left = /最長約(\d+)分/u.exec(said);
  return { dimension, at, minutes, left: left ? Number(left[1]) : null, key: `${bare(dimension)}:${at.x},${at.y},${at.z}` };
}

/** The key of the death an act's why gives up (its words, `GIVE_UP`), or null. */
export function givenUpBy(why: unknown, world: Rec | null, here: string | null): string | null {
  return typeof why === 'string' && GIVE_UP.test(why) && world ? deathAway(world, here)?.key ?? null : null;
}

/** What the death dropped, as the body lists it (`world.deaths`: 「name×n」 and 「ほかN種」), five at most. */
function dropped(world: Rec): string[] {
  const lost = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1))?.lostItems;
  return (Array.isArray(lost) ? lost : []).filter((item): item is string => typeof item === 'string').slice(0, 5);
}
const countIn = (items: readonly string[], name: RegExp): number => items.reduce((sum, item) => {
  const found = /^([a-z_]+)×(\d+)$/u.exec(item);
  return found && name.test(found[1]!) ? sum + Number(found[2]) : sum;
}, 0);

/** The way back: the gate she remembers in this dimension, its other end and from there to the drops. */
function wayBack(world: Rec, death: { dimension: string; at: Cell }, here: string): string {
  const kind = bare(death.dimension) === 'end' ? 'end_portal_frame' : 'nether_portal';
  const row = rec(world.rememberedPlaces)?.[kind];
  const place = typeof row === 'string' ? PLACE_ROW.exec(row.trim()) : null;
  if (!place) return `帰り道: この次元のゲートは体の控えに無い（${kind === 'nether_portal' ? 'ゲートを見つけるか組む' : 'エンドポータルの枠を探す'}）`;
  const gate = `${place[1]}m (${place[2]},${place[3]},${place[4]})`;
  const pair = typeof row === 'string' ? PAIR_NOTE.exec(row) : null;
  if (!pair || bare(pair[1]!) !== bare(death.dimension)) return `帰り道: ゲート ${gate}（歩いて約 ${walk(Number(place[1]), here)} 秒）。向こう側の場所は控えに無い`;
  const far = { x: Number(pair[2]), y: Number(pair[3]), z: Number(pair[4]) }, onward = metres(far, death.at);
  return `帰り道: ゲート ${gate}（歩いて約 ${walk(Number(place[1]), here)} 秒）→ 向こう側 (${far.x},${far.y},${far.z}) から落とし物まで ${onward}m（約 ${walk(onward, death.dimension)} 秒）`;
}

/** What the road's targets lack now (rods, pearls and eyes), with what lies in the drops and what gathering that again takes; null when nothing lacks. */
function shortOf(counts: ReadonlyMap<string, number>, items: readonly string[]): string | null {
  const rods = carried(counts, 'blaze_rod') + Math.floor(carried(counts, 'blaze_powder') / 2), pearls = carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
  const lostRods = countIn(items, /^blaze_rod$/u) + Math.floor(countIn(items, /^blaze_powder$/u) / 2), lostPearls = countIn(items, /^ender_(?:pearl|eye)$/u);
  const parts = [...rods < RODS_FOR_EYES ? [`ロッド 今 ${rods}/${RODS_FOR_EYES}${lostRods ? `（落とし物に ${lostRods}）` : ''}`] : [],
    ...pearls < PEARL_TARGET ? [`パール・アイ 今 ${pearls}/${PEARL_TARGET}${lostPearls ? `（落とし物に ${lostPearls}）` : ''}`] : []];
  if (!parts.length) return null;
  const again = lostRods * SECONDS_PER_ROD + lostPearls * SECONDS_PER_PEARL;
  return `区間の目標まで: ${parts.join('・')}${again ? `。落とし物の分を集め直すと約 ${Math.round(again / 10) * 10} 秒` : ''}`;
}

/** The block for a decision, or null (see the head of the file). `givenUp`: the key of the death she gave up, if any. */
export function deathReturnLine(world: Rec, facts: DoneFacts, givenUp: string | null): string | null {
  const death = deathAway(world, facts.dimension);
  if (!death || death.key === givenUp || !facts.dimension) return null;
  const items = dropped(world);
  const left = death.left !== null ? `消えるまで残り最長約 ${death.left} 分` : '残りの時間は最後の死の行';
  const vitals = [facts.hp !== null && facts.hp !== undefined ? `体力 ${Math.round(facts.hp * 10) / 10}` : null,
    facts.hunger !== null && facts.hunger !== undefined ? `満腹 ${facts.hunger}` : null, `食べ物 ${Math.round(facts.food)} 点`].filter(Boolean).join('・');
  return [`別の次元の落とし物（${death.minutes} 分前に死んだ所）: ${death.dimension} (${death.at.x},${death.at.y},${death.at.z})`
    + `${items.length ? ` に ${items.join('・')}` : ''}。${left}`,
  `この時間は、落とし物の所のチャンクが読み込まれている間（同じ次元で約 160m 以内にいる間）だけ減る。今は別の次元にいて、そこが読み込まれていなければ減らない`,
  wayBack(world, death, facts.dimension), ...[shortOf(facts.counts, items)].filter((line): line is string => line !== null), `今: ${vitals}`,
  `戻って拾うか捨てて作り直すかは、道のりと集め直しの時間を比べて決める（体は勝手に戻らない）。捨てるなら act の why に「${GIVE_UP_WORDS}」と書く（この行は消える）`].join('。');
}
