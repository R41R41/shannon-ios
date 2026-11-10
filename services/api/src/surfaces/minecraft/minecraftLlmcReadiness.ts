import { orderedPlan, type PlanKind, type PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { FOOD_PASS } from './minecraftNightArms.js';
import { BED_ITEM, carriedItemCounts, countMatching, wornItems, type ItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import {
  BEFORE_DIAMONDS, BEFORE_GATE, BLOCKS, END_BEDS, END_FALLBACK_WEAPONS, END_GATHER_MS, END_MIN_FOOD, END_OBSIDIAN, END_WEAPONS, endGatherSince,
  FIGHT_OBSIDIAN_LABEL, RETURN_TO_END,
  type PrepNeed, type PrepStage,
} from './minecraftLlmcPrepRules.js';
import { foodPointsWords } from './minecraftFoodWords.js';
import { fetchingNetherDrops, portalCellHand } from './minecraftLlmcGateEntry.js';
import { kindOf, readWhere } from './minecraftPlanFacts.js';
import { parseDoneWhen, predicateDimension } from './minecraftPlanDone.js';
import { returningToEnd } from './minecraftEndEntry.js';
import { framesOf } from './minecraftSeenMarks.js';
import { oreRouteHands, stonePickHands } from './minecraftOreRoute.js';

/**
 * mb-llmc r6 (run 29, 2026-10-22, owner 「r6 を作り 2 モデルで比べる」): the facts of readiness the decision is shown first,
 * written by the code
 * and decided by the model. Run 29 began inside a Nether fortress with one cooked mutton and no table, slabs or
 * shield; at 10 s she opened
 * the blaze spawner's shaft, at 418 s her health was 3.7 with no food and hunger 17, and she waited 325 s for
 * health that never came.
 *
 * - `preparationShortage`: what the current plan node and the dimension need (the knowledge's 「出発の点検」, as a
 * table) set against the
 *   pack: 「準備の不足（ネザーの奥へ）: 作業台・ハーフブロック・盾が無い。食料 15.6 点（目安 100）」. Null when nothing is missing.
 * - `recoveryLine`: health below full and hunger under 18, where health does not come back by itself; `foodLeads`: where food is
 *   (animals near, the scan's village rows, a hoglin and a crimson forest in the Nether, the gate back with its distance).
 */
type Stage = 'nether_deep' | 'nether_blaze' | 'nether_entry' | 'end' | 'diamonds';
type Need = PrepNeed;

const STAGES: Readonly<Record<'nether_deep' | 'nether_blaze' | 'end', { title: string; food: number; needs: readonly Need[] }>> = {
  nether_deep: { title: 'ネザーの奥へ', food: 100, needs: [
    // The section audit of 11/5: the slabs left the check (they held the fortress's search), and the golden piece is a goal here (the gate asks it).
    { label: '作業台', count: 1, pattern: /^crafting_table$/u },
    { label: '盾', count: 1, pattern: /^shield$/u }, { label: '金の防具', count: 1, pattern: /^golden_(?:helmet|chestplate|leggings|boots)$/u, goal: true },
    { label: '足場のブロック', count: 64, pattern: BLOCKS }] },
  // end1108h11 S7 (11/8): at the fortress with a bow, 30 arrows, a shield and 478 food points, the check of the way in said 「作業台が無い」 at
  // every decision, the knowledge said 「ブレイズは準備（shortage が空）の後」, and the head hid from a lone blaze at 14 m for 6 minutes at
  // health 20 (0 shots). Rods become powder and eyes in the 2×2 grid; the table is for remaking tools, not for the fight. The fight's own
  // check: the shield, the blocks of the hideout and food; no goals (a goal line would keep the shortage from being empty).
  nether_blaze: { title: 'ブレイズ戦へ', food: 60, needs: [
    { label: '盾', count: 1, pattern: /^shield$/u }, { label: '足場のブロック', count: 32, pattern: BLOCKS }] },
  end: { title: 'エンドへ', food: 330, needs: [
    { label: 'ベッド（目標 10）', count: END_BEDS, pattern: BED_ITEM },
    { label: FIGHT_OBSIDIAN_LABEL, count: END_OBSIDIAN, pattern: /^obsidian$/u },
    ...END_WEAPONS,
    // end1108d S9 (11/8): 「エンダーアイ 11/12」 one throw after 12 sent the first plan back to the Nether; 10 in hand is the stronghold's
    // (thrown eyes are picked up, frames hold some from the start; the frames in view say the rest).
    { label: 'エンダーアイ（12 が目安。落ちたアイは拾う）', count: 10, pattern: /^ender_eye$/u }, { label: '足場のブロック', count: 64, pattern: BLOCKS },
    // S1's lab (2026-11-02): a fall from a crystal's pillar is stopped by water the body pours under itself, with a full bucket and nothing else.
    { label: '水入りバケツ', count: 1, pattern: /^water_bucket$/u }] },
};
/**
 * The gate (run 36: the entry's shortage said 食料 100 点・鉄の防具 4・水入りバケツ while the node was the obsidian, and the plan put
 * 金の防具・ハーフブロック・食料 100 点 before the gate; the pass mark is the Nether within 30 minutes): what the gate needs is
 * a pickaxe, a shield, a
 * sword, blocks to stand on and food for the first stretch (40 points). The rest (the table, slabs, gold armour,
 * food 100) is the check after
 * she is in (`nether_deep`), which still holds before the fortress.
 * Owner 2026-10-24 (after run 38: only iron boots from a chest, no golden piece at the gate): the gate and the
 * diamonds read the one table of
 * `minecraftLlmcPrepRules.ts` (the iron helmet, chestplate and leggings worn before the diamonds, the golden
 * boots before the gate).
 */
/**
 * Chapter 7 (the continue contract): the stage a node's kind belongs to, read from the kind the model wrote and
 * never from a title.
 * The end's check: the
 * stronghold, the pearls and the End; the gate's: the obsidian, the portal and the Nether; the diamonds'.
 */
const STAGE_OF_KIND: Readonly<Partial<Record<PlanKind, Stage>>> = { end: 'end', stronghold: 'end', pearl: 'end', portal: 'nether_entry',
  obsidian: 'nether_entry', nether: 'nether_entry', diamond: 'diamonds' };

/**
 * The stage whose check holds now: by the dimension, and in the overworld by the kind of the current node (the
 * nearest node, itself
 * or above it, whose
 * kind has a stage) and eyes carried; a node of the diamonds is checked against `BEFORE_DIAMONDS`. `kinds`: the
 * current node's kind,
 * then those above it
 * (`nowKinds`); absent or empty: none is known and no stage is chosen by a node.
 */
export function preparationStage(dimension: string | null, counts: ItemCounts, kinds: readonly PlanKind[] | null): Stage | null {
  if (dimension === 'the_nether') {
    const rods = countMatching(counts, /^blaze_rod$/u), pearls = countMatching(counts, /^(?:ender_pearl|ender_eye)$/u);
    if (rods >= 7 && pearls >= 14) return null;
    return kinds?.[0] === 'blaze' && rods < 7 ? 'nether_blaze' : 'nether_deep';
  }
  if (dimension !== 'overworld') return null;
  if (countMatching(counts, /^ender_eye$/u) > 0) return 'end';
  for (const kind of kinds ?? []) {
    const stage = STAGE_OF_KIND[kind];
    if (stage) return stage;
  }
  return null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
/** How many of a need she has: each matching id (armour: each slot once). */
function held(counts: ItemCounts, need: Need): number {
  if (need.weight) return [...counts].reduce((sum, [name, count]) => sum + (need.pattern.test(name) ? count * need.weight!(name) : 0), 0);
  if (!need.slots) return countMatching(counts, need.pattern);
  const slots = new Set([...counts.keys()].filter(name => need.pattern.test(name)).map(name => name.split('_').at(-1)));
  return slots.size;
}

// Harvest tiers checked against the production body's 1.21.11 block registry.
const MINING_TOOLS: Readonly<Partial<Record<PlanKind, { label: string; tools: RegExp }>>> = {
  stone_tools: { label: '丸石の採掘に使えるツルハシ', tools: /^(?:wooden|copper|stone|golden|iron|diamond|netherite)_pickaxe$/u },
  iron: { label: '鉄鉱石の採掘に使えるツルハシ（銅・石・鉄・ダイヤ・ネザライト）', tools: /^(?:copper|stone|iron|diamond|netherite)_pickaxe$/u },
  diamond: { label: 'ダイヤ鉱石の採掘に使えるツルハシ（鉄・ダイヤ・ネザライト）', tools: /^(?:iron|diamond|netherite)_pickaxe$/u },
  obsidian: { label: '黒曜石の採掘に使えるツルハシ（ダイヤ・ネザライト）', tools: /^(?:diamond|netherite)_pickaxe$/u },
};
function miningToolShortage(counts: ItemCounts, kinds: readonly PlanKind[] | null, inventory?: unknown): string | null {
  // A past acquisition node is history; the current pack establishes mining capability.
  // This is a mining fact, not a requirement on chest loot, casting a portal, or an ancestor node.
  const requirement = kinds?.[0] ? MINING_TOOLS[kinds[0]] : undefined;
  if (!requirement) return null;
  const usable = currentUsableCounts(counts, inventory);
  return countMatching(usable, requirement.tools) === 0 ? `${requirement.label}が現在無い（過去の達成履歴とは別）` : null;
}

/** Unknown wear is kept unknown; an explicitly exhausted stack cannot establish current capability. */
export function currentUsableCounts(counts: ItemCounts, inventory?: unknown): Map<string, number> {
  const usable = new Map(counts);
  if (!Array.isArray(inventory)) return usable;
  const broken = new Map<string, number>();
  for (const raw of inventory) {
    const stack = raw as { name?: string; count?: number; durability?: { left?: number } } | null;
    if (stack && typeof stack.name === 'string' && typeof stack.count === 'number' && stack.durability?.left === 0)
      broken.set(stack.name, (broken.get(stack.name) ?? 0) + stack.count);
  }
  for (const [name, count] of broken) usable.set(name, Math.max(0, (usable.get(name) ?? 0) - count));
  return usable;
}

/** What the pack lacks of some needs: none at all, some but not enough, and armour carried but not worn. */
interface Gaps { none: string[]; short: string[]; unworn: string[] }
function gapsOf(needs: readonly Need[], parts: { counts: ItemCounts; worn?: readonly string[] }): Gaps {
  const gaps: Gaps = { none: [], short: [], unworn: [] };
  for (const need of needs) {
    const have = held(parts.counts, need);
    const label = need.materials ? `${need.label}（${need.materials(parts.counts)}）` : need.label;
    if (have <= 0) gaps.none.push(label);
    else if (have < need.count) gaps.short.push(`${label} ${have}/${need.count}`);
    if (need.worn && parts.worn && have > 0) {
      gaps.unworn.push(...[...parts.counts.keys()].filter(name => need.pattern.test(name) && !parts.worn!.includes(name)));
    }
  }
  return gaps;
}
const gapWords = (gaps: Gaps): string[] => [gaps.none.length ? `${gaps.none.join('・')}が無い` : '', gaps.short.join('・'),
  gaps.unworn.length ? `持っているが着ていない: ${gaps.unworn.join('・')}` : ''].filter(Boolean);

const foodLack = (table: PrepStage, food: number): string => food < table.food ? `${foodPointsWords(food)}（目安 ${table.food}）` : '';
/** The required needs of a stage that are not met (the food counts as one). */
function mustWords(table: PrepStage, parts: { counts: ItemCounts; food: number; worn?: readonly string[] }): string[] {
  return [...gapWords(gapsOf(table.needs.filter(need => !need.goal), parts)), foodLack(table, parts.food)].filter(Boolean);
}

/**
 * The End's check once the portal room's frames are in view (S5's section of 11/5: the line asked 12 eyes in hand when the frames held some
 * already): the eyes of the empty frames, not twelve (none when all hold one), and the food the gate asks there (80; G12, `minecraftEndGather.ts`).
 */
function endStage(world: Record<string, unknown> | undefined): PrepStage {
  const frames = world ? framesOf(world) : null;
  if (!frames) return STAGES.end;
  const empty = Math.max(0, frames.frames - frames.eyes);
  return { ...STAGES.end, food: END_MIN_FOOD, needs: STAGES.end.needs.flatMap(need => !need.label.startsWith('エンダーアイ') ? [need]
    : empty > 0 ? [{ ...need, label: 'エンダーアイ（空いた枠の分）', count: empty }] : []) };
}

/**
 * The End's check against the beds' gathering clock (`endGatherSince`, the gate's own; ChatGPT's review of 11/10, Q2: past ten minutes the gate
 * let her in on the fallback while this line still asked the beds and the fight obsidian at every decision). The check only reads the clock;
 * the gate's first hold at the portal starts it. Past `END_GATHER_MS` the check asks the fallback's kit instead (an iron sword required,
 * the bow and 30 arrows aims; the beds and the fight obsidian no longer asked). Without a task there is no clock and the table stays.
 */
function endCheck(parts: { counts: ItemCounts; world?: Record<string, unknown>; taskId?: string; now?: number }): PrepStage {
  const table = endStage(parts.world);
  if (!parts.taskId) return table;
  const gathering = (need: Need): boolean => need.pattern === BED_ITEM || need.label === FIGHT_OBSIDIAN_LABEL;
  // The review of 11/10, E1: an eye carried started the clock at the check, and it ran out before the stronghold. The gate starts it.
  const now = parts.now ?? Date.now(), since = endGatherSince(parts.taskId, now, false);
  if (since === null || now - since < END_GATHER_MS) return table;
  return { ...table, food: END_MIN_FOOD, title: `エンドへ（ベッド集めの ${END_GATHER_MS / 60_000} 分を過ぎた。予備の手：鉄以上の剣。弓と矢 30 はあれば使う）`,
    needs: [...table.needs.filter(need => !gathering(need) && !END_WEAPONS.includes(need)), ...END_FALLBACK_WEAPONS] };
}

/** Goals are facts of a missing fallback, never requirements of the entry gate. */
function goalWords(table: PrepStage, parts: { counts: ItemCounts; worn?: readonly string[] }): string {
  const wanted = gapWords(gapsOf(table.needs.filter(need => need.goal), parts));
  return wanted.length ? `目標（そろえば。必須ではない）— ${wanted.join('。')}` : '';
}

/**
 * The one line of what is missing for the stage or current mining operation, or null. `worn` (the frame's worn
 * ids, `wornItems`): a piece of a need
 * that is to be worn and is only carried is said as such (「着ていない: iron_helmet」), since armour in the pack does not protect.
 * A stage that says what its lack costs (`PrepStage.risk`: the diamonds', the gate's; run59 leg 1 went on to both with no shield and no
 * armour, the lack said in one line with the golden boots, which only a goal) says it in two parts: the required needs, with the cost of going on
 * without them, and the goals; the other stages keep the one line.
 */
export function preparationShortage(parts: { dimension: string | null; counts: ItemCounts; food: number; nowKinds: readonly PlanKind[] | null;
  worn?: readonly string[]; inventory?: unknown; world?: Record<string, unknown>; taskId?: string; journeyReadiness?: boolean; now?: number }): string | null {
  const returning = returningToEnd(parts.world ?? {}, parts.dimension, parts.taskId);
  const mining = miningToolShortage(parts.counts, parts.nowKinds, parts.inventory);
  const stage = parts.journeyReadiness === false ? null : preparationStage(parts.dimension, parts.counts, parts.nowKinds);
  if (!stage) return mining;
  const table: PrepStage = stage === 'end' ? (returning ? RETURN_TO_END : endCheck(parts))
    : stage === 'diamonds' ? BEFORE_DIAMONDS : stage === 'nether_entry' ? BEFORE_GATE : STAGES[stage];
  const goals = goalWords(table, parts);
  if (!table.risk) {
    const said = [...mustWords(table, parts), goals, mining].filter(Boolean);
    return said.length ? `準備の不足（${table.title}）: ${said.join('。')}` : null;
  }
  const must = mustWords(table, parts);
  const said = [must.length ? `必須（${table.title}に必ず）— ${must.join('。')}。欠けたまま進むと: ${table.risk}` : '',
    goals, mining].filter(Boolean);
  return said.length ? `準備の不足（${table.title}）: ${said.join('。')}` : null;
}

/** The fullness each food gives (the game's own hunger points), for what to eat to reach 18. Raw chicken, spider
 * eyes and the like are left out. */
export const FULLNESS: Readonly<Record<string, number>> = Object.freeze({
  rabbit_stew: 10, cooked_beef: 8, cooked_porkchop: 8, pumpkin_pie: 8, cooked_mutton: 6, cooked_salmon: 6, cooked_chicken: 6, golden_carrot: 6,
  mushroom_stew: 6, beetroot_soup: 6, bread: 5, baked_potato: 5, cooked_cod: 5, cooked_rabbit: 5, apple: 4, carrot: 3, beef: 3, porkchop: 3,
  rabbit: 3, mutton: 2, cod: 2, salmon: 2, melon_slice: 2, sweet_berries: 2, glow_berries: 2, cookie: 2, potato: 1, beetroot: 1, dried_kelp: 1,
});
/**
 * GPT's review 2026-10-28 (the live state is data; a rule and a story of a run said at every decision are not
 * facts): the recovery line says the fact,
 * what in the pack takes the fullness to 18 and how long health then takes; that health that does not come back
 * is to be eaten for before a descent
 * or a fight, even with an enemy near, and what going on without it costs, is a rule of the instructions (「敵と体力」).
 */

/**
 * Health that does not come back by itself (hunger under 18, health under full): the fact, what in the pack
 * takes the fullness to 18 and how long
 * health then takes to come back, and what going on without it cost (run 42: the line said the fact alone, 7
 * decisions in a row, and she went down at
 * 11.3 and died); null otherwise.
 */
/** A hostile within this many blocks counts as an enemy near (`enemyNear`). */
const ATTACK_NEAR = 8;
export function enemyNear(world: Record<string, unknown>): boolean {
  const threats = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  return threats.some(raw => { const distance = finite(record(raw)?.distance);
    return distance !== null && distance <= ATTACK_NEAR; });
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
export const feetOf = (world: Record<string, unknown>): Feet | null => {
  const at = record(world.position), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
};
const ANIMALS = /^(?:cow|pig|sheep|chicken|rabbit|mooshroom|cod|salmon|hoglin)$/u;
/** The village's rows that are food or lead to it (run 40: the descent note named 「ベッド ×6」 as where food is; a
 * bed is not food). */
const VILLAGE_ROW = /^(?:村の鐘|干し草|畑|作物)/u;
/**
 * The first `(x,y,z)` of a text, or its first bare `x,y,z`. r7 (run 30: the plan's 「ゲートから戻り狩って焼く」 had where `5,35,12`, with no
 * brackets, so the gate back was never said): both, as `planDone`'s `at:` reads it.
 */
export const firstPos = (text: string): Feet | null => readWhere(text, 'any');

/** The gate back from the Nether: the scan's portal row, else a plan node of the portal's kind with a place (its
 * distance from her feet). */
function gateBack(world: Record<string, unknown>, rows: readonly string[], nodes: readonly PlanNode[], feet: Feet | null): string | null {
  const row = rows.find(line => /ネザーポータル|nether_portal/u.test(line));
  if (row) return `帰りのゲート（走査）${row.replace(/^[^(（]*/u, '').slice(0, 50)}`;
  const node = nodes.find(item => kindOf(item) === 'portal' && item.where && firstPos(item.where));
  if (!node) return null;
  const at = firstPos(node.where!)!;
  const far = feet ? ` 約 ${Math.round(Math.hypot(at.x - feet.x, at.z - feet.z))}m` : '';
  return `帰りのゲート (${at.x},${at.y},${at.z})${far}（計画 ${node.id} の where）`;
}

/**
 * Where food is, from the frame alone: the animals near (nearest three), the scan's village, field and crop
 * rows, in the Nether a hoglin
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
  const unexplored = dimension === 'overworld' && !near.length ? '。走査外は未確認。地下や水中の食料・地表への帰路も未確認。水が見えるだけでは魚の所在も未確認' : '';
  const nether = dimension === 'the_nether' && !near.some(line => /hoglin|crimson|真紅/u.test(line)) ? '・ホグリン・真紅の森は見えていない' : '';
  return `食料の当て: ${near.length ? near.join('・') : `近くに動物・村・畑は見えていない${scan ? '（走査の範囲）' : ''}`}${nether}${gate ? `・${gate}` : ''}${unexplored}`;
}

/** A plan node about food: its kind is `food` (chapter 7: the kind the model wrote, not the title's words or the condition's). */
const isFoodNode = (node: PlanNode): boolean => kindOf(node) === 'food' || kindOf(node) === 'prep_descent';
/**
 * r7 (runs 29, 30: hunger 17 and no food, health that did not come back, and the plan's food node 「ゲートから戻り狩って焼く」 (p1.5) stayed
 * behind 「歪んだ幹で作業台」 (p1.1), 118 m the other way; Sonnet never went for food in 1,338 s): while health does not come back and she
 * has no food, the plan's first open food node is said before its now, with its place and how far: 「回復が先: 食料の節 [p1.5] ゲートから
 * 戻り狩って焼く＠5,35,12（約 313m）」. Null when there is none, or the current node is one (or under one).
 */
export function foodFirstLine(nodes: readonly PlanNode[], current: string | null, feet: Feet | null, dimension: string | null = null): string | null {
  // A node the model wrote `prep: skipped` on is one it chose to go without: it is not said as the node to go for.
  const open = (node: PlanNode) => node.state !== 'done' && node.prep?.state !== 'skipped';
  const leaf = (node: PlanNode) => !nodes.some(child => child.parentId === node.id && open(child));
  const isFood = isFoodNode;
  const parent = new Map(nodes.map(node => [node.id, node.parentId]));
  for (let at: string | null = current, guard = 0; at && guard < 16; at = parent.get(at) ?? null, guard += 1) {
    const node = nodes.find(item => item.id === at);
    if (node && isFood(node)) return null;
  }
  const order = orderedPlan(nodes), dimensions = new Map<string, string | null>(), beyondGate = new Set<string>();
  const here = dimension?.replace(/^minecraft:/u, '') ?? null, from = order.findIndex(node => node.id === current);
  let blocked = false;
  let near: string | null = null;
  // The plan's existing dimension convention: the nearest preceding explicit dim predicate, never a title or free-form place name.
  for (const [index, node] of order.entries()) {
const notePlanDimension = () => {
    const predicate = parseDoneWhen(node.doneWhen);
    const own = predicate ? predicateDimension(predicate) : null;
    near = own ?? near;
    dimensions.set(node.id, near);
    const crossesDimension = () => (index > from && here && own && own !== here && node.state !== 'done');
    if (crossesDimension()) blocked = true;
    if (blocked) beyondGate.add(node.id);

};
notePlanDimension();
}
  const candidates = order.filter(node => open(node) && leaf(node) && isFood(node) && node.id !== current);
  const food = candidates.find(node => !here || (!beyondGate.has(node.id) && (!dimensions.get(node.id) || dimensions.get(node.id) === here)));
  const foodBeyondDimension = () => (!food && here && candidates.length);
  if (foodBeyondDimension()) return `回復が先: 今いる次元（${here}）で向かえる食料の節は未確認。現地の候補か帰れる経路を確かめ、計画を見直す`;
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
 * run 26 (2026-10-26, 「エンドラを討伐して」, Sonnet: the plan said 食料 before the iron, she went down to the iron at 166 s
 * with 5 of 40 food points, came up the
 * shaft for cows at 311 s (114 s, the pillar failing four times), went down again at 484 s, up at 705 s and down
 * at 875 s; about 300 s on the stairs):
 * an act that takes her 10 or more blocks down from the surface while the food she carries is under what the
 * iron night needs says so in its result,
 * with the cows in sight.
 * A fact beside the act, which goes as it is; the food points are the stage knowledge's (`FOOD_BEFORE_DESCENT`,
 * 40 before the iron).
 */
export const FOOD_BEFORE_DESCENT = 40;
/** Planks that make a table (4), when the pack holds no table. */
export const TABLE_PLANKS = 4;
const SURFACE_Y = 45;
export const DESCENT = 10;
/** The lowest y the walks and digs of an act reach (a `rel` hand counts from her feet), or the feet's own when
 * none goes lower. */
export function lowestReach(hands: unknown, feetY: number): number {
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
 * Run 43 (+1,291 q95, 「[p5.1] ダイヤへ下りる」 from y≈14 to y=-56 with no table and no planks: the planks had gone into
 * the furnace; at the diamonds
 * 「作業台へ戻りダイヤのツルハシ」 took 270 s up and back, +1,351 to +1,623): the descent's check was the first one's only (from
 * the surface). A hand
 * that goes 10 or more further down underground without a table or 4 planks says so too: what cannot be made
 * down there, and what it cost.
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
 * Run 43 (+720 to +1,766, about 600 s: raw_iron ×15 with one plank, five waits before a furnace out of fuel, a
 * climb to the surface for wood; the
 * coal ore ×10 on the map at y=44 was passed on the way down): what she carries to smelt against the fuel she
 * carries, with the nearest coal on the map.
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
  // end1109o04: 14 raw meats and no coal on the map read as "no fuel, so wait for the night" with iron ore 14 blocks down. What is to be
  // smelted, ores apart from meat, and that the mining does not wait for the fuel (the coal is in the same rock as the iron; a log burns too).
  let ores = 0;
  for (const [name, count] of counts) if (TO_SMELT.test(name) && /(?:^raw_|_ore$)/u.test(name)) ores += count;
  const logs = countMatching(counts, /_(?:log|stem)$/u);
  const what = ores === items ? `（鉱石 ${ores}）` : `（鉱石 ${ores}・食べ物 ${items - ores}。生でも食べられる）`;
  const meanwhile = `${seen ? '' : '石炭は鉄と同じ地下の岩によく出る（鉄へ下りる途中で掘れる）。'}燃料が無くても鉱石は先に掘っておける（焼くのは燃料が揃ってから）`
    + (logs > 0 ? `。原木 ${logs} も燃える（1 本で 1.5 個）` : '');
  return `燃料: 焼く物 ${items} 個${what}に石炭 ${coal} が要る（石炭 1 で 8 個、板 1 枚は 1.5 個。板 ${planks} は作業台と道具の分）。${where}。${meanwhile}`;
}

const IRON_MARK = /鉄鉱石\[(?:deepslate_)?iron_ore\]/u;

/**
 * end1109o09: the now was the iron armour, no iron ore and no coal on the map, and twice by day she waited about 4 minutes for the night
 * (planNow already said waiting cost 14% of the goal; the replay with that said louder chose the wait 5 of 6). What was missing was how
 * to find it: the scan, then the stair down to y=16 and one row dug sideways (`oreRouteHands`). The line is said only while the now wants
 * iron and the map shows none, in the overworld, with a pickaxe that takes iron.
 */
export function ironSearchLine(world: Record<string, unknown>, counts: ItemCounts, dimension: string | null, now: PlanNode | undefined): string | null {
  if (dimension !== 'overworld' || !now) return null;
  const wants = /iron/u.test(String(now.doneWhen ?? '')) || /鉄(?!ゴーレム)/u.test(String(now.title ?? ''));
  if (!wants) return null;
  if (!['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].some(name => (counts.get(name) ?? 0) > 0)) return null;
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).filter((line): line is string => typeof line === 'string');
  if (marks.some(line => IRON_MARK.test(line))) return null;
  const route = oreRouteHands(world, 'iron', counts);
  if (!route) return null;
  return `鉄鉱石: 今の節 ${now.id} に要るが、地図に見えていない（待っても見えてこない。地下は昼も夜も同じ暗さなので夜を待たない）。探す手: ① mc_probe kind=scan（鉱石の行）`
    + ` ② それでも無ければ ${route}`;
}

const WANTS_WOOL = (node: PlanNode): boolean => /wool|_bed(?![a-z_])|(?:^|[^a-z_])bed(?:[^a-z_]|$)/u.test(String(node.doneWhen ?? '')) || /羊|ベッド/u.test(String(node.title ?? ''));

/**
 * end1109o10: no sheep near her start; the now was the bed (wool 3) and she walked the grass for them about 15 minutes over three days,
 * saw none, and waited each night in a hole (bed none). The facts she lacked: a walk does not make a sheep appear, the bed is not needed
 * to go on (the night underground goes as far as the day), and the node can be set aside and taken up again when a sheep is seen. Said
 * while the now (or the node above it that wants the bed) wants wool, no bed is in the pack, no sheep is in sight and no village bed
 * within 64 m is on the map. The hand names the highest node of the bed so that one set clears the sheep, the wool and the bed together.
 */
export function sheepAbsentLine(world: Record<string, unknown>, counts: ItemCounts, dimension: string | null, nodes: readonly PlanNode[],
  now: PlanNode | undefined): string | null {
  if (dimension !== 'overworld' || !now || !WANTS_WOOL(now)) return null;
  if (countMatching(counts, BED_ITEM) > 0) return null;
  const seen = (Array.isArray(world.nearbyEntities) ? world.nearbyEntities : [])
    .some(entity => !!entity && typeof entity === 'object' && (entity as { name?: unknown }).name === 'sheep');
  if (seen) return null;
  const feet = feetOf(world);
  const villageBed = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).some(line => {
    const m = typeof line === 'string' ? /^B [^()]*ベッド \((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line) : null;
    return !!m && (!feet || Math.hypot(Number(m[1]) - feet.x, Number(m[3]) - feet.z) <= 64);
  });
  if (villageBed) return null;
  let top = now;
  // Up while the node above wants the bed too and holds nothing else still open (「食料とベッド」 with the food done, not with it to do).
  const clean = (node: PlanNode) => WANTS_WOOL(node) && nodes.filter(kid => kid.parentId === node.id).every(kid => kid.state === 'done' || WANTS_WOOL(kid));
  for (let parent = nodes.find(node => node.id === top.parentId); parent && clean(parent); parent = nodes.find(node => node.id === top.parentId)) top = parent;
  return `羊: 今の節 ${now.id} に羊毛が要るが、見える所に羊がいない（草原を歩き回っても羊が出てくる保証は無く、時間だけが減る）。`
    + `ベッドが無くても先へ進める（夜は地下で鉄・ダイヤを掘れば昼と同じだけ進む）。手: plan_update の ops [{"op":"set","id":"${top.id}","state":"blocked","reason":"羊が見えない"}] で`
    + `${top.id === now.id ? 'この節' : `ベッドの節 ${top.id}`}を外し、次の節へ。ほかの用事の途中で羊が見えたら倒して羊毛を取り、state=continue で戻す`;
}

const WANTS_GOLD = (node: PlanNode): boolean => /raw_gold|gold_ingot|golden_/u.test(String(node.doneWhen ?? '')) || /金鉱石|金のブーツ|金の防具/u.test(String(node.title ?? ''));  // not 「火打ち金」
/** The map's mark of a gold ore (the body's mapMarks: 「金[gold_ore] (x,y,z)」, the id beside the word). */
const GOLD_MARK = /\[(?:deepslate_)?gold_ore\]/u;
/**
 * end1109o5a (section 5, the kit given): the gold boots' node came after the kit closed the diamonds, the nearest gold was about 60 m off and
 * deep, and she held that node for about 11 of her 15 minutes (much of it waiting a night in a hole); the obsidian, the flint and the gate
 * were never begun. The golden piece is a goal at the gate, not a requirement (`STAGES.nether_deep`, the prep rules' 「目標」). Said like the
 * sheep's (`sheepAbsentLine`): while the now wants gold, no golden piece is carried and no gold ore is on the map, the hand sets the gold
 * node aside, to be taken up again when gold is seen on the way.
 */
export function goldAbsentLine(world: Record<string, unknown>, counts: ItemCounts, dimension: string | null, nodes: readonly PlanNode[],
  now: PlanNode | undefined): string | null {
  if (dimension !== 'overworld' || !now || !WANTS_GOLD(now)) return null;
  if (countMatching(counts, /^golden_(?:helmet|chestplate|leggings|boots)$/u) > 0) return null;
  if (countMatching(counts, /^(?:raw_gold|gold_ingot)$/u) >= 4) return null;
  if ((Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).some(line => typeof line === 'string' && GOLD_MARK.test(line))) return null;
  let top = now;
  const clean = (node: PlanNode) => WANTS_GOLD(node) && nodes.filter(kid => kid.parentId === node.id).every(kid => kid.state === 'done' || WANTS_GOLD(kid));
  for (let parent = nodes.find(node => node.id === top.parentId); parent && clean(parent); parent = nodes.find(node => node.id === top.parentId)) top = parent;
  return `金: 今の節 ${now.id} に金が要るが、地図に金鉱石が見えていない。金の防具はゲートの目標で必須ではない（無くてもネザーへ入れる。ピグリンに襲われやすくなるだけ）。`
    + `探して歩くより黒曜石・火打ち金・ゲートが先。手: plan_update の ops [{"op":"set","id":"${top.id}","state":"blocked","reason":"金鉱石が見えない"}] で`
    + `${top.id === now.id ? 'この節' : `金の節 ${top.id}`}を外し、次の節へ。途中で金鉱石（y=-16 前後の壁）や箱の金が見えたら取り、state=continue で戻す`;
}

/**
 * thru t05b (w1109v, 11/9 18:08〜19:22, the same icy world with this line in): salmon swam 15〜24 m out in deep water, so the line never came,
 * and she waited on the shore for them for about 35 minutes at 0 food, starving at 2.3 health, until the night's zombies and a stray killed her
 * three times in 70 s. A fish in the water is no hunt without a rod: only land animals count as food in sight.
 */
const LAND_FOOD = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const WANTS_FOOD = (node: PlanNode): boolean => /food\s*>=|foodPoints/u.test(String(node.doneWhen ?? '')) || /食料|狩/u.test(String(node.title ?? ''));

/**
 * thru t05 (w1109v, an icy world by the water, 17:58): the now was the food (40 points, 「無ければ動物を4〜6体狩る」) and for about 35 minutes
 * she walked for salmon and rabbits at 0〜2.4 points, saw almost none, and never went down to the iron. The same facts as the sheep's
 * (`sheepAbsentLine`): a walk does not make an animal appear; going down first and taking what is seen on the way (animals, a village's
 * fields, fish) is faster; the rule 「省くなら prep に skipped と理由を書く」 is the way to go down. Said while the now wants food, the points
 * are under 40 and no animal that is food is in sight, in the overworld.
 */
export function foodAbsentLine(world: Record<string, unknown>, food: number, dimension: string | null, now: PlanNode | undefined,
  counts?: ItemCounts, nodes: readonly PlanNode[] = []): string | null {
  if (dimension !== 'overworld' || !now || food >= 40) return null;
  const aside = foodSetAside(now, nodes, counts);
  if (!WANTS_FOOD(now) && !aside) return null;
  // end1110r1: no land animal in the world, a cod 7〜31 m off in the water hid this line for about 6 minutes; she tried the fish five times
  // with no rod and got none. Only the land animals count.
  const seen = (Array.isArray(world.nearbyEntities) ? world.nearbyEntities : [])
    .some(entity => !!entity && typeof entity === 'object' && LAND_FOOD.has(String((entity as { name?: unknown }).name)));
  if (seen) return null;
  // end1110r1 (w1109i, no animals): 100 minutes on the food node at fullness 17〜18 and health 20, walking 10 m legs for animals by day and
  // waiting in a hole by night. A full bar is what the food is for: it lasts the way down to the iron.
  const hunger = finite(world.food);
  const full = hunger !== null && hunger >= 10 ? `満腹 ${round1(hunger)}/20 はまだ十分で、食料を持たずに鉄まで下りられる（満腹が 6 を切る前に、途中で見えた動物を狩る）。` : '';
  if (aside) {
    // The iron line (`ironSearchLine`) says the way down when the now wants iron; the hands are said here only when it is silent.
    const hands = counts && !ironSearchLine(world, counts, dimension, now) ? foodAbsentHands(world, counts, false) : '';
    return `${FOOD_PASS} 食料: 食料の節 ${aside.id} は外してある（prep skipped）ので、食料 ${round1(food)}/40 点のまま鉄へ下りてよい`
      + `（見える所に食べられる動物がいない。探し歩いても出てくる保証は無く、途中で見えた動物・村の畑で補う方が速い）。${full}`
      + `動物が見えたら狩って ${aside.id} を state=continue で戻す${hands}`;
  }
  return `${FOOD_PASS} 食料: 今の節 ${now.id} は食料 ${round1(food)}/40 点だが、見える所に食べられる動物がいない（歩き回っても動物が出てくる保証は無く、時間だけが減る）。${full}`
    + `先に鉄へ下り、途中で見えた動物・村の畑で補う方が速い（水の中の魚は竿が無いと取れない。岸で待たない）。下りるなら決まりの「省くなら prep に skipped と理由を書く」に当たる: plan_update の ops `
    + `[{"op":"set","id":"${now.id}","state":"blocked","reason":"動物が見えない","prep":{"state":"skipped","why":"動物が見えない"}}]。動物が見えたら狩って state=continue で戻す`
    + (counts ? foodAbsentHands(world, counts) : '');
}

const SKIPPED_FOOD = (node: PlanNode): boolean => WANTS_FOOD(node) && node.state === 'blocked' && node.prep?.state === 'skipped';
/**
 * end1110r1 (the review of 11/10, G05): once the food node is set aside the now goes on to the iron (`asideNext` in the plan tree), and the
 * food line, its mark and the way down went with it, while the iron node's own caution 「食料40点…を持ってから下りる」 came into the rules.
 * The food node set aside by the line's hand (blocked, prep skipped): the now itself, or with the now elsewhere the first such node, until an
 * iron pickaxe is held (the descent the 40 holds is the one to the iron; the diamonds' and the gate's needs are not passed by the mark).
 */
function foodSetAside(now: PlanNode, nodes: readonly PlanNode[], counts?: ItemCounts): PlanNode | undefined {
  if (SKIPPED_FOOD(now)) return now;
  if (WANTS_FOOD(now) || !counts || countMatching(counts, /^(?:iron|diamond|netherite)_pickaxe$/u) > 0) return undefined;
  return nodes.find(SKIPPED_FOOD);
}

/**
 * end1110r1: the line said 「先に鉄へ下り」 with no hand. She wrote the plan_update (p2.1 blocked, prep skipped), the now stayed p2.1 and she
 * searched the dark forest by day and waited the night; she had a wooden pickaxe only. The way down is said as one act: the stone pickaxe
 * made in a shaft when the wooden one is all (`stonePickHands`), then the way to the iron (`oreRouteHands`). No hand with no pickaxe at all.
 */
function foodAbsentHands(world: Record<string, unknown>, counts: ItemCounts, withUpdate = true): string {
  const stone = stonePickHands(world, counts);
  if (!stone && countMatching(counts, /^(?:stone|iron|diamond|netherite)_pickaxe$/u) === 0) return '';
  const route = oreRouteHands(world, 'iron', counts);
  if (!route) return '';
  if (route.startsWith('先に原木')) return `。下りる手: ${route}`;
  const hands = [...(stone ?? []), ...[...route.matchAll(/「([^」]+)」/gu)].map(m => m[1]!)];
  return `。下りる手${withUpdate ? '（plan_update と同じ判断で出してよい）' : ''}: mc_act ${JSON.stringify(hands)}`
    + `${stone ? '（木のツルハシで足元を掘って石を取り、頭の上に作業台を置いて石のツルハシを作る。鉄は石のツルハシから）' : ''}`;
}

export function descentNote(input: unknown, frame: BodyObservation | null): string | null {
  const facts = readinessOf(frame);
  const feet = facts ? feetOf(facts.world) : null;
  if (!facts || !feet || facts.dimension !== 'overworld') return null;
  if (feet.y < SURFACE_Y) return deepDescentNote(input, facts, feet);
  // Run 41 (the table was missing as well: 372 s with none, and she died on the way up): the food and the table
// (or planks to make one) are the descent's.
  // end1110r1: with no animal in sight, this note's 「未達 — 食料」 told her to stay up while the food line told her to go down first; she stayed
  // 100 minutes. The food is taken on the way down then (foodAbsentLine), not before it.
  const animalSeen = (Array.isArray(facts.world.nearbyEntities) ? facts.world.nearbyEntities : [])
    .some(entity => !!entity && typeof entity === 'object' && LAND_FOOD.has(String((entity as { name?: unknown }).name)));
  const lacks = [facts.food < FOOD_BEFORE_DESCENT && animalSeen ? foodPointsWords(facts.food, FOOD_BEFORE_DESCENT) : '',
    countMatching(facts.counts, /^crafting_table$/u) < 1 && countMatching(facts.counts, /_planks$/u) < TABLE_PLANKS
      ? `作業台 無・板 ${countMatching(facts.counts, /_planks$/u)}` : ''].filter(Boolean);
  if (!lacks.length) return null;
  const lowest = lowestReach(record(input)?.hands, feet.y);
  if (feet.y - lowest < DESCENT) return null;
  const cows = foodLeads(facts.world, facts.dimension).replace(/^食料の当て: /u, '');
  const near = /m/u.test(cows) && !cows.startsWith('近くに動物') ? `。近くに ${cows} が見えている` : '';
  // Run 42: she went down at health 11.3 that did not come back, fell and was shot dead; the health is the descent's too.
  const health = finite(facts.world.health), hunger = finite(facts.world.food);
  const recoveryWords = () => (health !== null && hunger !== null && health < 20 && hunger < 18 ? `。体力 ${round1(
    health)}/20 は戻らない（満腹 ${round1(hunger)}＜18）` : '');
  const hurt = recoveryWords();
  // Run 42 (the note ended 「このまま行くなら why に…書く」 and she wrote the numbers and went down, as if that were the way
// through): the cost in
  // what the runs measured, and what to do first; nothing that reads as a way past it.
  return `準備の状態（この act は地下 y=${Math.round(lowest)} へ下りる手）: 未達 — ${lacks.join('・')}${hurt}${near}。この受付は、準備が満たされたことを表さない`;
}

/**
 * The required needs of the stage a node of these kinds belongs to that are not met, with what going on without them costs, or null (a stage that does
 * not say what its lack costs, or every required need met). Beside a hand that goes on to that stage and beside the current node's step on to a node
 * of it: run59 leg 1 (2026-11-02) went down to the diamonds with no shield and into the gate with no armour, the lack said in a line and no answer
 * saying what going on was.
 */
export function requiredLack(facts: NonNullable<ReturnType<typeof readinessOf>>, kinds: readonly PlanKind[]): string | null {
  const stage = preparationStage(facts.dimension, facts.counts, kinds);
  return lackOfTable(facts, stage === 'diamonds' ? BEFORE_DIAMONDS : stage === 'nether_entry' ? BEFORE_GATE : null);
}

/** The required needs of one table that are not met, with what going on without them costs, or null (no table, no risk to say, or all met). */
export function lackOfTable(facts: NonNullable<ReturnType<typeof readinessOf>>, table: PrepStage | null): string | null {
  if (!table?.risk) return null;
  const must = mustWords(table, { counts: facts.counts, food: facts.food, worn: wornItems(facts.world.worn) });
  return must.length ? `未達の必須（${table.title}に必ず）— ${must.join('。')}。欠けたまま進むと: ${table.risk}` : null;
}

/** The first hand of an act (0-based) that goes into the Nether: the portal hand, which enters unless `enter` is false; -1 when none. */
export const enteringHand = (hands: unknown): number => (Array.isArray(hands) ? hands : [])
  .findIndex(raw => record(raw)?.do === 'portal' && record(raw)?.enter !== false);

/**
 * Run59 leg 2 (2026-11-02 14:34Z, with the wording of 8503f22 in production): the shield was missing (`make shield` had said 「missing: oak_log×2」)
 * and the model sent 「胸当てを着てゲートを建て点火（盾は材料なしで後回し）」: the portal hand, the third time in the run, with a required need of the
 * gate missing (the lines said it, and the result said it after the hand was accepted). The last resort of the coordinator's order (the wording
 * first): the hand that enters the Nether is held while a required need of the gate is missing, as the act's other held hands are (the hands
 * before it are sent), and what is missing and what going on costs is said in its place. The need is read as the body is now: armour carried and
 * not worn is missing, so an act that equips it and enters in one goes in the next. Null: nothing is held.
 */
export function gateHold(input: unknown, frame: BodyObservation | null): { hand: number; line: string } | null {
  const facts = readinessOf(frame);
  if (!facts || facts.dimension !== 'overworld' || fetchingNetherDrops(facts.world)) return null;
  const portalHand = enteringHand(record(input)?.hands), at = portalHand >= 0 ? portalHand : portalCellHand(input, frame);
  if (at < 0) return null;
  const lack = requiredLack(facts, ['portal']);
  return lack ? { hand: at + 1, line: `ネザーへ入る手は送らない。${lack}。そろえてからもう一度出す（理由を書いても省けない）` } : null;
}
