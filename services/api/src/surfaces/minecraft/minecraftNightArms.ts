import { carried } from './minecraftConditions.js';
import { thunderstorm } from './minecraftLlmcStateWords.js';
import { oreRouteHands, SEALED_SHAFT_WORD, stonePickHands, STONE_SHAFT } from './minecraftOreRoute.js';
export { thunderstorm } from './minecraftLlmcStateWords.js';

/**
 * The night with nothing to fight with, said as a fact (run60, 11/4 01:47: three minutes before night she kept taking planks from a village for sticks,
 * with no sword made after the iron was smelted; two to four zombies came with 7.6 health left). The line comes in the overworld within three minutes
 * of the night and through it, while no sword and no axe is carried. It names no hand: what to make, where to go and when to eat stay the decision's.
 */
export const NIGHT_FROM = 13_000, NIGHT_TO = 23_000, DAY_LENGTH = 24_000, TICKS_PER_MINUTE = 1_200;
const NEAR_TICKS = 3 * TICKS_PER_MINUTE;
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
const pearlNightWord = (counts: ReadonlyMap<string, number>, pearlNow: boolean): string =>
  pearlNow && carried(counts, 'ender_pearl') + carried(counts, 'ender_eye') < PEARLS_TO_GO
    ? '。パールを地上のエンダーマンで集めるなら、その夜は寝ない（地上のエンダーマンは夜に出て、寝ると夜が飛ぶ）' : '';

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
  const name = bed[0].replace(/^minecraft:/u, '');
  if (enemyNear(world)) {
    return tick < BED_FROM ? null
      : `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）が、8m 内に敵がいる間は寝られない（壁の向こうでも断られる）。敵が届かず 8m より離れた所なら寝られる`;
  }
  if (tick < BED_FROM) return `夜まで ${minutes(NIGHT_FROM - tick)}: ベッドを持っている（${name}）。寝られるのは夜になってから（あと ${minutes(BED_FROM - tick)}）。寝れば夜が飛び、朝になる${pearlNightWord(counts, pearlNow)}`;
  return `夜（朝まで ${minutes(NIGHT_TO - tick)}）: ベッドを持っている（${name}）。寝れば夜が飛び、朝になる（近くに敵がいる間は寝られない）。地下でも寝られる${pearlNightWord(counts, pearlNow)}`;
}

/**
 * end1109o04 (11/9, the opening lane, Haiku): a bed in the pack, morning, 10 minutes before the night and iron ore 14 blocks down, and she
 * chained `wait 30` five times and a sleep "to wait in the village for the night" (8 of 21 minutes). The bed's line (`nightBedLine`) starts a
 * minute before the bed is allowed; before that nothing said that the day is for the plan and the bed goes with her. Said first in the live
 * body like the night's choices. Null: not the overworld, no clock, a storm (the storm's bed line), no bed carried, or within the bed line's
 * minute.
 */
export function dayBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, pearlNow = false): string | null {
  if (dimension !== 'overworld' || thunderstorm(world)) return null;
  const tick = dayTick(world);
  if (tick === null || tick >= BED_FROM - BED_NEAR_TICKS) return null;
  if (![...counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  const left = BED_FROM - tick;
  return `昼（寝られるまで ${minutes(left)}）・ベッドを持っている。それまで待てば ${minutes(left)} なにも進まない`
    + `（ネザーまで 30 分の目標の ${Math.round(100 * left / (30 * TICKS_PER_MINUTE))}%）。今の節を進め、夜になった所で sleep する（ベッドは持って行けて、地下でも寝られる）${pearlNightWord(counts, pearlNow)}`;
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
const HAND_DIG = 'dirt,grass_block,coarse_dirt,podzol,rooted_dirt,mud,clay,sand,red_sand,gravel,snow,snow_block';
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
  underground = false, food?: number): string | null {
  if (dimension !== 'overworld') return null;
  const tick = dayTick(world);
  // end1109o06: she dug in about 3 minutes before night (before the old 1-minute window), stairs with an open mouth: the choice is said from then.
  if (tick === null || tick >= NIGHT_TO || tick < BED_FROM - NIGHT_CHOICE_NEAR_TICKS) return null;
  if ([...counts].some(([name, count]) => BED.test(name) && count > 0)) return null;
  // The iron is the night's work until the armour is made, then the diamonds' (end1109o10: the way to either is said as hands, `oreRouteHands`).
  // end1109o13: the diamonds' prep wants the helmet, chestplate and leggings worn; with the chestplate alone the line said the diamonds and she
  // waited (the prep held the descent). The iron is the night's work until all three.
  const armoured = ['iron_helmet', 'iron_chestplate'].every(name => carried(counts, name) > 0);
  const ore = !armoured ? 'iron' as const
    : carried(counts, 'diamond') < 3 && carriedNames(counts, IRON_PICK_UP).length ? 'diamond' as const : null;
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
  const share = Math.round(100 * left / (30 * TICKS_PER_MINUTE));
  return `${tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夜まで ${minutes(NIGHT_FROM - tick)}`}・ベッドを持っていない。`
    + `${underground ? '穴で' : '夜に地上で'}待てば ${minutes(left)} なにも進まない（ネザーまで 30 分の目標の ${share}%）。次の 1 手はどれか: `
    + choices.map((text, index) => `${'AB'[index]}) ${text}`).join(' ') + '。囲いで待つのは、どれもできない時だけ';
}

/** Thunderstorm sleep changes the weather; it need not advance a daytime clock to morning. */
function stormBedLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): string | null {
  const bed = [...counts].find(([name, count]) => BED.test(name) && count > 0);
  if (!bed) return null;
  const have = `雷雨: ベッドを持っている（${bed[0].replace(/^minecraft:/u, '')}）。`;
  return enemyNear(world)
    ? have + '時刻に関係なく寝られるが、8m 内に敵がいる間は寝られない（壁の向こうでも断られる）。'
      + '敵が届かず 8m より離れた所なら寝られる'
    : have + '時刻に関係なく寝られ、寝ると雷雨が止む（地下でも寝られる）';
}
