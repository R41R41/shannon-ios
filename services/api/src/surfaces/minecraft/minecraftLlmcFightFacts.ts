import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, wornItems } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { carried, cookingOf } from './minecraftConditions.js';
import { recipeOf } from './minecraftLlmcRecipes.js';
import { SHOOTER_KINDS } from './minecraftLlmcReachWords.js';
import type { PlanFacts } from './minecraftPlanFacts.js';

/**
 * 11/24 (the night of 11/23: the first act was a go and a fight, 39 m, into a pack of three zombies and a skeleton, with no gear; the input said
 * 「ほか 15 体（creeper 3・spider 2・zombie 6・skeleton 4）」 and a worn line of 「なし」 five times, with no place for the pack and no word of what the gear
 * could do): the two facts a decision to go to a fight needs, said as facts and not as advice, in the facts of both the normal and the urgent live state.
 * - the pack: the hostiles within `PACK_METERS` of the one she would go to (the nearest shooter within `SHOOTER_METERS`, else the nearest hostile), their
 *   kinds and number, the distance to it, and at dusk and at night the limit of the one-thing request's night line (`NIGHT_LIMIT_METERS`);
 * - the gear: weapon, armour pieces, shield and food points, and whether that reaches the skeleton rule's yardstick (a sword, a shield or three iron
 *   pieces, health 10 or more: `minecraftLlmcV2Knowledge.ts`), or that a body with no weapon does not cut (its reflex skips the fight).
 */
export const PACK_METERS = 10;
export const SHOOTER_METERS = 48;
export const NIGHT_LIMIT_METERS = 25;
const FIGHT_HEALTH = 10;
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const MATERIAL: Record<string, string> = { wooden: '木', stone: '石', golden: '金', iron: '鉄', diamond: 'ダイヤ', netherite: 'ネザライト' };
const ORDER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const BLADE = /^(?:wooden|stone|golden|iron|diamond|netherite)_(?:sword|axe)$/u;

/** Flow design: a part of the request's facts the plan says (`planFacts.request`) for the context of the facts. */
export const requestFlag = (planFacts: PlanFacts | undefined): { request?: true } => planFacts?.request === true ? { request: true } : {};

interface Seen { id: string; name: string; distance: number; at: { x: number; y: number; z: number } | null; health: number | null }
const pointOf = (value: unknown): Seen['at'] => {
  const at = rec(value), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
};
function hostilesOf(world: Record<string, unknown>): Seen[] {
  return (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(raw => {
    const item = rec(raw), distance = finite(item?.distance);
    if (!item || distance === null || typeof item.name !== 'string') return [];
    return [{ id: String(item.id ?? ''), name: item.name, distance, at: pointOf(item.position), health: finite(item.health) }];
  });
}
const apart = (a: NonNullable<Seen['at']>, b: NonNullable<Seen['at']>): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** The hostile she would go to: the nearest shooter within `SHOOTER_METERS`, else the nearest. */
function targetOf(all: readonly Seen[]): Seen | undefined {
  const byDistance = [...all].sort((a, b) => a.distance - b.distance);
  return byDistance.find(e => SHOOTER_KINDS.has(e.name) && e.distance <= SHOOTER_METERS) ?? byDistance[0];
}

/** The pack line: the hostile she would go to, the others within `PACK_METERS` of it, and the way there. Null when it stands alone. */
export function packLine(world: Record<string, unknown>, night: boolean, request: boolean): string | null {
  const all = hostilesOf(world), target = targetOf(all), at = target?.at;
  if (!target || !at) return null;
  const around = all.filter(e => e !== target && e.at && apart(e.at, at) <= PACK_METERS);
  if (!around.length) return null;
  const kinds = new Map<string, number>();
  for (const e of [target, ...around]) kinds.set(e.name, (kinds.get(e.name) ?? 0) + 1);
  const limit = night && request ? `（夜の上限 ${NIGHT_LIMIT_METERS}m）` : '';
  const counts = [...kinds].map(([name, n]) => `${name} ${n}`).join('・');
  return `#${target.id} ${target.name} の周り ${PACK_METERS}m: ${counts}（本人を含め ${around.length + 1} 体）・そこまで ${Math.round(target.distance)}m${limit}`;
}

const WORD_NO_WEAPON = '→ 武器が無いので体は斬らない（体の反射は武器なしの戦いを飛ばす）';
const WORD_SHORT = '→ 射手へ詰める目安（剣と、盾か鉄の防具 3 部位・体力 10 以上）に届かない';
const WORD_FIT = '→ 射手 1 体へ詰める目安に届く（群れや体力の多い敵は「打撃数」の行で見る）';
/** The best sword or axe carried, as 「剣 石」, or null. */
function weaponOf(counts: ReadonlyMap<string, number>): string | null {
  const blades = [...counts].filter(([name, n]) => n > 0 && BLADE.test(name)).map(([name]) => name);
  const best = blades.sort((a, b) => ORDER.indexOf(a.split('_')[0]!) - ORDER.indexOf(b.split('_')[0]!))[0];
  return best ? `${best.endsWith('sword') ? '剣' : '斧'} ${MATERIAL[best.split('_')[0]!] ?? ''}` : null;
}
/** The iron an iron sword takes (2), and the raw iron she carries counts as iron once smelted. */
const SWORD_IRON = 2;
/**
 * (a request to fight: the sword stayed stone and the meat raw while 2 iron stood in the pack, ten minutes before the first fight): what is between her and an iron
 * sword, as a fact (「鉄の剣まであと鉄 N」), said while the sword she holds is not iron or better. Nothing is said of a sword she has.
 */
export function swordGap(counts: ReadonlyMap<string, number>, weapon: string | null): string {
  if (weapon && /^剣 (?:鉄|ダイヤ|ネザライト)/u.test(weapon)) return '';
  const ingots = counts.get('iron_ingot') ?? 0, raw = (counts.get('raw_iron') ?? 0) + (counts.get('iron_ore') ?? 0) + (counts.get('deepslate_iron_ore') ?? 0);
  const lack = Math.max(0, SWORD_IRON - ingots - raw);
  return lack > 0 ? `（鉄の剣まであと鉄 ${lack}）` : ingots >= SWORD_IRON ? '（鉄の剣は今作れる）' : `（鉄の剣は鉄 ${SWORD_IRON} で作れる・生の鉄は焼く）`;
}
/** The food points if the raw meat she carries were cooked, beside the points she has (「焼けば 62 点・40 秒」); empty when she carries none. */
export function cookedWords(counts: ReadonlyMap<string, number>, food: number): string {
  const cook = cookingOf(counts);
  return cook ? `（焼けば ${Math.round((food + cook.gain) * 10) / 10} 点・${cook.seconds} 秒）` : '';
}

/** The gear line: weapon, armour, shield, food points, and what that comes to. Null when no hostile is listed. */
export function gearLine(observation: BodyObservation | null, world: Record<string, unknown>): string | null {
  if (!hostilesOf(world).length) return null;
  const counts = carriedItemCounts(world, observation?.facts), worn = wornItems(world.worn), weapon = weaponOf(counts);
  const pieces = worn.filter(name => /_(?:helmet|chestplate|leggings|boots)$/u.test(name));
  const iron = pieces.filter(name => /^(?:iron|diamond|netherite)_/u.test(name)).length;
  const held = worn.includes('shield'), shield = held ? '構えている' : (counts.get('shield') ?? 0) > 0 ? '持っているが構えていない' : 'なし';
  const health = finite(world.health), fit = !!weapon && (held || iron >= 3) && (health === null || health >= FIGHT_HEALTH);
  const verdict = !weapon ? WORD_NO_WEAPON : fit ? WORD_FIT : WORD_SHORT;
  const exact = carriedFood(world, observation?.facts ?? {}).points, food = Math.round(exact);
  return `戦う装備: ${weapon ?? '武器 なし'}${swordGap(counts, weapon)}・防具 ${pieces.join('・') || 'なし'}（4 部位のうち ${pieces.length} 部位）・盾 ${shield}・食べ物 ${food} 点${cookedWords(counts, exact)} ${verdict}`;
}


/**
 * 11/26 (the fourth run of the day: four hoglins at once, a wooden sword, health 20 to 0 in about 15 s; the gear line read 「射手 1 体へ詰める目安に届く」 for a wooden sword
 * and a shield, and no line said how many blows a hoglin takes): what one blow of the sword in the pack takes (the body's table, `SituationScanner.WEAPON_STATS`: wooden and golden 4,
 * stone 5, iron 6, diamond 7, netherite 8; a bare hand 1) and, for each hostile within `STRIKE_METERS`, its health and the blows that takes. The health is the body's
 * reading when the row carries one (`health`: the watched kinds, hoglin among them), else the usual full health of the kind (marked 「表」). A measured case: five blows of a wooden
 * sword took a hoglin from 40 to 22.8. Facts only; what to do with them is the decision's.
 */
export const STRIKE_METERS = 16;
const BLOW: Record<string, number> = { wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10 };
const FULL_HEALTH: Record<string, number> = { zombie: 20, husk: 20, drowned: 20, skeleton: 20, stray: 20, bogged: 16, creeper: 20, spider: 16, cave_spider: 12, witch: 26,
  hoglin: 40, zoglin: 40, piglin: 16, piglin_brute: 50, zombified_piglin: 20, blaze: 20, wither_skeleton: 20, ghast: 10, enderman: 40, vindicator: 24, pillager: 24 };
/** The weapon the body takes up (its order: swords first, the best of them; an axe only when there is no sword), as the id; null for none. */
function blowOf(counts: ReadonlyMap<string, number>): string | null {
  const have = [...counts].filter(([name, n]) => n > 0 && name in BLOW).map(([name]) => name).sort((a, b) => BLOW[b]! - BLOW[a]!);
  return have.find(name => name.endsWith('sword')) ?? have[0] ?? null;
}
/** Per hostile within `STRIKE_METERS`: 「hoglin #12 体力 40 → 10 打撃」; null when none is near. */
export function strikeLine(observation: BodyObservation | null, world: Record<string, unknown>): string | null {
  const near = hostilesOf(world).filter(e => e.distance <= STRIKE_METERS).sort((a, b) => a.distance - b.distance);
  if (!near.length) return null;
  const weapon = blowOf(carriedItemCounts(world, observation?.facts));
  const damage = weapon ? BLOW[weapon]! : 1;
  const hand = weapon ? `${weaponWords(weapon)}の 1 打撃 ${damage}${weapon.endsWith('axe') ? '（斧は打てる間隔が長い）' : ''}` : '武器なし（素手の 1 打撃 1）';
  const each = near.slice(0, 5).map(e => {
    const health = e.health ?? FULL_HEALTH[e.name] ?? null, name = `${e.name}${e.id ? ` #${e.id}` : ''} ${Math.round(e.distance)}m`;
    if (health === null) return { text: `${name} 体力不明`, hits: 0 };
    const hits = Math.ceil(health / damage);
    return { text: `${name} 体力 ${Math.round(health * 10) / 10}${e.health === null ? '（表）' : ''} → ${hits} 打撃`, hits };
  });
  const hits = each.reduce((sum, item) => sum + item.hits, 0);
  const words = each.map(item => item.text).join('・');
  const rest = near.length > 5 ? `（ほか ${near.length - 5} 体）` : '';
  const measured = weapon === 'wooden_sword' ? '。実測: 木の剣 5 打撃でホグリン 40 → 22.8（1 打撃約 3.4）' : '';
  return `打撃数（${hand}）: ${words}${rest}${each.length > 1 ? `・合わせて ${hits} 打撃` : ''}${measured}`;
}
const weaponWords = (id: string): string => `${id.endsWith('sword') ? '剣' : '斧'} ${MATERIAL[id.split('_')[0]!] ?? ''}`;

/** A shield below a third of its life is said as 「盾 残り 22/336」; the worn one (the off hand, `worn`: 「左手: shield(残り 22/336)」) first, else a carried one (耐久 in the pack). */
export const SHIELD_LOW_FRACTION = 1 / 3;
export function shieldLine(world: Record<string, unknown>): string | null {
  const worn = /左手:\s*(?:minecraft:)?shield\(残り(\d+)\/(\d+)\)/u.exec(typeof world.worn === 'string' ? world.worn : '');
  const packed = (Array.isArray(world.inventory) ? world.inventory : []).flatMap(raw => {
    const item = rec(raw), durability = rec(item?.durability), left = finite(durability?.left), max = finite(durability?.max);
    return item && /^(?:minecraft:)?shield$/u.test(String(item.name)) && left !== null && max !== null ? [{ left, max }] : [];
  })[0];
  const shield = worn ? { left: Number(worn[1]), max: Number(worn[2]), held: true } : packed ? { ...packed, held: false } : null;
  if (!shield || shield.max <= 0 || shield.left >= shield.max * SHIELD_LOW_FRACTION) return null;
  return `盾の耐久は ${shield.max} のうち残り ${shield.left}（${shield.held ? '構えている盾' : '持っている盾'}。3 分の 1 を下回っている）`;
}

/**
 * Run 7 of 11/26 (the diamond pickaxe went 764 → 73 of 1561 in 40 minutes and the stone axe stood at 15 of 131; only the shield had a line at a third, and no why
 * of 132 decisions named a tool's wear): a pick, axe, sword or shovel under a third of its life is said as the shield is, with what its recipe needs and what the
 * pack holds of it (the recipe table, smelting from raw iron). Facts only: what to make and when is the decision's.
 */
const TOOL_ITEM = /^(?:minecraft:)?((?:wooden|stone|golden|iron|diamond|netherite)_(?:pickaxe|axe|sword|shovel))$/u;
const PART_WORDS: Readonly<Record<string, string>> = { iron_ingot: '鉄インゴット', cobblestone: '丸石', planks: '板', diamond: 'ダイヤ', gold_ingot: '金インゴット', stick: '棒' };
function partLine(name: string, counts: ReadonlyMap<string, number>): string | null {
  const recipe = recipeOf(name);
  if (!recipe) return null;
  const have = (item: string): number => item === 'cobblestone' ? carried(counts, 'cobblestone') + carried(counts, 'cobbled_deepslate') + carried(counts, 'blackstone')
    : carried(counts, item);
  const needs = recipe.needs.map(part => `${PART_WORDS[part.item] ?? part.item} ${part.count}`).join('・');
  const held = recipe.needs.map(part => {
    const raw = part.item === 'iron_ingot' ? carried(counts, 'raw_iron') : 0;
    return `${PART_WORDS[part.item] ?? part.item} ${have(part.item)}${raw ? `＋原鉄 ${raw}` : ''}`;
  }).join('・');
  return `持ち: ${held}。作り直すなら ${needs}`;
}
/** The pickaxes of the pack that break iron ore and the like (stone or better) besides the diamond one. */
const SPARE_PICKS = ['stone_pickaxe', 'iron_pickaxe', 'netherite_pickaxe'];
/** What the obsidian takes (the end check's minimum, the dragon fight's, the gate if it is built again): the plan's own numbers. */
const OBSIDIAN_CHECK = 8, OBSIDIAN_FIGHT = 12, OBSIDIAN_GATE = 10;
/**
 * 11/27 (run 9: the diamond pickaxe went 73 to 10 of 1561 in ten minutes, mostly digging ore and stone, while no other pickaxe was in the pack; the head read
 * 「残り 73 は 1/3 を切っている」 as a tool to replace, asked for a spare it could not make (the diamond ones cost 3 diamonds), and tried to drop it twice): the facts that
 * make a short diamond pickaxe a thing to keep. Obsidian breaks with the diamond pickaxe only, one use a block, so what is left is a number of obsidian blocks.
 * The body takes the cheapest tool by time plus wear (utils/toolChoice: a use of the diamond one is worth 6 s, a stone one 0.1 s), so a stone pickaxe in the pack takes the stone,
 * dirt, gravel, coal and iron ore. Facts only.
 */
function diamondLines(counts: ReadonlyMap<string, number>, left: number, max: number): string[] {
  const lines: string[] = [];
  if (!SPARE_PICKS.some(name => (counts.get(name) ?? 0) > 0)) {
    const stone = partLine('stone_pickaxe', counts);
    lines.push(`体は一番安い道具から使う設計。石のツルハシが荷にあれば、石・土・砂利・石炭・鉄鉱石は石で足りるので、ダイヤの減りを抑えられる。今は荷の石以上のツルハシがダイヤ 1 本のみで、掘るたびにダイヤが減っている（石のツルハシ: ${stone ?? '丸石 3・棒 2'}）。ダイヤを端の石掘り（go の dig・縦穴の石の層）に使わない: 石の道具が尽きたら掘る手を減らし、丸石 3・棒 2 と作業台（板 4）が近くにあれば先に石のつるはしを作る。ダイヤの残りは黒曜石と、高所から降りる・逃げる分`);
  }
  const have = counts.get('obsidian') ?? 0;
  const need: Array<[string, number]> = [['点検', Math.max(0, OBSIDIAN_CHECK - have)], ['戦い用', Math.max(0, OBSIDIAN_FIGHT - have)], ['ゲート作り直し', OBSIDIAN_GATE]];
  const said = need.map(([name, n]) => `${name}${name === 'ゲート作り直し' ? '' : 'あと '}${n}${n <= left ? '→足りる' : '→足りない'}`).join('・');
  lines.push(`黒曜石を壊せるのはダイヤのつるはしだけ（1 個＝1 使い）。残り ${left}/${max} は黒曜石 ${left} 個分（今 ${have} 個持ち。必要: ${said}）。残り少ないダイヤは黒曜石用に持ち続ける: 捨てない・空けない（体も最後の 1 本は投げない）。ただし高所で降りる・逃げる命が先で、その時は黒曜石でなく降りるのに使ってよい。壊れたら作り直しはダイヤ 3 が要る`);
  return lines;
}
/**
 * The diamond pickaxe wore out digging stone (73 of 1561 to nothing in about eight minutes) and the lines that told its obsidian use vanished with it (they hang on the pickaxe being in the pack), so the
 * input said only 「黒曜石 7/8（あと 1）」 as if a mine would do. When no diamond (or netherite) pickaxe is carried and the obsidian is short of the fight's number: obsidian cannot be dug, what is held,
 * and what making the pickaxe again takes (3 diamonds, 2 sticks, a table). A separate line from the pickaxe's own (`diamondLines`); null when one is carried, nothing is wanted, or in the End.
 */
export function noPickObsidianLine(counts: ReadonlyMap<string, number>, dimension: string | null, wanted = false, short = false): string | null {
  if (dimension === 'the_end' || carried(counts, 'diamond_pickaxe') > 0 || carried(counts, 'netherite_pickaxe') > 0) return null;
  const have = carried(counts, 'obsidian');
  if (have >= OBSIDIAN_FIGHT || (have <= 0 && !wanted)) return null;
  const diamonds = carried(counts, 'diamond');
  if (short) return `黒曜石は掘れない（ダイヤのつるはしが荷に無い。手元 ${have}・作り直しはダイヤ 3）`;
  return `黒曜石は掘れない（荷にダイヤのつるはしが無い）。手元 ${have}（点検 ${OBSIDIAN_CHECK}・戦い ${OBSIDIAN_FIGHT}）。作り直しはダイヤ 3＋棒 2＋作業台（手元のダイヤ ${diamonds}${diamonds >= 3 ? "＝作れる" : "＝足りない"}）`;
}
/**
 * When the diamond pickaxe is the only pickaxe (no stone or iron one), every stone and ore dug wears it (the body takes the cheapest tool that breaks the block, and with one tool that is the diamond one),
 * and the obsidian's use runs out. The hands to take before the next dig, as the node's candidate (not a fact to read about the pickaxe): wood, planks, sticks, a stone pickaxe, with the table. Null: a
 * spare pickaxe is carried, no diamond pickaxe is carried, or she is not in the overworld.
 */
export function spareDigWords(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if ((dimension !== null && dimension !== 'overworld') || carried(counts, 'diamond_pickaxe') <= 0 || SPARE_PICKS.some(name => carried(counts, name) > 0)) return null;
  const logs = [...counts].reduce((sum, [name, n]) => sum + (/(?:^|_)log$/u.test(name) ? n : 0), 0);
  const planks = [...counts].reduce((sum, [name, n]) => sum + (/_planks$/u.test(name) ? n : 0), 0);
  const table = carried(counts, 'crafting_table') > 0 ? '作業台は持っている' : '作業台が要る（板 4。足元の近くに置く）';
  return `今の手の候補（掘る手の前に）: 荷の掘る道具がダイヤのつるはし 1 本だけで、石を掘るだけでも毎回減る。石のつるはしを作る: 原木→板→棒 2→丸石 3（${table}。手元 原木 ${logs}・板 ${planks}・棒 ${carried(counts, 'stick')}・丸石 ${carried(counts, 'cobblestone')}）。ダイヤのは黒曜石用に取っておく`;
}
export function toolLines(world: Record<string, unknown>): string[] {
  const counts = carriedItemCounts(world, undefined);
  const extra: string[] = [];
  const lines = (Array.isArray(world.inventory) ? world.inventory : []).flatMap(raw => {
    const item = rec(raw), durability = rec(item?.durability), left = finite(durability?.left), max = finite(durability?.max);
    const id = TOOL_ITEM.exec(String(item?.name))?.[1];
    if (!item || !id || left === null || max === null || max <= 0 || left >= max * SHIELD_LOW_FRACTION) return [];
    const make = partLine(id, counts);
    if (id === 'diamond_pickaxe' && extra.length === 0) extra.push(...diamondLines(counts, left, max));
    return [`${id} の耐久は ${max} のうち残り ${left}（3 分の 1 を下回っている${make ? `。${make}` : ''}）`];
  }).slice(0, 3);
  const noPick = noPickObsidianLine(counts, typeof world.dimension === 'string' ? world.dimension : null, false, true);
  return [...lines, ...extra, ...(noPick ? [noPick] : [])];
}

/** Dusk or night in the overworld (the day's tick from 12000: the one-thing request's night line applies). */
const nightly = (world: Record<string, unknown>): boolean =>
  (finite(world.timeOfDay) ?? -1) >= 12_000 && (world.dimension === undefined || world.dimension === 'overworld');
/**
 * 11/24 try1124b (the owner's test, 07:12–07:15: a zombie came while she stood in a pool; 22 urgent decisions of gpt-6-luna each chose a go of 1 to 4 blocks
 * inside the water (7 hits, health 20 to 6.7), the land was 4 blocks east on the map she was given, and a swimmer moves at 1 to 2 m/s while a zombie on
 * the bank runs at about 3): where she stands (water) and the nearest land read from the surface map, as a fact. It decides no hand.
 * Said only while a hostile is within `WATER_ENEMY_METERS`.
 */
export const WATER_ENEMY_METERS = 12;
/** A land cell counts as one she reaches first when the enemy is at least this much farther from it than she is. */
export const LAND_GAP_METERS = 2;
const DIRECTIONS = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
function directionWords(dx: number, dz: number): string {
  const parts = [...dx ? [`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`] : [], ...dz ? [`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`] : []];
  return parts.join('・') || 'ここ';
}
/** 'at' of a hostile as a bearing word from the feet (東 = +x, 南 = +z; the map's north is up). */
const bearing = (dx: number, dz: number): string => DIRECTIONS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8]!;
const WATER_SYMBOLS = new Set(['w', '-']);
const LAND_SYMBOLS = new Set([':', 's', '#', 'I', ',']);
const OVERLAY_SYMBOLS = new Set(['*', '!', 'm']);
/** The surface map as a grid: the feet cell, and the symbol and height of each cell. Null for another mode or a map that does not read. */
function surfaceGrid(map: string): { feet: { x: number; y: number; z: number }; cells: Map<string, { sym: string; h: number }> } | null {
  const lines = map.split('\n');
  const head = /足=\((-?\d+),(-?\d+),(-?\d+)\) x=(-?\d+)\.\.(-?\d+) z=-?\d+\.\.-?\d+ 方式=surface/u.exec(lines[0] ?? '');
  if (!head) return null;
  const feet = { x: Number(head[1]), y: Number(head[2]), z: Number(head[3]) }, x0 = Number(head[4]), width = Number(head[5]) - x0 + 1;
  const cells = new Map<string, { sym: string; h: number }>();
  for (const line of lines.slice(2)) {
    const tokens = line.trim().split(/\s+/u);
    if (!/^-?\d+$/u.test(tokens[0] ?? '') || tokens.length !== width + 1) { if (cells.size) break; continue; }
    const z = Number(tokens[0]);
    tokens.slice(1).forEach((token, index) => {
      const height = /^(.)([0-9+a-iv])$/u.exec(token);
      if (height) cells.set(`${x0 + index},${z}`, { sym: height[1]!, h: /\d/u.test(height[2]!) ? Number(height[2]) : height[2] === '+' ? 10 : -1 });
    });
  }
  if (!cells.size) return null;
  // The drawing puts `*` (walked in the last minute), `!` (a hostile) and `m` (an animal) over the block's own letter (localMap.ts drawTop), so after a swim part of the pool around
  // her is `*`. Such a cell counts as water when most of its eight known neighbours are water (one pass, from the letters as drawn). It is never taken for land: the nearest land
  // is read from the drawn land letters only, so a bank cell under the trail is missed rather than a wrong cell named.
  const wetOverlaid: string[] = [];
  for (const [key, cell] of cells) {
    if (!OVERLAY_SYMBOLS.has(cell.sym)) continue;
    const [x, z] = key.split(',').map(Number) as [number, number];
    let wet = 0, dry = 0;
    for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const sym = cells.get(`${x + dx},${z + dz}`)?.sym;
      if (sym && WATER_SYMBOLS.has(sym)) wet += 1; else if (sym && LAND_SYMBOLS.has(sym)) dry += 1;
    }
    if (wet > dry) wetOverlaid.push(key);
  }
  for (const key of wetOverlaid) cells.set(key, { ...cells.get(key)!, sym: 'w' });
  return { feet, cells };
}
/** Whether her feet are in water and where the nearest land (a ground cell level with her or one above) is, as a line; null when she is not in water, no hostile is near, or the map does not read. */
export function waterLine(world: Record<string, unknown>): string | null {
  const near = hostilesOf(world).filter(e => e.distance <= WATER_ENEMY_METERS).sort((a, b) => a.distance - b.distance);
  const map = typeof world.localMap === 'string' ? world.localMap : '';
  const grid = near.length && map ? surfaceGrid(map) : null;
  if (!grid) return null;
  const { feet, cells } = grid;
  let wet = 0, dry = 0;
  for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
    if (!dx && !dz) continue;
    const sym = cells.get(`${feet.x + dx},${feet.z + dz}`)?.sym;
    if (sym && WATER_SYMBOLS.has(sym)) wet += 1; else if (sym && LAND_SYMBOLS.has(sym)) dry += 1;
  }
  if (wet < 4 || wet <= dry) return null;
  const enemy = near[0]!, at = enemy.at;
  interface Land { dx: number; dz: number; h: number; d: number; gap: number | null }
  const lands: Land[] = [];
  for (const [key, cell] of cells) {
    if (!LAND_SYMBOLS.has(cell.sym) || cell.h < 0 || cell.h > 2) continue;
    const [x, z] = key.split(',').map(Number) as [number, number];
    const dx = x - feet.x, dz = z - feet.z, d = Math.hypot(dx, dz);
    // gap: how much farther the enemy is from that cell than she is (positive: she gets there first).
    lands.push({ dx, dz, h: cell.h, d, gap: at ? Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z) - d : null });
  }
  const nearest = lands.reduce<Land | null>((best, land) => !best || land.d < best.d ? land : best, null);
  const away = lands.filter(land => land.gap !== null && land.gap >= LAND_GAP_METERS).reduce<Land | null>((best, land) => !best || land.d < best.d ? land : best, null);
  const spot = (land: Land) => `${directionWords(land.dx, land.dz)}（約 ${Math.round(land.d)}m・立つ所 (${feet.x + land.dx},${feet.y + land.h},${feet.z + land.dz})）`;
  const side = at ? `敵 #${enemy.id} ${enemy.name} は ${bearing(at.x - feet.x - 0.5, at.z - feet.z - 0.5)} ${Math.round(enemy.distance)}m` : `敵 ${enemy.name} ${Math.round(enemy.distance)}m`;
  const land = !nearest ? '地図の中に陸が見えない'
    : away && away !== nearest && nearest.gap !== null && nearest.gap < LAND_GAP_METERS ? `最寄りの陸は ${spot(nearest)}だが敵に近い。敵より先に着ける陸は ${spot(away)}`
    : `最寄りの陸は ${spot(nearest)}`;
  return `今は水の中（周り 8 マスのうち水 ${wet}）・${land}・${side}。水の中の歩みは 1〜2 m/s で、陸の敵の走り（約 3 m/s）より遅い。水の中を数マス泳いでも距離は開かない: 陸へ上がり（go は waterOk を付ける。walk は付けずに泳ぐ）、陸で 10 マス以上離れる手を同じ act に入れる。敵が陸の側にいる時は、敵から遠い陸を選ぶ`;
}
export function fightLines(observation: BodyObservation | null, request: boolean): string[] {
  const world = rec(observation?.state.world);
  if (!world) return [];
  return [packLine(world, nightly(world), request), gearLine(observation, world), strikeLine(observation, world), shieldLine(world), ...toolLines(world), waterLine(world)].filter((line): line is string => !!line);
}
