import type { ProcedureMemory } from '@shannon/mind';
import { BED_ITEM } from './minecraftItems.js';
import { BED_DEFER } from './minecraftBedDefer.js';
import { takeNeed } from './minecraftFillers.js';
import { foodMove } from './minecraftProcedureFood.js';
import { villageVisit, type MapVisits } from './minecraftProcedureMap.js';
import { carried, inPack, nearestNeed, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
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

/**
 * How far from where the task began, or from the place the route names for the step, a sheep may be walked to (mb-r20). Run 20's
 * hunt took three walks of 117, 91 and 107 m after one another and ended 400 m south of where it began, past the cave, the iron and
 * the obsidian the route had named near the start; a search beyond this goes back to the planner, who can take the iron first and
 * spend the night in a shelter.
 */
export const SHEEP_REACH = 160;

/** Sheep searched for when none is in reach: the nearest within 128 m, walked to, three of them taken; not past `SHEEP_REACH` of the start. */
interface BedWaits { store: { bedWaits?: boolean }; at: Cell | null; daylight: boolean }
type BedStore = MapVisits & { bedWaits?: boolean };
function sheepSearch(memory: ProcedureMemory, key: string, anchors: readonly Cell[], defer: BedWaits): McMove {
  const attack = { tool: 'mc.attack-continuously', input: { entityName: 'sheep', maxKills: 3, maxDistance: 32 }, why: '羊毛を取る', expectMs: 30_000,
    key: `${key}:hunt` };
  const walk = fromFirstCell(memory, 'sheep:none', cell => {
    // mb-r23: the nearest sheep is far and the day is long: the walk and the hunt wait, the iron comes first (`minecraftBedDefer.ts`).
    if (defer.daylight && defer.at && Math.hypot(cell.x - defer.at.x, cell.z - defer.at.z) > BED_DEFER.sheepFar) {
      defer.store.bedWaits = true;
      return null;
    }
    if (anchors.length && anchors.every(anchor => Math.hypot(cell.x - anchor.x, cell.z - anchor.z) > SHEEP_REACH)) {
      memory.notes.set('sheep:far', true);
      return null;
    }
    return { tool: 'mc.move-to', input: { ...cell, range: 6 }, why: '羊のところへ行く', expectMs: 30_000, key: `${key}:walk`, then: () => attack, chain: 2 };
  });
  return doing({ tool: 'mc.find-nearest-entity', input: { entityType: 'sheep', maxDistance: 128 }, why: '羊を探す', expectMs: 2_000,
    key, then: walk, chain: 3 });
}

/**
 * The sheep in reach to hunt for the bed: of the colours she already holds, the one with the most wool (a bed needs three of a colour:
 * run 20 held white 2, black 2 and light gray 1 and walked on for a white one, 80 s for nothing); else the nearest. Its colour, how
 * many she holds of it, and the sheep.
 */
function sheepToHunt(facts: MinecraftProcedureFacts) {
  const sheep = facts.needs.filter(need => need.need === 'bed_wool' && need.canReach && (need.distance ?? Infinity) <= 48)
    .map(need => {
      const colour = typeof need.data.color === 'string' ? need.data.color : null;
      return { need, colour, have: colour ? inPack(facts, new RegExp(`^${colour}_wool$`, 'u')) : 0 };
    });
  return sheep.sort((a, b) => b.have - a.have || (a.need.distance ?? Infinity) - (b.need.distance ?? Infinity))[0] ?? null;
}

/** The bed: a standing one taken, else one made from wool carried, else sheep in reach, else sheep searched for; null when she has one. */
function bedMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: BedStore, anchors: readonly Cell[]): McMove | null {
  if (carried(facts, BED_ITEM) || facts.milestone.bedPlaced) return null;
  const daylight = facts.dimension === 'overworld' && facts.darkIn !== null && facts.darkIn >= BED_DEFER.darkInSeconds;
  // Dusk: the bed left for later is wanted again.
  if (visits.bedWaits && !daylight) visits.bedWaits = false;
  return standingBed(facts, memory, visits, anchors, daylight);
}

/** The bed from what is at hand (a standing one, wool, a sheep in reach, a village); else it waits (far sheep, daylight) or the sheep are searched for. */
function standingBed(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: BedStore, anchors: readonly Cell[],
  daylight: boolean): McMove | null {
  const standing = nearestNeed(facts, 'bed', 96);
  const take = standing ? takeNeed(standing) : null;
  if (take) return doing(take);
  const color = woolColor(facts);
  if (color) return planksFor(facts, 3) ?? craft(`${color}_bed`, 'ベッドを作る');
  const sheep = sheepToHunt(facts);
  if (sheep) {
    const { colour, have } = sheep;
    return doing({ tool: 'mc.attack-continuously', input: { entityName: 'sheep', maxKills: Math.max(1, 3 - have), maxDistance: 48,
      ...(colour ? { color: colour } : {}) }, why: 'ベッドの羊毛を取る', expectMs: 30_000, key: `wool:${colour ?? 'any'}:${have}` });
  }
  // A village the map knows near (mb-map): its beds, before a search for sheep.
  const village = villageVisit(facts, visits, memory);
  if (village) return village;
  // The bed was left for later and the day is still long (the sheep were far): nothing to do for it now. A sheep within reach is hunted above.
  if (visits.bedWaits && daylight) return null;
  const key = `sheep:find:${inPack(facts, WOOL)}`;
  if (memory.notes.has('sheep:far')) return stuck(`羊が出発点から${SHEEP_REACH}m の外にしか見えない（先へ流れない）。鉄を先にして、夜は囲いで過ごす手がある`);
  // Only none in sight counts as none: a walk or a hunt that failed is tried again (the run's own counts end it).
  const none = memory.notes.has('sheep:none') || memory.lastFailure(key) === 'target_not_found';
  return none ? stuck('ベッドも羊も近くに見えない（128m）') : sheepSearch(memory, key, anchors, { store: visits, at: facts.at, daylight });
}

/** 「食料と羊とベッド」: the bed first; food while the bed waits on a search the planner must decide. */
export function bedAndFoodMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: BedStore, anchors: readonly Cell[] = []): McMove {
  const bed = bedMove(facts, memory, visits, anchors);
  if (bed?.kind === 'do') return bed;
  const food = foodMove(facts, memory);
  if (food?.kind === 'do' || !bed) return food ?? { kind: 'done' };
  // Both wait on the planner: the bed's reason first.
  return bed.kind === 'stuck' && food?.kind === 'stuck' ? stuck(`${bed.why}・${food.why}`) : bed;
}
