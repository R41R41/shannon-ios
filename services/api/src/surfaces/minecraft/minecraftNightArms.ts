import { carried } from './minecraftConditions.js';
import { NETHER_BY_SECONDS } from './minecraftLlmcPrepRules.js';
import { thunderstorm } from './minecraftLlmcStateWords.js';
import { SLEEP_COST, SLEEP_SKIP } from '../../contracts/minecraftSleepWords.js';
import { REQUEST_NIGHT_WAY } from './minecraftRequestSteps.js';
import { oreRouteHands, SEALED_SHAFT_WORD, stonePickHands, STONE_SHAFT } from './minecraftOreRoute.js';
import { framesOf } from './minecraftSeenMarks.js';
import { wornItems } from './minecraftItems.js';
export { thunderstorm } from './minecraftLlmcStateWords.js';

/**
 * The night with nothing to fight with, said as a fact (run60, 11/4 01:47: three minutes before night she kept taking planks from a village for sticks,
 * with no sword made after the iron was smelted; two to four zombies came with 7.6 health left). The line comes in the overworld within three minutes
 * of the night and through it, while no sword and no axe is carried. It names no hand: what to make, where to go and when to eat stay the decision's.
 */
export const NIGHT_FROM = 13_000, NIGHT_TO = 23_000, DAY_LENGTH = 24_000, TICKS_PER_MINUTE = 1_200;
const NEAR_TICKS = 3 * TICKS_PER_MINUTE;
/** The owner's ruler to the Nether, the one the goal's text and the road's milestone use (`NETHER_BY_SECONDS`): the night's lines say their share of it. */
const NETHER_MINUTES = Math.round(NETHER_BY_SECONDS / 60), NETHER_TICKS = NETHER_BY_SECONDS * 20;
/** What waiting costs against the Nether's target, said only while the Nether is the goal (a request of one thing has no such target: the share was said to a cake). */
const netherShare = (left: number, nether: boolean): string => nether ? `（ネザーまで ${NETHER_MINUTES} 分の目標の ${Math.round(100 * left / NETHER_TICKS)}%）` : '';
const WEAPON = /(?:^|:)(?:wooden|stone|golden|iron|diamond|netherite)_(?:sword|axe)$/u;
/** The blade of the iron gear: the weapon the night and the gate are met with (a stone one is what the first hour makes). */
const IRON_BLADE = /(?:^|:)(?:iron|diamond|netherite)_sword$/u;
const IRON_FOR_SWORD = 2;
const IRON_FOR_PICKAXE = 3;
const IRON_PICK_UP = /(?:^|:)(?:iron|diamond|netherite)_pickaxe$/u;

export const minutes = (ticks: number): string => ticks < 2 * TICKS_PER_MINUTE
  ? `${Math.max(1, Math.round(ticks / 20))} 秒` : `約 ${Math.round(ticks / TICKS_PER_MINUTE)} 分`;

/** The tick of the day (0–23,999): the body's numeric `timeOfDay` first, else its `time` string of digits; null when neither. */
export function dayTick(world: Record<string, unknown>): number | null {
  const raw = world.timeOfDay;
  if (typeof raw === 'number' && Number.isFinite(raw)) return ((Math.floor(raw) % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH;
  return typeof world.time === 'string' && /^\d+$/u.test(world.time.trim()) ? Number(world.time.trim()) % DAY_LENGTH : null;
}

/** A bed works in an overworld thunderstorm even when the clock is absent. */
export function canSleepNow(world: Record<string, unknown>): boolean {
  if (thunderstorm(world)) return true;
  const tick = dayTick(world);
  return tick !== null && tick >= BED_FROM && tick < NIGHT_TO;
}

/**
 * 11/26 (run 7): afloat in deep water at dusk, the bed's long lines and the sleep gate (which held the furnace's take for a sleep that could not come: no_bed_spot, 107 s idle) both said
 * 「寝る」. The body's own line about where she is (`world.inside`: 「深い水の中（足の下も水で床が無い…）。近くの呼吸できる足場は未確認」, said when no side cell could be a floor) is the fact:
 * a bed is put on a floor. One line then replaces the sleep's explanation (the way to take the sleep back stays in the skip's and the booking's lines). Null on land, or when a
 * floor candidate is named. Not in `canSleepNow` (a clock check others use).
 */
const AFLOAT_NO_FLOOR = /^深い水の中.*近くの呼吸できる足場は未確認/u;
export const AFLOAT_NO_SLEEP = '今は水の上で寝られない（足元が深い水で、隣に床にできる所が無い。寝るなら先に足場を作る）';
export const noSleepSpot = (world: Record<string, unknown>): boolean => typeof world.inside === 'string' && AFLOAT_NO_FLOOR.test(world.inside);

const carriedNames = (counts: ReadonlyMap<string, number>, pattern: RegExp): string[] =>
  [...counts].filter(([name, count]) => pattern.test(name) && count > 0).map(([name]) => name.replace(/^minecraft:/u, ''));

/**
 * What she holds against the dark, as a fact: nothing, or only blades that are not iron while iron for a sword is in the pack (the iron was
 * smelted and the sword not made); and no shield once iron is in the pack (the whole-run audit of 11/4, order 1: the sword and the shield right
 * after the iron).
 */
function armsWords(counts: ReadonlyMap<string, number>): string | null {
  const iron = carried(counts, 'iron_ingot');
  const ironPick = carriedNames(counts, IRON_PICK_UP).length > 0;
  // end1109o10: with iron 3 and no iron pickaxe this line said the sword (2) and the shield (1); she made both, and the pickaxe waited
  // 13 minutes for the next iron. The first 3 are the pickaxe's (diamonds and obsidian take nothing less); the arms get what is over.
  const spare = ironPick ? iron : Math.max(0, iron - IRON_FOR_PICKAXE);
  const words: string[] = [];
  const blade = carriedNames(counts, IRON_BLADE).length > 0, weapons = carriedNames(counts, WEAPON), shield = carried(counts, 'shield') > 0;
  const withheld = !ironPick && ((!blade && weapons.length > 0 && iron >= IRON_FOR_SWORD && spare < IRON_FOR_SWORD) || (!shield && iron > 0 && spare === 0));
  if (!blade) {
    if (!weapons.length) words.push('剣も斧も荷に無い');
    else if (spare >= IRON_FOR_SWORD || ironPick) {
      words.push(`荷の剣・斧は ${weapons.join('・')} だけ（鉄の剣は無い。鉄の剣は鉄 ${IRON_FOR_SWORD} 個で作れる。${ironPick ? '' : `鉄のツルハシの ${IRON_FOR_PICKAXE} 個を除いて`}鉄は ${spare} 個）`);
    }
  }
  if ((ironPick || spare > 0) && !shield) words.push(`盾が無い（盾は板 6 と鉄 1 で作れる。${ironPick ? '' : `鉄のツルハシの ${IRON_FOR_PICKAXE} 個を除いて`}鉄は ${spare} 個）`);
  if (withheld) words.push(`鉄 ${iron} 個は鉄のツルハシ（鉄 ${IRON_FOR_PICKAXE}）が先（ダイヤと黒曜石は鉄のツルハシでしか掘れない。剣・盾に使うとツルハシが次の鉄まで遅れる）`);
  return words.length ? words.join('。') : null;
}

/**
 * The line for a decision, or null: not the overworld, the dark not near (the night within three minutes and through it; underground at any
 * hour, where the light is out and hostiles spawn: `underground`), or an iron sword in the pack (or, with no iron for one, any blade).
 */
export function nightArmsLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null,
  underground = false): string | null {
  if (dimension !== 'overworld') return null;
  const time = dayTick(world);
  const night = time !== null && time < NIGHT_TO && time >= NIGHT_FROM - NEAR_TICKS;
  const storm = thunderstorm(world);
  if (!night && !underground && !storm) return null;
  const arms = armsWords(counts);
  if (!arms) return null;
  if (storm) return `雷雨は昼でも地上にゾンビ・スケルトンが湧く: ${arms}`;
  if (!night || time === null) return `地下は昼でも暗く、ゾンビ・スケルトンが湧く: ${arms}`;
  const when = time >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - time)}）` : `夜まで ${minutes(NIGHT_FROM - time)}`;
  return `${when}: ${arms}。夜は地上にゾンビ・スケルトンが湧く`;
}

/** The bed in the pack. */
export const BED = /(?:^|:)[a-z_]+_bed$/u;
/** A bed can be slept in from tick 12,542 (the game's dusk, before the hostiles of 13,000); the line comes a minute before that. */
export const BED_FROM = 12_542;
const BED_NEAR_TICKS = 1_200;
const NIGHT_CHOICE_NEAR_TICKS = 3_600;
export const BED_ENEMY_BLOCKS = 8;

export const enemyNear = (world: Record<string, unknown>): boolean => (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).some(item => {
  const entry = item && typeof item === 'object' ? item as { distance?: unknown } : null;
  return typeof entry?.distance === 'number' && entry.distance <= BED_ENEMY_BLOCKS;
});

/**
 * K10 (11/10 review, no run): the pearls hunted on the overworld's night when no warped forest was found. The bed's lines say in every decision
 * that a sleep makes the morning, and a night slept through has no endermen. While the plan's now is a pearl node (`pearlNow`) and the pearls and
 * eyes are under the 10 that go to the stronghold, the bed's line says that too, as a fact beside it; the choice stays hers.
 */
const PEARLS_TO_GO = 10;
/**
 * Pearls and eyes still missing: against the empty frames of the portal room when the body has counted them (`framesOf`: the frames seen less the eyes in them), else
 * against the 10 that go to the stronghold. 11/27 (run of that night): the plan's pearl node was renamed and kept its kind `stronghold`, so the plan's now never read as a pearl node;
 * with 10 eyes in the pack and 1 frame still empty the gap is 1 pearl, which the 10 alone did not show.
 */
export function pearlGap(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): number {
  const frames = framesOf(world);
  const need = frames ? Math.max(0, frames.frames - frames.eyes) : PEARLS_TO_GO;
  return Math.max(0, need - carried(counts, 'ender_pearl') - carried(counts, 'ender_eye'));
}

/** The pieces she has on, of the four (`world.worn`), for the night's danger words. */
const ARMOUR_PIECES = /^(?:leather|chainmail|iron|golden|diamond|netherite|turtle)_(?:helmet|chestplate|leggings|boots)$/u;
/**
 * What waiting on the surface in the dark is, as facts beside the pearl hunt: her health, the armour on, the shield, the creatures near, and what spawns. No hand and no
 * threshold; whether the night is spent on the surface is hers.
 */
export function nightDangerWords(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  if (typeof world.health === 'number' && Number.isFinite(world.health)) parts.push(`体力 ${Math.round(world.health * 10) / 10}/20`);
  if (typeof world.worn === 'string') parts.push(`着ている防具 ${wornItems(world.worn).filter(name => ARMOUR_PIECES.test(name)).length}/4`);
  parts.push(`盾 ${carried(counts, 'shield') > 0 ? 'あり' : '無し'}`);
  if (Array.isArray(world.nearbyThreats)) parts.push(`今見えている敵 ${world.nearbyThreats.length} 体`);
  return `夜に地表で待つ時の事実: ${parts.join('・')}・夜の地上はゾンビ・スケルトン・クリーパー・クモが湧く（明かりの無い所ほど）`;
}

/** The pearl word of the bed's lines: said while the plan's now is the pearls (`pearlNow`) and some are still missing (`pearlGap`), with the night's danger beside it. */
const pearlNightWord = (world: Record<string, unknown>, counts: ReadonlyMap<string, number>, pearlNow: boolean): string =>
  pearlNow && pearlGap(world, counts) > 0
    ? `。パールを地上のエンダーマンで集めるなら、その夜は寝ない（地上のエンダーマンは夜に出て、寝ると夜が飛ぶ）。${nightDangerWords(world, counts)}` : '';

/**
 * The bed against the night, as the facts of the game (the coordinator's wording of 11/4, after run60 and run61 both ended in a night): within a minute of
 * the night and through it, with a bed in the pack. A sleep skips the night and makes the morning; it works underground too. With an enemy within 8
 * blocks at night the line says the sleep is refused while it is there, walls or not (the whole-run audit of 11/4, chapter 3: the line went out
 * then, and a place out of their reach was never said to come first). It names no hand.
 */
export function nightBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, pearlNow = false): string | null {
  if (dimension !== 'overworld') return null;
  if (thunderstorm(world)) return stormBedLine(world, counts);
  const tick = dayTick(world);
  if (tick === null) return null;
  const bed = [...counts].find(([name, count]) => BED.test(name) && count > 0);
  if (!bed || tick >= NIGHT_TO || tick < BED_FROM - BED_NEAR_TICKS) return null;
  if (noSleepSpot(world)) return AFLOAT_NO_SLEEP;
  const name = bed[0].replace(/^minecraft:/u, '');
  if (enemyNear(world)) {
    return tick < BED_FROM ? null
      : `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）が、8m 内に敵がいる間は寝られない（壁の向こうでも断られる）。敵が届かず 8m より離れた所なら寝られる`;
  }
  if (tick < BED_FROM) return `夜まで ${minutes(NIGHT_FROM - tick)}: ベッドを持っている（${name}）。寝られるのは夜になってから（あと ${minutes(BED_FROM - tick)}）。待たずに sleep の手を 1 つ積めば、夜になり次第（10 秒以内なら体が待って）寝る。${SLEEP_COST}。ただし夜に湧く敵を倒す・夜のうちに急ぐ作業や、人が寝ないと言った時は積まない（積んだ後は ${SLEEP_SKIP} で消せる）${pearlNightWord(world, counts, pearlNow)}`;
  return `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）。${SLEEP_COST}（近くに敵がいる間は寝られない）。寝るのは、これから地上で動く夜を飛ばす時か、地上へ出る手の直前が夜の時。夜に湧く敵を倒す・夜のうちに急ぐ作業の間と、人が寝ないと言った時は寝ない（${SLEEP_SKIP}）。地下の作業が続く間の夜は飛ばさない（夜は約 520 秒。地上へ出る見込みの時刻と比べる）${pearlNightWord(world, counts, pearlNow)}`;
}

/**
 * end1109o04 (11/9, the opening lane, Haiku): a bed in the pack, morning, 10 minutes before the night and iron ore 14 blocks down, and she
 * chained `wait 30` five times and a sleep "to wait in the village for the night" (8 of 21 minutes). The bed's line (`nightBedLine`) starts a
 * minute before the bed is allowed; before that nothing said that the day is for the plan and the bed goes with her. Said first in the live
 * body like the night's choices. Null: not the overworld, no clock, a storm (the storm's bed line), no bed carried, or within the bed line's
 * minute.
 */
/**
 * run 8 (11/27): this paragraph (about 900 characters) was in about 90% of the inputs with the sleep state beside it; `sleep` was in 16 of 86 hands, one night was skipped, and three
 * were a `drop; sleep` with no work in it. The clock and the cost of waiting are said each time (`brief`); the explanation of when a sleep is put in is said in full on the first time and
 * now and then (the caller decides), and the rule against a sleep standing in for work is in both, with its reason.
 */
const NO_SLEEP_FOR_WORK = '寝られるまで 7 分以上ある間は、sleep だけの手（drop；sleep など作業の無い手）を入れない（理由: 昼は sleep だけでは寝られず、その分作業が進まない）。夜に地上で動く予定なら sleep を作業の act の先頭か末尾に 1 手入れる（夜になり次第、体が次の手の前で寝る。待たなくてよい）';
export function dayBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, pearlNow = false, nether = true, brief: boolean | (() => boolean) = false): string | null {
  if (dimension !== 'overworld' || thunderstorm(world)) return null;
  const tick = dayTick(world);
  if (tick === null || tick >= BED_FROM - BED_NEAR_TICKS) return null;
  if (![...counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  if (noSleepSpot(world)) return AFLOAT_NO_SLEEP;
  const left = BED_FROM - tick;
  const facts = `昼（寝られるまで ${minutes(left)}）・ベッドを持っている。それまで待てば ${minutes(left)} なにも進まない${netherShare(left, nether)}`;
  if (typeof brief === 'function' ? brief() : brief) return `${facts}。今の節を進める。${NO_SLEEP_FOR_WORK}。夜を使う依頼や人が寝ないと言った時は予約しない`;
  return `${facts}。${NO_SLEEP_FOR_WORK}。今の節を進める。予約の理由: 夜の地上は敵が増えて危なく、寝れば夜が飛んで朝になる。夜を使う依頼・節（夜に湧く敵を倒す・夜に急ぐ）や、人が寝ないと言った時は入れない（${SLEEP_SKIP} で予約を消せる）。夜を使わない依頼（ケーキ・羊毛・道具づくり）は入れてよい。地下の作業が続く間の夜は飛ばさない（夜は約 520 秒）${pearlNightWord(world, counts, pearlNow)}`;
}

/**
 * By day with no bed in the pack, the bed is said as a thing to make first, whatever the
 * request or the node is (with nothing ordered, a bed is still made first; a run with no bed at dusk lost every material to two deaths in four minutes). Said with its reasons, once the clock is known; left out when a node of the plan already makes the bed
 * (`bedNode`: the first plan's own node must not be said twice), when the night's own choice line has taken over (3 minutes before dark), in a storm and outside the overworld.
 */
export function dayNoBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, bedNode = false): string | null {
  if (dimension !== 'overworld' || thunderstorm(world) || bedNode) return null;
  const tick = dayTick(world);
  if (tick === null || tick >= BED_FROM - NIGHT_CHOICE_NEAR_TICKS) return null;
  if ([...counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  return `昼（夜まで ${minutes(BED_FROM - tick)}）・ベッドを持っていない。夜が来ると地上は敵が増えて危ない（夜になってからでは、暗い地上で羊や材料を探すことになる）。ベッドがあれば寝て夜を飛ばせる。`
    + '今の依頼や節が別でも、ベッドを先に 1 個作る（羊毛 3＋板 3。同じ色の羊 3 体か、村のベッドを dig takeOk で取る。約 100 秒）。理由: 夜に間に合わず無いまま夜になると、待つか死ぬかになる';
}

/**
 * end1109o03 (11/9, the opening lane, all Haiku): a night with no bed carried, a village of seven beds around her and a stone pickaxe in the pack.
 * The night's order in the stage knowledge (take a bed, else a sealed shaft down to the iron) was in the system text, and she waited in a dirt
 * ring for 7 of her 18 minutes (1107c/d/g did the same with no village). The scene replay of the first night decision (Haiku, 6 each): as it was
 * 3/6 waited; with the choices said as the plan's now, 6/6 took the villager's bed and slept. The choices are said here, first in the live body
 * (before the plan's now), with what waiting costs; which one is the decision's. Null: not the overworld, no clock, the night not within a
 * minute, a bed carried (`nightBedLine`), or neither choice open (no bed in the landmarks, no pickaxe). Underground (o03 at 28 minutes: an iron
 * pickaxe, open iron 11 m west and 29 down, and she waited out a stormy night in a sealed hole) only the way down to the iron is said.
 */
const PICKAXE = /(?:^|:)(?:stone|iron|diamond|netherite)_pickaxe$/u;
/**
 * end1109o06 (the first random world): told "足元を 2 段掘って頭の上を塞ぎ…vertical shape=stairs", she dug stairs for the hole, the stair's mouth
 * stayed open (the cap was put where she had stood), a zombie came down it, the fight took her up to the surface and a skeleton killed her.
 * A shaft 2 deep has a cap cell that is exact: the cell she stands in now is the one over her head at the bottom. The two hands are said as written.
 */
const HOLE_DIG = 'dirt,grass_block,coarse_dirt,podzol,stone,andesite,diorite,granite,tuff,deepslate,gravel,sand';
function sealHands(at: { x?: unknown; y?: unknown; z?: unknown } | null): string {
  const [x, y, z] = [at?.x, at?.y, at?.z].map(value => typeof value === 'number' ? Math.floor(value) : null);
  if (x === null || y === null || z === null) return '足元を 2 段掘って（vertical down shaft で y を今の足の y−2）頭の上を塞ぎ、その底から';
  return `足元を 2 段掘って頭の上を塞ぐ（手 2 つ「vertical down shaft y=${y - 2} dig=${HOLE_DIG} liquid=stop」「place dirt ${x},${y},${z}」。`
    + `今の足のマスが、下りた後の頭の上。土が無ければ cobblestone。stairs は口が開いたままになる。葉の上なら先に地面へ）。塞いだ後、その底から`;
}
/** The two hands of the sealed hole as `mc_act` takes them; empty without a position. */
function sealList(at: { x?: unknown; y?: unknown; z?: unknown } | null): string[] {
  const [x, y, z] = [at?.x, at?.y, at?.z].map(value => typeof value === 'number' ? Math.floor(value) : null);
  return x === null || y === null || z === null ? [] : [`vertical down shaft y=${y - 2} dig=${HOLE_DIG} liquid=stop`, `place dirt ${x},${y},${z}`];
}
/**
 * The head passes the descent's preparation (food 40) for the night with no bed (end1109o13): said in the night's line, and the live's rewrite
 * leaves out the plan's own cautions of the 40 while the line carries it (`minecraftLlmcLiveRewrite.ts`). By day the rule is as it was.
 */
export const NIGHT_PASS = '【夜の通し】';
/**
 * thru t05b (w1109v, 11/9 18:43): after a death she had nothing (no pickaxe, no planks, no logs), no village bed was near, and the night line
 * said nothing at all (its two choices both need a bed or a pickaxe); she stood on the shore at 2.3 health and the zombies and a stray killed
 * her three times in 70 s. Dirt, sand, gravel and snow come by hand: the hole of `sealHands` without the stone, and its cap from what was dug.
 */
/** Ten ids, not twelve: the body takes 1 to 12 in one canDig and refuses the whole act at 13, and the head adds one or two of its own (11/21: 13 ids refused 20 acts, two of them the cane's pickup). */
const HAND_DIG = 'dirt,grass_block,coarse_dirt,podzol,rooted_dirt,mud,clay,sand,gravel,snow';
function handSealHands(at: { x?: unknown; y?: unknown; z?: unknown } | null): string {
  const [x, y, z] = [at?.x, at?.y, at?.z].map(value => typeof value === 'number' ? Math.floor(value) : null);
  const hands = x === null || y === null || z === null ? '「vertical down shaft で y を今の足の y−2」と、今の足のマスへ place'
    : `「vertical down shaft y=${y - 2} dig=${HAND_DIG} liquid=stop」「place dirt ${x},${y},${z}」`;
  return `土・砂・砂利・雪は素手でも掘れる: 足元を 2 段掘って頭の上を塞ぐ（手 2 つ ${hands}。掘った土か砂で塞ぐ。`
    + '足元が石・氷・水なら、土か砂の地面まで歩いてから）。底で朝を待ち、朝に原木から道具を作り直す（地上に立ったまま待たない・素手で敵と打ち合わない）';
}
/**
 * The mark of the food-absent line (`foodAbsentLine`): while it is said, the live's rewrite leaves out her own rules that hold the descent for
 * the food 40 too (end1110r1: she wrote 「未達の間は地下へ下りない・鉄を掘らない（夜通しでも同じ）」 in a world with no land animal and waited).
 */
export const FOOD_PASS = '【動物なし】';
const BED_MARK = /^B [^()]*ベッド \((-?\d+),(-?\d+),(-?\d+)\)/u;
export function nightChoiceLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null,
  underground = false, food?: number, nether = true, single = false): string | null {
  if (dimension !== 'overworld') return null;
  const tick = dayTick(world);
  // end1109o06: she dug in about 3 minutes before night (before the old 1-minute window), stairs with an open mouth: the choice is said from then.
  if (tick === null || tick >= NIGHT_TO || tick < BED_FROM - NIGHT_CHOICE_NEAR_TICKS) return null;
  if ([...counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  // 11/23 (the cake's evening, a night with no bed: she dug a dirt hole under the village and stayed, and the owner's bed request did not
  // move her): a one-thing request has no iron, so the dragon run's hole (A) was the only choice said and the model followed it about ten
  // times, while the stage knowledge of the same input said the opposite. For a one-thing request the night is said once, in the stage's
  // own words (`REQUEST_NIGHT_WAY`); the dragon run's night is as it was.
  if (single) return `${tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夜まで ${minutes(NIGHT_FROM - tick)}`}・ベッドを持っていない。${REQUEST_NIGHT_WAY}`;
  // The iron is the night's work until the armour is made, then the diamonds' (end1109o10: the way to either is said as hands, `oreRouteHands`).
  // end1109o13: the diamonds' prep wants the helmet, chestplate and leggings worn; with the chestplate alone the line said the diamonds and she
  // waited (the prep held the descent). The iron is the night's work until all three.
  const armoured = ['iron_helmet', 'iron_chestplate'].every(name => carried(counts, name) > 0);
  const ore = !armoured ? 'iron' as const
    // 11/10 review (no run): with the diamond pickaxe made the diamonds are no longer the night's work (the pearls hunted on the overworld's
    // night, the walk to the stronghold); the line and `nightWaitHold` stay silent then.
    : carried(counts, 'diamond') < 3 && carried(counts, 'diamond_pickaxe') === 0 && carriedNames(counts, IRON_PICK_UP).length ? 'diamond' as const : null;
  if (!ore) return null;
  const at = world.position && typeof world.position === 'object' ? world.position as { x?: unknown; y?: unknown; z?: unknown } : null;
  const px = typeof at?.x === 'number' ? at.x : null, pz = typeof at?.z === 'number' ? at.z : null;
  const beds = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).flatMap(line => {
    const m = typeof line === 'string' ? BED_MARK.exec(line) : null;
    if (!m) return [];
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return [{ x, y, z, d: px === null || pz === null ? 0 : Math.hypot(x - px, z - pz) }];
  }).sort((a, b) => a.d - b.d);
  const pick = carriedNames(counts, ore === 'diamond' ? IRON_PICK_UP : PICKAXE)[0];
  const route = oreRouteHands(world, ore, counts, true, !underground);
  // end1109o13 (the coordinator's 0:50 of 11/10, no run to check it): the first night with food 27.2 she waited in a hole while the line asked
  // three steps (seal, write prep skipped in a plan_update, go down) and each replay moved at most 2 of 6. The night's way is said as one act,
  // its hands as they go into `mc_act`, and the descent's prep is passed by the head for the night (`NIGHT_PASS`): no plan_update is asked.
  // end1110r1: with a wooden pickaxe only (after a death) the line had no hand and she waited the second night in a hole, stone 2 under her
  // feet: the stone pickaxe is made in the shaft first (`stonePickHands`), then the same way to the iron.
  const stone = ore === 'iron' && !pick ? stonePickHands(world, counts) : null;
  const hands = [...(underground ? [] : sealList(at)), ...(stone ?? []), ...[...(route ?? '').matchAll(/「([^」]+)」/gu)].map(m => m[1]!)];
  const pass = typeof food === 'number' && food < 40
    ? `${NIGHT_PASS} 下りる準備の食料 40 は夜の間は通す（今 ${Math.round(food * 10) / 10} 点。夜は狩れず、待っても増えない。plan_update は要らない。朝に狩って 40 にする）。` : '';
  const way = hands.length && (underground || sealList(at).length)
    ? `次の 1 手 mc_act ${JSON.stringify(hands)}（${underground ? '' : '最初の 2 手で足元を掘って頭の上を塞ぐ。'}`
      + `${route?.startsWith(SEALED_SHAFT_WORD) ? '3 手目は塞いだまま真下へ（作業台・板 4・原木が無いと 10 段以上の下りは止められるので、今の足から 9 段まで）。' : ''}`
      + `${stone ? `木のツルハシで ${STONE_SHAFT} 段下りて石を掘り、頭の上に作業台を置いて石のツルハシを作る（鉄は石のツルハシから）。` : ''}掘った壁に鉱石が見えたら mine。y=0 より下は deepslate_ の付く名前）`
    : `${underground ? '今いる所から' : sealHands(at)}手 ${route}`;
  // end1109o13: with the helmet and chestplate on and 5 raw iron for the legs, she waited the night out to smelt at the furnace on the surface.
  // A furnace is 8 cobblestone and works below as well: the raw iron carried is smelted where she is.
  const raw = carried(counts, 'raw_iron');
  const smelt = ore === 'iron' && raw >= 3 && (carried(counts, 'furnace') > 0 || carried(counts, 'cobblestone') >= 8)
    ? `持っている生鉄 ${raw} は今いる所で焼く（かまどを${carried(counts, 'furnace') > 0 ? '' : '丸石 8 で作って'}足元に置き、燃料と入れる。地上のかまどへ朝に戻らない）。それから ` : '';
  const choices = [
    ...(!underground && beds[0] && beds[0].d <= 64 ? [`村のベッド (${beds[0].x},${beds[0].y},${beds[0].z})（${Math.round(beds[0].d)}m）へ寄り、sleep で寝る。村人が寝ていたら、そのベッドを dig takeOk collect=true で取り、sleep で置いて寝る（約 20 秒で朝。村人は起きるだけで傷つかない。村のベッドは取ってよい）`] : []),
    ...((pick || stone) && route ? [`${underground ? '今いる所から' : ''}地下で${ore === 'iron' ? '鉄' : 'ダイヤ'}を掘り進む（${pick ?? '木のツルハシだけ。先に石のツルハシを作る'}）: ${pass}${smelt}${way}。地下の暗さは昼も夜も同じなので、夜も昼と同じだけ進む（「朝に掘る」のなら今掘るのと同じ。待てば朝に同じ所から始まるだけ）`] : []),
  ];
  if (!choices.length && !underground && !pick) choices.push(handSealHands(at));
  if (!choices.length) return null;
  const left = tick >= NIGHT_FROM ? NIGHT_TO - tick : NIGHT_TO - NIGHT_FROM;

  return `${tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夜まで ${minutes(NIGHT_FROM - tick)}`}・ベッドを持っていない。`
    + `${underground ? '穴で' : '夜に地上で'}待てば ${minutes(left)} なにも進まない${netherShare(left, nether)}。次の 1 手はどれか: `
    + choices.map((text, index) => `${'AB'[index]}) ${text}`).join(' ') + '。穴は、地下で掘るために塞いで下りる入口であって、朝まで待つ場所ではない。囲いで待つのは、どれもできない時だけ';
}

/** Thunderstorm sleep changes the weather; it need not advance a daytime clock to morning. */
function stormBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): string | null {
  const bed = [...counts].find(([name, count]) => BED.test(name) && count > 0);
  if (!bed) return null;
  if (noSleepSpot(world)) return AFLOAT_NO_SLEEP;
  const have = `雷雨: ベッドを持っている（${bed[0].replace(/^minecraft:/u, '')}）。`;
  return enemyNear(world)
    ? have + '時刻に関係なく寝られるが、8m 内に敵がいる間は寝られない（壁の向こうでも断られる）。'
      + '敵が届かず 8m より離れた所なら寝られる'
    : have + '時刻に関係なく寝られ、寝ると雷雨が止む。寝るのは、これから地上で動く夜を飛ばす時か、地上へ出る手の直前が夜の時。地下の作業が続く間の夜は飛ばさない（夜は約 520 秒。地上へ出る見込みの時刻と比べる）';
}
