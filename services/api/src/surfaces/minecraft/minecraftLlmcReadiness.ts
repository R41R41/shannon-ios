import { orderedPlan, type PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { BED_ITEM, carriedItemCounts, countMatching, type ItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { BEFORE_DIAMONDS, BEFORE_GATE, BLOCKS, type PrepNeed, type PrepStage } from './minecraftLlmcPrepRules.js';
import { foodPointsWords } from './minecraftFoodWords.js';

/**
 * mb-llmc r6 (run 29, 2026-10-22, owner 「r6 を作り 2 モデルで比べる」): the facts of readiness the decision is shown first, written by the code
 * and decided by the model. Run 29 began inside a Nether fortress with one cooked mutton and no table, slabs or shield; at 10 s she opened
 * the blaze spawner's shaft, at 418 s her health was 3.7 with no food and hunger 17, and she waited 325 s for health that never came.
 *
 * - `preparationShortage`: what the current plan node and the dimension need (the knowledge's 「出発の点検」, as a table) set against the
 *   pack: 「準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾が無い。食料 15.6 点（目安 100）」. Null when nothing is missing.
 * - `recoveryLine`: health below full and hunger under 18, where health does not come back by itself; `foodLeads`: where food is
 *   (animals near, the scan's village rows, a hoglin and a crimson forest in the Nether, the gate back with its distance).
 */
type Stage = 'nether_deep' | 'nether_entry' | 'end' | 'diamonds';
type Need = PrepNeed;

const STAGES: Readonly<Record<'nether_deep' | 'end', { title: string; food: number; needs: readonly Need[] }>> = {
  nether_deep: { title: 'ネザーの奥へ', food: 100, needs: [
    { label: '作業台', count: 1, pattern: /^crafting_table$/u }, { label: 'ハーフブロック', count: 12, pattern: /_slab$/u },
    { label: '盾', count: 1, pattern: /^shield$/u }, { label: '金の防具', count: 1, pattern: /^golden_(?:helmet|chestplate|leggings|boots)$/u },
    { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
  end: { title: 'エンドへ', food: 80, needs: [
    { label: 'ベッド', count: 4, pattern: BED_ITEM }, { label: '弓', count: 1, pattern: /^bow$/u }, { label: '矢', count: 30, pattern: /^arrow$/u },
    { label: 'エンダーアイ', count: 12, pattern: /^ender_eye$/u }, { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
};
/**
 * The gate (run 36: the entry's shortage said 食料 100 点・鉄の防具 4・水入りバケツ while the node was the obsidian, and the plan put
 * 金の防具・ハーフブロック・食料 100 点 before the gate; the pass mark is the Nether within 30 minutes): what the gate needs is a pickaxe, a shield, a
 * sword, blocks to stand on and food for the first stretch (40 points). The rest (the table, slabs, gold armour, food 100) is the check after
 * she is in (`nether_deep`), which still holds before the fortress.
 * Owner 2026-10-24 (after run 38: only iron boots from a chest, no golden piece at the gate): the gate and the diamonds read the one table of
 * `minecraftLlmcPrepRules.ts` (the iron helmet, chestplate and leggings worn before the diamonds, the golden boots before the gate).
 */
const END_NODE = /ストロングホールド|エンド(?!ウ)|三角|ポータルの部屋|アイ/u;
const GATE_NODE = /ゲート|ネザーに入|黒曜石|火打|金のブーツ/u;
const DIAMOND_NODE = /ダイヤ/u;

/**
 * The stage whose check holds now: by the dimension, and in the overworld by the current node's title (and eyes carried); a node of the
 * diamonds is checked against `BEFORE_DIAMONDS`.
 */
export function preparationStage(dimension: string | null, counts: ItemCounts, nowTitle: string | null): Stage | null {
  if (dimension === 'the_nether') {
    const rods = countMatching(counts, /^blaze_rod$/u), pearls = countMatching(counts, /^(?:ender_pearl|ender_eye)$/u);
    return rods >= 7 && pearls >= 12 ? null : 'nether_deep';
  }
  if (dimension !== 'overworld') return null;
  if (countMatching(counts, /^ender_eye$/u) > 0 || (nowTitle && END_NODE.test(nowTitle))) return 'end';
  if (nowTitle && GATE_NODE.test(nowTitle)) return 'nether_entry';
  return nowTitle && DIAMOND_NODE.test(nowTitle) ? 'diamonds' : null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
/** How many of a need she has: each matching id (armour: each slot once). */
function held(counts: ItemCounts, need: Need): number {
  if (!need.slots) return countMatching(counts, need.pattern);
  const slots = new Set([...counts.keys()].filter(name => need.pattern.test(name)).map(name => name.split('_').at(-1)));
  return slots.size;
}

/**
 * The one line of what is missing for the stage, or null (no stage, nothing missing). `worn` (the frame's worn ids, `wornItems`): a piece of a need
 * that is to be worn and is only carried is said as such (「着ていない: iron_helmet」), since armour in the pack does not protect.
 */
export function preparationShortage(parts: { dimension: string | null; counts: ItemCounts; food: number; nowTitle: string | null;
  worn?: readonly string[] }): string | null {
  const stage = preparationStage(parts.dimension, parts.counts, parts.nowTitle);
  if (!stage) return null;
  const table: PrepStage = stage === 'diamonds' ? BEFORE_DIAMONDS : stage === 'nether_entry' ? BEFORE_GATE : STAGES[stage];
  const none: string[] = [], short: string[] = [], unworn: string[] = [];
  for (const need of table.needs) {
    const have = held(parts.counts, need);
    if (have <= 0) none.push(need.label);
    else if (have < need.count) short.push(`${need.label} ${have}/${need.count}`);
    if (need.worn && parts.worn && have > 0) {
      unworn.push(...[...parts.counts.keys()].filter(name => need.pattern.test(name) && !parts.worn!.includes(name)));
    }
  }
  const food = parts.food < table.food ? `${foodPointsWords(parts.food)}（目安 ${table.food}）` : '';
  const said = [none.length ? `${none.join('・')}が無い` : '', short.join('・'), unworn.length ? `持っているが着ていない: ${unworn.join('・')}` : '', food]
    .filter(Boolean);
  return said.length ? `準備の不足（${table.title}）: ${said.join('。')}` : null;
}

/** The fullness each food gives (the game's own hunger points), for what to eat to reach 18. Raw chicken, spider eyes and the like are left out. */
export const FULLNESS: Readonly<Record<string, number>> = Object.freeze({
  rabbit_stew: 10, cooked_beef: 8, cooked_porkchop: 8, pumpkin_pie: 8, cooked_mutton: 6, cooked_salmon: 6, cooked_chicken: 6, golden_carrot: 6,
  mushroom_stew: 6, beetroot_soup: 6, bread: 5, baked_potato: 5, cooked_cod: 5, cooked_rabbit: 5, apple: 4, carrot: 3, beef: 3, porkchop: 3,
  rabbit: 3, mutton: 2, cod: 2, salmon: 2, melon_slice: 2, sweet_berries: 2, glow_berries: 2, cookie: 2, potato: 1, beetroot: 1, dried_kelp: 1,
});
/**
 * GPT's review 2026-10-28 (the live state is data; a rule and a story of a run said at every decision are not facts): the recovery line says the fact,
 * what in the pack takes the fullness to 18 and how long health then takes; that health that does not come back is to be eaten for before a descent
 * or a fight, even with an enemy near, and what going on without it costs, is a rule of the instructions (「敵と体力」).
 */

/**
 * Health that does not come back by itself (hunger under 18, health under full): the fact, what in the pack takes the fullness to 18 and how long
 * health then takes to come back, and what going on without it cost (run 42: the line said the fact alone, 7 decisions in a row, and she went down at
 * 11.3 and died); null otherwise.
 */
/** A hostile within this many blocks counts as an enemy near (`enemyNear`). */
const ATTACK_NEAR = 8;
export function enemyNear(world: Record<string, unknown>): boolean {
  const threats = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  return threats.some(raw => { const distance = finite(record(raw)?.distance); return distance !== null && distance <= ATTACK_NEAR; });
}
export function recoveryLine(hunger: number | null, health: number | null, food: number, counts?: ItemCounts): string | null {
  if (hunger === null || health === null || health >= 20 || hunger >= 18) return null;
  const fact = `体力 ${round1(health)}/20 は自然に戻らない（満腹 ${round1(hunger)}＜18、${foodPointsWords(food)}）`;
  // Fill to 20, not 18: health coming back uses the fullness up (about 1.5 per point), so 18 gives a point or two and stops again.
  const now = Math.floor(hunger), need = 20 - now;
  // Natural regeneration at 18 or more: a point every 4 s (80 ticks).
  const back = `満腹 18 以上の間は体力が 4 秒に 1 戻る（20 まで約 ${Math.max(5, Math.round((20 - health) * 4 / 5) * 5)} 秒。満腹が 18 を切ったらまた食べる）`;
  const eat: string[] = [];
  let got = 0;
  for (const [name, each] of Object.entries(FULLNESS).sort((a, b) => b[1] - a[1])) {
    if (got >= need) break;
    const have = counts?.get(name) ?? 0;
    if (have <= 0) continue;
    const take = Math.min(have, Math.ceil((need - got) / each));
    eat.push(`${name}×${take}`);
    got += take * each;
  }
  const plan = !counts ? '' : now + got >= 18 ? `。${eat.join('・')} を食べると満腹 ${Math.min(20, now + got)} になり、${back}`
    : eat.length ? `。持ち物の食べ物（${eat.join('・')}）では満腹 ${now + got} までで 18 に届かない` : '。持ち物に食べ物が無い';
  return `${fact}${plan}`;
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
interface Feet { x: number; y: number; z: number }
const feetOf = (world: Record<string, unknown>): Feet | null => {
  const at = record(world.position), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
};
const ANIMALS = /^(?:cow|pig|sheep|chicken|rabbit|mooshroom|goat|hoglin)$/u;
/** The village's rows that are food or lead to it (run 40: the descent note named 「ベッド ×6」 as where food is; a bed is not food). */
const VILLAGE_ROW = /^(?:村の鐘|干し草|畑|作物)/u;
/**
 * The first `(x,y,z)` of a text, or its first bare `x,y,z`. r7 (run 30: the plan's 「ゲートから戻り狩って焼く」 had where `5,35,12`, with no
 * brackets, so the gate back was never said): both, as `planDone`'s `at:` reads it.
 */
export const firstPos = (text: string): Feet | null => {
  const match = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u.exec(text) ?? /(?<![\d.])(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?![\d.])/u.exec(text);
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
};

/** The gate back from the Nether: the scan's portal row, else a plan node about the gate with a place (its distance from her feet). */
function gateBack(world: Record<string, unknown>, rows: readonly string[], nodes: readonly PlanNode[], feet: Feet | null): string | null {
  const row = rows.find(line => /ネザーポータル|nether_portal/u.test(line));
  if (row) return `帰りのゲート（走査）${row.replace(/^[^(（]*/u, '').slice(0, 50)}`;
  const node = nodes.find(item => /ゲート|ポータル/u.test(item.title) && item.where && firstPos(item.where));
  if (!node) return null;
  const at = firstPos(node.where!)!;
  const far = feet ? ` 約 ${Math.round(Math.hypot(at.x - feet.x, at.z - feet.z))}m` : '';
  return `帰りのゲート (${at.x},${at.y},${at.z})${far}（計画 ${node.id} の where）`;
}

/**
 * Where food is, from the frame alone: the animals near (nearest three), the scan's village, field and crop rows, in the Nether a hoglin
 * and the crimson forest's stems, and the gate back. One line, or the fact that none is near.
 */
export function foodLeads(world: Record<string, unknown>, dimension: string | null, nodes: readonly PlanNode[] = []): string {
  const animals = (Array.isArray(world.nearbyEntities) ? world.nearbyEntities : []).flatMap(item => {
    const entity = record(item), name = typeof entity?.name === 'string' ? entity.name : '';
    const distance = finite(entity?.distance), id = finite(entity?.id) !== null ? `#${String(entity!.id)} ` : '';
    return ANIMALS.test(name) && distance !== null ? [{ line: `${id}${name} ${Math.round(distance)}m`, distance }] : [];
  }).sort((left, right) => left.distance - right.distance).slice(0, 3).map(item => item.line);
  const scan = record(world.scan);
  const sameDimension = !scan?.dimension || String(scan.dimension).replace(/^minecraft:/u, '') === dimension;
  const rows = sameDimension && Array.isArray(scan?.rows) ? (scan!.rows as unknown[]).filter((row): row is string => typeof row === 'string') : [];
  const places = rows.filter(row => VILLAGE_ROW.test(row) || (dimension === 'the_nether' && /crimson|真紅/u.test(row)))
    .slice(0, 3).map(row => row.slice(0, 60));
  const gate = dimension === 'the_nether' ? gateBack(world, rows, nodes, feetOf(world)) : null;
  const near = [...animals, ...places];
  const nether = dimension === 'the_nether' && !near.some(line => /hoglin|crimson|真紅/u.test(line)) ? '・ホグリン・真紅の森は見えていない' : '';
  return `食料の当て: ${near.length ? near.join('・') : `近くに動物・村・畑は見えていない${scan ? '（走査の範囲）' : ''}`}${nether}${gate ? `・${gate}` : ''}`;
}

/** A plan node about food: its doneWhen asks food points, or its title is about getting or cooking food. */
const FOOD_NODE = /食料|食べ物|狩|肉|ホグリン|パン/u;
/**
 * r7 (runs 29, 30: hunger 17 and no food, health that did not come back, and the plan's food node 「ゲートから戻り狩って焼く」 (p1.5) stayed
 * behind 「歪んだ幹で作業台」 (p1.1), 118 m the other way; Sonnet never went for food in 1,338 s): while health does not come back and she
 * has no food, the plan's first open food node is said before its now, with its place and how far: 「回復が先: 食料の節 [p1.5] ゲートから
 * 戻り狩って焼く＠5,35,12（約 313m）」. Null when there is none, or the current node is one (or under one).
 */
export function foodFirstLine(nodes: readonly PlanNode[], current: string | null, feet: Feet | null): string | null {
  const open = (node: PlanNode) => node.state !== 'done';
  const leaf = (node: PlanNode) => !nodes.some(child => child.parentId === node.id && open(child));
  const isFood = (node: PlanNode) => /food>=/u.test(node.doneWhen ?? '') || FOOD_NODE.test(node.title);
  const parent = new Map(nodes.map(node => [node.id, node.parentId]));
  for (let at: string | null = current, guard = 0; at && guard < 16; at = parent.get(at) ?? null, guard += 1) {
    const node = nodes.find(item => item.id === at);
    if (node && isFood(node)) return null;
  }
  const food = orderedPlan(nodes).find(node => open(node) && leaf(node) && isFood(node) && node.id !== current);
  if (!food) return null;
  const at = food.where ? firstPos(food.where) : null;
  const far = at && feet ? `（約 ${Math.round(Math.hypot(at.x - feet.x, at.z - feet.z))}m）` : '';
  return `回復が先: 食料の節 [${food.id}] ${food.title}${food.where ? `＠${food.where.slice(0, 40)}` : ''}${far}`;
}
/** The feet of a frame's world (for the readiness lines). */
export function feetIn(world: Record<string, unknown>): Feet | null { return feetOf(world); }

/** The readiness facts of a frame: its dimension, counts, food points, hunger and health. */
export function readinessOf(observation: BodyObservation | null): { world: Record<string, unknown>; dimension: string | null; counts: ItemCounts;
  food: number; hunger: number | null; health: number | null } | null {
  const world = record(observation?.state.world);
  if (!observation || !world) return null;
  const dimension = world.dimension ?? observation.facts.dimension;
  return { world, counts: carriedItemCounts(world, observation.facts), food: carriedFood(world, observation.facts).points,
    hunger: finite(world.food), health: finite(world.health),
    dimension: typeof dimension === 'string' ? dimension.replace(/^minecraft:/u, '') : null };
}

/**
 * run 26 (2026-10-26, 「エンドラを討伐して」, Sonnet: the plan said 食料 before the iron, she went down to the iron at 166 s with 5 of 40 food points, came up the
 * shaft for cows at 311 s (114 s, the pillar failing four times), went down again at 484 s, up at 705 s and down at 875 s; about 300 s on the stairs):
 * an act that takes her 10 or more blocks down from the surface while the food she carries is under what the iron night needs says so in its result,
 * with the cows in sight.
 * A fact beside the act, which goes as it is; the food points are the stage knowledge's (`FOOD_BEFORE_DESCENT`, 40 before the iron).
 */
export const FOOD_BEFORE_DESCENT = 40;
/** Planks that make a table (4), when the pack holds no table. */
const TABLE_PLANKS = 4;
const SURFACE_Y = 45, DESCENT = 10;
/** The lowest y the walks and digs of an act reach (a `rel` hand counts from her feet), or the feet's own when none goes lower. */
function lowestReach(hands: unknown, feetY: number): number {
  let lowest = feetY;
  for (const raw of Array.isArray(hands) ? hands : []) {
    const hand = record(raw);
    // vertical down (continue contract 6): `toY` is the feet's y it goes down to (absolute), a descent like a go's.
    if (hand?.do === 'vertical') {
      const toY = hand.dir === 'down' ? finite(hand.toY) : null;
      if (toY !== null) lowest = Math.min(lowest, toY);
      continue;
    }
    if (hand?.do !== 'walk' && hand?.do !== 'go' && hand?.do !== 'dig') continue;
    const points = [record(hand.to), ...(Array.isArray(hand.path) ? hand.path.map(record) : []), ...(Array.isArray(hand.goals) ? hand.goals.map(record) : []),
      ...(Array.isArray(hand.at) ? hand.at.map(record) : [])];
    for (const point of points) {
      const y = finite(point?.y);
      if (y !== null) lowest = Math.min(lowest, hand.rel === true ? feetY + y : y);
    }
  }
  return lowest;
}
/**
 * Run 43 (+1,291 q95, 「[p5.1] ダイヤへ下りる」 from y≈14 to y=-56 with no table and no planks: the planks had gone into the furnace; at the diamonds
 * 「作業台へ戻りダイヤのツルハシ」 took 270 s up and back, +1,351 to +1,623): the descent's check was the first one's only (from the surface). A hand
 * that goes 10 or more further down underground without a table or 4 planks says so too: what cannot be made down there, and what it cost.
 */
function deepDescentNote(input: unknown, facts: NonNullable<ReturnType<typeof readinessOf>>, feet: Feet): string | null {
  const planks = countMatching(facts.counts, /_planks$/u), logs = countMatching(facts.counts, /_(?:log|stem|wood|hyphae)$/u);
  if (countMatching(facts.counts, /^crafting_table$/u) > 0 || planks >= TABLE_PLANKS) return null;
  const lowest = lowestReach(record(input)?.hands, feet.y);
  if (feet.y - lowest < DESCENT) return null;
  const have = logs > 0 ? `原木 ${logs} を持っている（原木 1 で板 4。作業台は板 4）` : '原木は持っていない';
  return `作業台 無・板 ${planks}: y=${Math.round(lowest)} へ下りる手を受け付けた。下では木が見つかりにくく、作業台の要る物（ダイヤのツルハシ・鉄の道具）は作れない。${have}`;
}

/** Items a furnace makes something of that the route needs: the ores (raw) and raw meat. */
const TO_SMELT = /^(?:raw_iron|raw_gold|iron_ore|deepslate_iron_ore|gold_ore|deepslate_gold_ore|beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/u;
/** What burns, in items smelted, that is not wanted for anything else (wood is the table's and the tools': said apart). */
const FUELS: ReadonlyArray<readonly [RegExp, number]> = [[/^(?:coal|charcoal)$/u, 8], [/^coal_block$/u, 80], [/^lava_bucket$/u, 100]];
const COAL_MARK = /石炭\[(?:deepslate_)?coal_ore\] \((-?\d+),(-?\d+),(-?\d+)\)[^×]*×(\d+)/u;
/**
 * Run 43 (+720 to +1,766, about 600 s: raw_iron ×15 with one plank, five waits before a furnace out of fuel, a climb to the surface for wood; the
 * coal ore ×10 on the map at y=44 was passed on the way down): what she carries to smelt against the fuel she carries, with the nearest coal on the map.
 * Null when the fuel is enough or there is nothing to smelt.
 */
export function fuelShortage(world: Record<string, unknown>, counts: ItemCounts): string | null {
  let items = 0;
  for (const [name, count] of counts) if (TO_SMELT.test(name)) items += count;
  if (items < 2) return null;
  const burns = FUELS.reduce((sum, [pattern, each]) => sum + countMatching(counts, pattern) * each, 0);
  if (burns >= items) return null;
  const coal = Math.ceil((items - burns) / 8), planks = countMatching(counts, /_planks$/u);
  const feet = feetOf(world);
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).filter((line): line is string => typeof line === 'string');
  const seen = marks.map(line => COAL_MARK.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), n: Number(m[4]) }))
    .map(c => ({ ...c, far: feet ? Math.round(Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z)) : null }))
    .sort((a, b) => (a.far ?? 1e9) - (b.far ?? 1e9))[0];
  const where = seen ? `地図の石炭 (${seen.x},${seen.y},${seen.z}) ×${seen.n}${seen.far !== null ? ` が ${seen.far}m` : ''}` : '地図に石炭は見えていない';
  return `燃料: 焼く物 ${items} 個に石炭 ${coal} が要る（石炭 1 で 8 個、板 1 枚は 1.5 個。板 ${planks} は作業台と道具の分）。${where}`;
}

export function descentNote(input: unknown, frame: BodyObservation | null): string | null {
  const facts = readinessOf(frame);
  const feet = facts ? feetOf(facts.world) : null;
  if (!facts || !feet || facts.dimension !== 'overworld') return null;
  if (feet.y < SURFACE_Y) return deepDescentNote(input, facts, feet);
  // Run 41 (the table was missing as well: 372 s with none, and she died on the way up): the food and the table (or planks to make one) are the descent's.
  const lacks = [facts.food < FOOD_BEFORE_DESCENT ? foodPointsWords(facts.food, FOOD_BEFORE_DESCENT) : '',
    countMatching(facts.counts, /^crafting_table$/u) < 1 && countMatching(facts.counts, /_planks$/u) < TABLE_PLANKS
      ? `作業台 無・板 ${countMatching(facts.counts, /_planks$/u)}` : ''].filter(Boolean);
  if (!lacks.length) return null;
  const lowest = lowestReach(record(input)?.hands, feet.y);
  if (feet.y - lowest < DESCENT) return null;
  const cows = foodLeads(facts.world, facts.dimension).replace(/^食料の当て: /u, '');
  const near = /m/u.test(cows) && !cows.startsWith('近くに動物') ? `。近くに ${cows} が見えている` : '';
  // Run 42: she went down at health 11.3 that did not come back, fell and was shot dead; the health is the descent's too.
  const health = finite(facts.world.health), hunger = finite(facts.world.food);
  const hurt = health !== null && hunger !== null && health < 20 && hunger < 18 ? `。体力 ${round1(health)}/20 は戻らない（満腹 ${round1(hunger)}＜18）` : '';
  // Run 42 (the note ended 「このまま行くなら why に…書く」 and she wrote the numbers and went down, as if that were the way through): the cost in
  // what the runs measured, and what to do first; nothing that reads as a way past it.
  return `準備の状態（この act は地下 y=${Math.round(lowest)} へ下りる手）: 未達 — ${lacks.join('・')}${hurt}${near}。この受付は、準備が満たされたことを表さない`;
}
