import type { ProcedureMemory } from '@shannon/mind';
import { BED_ITEM, EDIBLE_FOOD } from './minecraftItems.js';
import { fed } from './minecraftStage.js';
import { takeNeed } from './minecraftFillers.js';
import { carried, inPack, nearestNeed, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { cobbleFor, craft, digLogs, doing, fromFirstCell, planksFor, plankWorth, stuck, toolOf, type McMove } from './minecraftProcedureMoves.js';

/**
 * The opening's procedures (session mb-arch): wood, the wooden and the stone pickaxe, the stone axe, wood in store, and the bed and the
 * food, each a rule over the frame that names the next body call. Run 19's openings took 79 s to the wooden pickaxe and 168 s to the
 * stone tools over twelve decisions; here the planner starts them with one call.
 */
const ANY_PICKAXE = /_pickaxe$/u;
const STONE_PICKAXE = /^(?:stone|iron|diamond|netherite)_pickaxe$/u;
const STONE_AXE = /^(?:stone|iron|diamond|netherite)_axe$/u;
const WOOL = /^([a-z_]+)_wool$/u;

/** 「木」: logs for the opening at once (the tools, the table, the bed and the sticks of the iron age take about six). */
export function woodMove(facts: MinecraftProcedureFacts): McMove {
  return digLogs(facts, 6, '最初の原木をまとめて掘る');
}

/** 「木と石のツルハシ」: a wooden pickaxe (planks for it and for the table the body sets down), then stone and a stone pickaxe. */
export function pickaxeMove(facts: MinecraftProcedureFacts): McMove {
  if (!carried(facts, ANY_PICKAXE)) return toolOf(facts, 'wooden_pickaxe', planksFor(facts, 9));
  const axe = carried(facts, STONE_AXE) ? 0 : 3;
  return toolOf(facts, 'stone_pickaxe', cobbleFor(facts, 3, axe));
}

/** 「石の斧」. */
export function axeMove(facts: MinecraftProcedureFacts): McMove {
  return toolOf(facts, 'stone_axe', cobbleFor(facts, 3));
}

/** 「木材」: twelve planks' worth carried. */
export function storeMove(facts: MinecraftProcedureFacts): McMove {
  return digLogs(facts, Math.ceil((12 - plankWorth(facts)) / 4) + 1, '木材を蓄える');
}

/** The colour of which three wool are carried, or null. */
function woolColor(facts: MinecraftProcedureFacts): string | null {
  for (const [name, count] of facts.pack) {
    const match = WOOL.exec(name);
    if (match && count >= 3) return match[1]!;
  }
  return null;
}

/** Sheep searched for when none is in reach: the nearest within 128 m, walked to, three of them taken. */
function sheepSearch(memory: ProcedureMemory, key: string): McMove {
  const attack = { tool: 'mc.attack-continuously', input: { entityName: 'sheep', maxKills: 3, maxDistance: 32 }, why: '羊毛を取る', expectMs: 30_000,
    key: `${key}:hunt` };
  const walk = fromFirstCell(memory, 'sheep:none', cell => ({ tool: 'mc.move-to', input: { ...cell, range: 6 }, why: '羊のところへ行く',
    expectMs: 30_000, key: `${key}:walk`, then: () => attack, chain: 2 }));
  return doing({ tool: 'mc.find-nearest-entity', input: { entityType: 'sheep', maxDistance: 128 }, why: '羊を探す', expectMs: 2_000,
    key, then: walk, chain: 3 });
}

/** The bed: a standing one taken, else one made from wool carried, else sheep in reach, else sheep searched for; null when she has one. */
function bedMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  if (carried(facts, BED_ITEM) || facts.milestone.bedPlaced) return null;
  const standing = nearestNeed(facts, 'bed', 96);
  const take = standing ? takeNeed(standing) : null;
  if (take) return doing(take);
  const color = woolColor(facts);
  if (color) return planksFor(facts, 3) ?? craft(`${color}_bed`, 'ベッドを作る');
  const sheep = nearestNeed(facts, 'bed_wool', 48);
  if (sheep) {
    const colour = typeof sheep.data.color === 'string' ? sheep.data.color : null;
    const have = colour ? inPack(facts, new RegExp(`^${colour}_wool$`, 'u')) : 0;
    return doing({ tool: 'mc.attack-continuously', input: { entityName: 'sheep', maxKills: Math.max(1, 3 - have), maxDistance: 48,
      ...(colour ? { color: colour } : {}) }, why: 'ベッドの羊毛を取る', expectMs: 30_000, key: `wool:${colour ?? 'any'}:${have}` });
  }
  const key = `sheep:find:${inPack(facts, WOOL)}`;
  return memory.notes.has('sheep:none') || memory.failed(key) ? stuck('ベッドも羊も近くに見えない（128m）') : sheepSearch(memory, key);
}

/** Food enough to go on (`fed`): an animal in reach, else any food animal near; null when fed. */
function foodMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  if (fed(facts.counts)) return null;
  const food = carried(facts, EDIBLE_FOOD);
  const animal = nearestNeed(facts, 'food', 48);
  if (animal) {
    return doing({ tool: 'mc.attack-continuously', input: { entityName: animal.name, maxKills: 2, maxDistance: 32 }, why: '食べ物の動物を取る',
      expectMs: 20_000, key: `food:${animal.name}:${food}` });
  }
  const key = `food:any:${food}`;
  if (memory.failed(key)) return stuck('食べ物の動物が近くに見えない');
  return doing({ tool: 'mc.attack-continuously', input: { entityName: 'food_animals', maxKills: 3, maxDistance: 48 }, why: '食べ物の動物を探して取る',
    expectMs: 40_000, key });
}

/** 「食料と羊とベッド」: the bed first; food while the bed waits on a search the planner must decide. */
export function bedAndFoodMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove {
  const bed = bedMove(facts, memory);
  if (bed?.kind === 'do') return bed;
  const food = foodMove(facts, memory);
  if (food?.kind === 'do' || !bed) return food ?? { kind: 'done' };
  // Both wait on the planner: the bed's reason first.
  return bed.kind === 'stuck' && food?.kind === 'stuck' ? stuck(`${bed.why}・${food.why}`) : bed;
}
