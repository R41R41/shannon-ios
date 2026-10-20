import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, carried, cellKey, cellsInText, inPack, mapPlaces, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { craft, doing, fromFirstCell, stuck, toolOf, type McMove } from './minecraftProcedureMoves.js';
import { caveDescent, ruinedPortal, type MapVisits } from './minecraftProcedureMap.js';

/**
 * From the diamonds to the gate (session mb-arch; 「ダイヤ」「黒曜石」「ゲート」), with the body's own tools (Minebot catalog):
 * `stair-mine` to Y-58, `mine-block` for the diamonds (it finds them in the loaded world and digs its way there), the obsidian cast by
 * pouring the water bucket on a lava source (`use-item-on-block` does it and takes the water back) and dug with the diamond pickaxe,
 * flint from gravel (dug again where it was set down: a tenth of the time it drops flint), the frame built and lit at once
 * (`build-structure nether_portal` lights it when the flint and steel is carried), and the portal block found and entered.
 *
 * `batchObsidian`: the body casts and digs many at once (`use-item-on-block` with a count, mb-body), when its tool takes a count.
 */
const DIAMOND_PICKAXE = /^(?:diamond|netherite)_pickaxe$/u;
const DIAMOND = /^diamond$/u;
const OBSIDIAN = /^obsidian$/u;
const FLINT_AND_STEEL = /^flint_and_steel$/u;
const DEEP_Y = -58;

/** 「ダイヤ」: down to Y-58, the diamonds near dug (a wider look, then a tunnel each way), the pickaxe made. */
export function diamondMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: MapVisits): McMove {
  const have = carried(facts, DIAMOND);
  if (have >= 3) return toolOf(facts, 'diamond_pickaxe', null);
  const y = facts.at ? Math.floor(facts.at.y) : 64;
  if (y > DEEP_Y + 10) {
    // A cave entrance whose bottom is lower walked down first (mb-map); the stair goes on from its bottom.
    const cave = caveDescent(facts, visits, { within: 96, depth: [DEEP_Y - 6, y - 12], why: 'ダイヤの深さへ下りる' });
    if (cave) return cave;
    return doing({ tool: 'mc.stair-mine', input: { targetY: DEEP_Y }, why: 'ダイヤの深さ（Y-58）へ降りる', expectMs: 4_000 * (y - DEEP_Y), key: `diamond:down:${y}` });
  }
  // The body finds ores in the whole loaded world (its view distance), hidden ones too, and digs its way there: a wider look, not a tunnel.
  const moves = (memory.notes.get('diamond:moves') as number | undefined) ?? 0;
  for (const radius of [32, 64, 128]) {
    const key = `diamond:${have}:${radius}:${moves}`;
    if (memory.lastFailure(key) === 'target_not_found') continue;
    return doing({ tool: 'mc.mine-block', input: { blockName: 'diamond_ore', count: 3 - have, searchRadius: radius }, why: 'ダイヤを掘る',
      expectMs: 90_000 + radius * 1_000, key });
  }
  return towardMapped(facts, memory, { head: '鉱石', name: /diamond/u, note: 'diamond', why: '地図で覚えているダイヤの所へ行く' })
    ?? stuck('Y-58 の周り 128m にダイヤが見えず、地図にも覚えていない');
}

/**
 * A place the body's map remembers (mb-body's `mapSummary`) and the procedure has not gone to yet, walked to; the procedure looks again
 * from there (`<note>:moves` counts the walks, so the next looks are new work). Null when the map has none left.
 */
function towardMapped(facts: MinecraftProcedureFacts, memory: ProcedureMemory,
  place: { head: string; name?: RegExp; note: string; why: string }): McMove | null {
  const visited = (memory.notes.get(`${place.note}:visited`) as Set<string> | undefined) ?? new Set<string>();
  memory.notes.set(`${place.note}:visited`, visited);
  const cell = mapPlaces(facts, place.head, place.name).find(item => !visited.has(cellKey(item)));
  if (!cell) return null;
  visited.add(cellKey(cell));
  const arrived = () => {
    memory.notes.set(`${place.note}:moves`, ((memory.notes.get(`${place.note}:moves`) as number | undefined) ?? 0) + 1);
    memory.notes.delete(`${place.note}:none`);
    return null;
  };
  return doing({ tool: 'mc.move-to', input: { ...cell, goalType: 'near', range: 4 }, why: place.why, expectMs: 120_000,
    key: `${place.note}:map:${cellKey(cell)}`, then: arrived });
}

/** Water in the bucket: the nearest water source found, walked to, scooped. */
function fillBucket(memory: ProcedureMemory): McMove {
  const scoop = (cell: Cell): MinecraftWorkItem => ({ tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'bucket' }, why: '水を汲む', expectMs: 3_000,
    key: `water:scoop:${cellKey(cell)}` });
  const walk = fromFirstCell(memory, 'water:none', cell => ({ tool: 'mc.move-to', input: { ...cell, goalType: 'near', range: 2 }, why: '水のそばへ行く',
    expectMs: 30_000, key: `water:walk:${cellKey(cell)}`, then: () => scoop(cell), chain: 2 }));
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'water', maxDistance: 48, count: 3 }, why: '水を探す', expectMs: 2_000, key: 'water:find',
    then: walk, chain: 3 });
}

/**
 * Obsidian from the nearest lava pool not tried yet: found, walked to, the water poured on it. One at a time, the obsidian is dug after;
 * with the body's batch (`batch`: how many), the body pours, digs and takes the water back itself, that many times at that pool.
 */
function castOne(facts: MinecraftProcedureFacts, memory: ProcedureMemory, batch: number | null): McMove {
  const count = carried(facts, OBSIDIAN);
  const tried = (memory.notes.get('lava:tried') as Set<string> | undefined) ?? new Set<string>();
  memory.notes.set('lava:tried', tried);
  const pick = (text: string): MinecraftWorkItem | null => {
    const cell = cellsInText(text).find(item => !tried.has(cellKey(item)));
    if (!cell) {
      memory.notes.set('lava:none', true);
      return null;
    }
    tried.add(cellKey(cell));
    const dig = { tool: 'mc.dig-block-at', input: { ...cell }, why: '黒曜石を掘る', expectMs: 12_000, key: `obsidian:dig:${cellKey(cell)}` };
    const pour = batch === null
      ? { tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'water_bucket' }, why: '溶岩に水をかける', expectMs: 4_000,
        key: `obsidian:pour:${cellKey(cell)}`, then: (result: string) => /黒曜石に変換/u.test(result) ? dig : null, chain: 2 }
      : { tool: 'mc.use-item-on-block', input: { ...cell, itemName: 'water_bucket', count: batch }, why: '溶岩の溜まりで黒曜石をまとめて作る',
        expectMs: 25_000 * batch, key: `obsidian:batch:${cellKey(cell)}` };
    return { tool: 'mc.move-to', input: { ...cell, goalType: 'block' }, why: '溶岩のそばへ行く', expectMs: 20_000, key: `obsidian:walk:${cellKey(cell)}`,
      then: () => pour, chain: 3 };
  };
  return doing({ tool: 'mc.find-blocks', input: { blockName: 'lava', maxDistance: 32, count: 10 }, why: '溶岩の溜まりを探す', expectMs: 2_000,
    key: `obsidian:${count}:${memory.notes.get('lava:moves') ?? 0}`, then: pick, chain: 4 });
}

/** 「黒曜石」: ten obsidian, by the body's batch tool when it has one, else one lava source at a time. */
export function obsidianMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, batchObsidian: string | null, visits: MapVisits): McMove {
  if (!carried(facts, DIAMOND_PICKAXE)) return stuck('黒曜石はダイヤのツルハシでしか掘れない');
  if (!inPack(facts, /^water_bucket$/u)) {
    if (!inPack(facts, /^bucket$/u)) return stuck('水を運ぶバケツが無い');
    return memory.notes.has('water:none') ? stuck('48m 以内に水が見えない') : fillBucket(memory);
  }
  const count = carried(facts, OBSIDIAN);
  // A ruined portal near (mb-map): its chest and its frame before any lava.
  const portal = ruinedPortal(facts, visits, { obsidian: 10 - count, flint: !carried(facts, FLINT_AND_STEEL) });
  if (portal) return portal;
  if (memory.notes.has('lava:none')) {
    return towardMapped(facts, memory, { head: '溶岩の溜まり', note: 'lava', why: '地図で覚えている溶岩の溜まりへ行く' })
      ?? stuck('32m 以内に使える溶岩の溜まりが見えず、地図にも覚えていない');
  }
  return castOne(facts, memory, batchObsidian ? 10 - count : null);
}

/** Flint: gravel set down and dug again where it stands (a tenth of the time it drops flint), gravel dug first when none is carried. */
function flintMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, visits: MapVisits): McMove {
  // A ruined portal's chest holds a flint and steel about half the time (mb-map): looked into before any gravel.
  const chest = ruinedPortal(facts, visits, { obsidian: 0, flint: true });
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
