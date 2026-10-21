import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, carried, cellKey, cellsInText, inPack, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { cardinal, craft, doing, fromFirstCell, stuck, toolOf, type McMove } from './minecraftProcedureMoves.js';
import { caveDescent, lavaPlaces, mappedObsidian, obsidianAhead, orePlaces, portalAhead, ruinedPortal, towardMapped, towardRoute, type MapPlace,
  type MapVisits } from './minecraftProcedureMap.js';
import { dropJunk, guardOutward, healFirst, noteSurface, pickaxeReserve } from './minecraftProcedureCare.js';
import { needsWater, onSurface, upForWater, waterBeforeDescent, waterForObsidian, waterGivenUp } from './minecraftProcedureWater.js';
import { tripSeconds } from './minecraftProcedureTrip.js';
import type { ProcedureTaskStore } from './minecraftProceduresIron.js';
import type { RouteLeg } from './minecraftRoutePlanner.js';

/** How many lava pools of the map she has walked to in this task. */
const lavaWalks = (visits: MapVisits) => [...visits.visited].filter(key => key.startsWith('lava:')).length;

/**
 * From the diamonds to the gate (session mb-arch; 「ダイヤ」「黒曜石」「ゲート」), with the body's own tools (Minebot catalog):
 * `stair-mine` to Y-58, `mine-block` for the diamonds (it finds them in the loaded world and digs its way there), the obsidian cast by
 * pouring the water bucket on a lava source (`use-item-on-block` does it and takes the water back) and dug with the diamond pickaxe,
 * flint from gravel (dug again where it was set down: a tenth of the time it drops flint), the frame built and lit at once
 * (`build-structure nether_portal` lights it when the flint and steel is carried), and the portal block found and entered.
 *
 * `batchObsidian`: the body casts and digs many at once (`use-item-on-block` with a count, mb-body), when its tool takes a count.
 *
 * Run 20 (mb-r20) went down for the diamonds with the bucket empty and spent 966 s after the diamond pickaxe on 4 obsidian: 325 s for
 * water that was 64-112 m off through deepslate, 530 s digging a tunnel to obsidian that was 60-130 m off, 130 s on a full pack, while
 * the obsidian of a ruined portal stood on the surface 121 m east. So: the water is in the bucket before the stair goes down; the
 * pack is cleared of rock before a dig; the obsidian is taken in the order the surface, the lava, and last the rock far off.
 */
const DIAMOND_PICKAXE = /^(?:diamond|netherite)_pickaxe$/u;
const DIAMOND = /^diamond$/u;
const OBSIDIAN = /^obsidian$/u;
const FLINT_AND_STEEL = /^flint_and_steel$/u;
const WATER_BUCKET = /^water_bucket$/u;
const DEEP_Y = -58;
/** A lava pool this close (horizontally) is walked to under ground; a farther one is gone to by the surface and a shaft dug above it. */
const LAVA_UNDER_GROUND = 40;
/** How near a lava pool she is walked to before the water is poured: a place to stand within this many blocks of it. */
export const LAVA_REACH = 3;
/** A way up this high or less is taken for a surface obsidian. */
const MOST_UP = 150;

/** 「ダイヤ」: down to Y-58, the diamonds near dug (a wider look, then a tunnel each way), the pickaxe made. */
export function diamondMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, leg?: RouteLeg): McMove {
  if (carried(facts, DIAMOND) >= 3) return toolOf(facts, 'diamond_pickaxe', null);
  const y = facts.at ? Math.floor(facts.at.y) : 64;
  return y > DEEP_Y + 10 ? goDownForDiamonds(facts, memory, store, y) : digDiamonds(facts, memory, store, leg);
}

/** Before the stair goes down: water in the bucket (down there it cannot be had), the pack clear, the pickaxe sound, health made up. */
function goDownForDiamonds(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, y: number): McMove {
  noteSurface(facts, store);
  // mb-r22: the water first, from wherever she stands (run 22 went down empty from 40 blocks under ground and paid 229 s for it).
  const ready = waterBeforeDescent(facts, memory, DEEP_Y) ?? dropJunk(facts, memory) ?? pickaxeReserve(facts) ?? healFirst(facts, memory);
  if (ready) return ready;
  // A cave entrance whose bottom is lower walked down first (mb-map); the stair goes on from its bottom.
  const cave = caveDescent(facts, store, memory, { within: 96, depth: [DEEP_Y - 6, y - 12], why: 'ダイヤの深さへ下りる' });
  if (cave) return guardOutward(facts, store, cave);
  return guardOutward(facts, store, descentLeg(facts, memory, y));
}

/** With the bucket still empty and no water known, the stair goes down in legs and looks for water at the foot of each (mb-r22). */
const DESCENT_LEG = 32;

/** The stair down to the diamonds: the whole way, or a leg of it while the bucket is empty (the water looked for again from there). */
function descentLeg(facts: MinecraftProcedureFacts, memory: ProcedureMemory, y: number): McMove {
  const legs = needsWater(facts) && y - DEEP_Y > DESCENT_LEG;
  const targetY = legs ? y - DESCENT_LEG : DEEP_Y;
  return doing({ tool: 'mc.stair-mine', input: { targetY }, why: legs ? 'ダイヤの深さへ降りる（水を探しながら区切って）' : 'ダイヤの深さ（Y-58）へ降りる',
    expectMs: 1_500 * (y - targetY), key: `diamond:down:${y}`,
    then: () => {
      if (legs) memory.notes.delete('water:none');
      return null;
    } });
}

/** At the depth: the pack cleared, the diamonds near dug (a wider look, then the places the map and the route name). */
function digDiamonds(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, leg?: RouteLeg): McMove {
  const have = carried(facts, DIAMOND);
  const ready = dropJunk(facts, memory) ?? pickaxeReserve(facts);
  if (ready) return ready;
  // The body finds ores in the whole loaded world (its view distance), hidden ones too, and digs its way there: a wider look, not a tunnel.
  // After a walk to a diamond the map remembers, a near look only (the walk ends within four blocks of it).
  const moves = [...store.visited].filter(key => key.startsWith('diamond:')).length;
  for (const radius of moves ? [32] : [32, 64, 128]) {
    const key = `diamond:${have}:${radius}:${moves}`;
    if (memory.lastFailure(key) === 'target_not_found') continue;
    return doing({ tool: 'mc.mine-block', input: { blockName: 'diamond_ore', count: 3 - have, searchRadius: radius }, why: 'ダイヤを掘る',
      expectMs: 90_000 + radius * 1_000, key });
  }
  const guard = (move: McMove | null) => move ? guardOutward(facts, store, move) : null;
  return guard(towardMapped(facts, store, memory, { places: orePlaces(facts, 'ダイヤ'), note: 'diamond', why: '地図で覚えているダイヤの所へ行く' }))
    ?? guard(towardRoute(facts, store, memory, leg, 'ルートが示したダイヤの場所へ行く'))
    ?? stuck('Y-58 の周り 128m にダイヤが見えず、地図にも覚えていない（200m 以内）');
}

/**
 * The way up from down below (the stair she dug is the way): the surface she went down from, or the height of the place to go to when
 * that is not known. Null when there is nothing to climb with (no stone to build with, none known to climb to).
 */
function wayUp(facts: MinecraftProcedureFacts, store: ProcedureTaskStore, toY: number, why: string, toward?: Cell): McMove | null {
  if (!facts.at) return null;
  const to = store.surface?.y ?? toY;
  if (to - facts.at.y < 20) return null;
  // A stair up builds a block sideways for each one up: aimed at the place she is going to.
  return doing({ tool: 'mc.stair-mine', input: { targetY: to, ...(toward ? { direction: cardinal(facts.at, toward) } : {}) }, why,
    expectMs: 1_800 * (to - facts.at.y), key: `up:${Math.floor(facts.at.y)}:${to}` });
}

/** The lava pool the map names that is nearest to her (sideways), not given up on yet: the place and how far sideways. */
function mappedLava(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory) {
  if (!facts.at) return null;
  const at = facts.at;
  return lavaPlaces(facts).map(place => ({ place, sideways: Math.hypot(place.at.x - at.x, place.at.z - at.z) }))
    .filter(item => item.sideways <= 200 && !visits.visited.has(`lava:${cellKey(item.place.at)}`) && memory.failed(`lava:map:${cellKey(item.place.at)}`) === 0)
    .sort((a, b) => a.sideways - b.sideways)[0] ?? null;
}

/**
 * A lava pool far from where she is, taken by the surface (mb-r20): up the stair she dug when she is below, the walk on the surface to
 * above the pool (fast; a walk through rock is two to eight seconds a metre), then a shaft dug down beside it. Null when the pool is
 * within `LAVA_UNDER_GROUND` sideways (walked to under ground, `towardMapped`) or when there is no way to take.
 */
function lavaBySurface(facts: MinecraftProcedureFacts, store: ProcedureTaskStore, visits: MapVisits, memory: ProcedureMemory): McMove | null {
  const lava = mappedLava(facts, visits, memory);
  if (!lava || !facts.at || lava.sideways <= LAVA_UNDER_GROUND || lava.place.at.y >= 50) return null;
  const target = lava.place.at;
  // mb-r22 (owner 2026-10-21): a pool near the diamonds' depth is walked to under ground when that is the shorter way (run 22: 56 m sideways
  // and 73 up, about 110 s through the rock, against 230 s up to the surface, across and down).
  if (!onSurface(facts) && tripSeconds(block(facts.at), target) <= surfaceRouteSeconds(facts.at, target, store)) return null;
  if (!onSurface(facts)) return wayUp(facts, store, 64, '遠い溶岩の溜まりへは、階段を上がって地上から行く', target);
  const dive = (): McMove => doing({ tool: 'mc.stair-mine', input: { targetY: target.y + 3 }, why: '溶岩の溜まりのそばへ縦穴を掘って降りる',
    expectMs: 1_500 * Math.max(1, facts.at!.y - target.y), key: `lava:dive:${cellKey(target)}`,
    then: () => {
      store.visited.add(`lava:${cellKey(target)}`);
      memory.notes.delete('lava:none');
      return null;
    } });
  if (lava.sideways <= 24) return dive();
  return doing({ tool: 'mc.move-to', input: { x: target.x, y: facts.at.y, z: target.z, goalType: 'nearxz', range: 10 }, why: '溶岩の溜まりの真上へ、地上を歩く',
    expectMs: 60_000, resumable: true, key: `lava:surface:${cellKey(target)}` });
}

/**
 * Obsidian from the nearest lava pool not tried yet: found, walked to, the water poured on it. One at a time, the obsidian is dug after;
 * with the body's batch (`batch`: how many), the body pours, digs and takes the water back itself, that many times at that pool.
 */
function castOne(facts: MinecraftProcedureFacts, memory: ProcedureMemory, batch: number | null, visits: MapVisits): McMove {
  const count = carried(facts, OBSIDIAN);
  const tried = (memory.notes.get('lava:tried') as Set<string> | undefined) ?? new Set<string>();
  memory.notes.set('lava:tried', tried);
  const pick = (text: string): MinecraftWorkItem | null => {
    const cell = cellsInText(text).find(item => !tried.has(cellKey(item)));
    if (!cell) {
      memory.notes.set('lava:none', lavaWalks(visits));
      return null;
    }
    tried.add(cellKey(cell));
    const dig = { tool: 'mc.dig-block-at', input: { ...cell }, why: '黒曜石を掘る', expectMs: 12_000, key: `obsidian:dig:${cellKey(cell)}` };
    const pour = batch === null
      ? { tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'water_bucket' }, why: '溶岩に水をかける', expectMs: 4_000,
        key: `obsidian:pour:${cellKey(cell)}`, then: (result: string) => /黒曜石に変換/u.test(result) ? dig : null, chain: 2 }
      : { tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'water_bucket', count: batch }, why: '溶岩の溜まりで黒曜石をまとめて作る',
        expectMs: 25_000 * batch, key: `obsidian:batch:${cellKey(cell)}` };
    // mb-r23: near, not `block`: the body wants a place from which the block can be dug, and lava cannot be dug (run 23: it stopped 2.6 m
    // from the pool with "no place to stand", 32 s and 23 s, and the procedure failed). Water is poured from a few blocks off.
    return { tool: 'mc.move-to', input: { ...cell, goalType: 'near', range: LAVA_REACH }, why: '溶岩のそばへ行く', expectMs: 20_000,
      key: `obsidian:walk:${cellKey(cell)}`, resumable: true, then: () => pour, chain: 3 };
  };
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'lava', maxDistance: 48, count: 10 }, why: '溶岩の溜まりを探す', expectMs: 2_000,
    key: `obsidian:${count}:${lavaWalks(visits)}`, then: pick, chain: 4 });
}

/** Seconds by the surface to a pool far off: up the stair she dug, across the ground above it, and a shaft down beside it. */
function surfaceRouteSeconds(at: Cell, target: Cell, store: ProcedureTaskStore): number {
  const top = { x: at.x, y: store.surface?.y ?? 64, z: at.z };
  const above = { x: target.x, y: top.y, z: target.z };
  return tripSeconds(block(at), top) + tripSeconds(top, above) + tripSeconds(above, target);
}

/** Seconds to the nearest lava pool the map names (Infinity when none): what a pool under ground weighs against the obsidian on the surface. */
function lavaSeconds(facts: MinecraftProcedureFacts): number {
  const at = facts.at;
  return at ? Math.min(Infinity, ...lavaPlaces(facts).map(place => tripSeconds(block(at), place.at))) : Infinity;
}

/** The nearest of two places by distance (the walk they need is the same kind). */
const nearest = (places: Array<{ place: MapPlace; kind: 'portal' | 'mapped' } | null>) =>
  places.filter((item): item is { place: MapPlace; kind: 'portal' | 'mapped' } => item !== null).sort((a, b) => a.place.distance - b.place.distance)[0] ?? null;

/**
 * 「黒曜石」: ten obsidian, in the order the surface, the lava, the rock (mb-r20, owner 2026-10-20). (1) What the map remembers on the
 * surface, nearest first: a ruined portal's chest and frame, other obsidian seen above ground (a way up the stair she dug when she is
 * below). A lava pool in reach below with the water in the bucket is cheaper and goes first. (2) Lava with the water: by the body's
 * batch when its tool takes a count, else one source at a time; the water from the surface or the stair back up to it. (3) Obsidian in
 * the rock far off, dug by the body's own tunnelling (`mine-block` with a wide radius), last.
 */
export function obsidianMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, batchObsidian: string | null, store: ProcedureTaskStore,
  leg?: RouteLeg): McMove {
  if (!carried(facts, DIAMOND_PICKAXE)) return stuck('黒曜石はダイヤのツルハシでしか掘れない');
  const count = carried(facts, OBSIDIAN);
  const water = inPack(facts, WATER_BUCKET) > 0;
  const junk = dropJunk(facts, memory);
  if (junk) return junk;
  noteSurface(facts, store);
  // A lava pool under ground that is nearer, by the seconds it takes, than the obsidian on the surface goes first (mb-r22: the pools near
  // the diamonds' depth, 230 s of climbing and descending saved); with no water in the bucket the water is fetched on the way to it.
  const lavaFirst = !onSurface(facts) ? lavaSeconds(facts) : Infinity;
  const surface = surfaceObsidian(facts, memory, store, count, lavaFirst);
  if (surface) return guardOutward(facts, store, surface);
  if (!water) return getWater(facts, memory, store);
  // None in sight since the last walk: a pool the map remembers (by the surface when it is far), and a look from there.
  if (memory.notes.get('lava:none') === lavaWalks(store)) return lavaOrRock(facts, memory, store, count, leg);
  return castOne(facts, memory, batchObsidian ? 10 - count : null, store);
}

/**
 * What the map remembers on the surface, nearest first: a ruined portal's chest and frame, other obsidian seen above ground. Below, the
 * stair up first (aimed at it); null when there is none within reach.
 */
function surfaceObsidian(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, count: number,
  lavaBelow = Infinity): McMove | null {
  const y = facts.at ? Math.floor(facts.at.y) : 64;
  const flint = !carried(facts, FLINT_AND_STEEL);
  const portal = portalAhead(facts, store, memory, { obsidian: 10 - count, flint });
  const mapped = count < 10 ? obsidianAhead(facts, store, memory) : null;
  const target = nearest([portal ? { place: portal, kind: 'portal' } : null, mapped ? { place: mapped, kind: 'mapped' } : null]);
  if (!target || target.place.at.y - y > MOST_UP) return null;
  if (facts.at && tripSeconds(block(facts.at), target.place.at) >= lavaBelow) return null;
  if (!onSurface(facts) && target.place.at.y - y > 25) {
    const up = wayUp(facts, store, target.place.at.y, '地上の黒曜石・荒廃したポータルへ、階段を上がって行く', target.place.at);
    if (up) return up;
  }
  return target.kind === 'portal' ? ruinedPortal(facts, store, memory, { obsidian: 10 - count, flint }) : mappedObsidian(store, mapped!, 10 - count);
}

/** The bucket without water: filled where water is near, else the stair back up to the surface; stuck when there is no bucket or no water at all. */
function getWater(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore): McMove {
  if (!inPack(facts, /^bucket$/u)) return stuck('水を運ぶバケツが無い');
  const below = !onSurface(facts);
  if (!waterGivenUp(memory, below)) return waterForObsidian(facts, memory, lavaPlaces(facts).map(place => place.at));
  return below ? upForWater(facts, memory, store) : stuck('地上にも水が見えない');
}

/** No lava in sight: a pool the map remembers (by the surface when it is far), the route's place, and last the rock far off. */
function lavaOrRock(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, count: number, leg?: RouteLeg): McMove {
  const guard = (move: McMove | null) => move ? guardOutward(facts, store, move) : null;
  const walk = lavaBySurface(facts, store, store, memory)
    ?? towardMapped(facts, store, memory, { places: lavaPlaces(facts), note: 'lava', why: '地図で覚えている溶岩の溜まりへ行く', rise: onSurface(facts) ? 24 : 100 })
    ?? towardRoute(facts, store, memory, leg, 'ルートが示した黒曜石の場所へ行く');
  if (walk) return guard(walk)!;
  // The rock far off, last: the body digs its way to the obsidian it finds in the loaded world.
  const key = `obsidian:far:${count}`;
  if (memory.lastFailure(key) === 'target_not_found') return stuck('32m 以内に使える溶岩の溜まりが見えず、地図にも黒曜石を覚えていない（200m 以内）');
  return doing({ tool: 'mc.mine-block', input: { blockName: 'obsidian', count: Math.max(1, 10 - count), searchRadius: 128 }, why: '遠くの黒曜石を掘り進んで取る',
    expectMs: 240_000, key });
}

/** Flint: gravel set down and dug again where it stands (a tenth of the time it drops flint), gravel dug first when none is carried. */
function flintMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: MapVisits): McMove {
  // A ruined portal's chest holds a flint and steel about half the time (mb-map): looked into before any gravel.
  const chest = ruinedPortal(facts, visits, memory, { obsidian: 0, flint: true });
  if (chest) return chest;
  if (!inPack(facts, /^gravel$/u)) {
    const key = `gravel:${carried(facts, /^flint$/u)}`;
    if (memory.lastFailure(key) === 'target_not_found') return stuck('48m 以内に砂利が見えない');
    return doing({ tool: 'mc.mine-block', input: { blockName: 'gravel', count: 6, searchRadius: 48 }, why: '火打石の砂利を掘る', expectMs: 30_000, key });
  }
  const tries = (memory.notes.get('flint:tries') as number | undefined) ?? 0;
  if (tries >= 40) return stuck('砂利を 40 回掘り直しても火打石が出ない');
  memory.notes.set('flint:tries', tries + 1);
  const dig = (text: string): MinecraftWorkItem | null => {
    const cell = cellsInText(text)[0];
    return cell ? { tool: 'mc.dig-block-at', input: { ...cell }, why: '砂利を掘り直す', expectMs: 3_000, key: `flint:dig:${tries}` } : null;
  };
  return doing({ tool: 'mc.place-block-at', input: { blockName: 'gravel' }, why: '砂利を置き直す', expectMs: 3_000, key: `flint:${tries}`, then: dig, chain: 2 });
}

/** The frame built beside her and lit (its place kept for the task), its portal block found and entered. */
function portalMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: { portal?: Cell }): McMove {
  const origin = store.portal;
  if (!origin) {
    if (!facts.at) return stuck('自分の位置が分からない');
    const at = block(facts.at);
    const cell = { x: at.x + 2, y: at.y, z: at.z };
    const built = () => {
      store.portal = cell;
      return null;
    };
    return doing({ tool: 'mc.build-structure', input: { structureName: 'nether_portal', ...cell }, why: 'ゲートの枠を建てて火をつける', expectMs: 60_000,
      key: 'portal:build', then: built });
  }
  const enter = fromFirstCell(memory, 'portal:unlit', cell => ({ tool: 'mc.enter-portal', input: { ...cell }, why: 'ゲートに入る', expectMs: 35_000,
    key: 'portal:enter' }));
  if (memory.notes.has('portal:unlit') && !memory.notes.has('portal:lit')) {
    memory.notes.delete('portal:unlit');
    memory.notes.set('portal:lit', true);
    return doing({ tool: 'mc.use-item-on-block', input: { x: origin.x + 1, y: origin.y, z: origin.z, itemName: 'flint_and_steel' }, why: 'ゲートに火をつける',
      expectMs: 3_000, key: 'portal:light' });
  }
  if (memory.notes.has('portal:unlit')) return stuck('ゲートに火がつかない');
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'nether_portal', maxDistance: 16, count: 1 }, why: 'ゲートの入口を探す', expectMs: 2_000,
    key: `portal:find:${memory.succeeded('portal:light')}`, then: enter, chain: 2 });
}

/** 「ゲート」: the flint and steel, then the frame, the fire and the way in. */
export function gateMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: { portal?: Cell } & MapVisits): McMove {
  if (!carried(facts, FLINT_AND_STEEL)) {
    if (carried(facts, /^flint$/u) && carried(facts, /^iron_ingot$/u)) return craft('flint_and_steel', '火打石と打ち金を作る');
    if (!carried(facts, /^iron_ingot$/u)) return stuck('火打石と打ち金に鉄インゴットが 1 個要る');
    return flintMove(facts, memory, store);
  }
  if (carried(facts, OBSIDIAN) < 10 && !store.portal) return stuck('ゲートの枠に黒曜石が 10 個要る');
  return portalMove(facts, memory, store);
}
