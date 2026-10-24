import { orderedPlan, type PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { BED_ITEM, carriedItemCounts, countMatching, type ItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { BEFORE_DIAMONDS, BEFORE_GATE, BLOCKS, type PrepNeed, type PrepStage } from './minecraftLlmcPrepRules.js';

/**
 * mb-llmc r6 (run 29, 2026-10-22, owner 「r6 を作り 2 モデルで比べる」): the facts of readiness the decision is shown first, written by the code
 * and decided by the model. Run 29 began inside a Nether fortress with one cooked mutton and no table, slabs or shield; at 10 s she opened
 * the blaze spawner's shaft, at 418 s her health was 3.7 with no food and hunger 17, and she waited 325 s for health that never came.
 *
 * - `preparationShortage`: what the current plan node and the dimension need (the knowledge's 「出発の点検」, as a table) set against the
 *   pack: 「準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾が無い。食料 15.6 点（目安 100）」. Null when nothing is missing.
 * - `recoveryLine`: health below full and hunger under 18, where health does not come back by itself; `foodLeads`: where food is
 *   (animals near, the scan's village rows, a hoglin and a crimson forest in the Nether, the gate back with its distance).
 * - `llmcWaitLine`: what an `fca_wait` of a task nobody can answer is told (what there is to wait for, or that there is nothing).
 */
type Stage = 'nether_deep' | 'nether_entry' | 'end' | 'diamonds';
type Need = PrepNeed;

const ARMOUR = /^(?:iron|diamond|netherite)_(?:helmet|chestplate|leggings|boots)$/u;
const STAGES: Readonly<Record<Exclude<Stage, 'diamonds'>, { title: string; food: number; needs: readonly Need[] }>> = {
  nether_deep: { title: 'ネザーの奥へ', food: 100, needs: [
    { label: '作業台', count: 1, pattern: /^crafting_table$/u }, { label: 'ハーフブロック', count: 12, pattern: /_slab$/u },
    { label: '盾', count: 1, pattern: /^shield$/u }, { label: '金の防具', count: 1, pattern: /^golden_(?:helmet|chestplate|leggings|boots)$/u },
    { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
  nether_entry: { title: 'ネザーに入る前', food: 100, needs: [
    { label: '鉄の防具', count: 4, pattern: ARMOUR, slots: true }, { label: '盾', count: 1, pattern: /^shield$/u },
    { label: '剣', count: 1, pattern: /^(?:stone|iron|diamond|netherite)_sword$/u },
    { label: '鉄以上のツルハシ', count: 1, pattern: /^(?:iron|diamond|netherite)_pickaxe$/u },
    { label: '水入りバケツ', count: 1, pattern: /^water_bucket$/u }, { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
  end: { title: 'エンドへ', food: 80, needs: [
    { label: 'ベッド', count: 4, pattern: BED_ITEM }, { label: '弓', count: 1, pattern: /^bow$/u }, { label: '矢', count: 30, pattern: /^arrow$/u },
    { label: 'エンダーアイ', count: 12, pattern: /^ender_eye$/u }, { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
};
/**
 * SHANNON_MINECRAFT_LLMC_V2 (run 36: the entry's shortage said 食料 100 点・鉄の防具 4・水入りバケツ while the node was the obsidian, and the plan put
 * 金の防具・ハーフブロック・食料 100 点 before the gate; the pass mark is the Nether within 30 minutes): what the gate needs is a pickaxe, a shield, a
 * sword, blocks to stand on and food for the first stretch (40 points). The rest (the table, slabs, gold armour, food 100) is the check after
 * she is in (`nether_deep`), which still holds before the fortress.
 * Owner 2026-10-24 (after run 38: only iron boots from a chest, no golden piece at the gate): the gate and the diamonds read the one table of
 * `minecraftLlmcPrepRules.ts` (the iron helmet, chestplate and leggings worn before the diamonds, the golden boots before the gate).
 */
const ENTRY_V2: PrepStage = BEFORE_GATE;
const END_NODE = /ストロングホールド|エンド(?!ウ)|三角|ポータルの部屋|アイ/u;
const GATE_NODE = /ゲート|ネザーに入|黒曜石|火打|金のブーツ/u;
const DIAMOND_NODE = /ダイヤ/u;

/**
 * The stage whose check holds now: by the dimension, and in the overworld by the current node's title (and eyes carried). `v2`: a node of the
 * diamonds is checked against `BEFORE_DIAMONDS` (the old modes have no such stage).
 */
export function preparationStage(dimension: string | null, counts: ItemCounts, nowTitle: string | null, v2 = false): Stage | null {
  if (dimension === 'the_nether') {
    const rods = countMatching(counts, /^blaze_rod$/u), pearls = countMatching(counts, /^(?:ender_pearl|ender_eye)$/u);
    return rods >= 7 && pearls >= 12 ? null : 'nether_deep';
  }
  if (dimension !== 'overworld') return null;
  if (countMatching(counts, /^ender_eye$/u) > 0 || (nowTitle && END_NODE.test(nowTitle))) return 'end';
  if (nowTitle && GATE_NODE.test(nowTitle)) return 'nether_entry';
  return v2 && nowTitle && DIAMOND_NODE.test(nowTitle) ? 'diamonds' : null;
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
  v2?: boolean; worn?: readonly string[] }): string | null {
  const stage = preparationStage(parts.dimension, parts.counts, parts.nowTitle, parts.v2 === true);
  if (!stage) return null;
  const table = stage === 'diamonds' ? BEFORE_DIAMONDS : parts.v2 && stage === 'nether_entry' ? ENTRY_V2 : STAGES[stage];
  const none: string[] = [], short: string[] = [], unworn: string[] = [];
  for (const need of table.needs) {
    const have = held(parts.counts, need);
    if (have <= 0) none.push(need.label);
    else if (have < need.count) short.push(`${need.label} ${have}/${need.count}`);
    if (need.worn && parts.worn && have > 0) {
      unworn.push(...[...parts.counts.keys()].filter(name => need.pattern.test(name) && !parts.worn!.includes(name)));
    }
  }
  const food = parts.food < table.food ? `食料 ${round1(parts.food)} 点（目安 ${table.food}）` : '';
  const said = [none.length ? `${none.join('・')}が無い` : '', short.join('・'), unworn.length ? `持っているが着ていない: ${unworn.join('・')}` : '', food]
    .filter(Boolean);
  return said.length ? `準備の不足（${table.title}）: ${said.join('。')}` : null;
}

/** Health that does not come back by itself (hunger under 18, health under full), said as the fact; null otherwise. */
export function recoveryLine(hunger: number | null, health: number | null, food: number): string | null {
  if (hunger === null || health === null || health >= 20 || hunger >= 18) return null;
  return `この状態では体力は自然に戻らない（満腹 ${round1(hunger)}＜18、食料 ${round1(food)} 点）`;
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
const VILLAGE_ROW = /^(?:村の鐘|ベッド|干し草|畑|作物)/u;
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

/** The furnaces at work in the frame (`world.jobs`): how many, and the soonest done in seconds. */
function furnaces(world: Record<string, unknown>): string | null {
  const jobs = (Array.isArray(world.jobs) ? world.jobs : []).flatMap(item => {
    const left = finite(record(item)?.remainingEstimateMs);
    return left !== null ? [left] : [];
  });
  return jobs.length ? `かまどの焼き上がり（${jobs.length} 件、早いもので約 ${Math.max(0, Math.round(Math.min(...jobs) / 1000))} 秒）` : null;
}

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
 * What an `fca_wait` of a task nobody can answer is told in the mode (one line; it never stops the task): what there is to wait for (a
 * furnace at work, health coming back at hunger 18 or more), or that there is nothing, with the recovery fact and where food is.
 */
export function llmcWaitLine(observation: BodyObservation | null, nodes: readonly PlanNode[] = []): string {
  const facts = readinessOf(observation);
  const head = '待ちではタスクは止まらない（運用者の依頼: 返事を待つ相手はいない）。';
  if (!facts) return `${head}体の観測が無い: 待つ物は分からない。計画の今の節を続ける。`;
  const regen = facts.hunger !== null && facts.health !== null && facts.hunger >= 18 && facts.health < 20
    ? `体力の回復（満腹 ${round1(facts.hunger)}≥18、体力 ${round1(facts.health)}/20）` : null;
  const waits = [furnaces(facts.world), regen].filter(Boolean);
  if (waits.length) return `${head}待つ物: ${waits.join('・')}。その場で待つなら mc.act の wait の手で（体が待つ）。`;
  const recovery = recoveryLine(facts.hunger, facts.health, facts.food);
  return `${head}待つ物が無い（焼いている物は無い${recovery ? `・${recovery}` : ''}）。`
    + `${recovery ? `${foodLeads(facts.world, facts.dimension, nodes)}。` : ''}計画の今の節を続ける。`;
}
