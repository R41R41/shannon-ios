import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, cellKey, cellsInText, inPack, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { cardinal, doing, stuck, type McMove } from './minecraftProcedureMoves.js';
import { waterPlaces } from './minecraftProcedureMap.js';
import type { ProcedureTaskStore } from './minecraftProceduresIron.js';

/**
 * Water for the bucket (mb-r20, owner 2026-10-20: 「30分以内にスムーズにネザー」). Run 20 made the bucket at 381 s, went down to Y-58 with it
 * empty, and looked for water there for 325 s (four walks to water 64-112 m off through deepslate, none arrived) and 0 obsidian came of it.
 * So: the bucket is filled where there is water on the surface, as soon as it is made and before any stair is dug; a water cell she could
 * not reach is remembered across tasks (a task's extension began the count again and went to the same lake); and with no water down below,
 * the way up she dug herself is the way to the water.
 */
const NEAR_BELOW = 30;
/** A cell this far from one she could not reach is the same water (a lake lists its cells side by side). */
const SAME_WATER = 8;
const UNREACHABLE_MS = 20 * 60_000;
const SURFACE_Y = 50;

const unreachable: Array<{ cell: Cell; at: number }> = [];
/** Water she could not get to (a walk that failed for good), kept for this process: the same world, a task after a task. */
export function markWaterUnreachable(cell: Cell, at = Date.now()): void {
  unreachable.push({ cell, at });
  while (unreachable.length > 32) unreachable.shift();
}
export function waterUnreachable(cell: Cell, at = Date.now()): boolean {
  return unreachable.some(entry => at - entry.at < UNREACHABLE_MS
    && Math.hypot(entry.cell.x - cell.x, entry.cell.y - cell.y, entry.cell.z - cell.z) <= SAME_WATER);
}
/** For tests: nothing is remembered. */
export function forgetUnreachableWater(): void {
  unreachable.length = 0;
}

/** A walk the arbiter cut or a reflex of the body stopped says nothing of the water. */
const giveUp = (cell: Cell, failure: string) => { if (failure !== 'cut' && failure !== 'interrupted_by_reflex') markWaterUnreachable(cell); };

export const onSurface = (facts: MinecraftProcedureFacts) => facts.dimension === 'overworld' && facts.at !== null && facts.at.y >= SURFACE_Y;
/** An empty bucket and no water in one. */
export const needsWater = (facts: MinecraftProcedureFacts) => inPack(facts, /^bucket$/u) > 0 && inPack(facts, /^water_bucket$/u) === 0;
/** No water found where she looked: below (within reach of the stair) or on the surface; a look in the other place is not given up. */
export const waterGivenUp = (memory: ProcedureMemory, below: boolean) => memory.notes.get('water:none') === (below ? 'below' : 'surface');

/**
 * Water found, the nearest cell not given up on walked to (a walk that was getting nearer is made again, not counted), and scooped. Deep
 * down only a cell within `NEAR_BELOW` m counts: a walk through rock takes two to eight seconds a metre.
 */
/** What a step of height weighs against a metre along the ground (a walk down into rock and back up is the slowest there is). */
const HEIGHT_WEIGHT = 3;
/** What a metre of a water's distance from the furnaces (where the next steps are) weighs against one from her. */
const ANCHOR_WEIGHT = 0.5;
/**
 * Water below this height is taken for a cave's, a ravine's or the sea's floor (the sea's surface lies at 62): a walk into rock, and
 * back up, whatever the height she stands at. It costs this much more than the same water on the surface (run 21: the cave's at 58
 * against the pond's at 62, both some 30 blocks below a hill she stood on).
 */
const CAVE_LEVEL = 60, CAVE_PENALTY = 40;

/**
 * The water to walk to, of those the body found: the cheapest walk, not the nearest in three dimensions (run 21: the nearest, 37 m
 * off, lay in a cave 30 blocks down, and the walk down through rock and back cost about 150 s; the water at her own height, 50 m off,
 * was passed over). Height counts `HEIGHT_WEIGHT` times a metre along the ground, and the furnaces' distance a little (she goes back
 * to them next). The order the body gave is kept for ties.
 */
export function cheapestWater(from: Cell | null, cells: readonly Cell[], anchors: readonly Cell[] = []): Cell | undefined {
  if (!from) return cells[0];
  const cost = (cell: Cell) => Math.hypot(cell.x - from.x, cell.z - from.z) + HEIGHT_WEIGHT * Math.abs(cell.y - from.y)
    + (cell.y < CAVE_LEVEL ? CAVE_PENALTY : 0)
    + (anchors.length ? ANCHOR_WEIGHT * Math.min(...anchors.map(anchor => Math.hypot(cell.x - anchor.x, cell.y - anchor.y, cell.z - anchor.z))) : 0);
  let best: Cell | undefined, bestCost = Infinity;
  for (const cell of cells) {
    const value = cost(cell);
    if (value < bestCost) {
      best = cell;
      bestCost = value;
    }
  }
  return best;
}

export function fillBucket(facts: MinecraftProcedureFacts, memory: ProcedureMemory, maxDistance = 64): McMove {
  const deep = !onSurface(facts);
  const from = facts.at;
  const scoop = (cell: Cell): MinecraftWorkItem => ({ tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'bucket' }, why: '水を汲む', expectMs: 3_000,
    key: `water:scoop:${cellKey(cell)}`, onFail: failure => giveUp(cell, failure) });
  const pick = (text: string): MinecraftWorkItem | null => {
    const cell = cheapestWater(from, cellsInText(text).filter(candidate => !waterUnreachable(candidate)
      && memory.failed(`water:walk:${cellKey(candidate)}`) === 0
      && (!deep || !from || Math.hypot(candidate.x - from.x, candidate.y - from.y, candidate.z - from.z) <= NEAR_BELOW)),
    facts.jobs.map(job => block(job.position)));
    if (!cell) {
      memory.notes.set('water:none', deep ? 'below' : 'surface');
      return null;
    }
    return { tool: 'mc.move-to', input: { ...cell, goalType: 'near', range: 2 }, why: '水のそばへ行く', expectMs: 30_000, key: `water:walk:${cellKey(cell)}`,
      resumable: true, onFail: failure => giveUp(cell, failure), then: () => scoop(cell), chain: 2 };
  };
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'water', maxDistance: deep ? NEAR_BELOW + 18 : maxDistance, count: 16 }, why: '水を探す',
    expectMs: 2_000, key: `water:find:${memory.succeeded('water:find')}:${unreachable.length}`, then: pick, chain: 3 });
}

/**
 * The water filled on the surface, on the way (not a wait): the bucket empty, on the surface, no water given up on. Null when there is
 * nothing to do (no bucket, already full, down below, no water in sight).
 */
export function waterOnTheSurface(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  if (!needsWater(facts) || !onSurface(facts) || waterGivenUp(memory, false)) return null;
  return fillBucket(facts, memory);
}

/**
 * Down below with an empty bucket and no water near: the stair dug down is the way up to the surface (and the water). The surface is
 * the one the descent began at (`noteSurface`); stuck when it is not known (the planner decides).
 */
export function upForWater(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore): McMove {
  const up = store.surface;
  if (!up || !facts.at) return stuck('水が汲めず、地上へ戻る道（下りた階段）も分からない');
  if (memory.notes.has('water:up')) return stuck('地上へ戻っても水が見つからなかった');
  // The climb builds a block sideways for each one up: aimed at the nearest water the map remembers on the surface, when it has one.
  const spring = waterPlaces(facts).filter(place => place.at.y >= SURFACE_Y).sort((a, b) => a.distance - b.distance)[0];
  return doing({ tool: 'mc.stair-mine', input: { targetY: up.y, ...(spring ? { direction: cardinal(facts.at, spring.at) } : {}) },
    why: '下りた階段を上がって、地上の水を汲みに行く', expectMs: 2_000 * Math.max(1, up.y - facts.at.y),
    key: `water:up:${Math.floor(facts.at.y)}`, then: () => {
      memory.notes.set('water:up', true);
      memory.notes.delete('water:none');
      return null;
    } });
}
