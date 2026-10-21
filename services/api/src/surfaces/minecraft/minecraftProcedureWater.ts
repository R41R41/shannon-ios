import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, cellKey, cellsInText, inPack, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { cardinal, doing, stuck, type McMove } from './minecraftProcedureMoves.js';
import { waterPlaces } from './minecraftProcedureMap.js';
import { bestWater } from './minecraftProcedureTrip.js';
import type { ProcedureTaskStore } from './minecraftProceduresIron.js';

/**
 * Water for the bucket (mb-r20, owner 2026-10-20: 「30分以内にスムーズにネザー」). Run 20 made the bucket at 381 s, went down to Y-58 with it
 * empty, and looked for water there for 325 s (four walks to water 64-112 m off through deepslate, none arrived) and 0 obsidian came of it.
 * So: the bucket is filled where there is water on the surface, as soon as it is made and before any stair is dug; a water cell she could
 * not reach is remembered across tasks (a task's extension began the count again and went to the same lake); and with no water down below,
 * the way up she dug herself is the way to the water.
 */
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

/** The most seconds of detour a water is worth: on the surface, under ground on the way down, and for the obsidian (it cannot be made without). */
const SURFACE_DETOUR_S = 120, UNDERGROUND_DETOUR_S = 90, OBSIDIAN_DETOUR_S = 400;
/** How far the body looks for water (blocks): the same under ground as above (mb-r22; under ground it looked 48 and the cell listed was dropped past 30). */
const WATER_LOOK = 64;

export interface FillOptions {
  /** The most seconds of detour the water may cost (`waterDetour`). */
  maxSeconds?: number;
  /** A try at a small price (`waterWhileSmelting`): finding none worth it is noted apart and does not give up the look for water. */
  cheap?: boolean;
  /** Where the next steps are (the furnaces by default): the water on the way to them costs least. */
  after?: readonly Cell[];
}

const cellsOnce = (cells: readonly Cell[]): Cell[] => [...new Map(cells.map(cell => [cellKey(cell), cell] as const)).values()];

/**
 * The bucket filled: the water the body finds within `WATER_LOOK` and the water the map remembers, together, the one that costs the least
 * detour walked to (`bestWater`: height and rock count, a walk that was getting nearer is made again, not counted) and scooped.
 */
export function fillBucket(facts: MinecraftProcedureFacts, memory: ProcedureMemory, options: FillOptions = {}): McMove {
  const deep = !onSurface(facts);
  const from = facts.at;
  const after = options.after ?? facts.jobs.map(job => block(job.position));
  const scoop = (cell: Cell): MinecraftWorkItem => ({ tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'bucket' }, why: '水を汲む', expectMs: 3_000,
    key: `water:scoop:${cellKey(cell)}`, onFail: failure => giveUp(cell, failure) });
  const pick = (text: string): MinecraftWorkItem | null => {
    const known = cellsOnce([...cellsInText(text), ...waterPlaces(facts).map(place => place.at)])
      .filter(candidate => !waterUnreachable(candidate) && memory.failed(`water:walk:${cellKey(candidate)}`) === 0);
    const choice = bestWater(from, known, after, options.maxSeconds ?? SURFACE_DETOUR_S);
    if (!choice) {
      memory.notes.set(options.cheap ? 'water:cheap:none' : 'water:none', options.cheap ? true : deep ? 'below' : 'surface');
      return null;
    }
    const cell = choice.cell;
    return { tool: 'mc.move-to', input: { ...cell, goalType: 'near', range: 2 }, why: '水のそばへ行く', key: `water:walk:${cellKey(cell)}`,
      expectMs: Math.min(240_000, Math.max(30_000, Math.round(choice.seconds * 1_500))),
      resumable: true, onFail: failure => giveUp(cell, failure), then: () => scoop(cell), chain: 2 };
  };
  // Nothing found in sight is not a failure: the map's memory is looked at all the same (`pick`).
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'water', maxDistance: WATER_LOOK, count: 16 }, why: '水を探す',
    expectMs: 2_000, key: `water:find:${memory.succeeded('water:find')}:${unreachable.length}`, then: pick, chain: 3,
    accepts: failure => failure === 'target_not_found' });
}

/**
 * Before the stair goes down (mb-r22, owner 2026-10-21: 「30分以内にスムーズにネザー」): the bucket must hold water, whatever the height she
 * stands at. Run 22 made the bucket 40 blocks under ground, found no water on the surface (`waterOnTheSurface` needs it) and went down to
 * Y-58 with it empty; the water cost 229 s there. The water of least detour toward the depth is taken, the body's find (64 m, the surface
 * water seen from under ground too) and the map's together; with none known the descent goes on in legs that look again for water at the
 * foot of each (`descentLeg`), and the obsidian's own step fetches it last of all (`getWater`). Null when the bucket is full or none is worth it.
 */
export function waterBeforeDescent(facts: MinecraftProcedureFacts, memory: ProcedureMemory, deepY: number): McMove | null {
  const at = facts.at;
  if (!needsWater(facts) || !at || facts.dimension !== 'overworld') return null;
  const below = !onSurface(facts);
  if (waterGivenUp(memory, below)) return null;
  const toward = { x: Math.floor(at.x), y: deepY, z: Math.floor(at.z) };
  return fillBucket(facts, memory, { maxSeconds: below ? UNDERGROUND_DETOUR_S : SURFACE_DETOUR_S, after: [toward] });
}

/**
 * The bucket filled while the iron cooks (mb-r24, Minecraft run 24: the bucket was made at 433 s and the water fetched at 628 s, after
 * the armour, as the diamonds' first move: 691 s against 430 meant). The furnaces' remaining time (`cookingMs`) pays for the trip: the
 * water is taken at once when the detour to it, back to the furnaces, is no more than what they still cook plus 20 s (at most the
 * detours of `waterBeforeDescent`), wherever she stands. Dearer water is left for the descent (`waterBeforeDescent`), which has its own
 * price. Null when there is no bucket to fill, the look found none worth it, or a look for water gave up.
 */
export function waterWhileSmelting(facts: MinecraftProcedureFacts, memory: ProcedureMemory, cookingMs: number): McMove | null {
  if (!needsWater(facts) || !facts.at || facts.dimension !== 'overworld' || memory.notes.has('water:cheap:none')) return null;
  const below = !onSurface(facts);
  if (waterGivenUp(memory, below)) return null;
  const worth = Math.min(below ? UNDERGROUND_DETOUR_S : SURFACE_DETOUR_S, Math.max(30, Math.round(cookingMs / 1_000) + 20));
  return fillBucket(facts, memory, { maxSeconds: worth, cheap: true });
}

/** The bucket for the obsidian: the water that costs least on the way to the lava the map knows (the pool's own water is the best). */
export function waterForObsidian(facts: MinecraftProcedureFacts, memory: ProcedureMemory, lava: readonly Cell[]): McMove {
  return fillBucket(facts, memory, { maxSeconds: OBSIDIAN_DETOUR_S, after: lava });
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
