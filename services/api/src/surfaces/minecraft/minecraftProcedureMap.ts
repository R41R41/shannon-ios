import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, cellKey, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { doing, type McMove } from './minecraftProcedureMoves.js';

/**
 * The procedures' use of the body's map (mb-map, 2026-10-20; `world.mapSummary`): the cave entrances walked down instead of a stair dug
 * (`洞窟の入口 …: 28m 南 (262,65,250) → 底 (279,48,258)`), a ruined portal's frame and chest before lava and gravel, and a village with a
 * smith's chest before more digging. Each place is gone to once a task (`visited`); only cells and counts are read from the map's words.
 */
export interface MapVisits { visited: Set<string> }

const N = '(-?\\d+)';
const CELL = `\\(${N},\\s*${N},\\s*${N}\\)`;
const cellOf = (match: RegExpMatchArray, at: number): Cell => block({ x: Number(match[at]), y: Number(match[at + 1]), z: Number(match[at + 2]) });
const line = (facts: MinecraftProcedureFacts, head: string) => facts.map.split('\n').find(item => item.trimStart().startsWith(head)) ?? '';

/** The entrances the map lists (nearest first): where to stand, how far, and the bottom its hollow leads to. */
export function caveEntrances(facts: MinecraftProcedureFacts): Array<{ distance: number; mouth: Cell; bottom: Cell }> {
  const pattern = new RegExp(`(\\d+)m\\s+\\S+\\s+${CELL}\\s*→\\s*底\\s*${CELL}`, 'gu');
  return [...line(facts, '洞窟の入口').matchAll(pattern)].slice(0, 8)
    .map(match => ({ distance: Number(match[1]), mouth: cellOf(match, 2), bottom: cellOf(match, 5) }));
}

/** One kind of structure in the map's `構造物` line (`村`, `荒廃したポータル`): each place, how far, and the words in its brackets. */
export function structures(facts: MinecraftProcedureFacts, name: string): Array<{ distance: number; at: Cell; extra: string }> {
  const part = line(facts, '構造物').replace(/^\s*構造物:\s*/u, '').split('／').find(item => item.startsWith(`${name}:`)) ?? '';
  const pattern = new RegExp(`(\\d+)m\\s+\\S+\\s+${CELL}(（[^）]*）)?`, 'gu');
  return [...part.matchAll(pattern)].slice(0, 4).map(match => ({ distance: Number(match[1]), at: cellOf(match, 2), extra: match[5] ?? '' }));
}

const firstCell = (text: string): Cell | null => {
  const match = new RegExp(CELL, 'u').exec(text);
  return match ? cellOf(match, 1) : null;
};

/**
 * A walk down a cave entrance to its bottom instead of a stair dug (mb-map: 8 of 10 walks reached it, 34-38 steps in 11-14 s), when
 * the mouth is within `within` m and the bottom is at least twelve below her and inside `depth`. Each entrance once a task.
 */
export function caveDescent(facts: MinecraftProcedureFacts, visits: MapVisits, parts: { within: number; depth: [number, number]; why: string })
  : McMove | null {
  if (!facts.at || facts.dimension !== 'overworld') return null;
  const y = facts.at.y;
  const way = caveEntrances(facts).find(item => item.distance <= parts.within && item.bottom.y <= y - 12
    && item.bottom.y >= parts.depth[0] && item.bottom.y <= parts.depth[1] && !visits.visited.has(`cave:${cellKey(item.bottom)}`));
  if (!way) return null;
  visits.visited.add(`cave:${cellKey(way.bottom)}`);
  const down: MinecraftWorkItem = { tool: 'mc.move-to', input: { ...way.bottom, goalType: 'near', range: 3 }, why: '洞窟の底へ歩いて下りる', expectMs: 40_000,
    key: `cave:down:${cellKey(way.bottom)}` };
  return doing({ tool: 'mc.move-to', input: { ...way.mouth, goalType: 'near', range: 2 }, why: `${parts.why}（洞窟の入口へ）`, expectMs: 30_000,
    key: `cave:mouth:${cellKey(way.mouth)}`, then: () => down, chain: 2 });
}

/** A chest walked to, looked into, and the wanted items in it taken (each that it holds), in the order given. */
function lootChest(chest: Cell, wanted: readonly string[], why: string): McMove {
  const takeFrom = (contents: string, left: readonly string[]): MinecraftWorkItem | null => {
    const item = left.find(name => new RegExp(`(?:^|[^a-z_])${name}(?:[^a-z_]|$)`, 'u').test(contents));
    if (!item) return null;
    const rest = left.slice(left.indexOf(item) + 1);
    return { tool: 'mc.withdraw-from-container', input: { ...chest, itemName: item }, why: `箱から${item}を取る`, expectMs: 3_000,
      key: `chest:take:${cellKey(chest)}:${item}`, then: () => takeFrom(contents, rest) };
  };
  const look: MinecraftWorkItem = { tool: 'mc.check-container', input: { ...chest }, why: '箱の中を見る', expectMs: 3_000, key: `chest:look:${cellKey(chest)}`,
    then: contents => takeFrom(contents, wanted) };
  return doing({ tool: 'mc.move-to', input: { ...chest, goalType: 'block' }, why, expectMs: 60_000, key: `chest:walk:${cellKey(chest)}`, then: () => look,
    chain: 2 + wanted.length });
}

/** The ruined portal's chest (a flint and steel about half the time) and its frame's obsidian, nearest first, each once a task. */
export function ruinedPortal(facts: MinecraftProcedureFacts, visits: MapVisits, parts: { obsidian: number; flint: boolean; within?: number })
  : McMove | null {
  for (const portal of structures(facts, '荒廃したポータル').filter(item => item.distance <= (parts.within ?? 130))) {
    const chest = /箱/u.test(portal.extra) ? firstCell(portal.extra.slice(portal.extra.indexOf('箱'))) : null;
    if (chest && !visits.visited.has(`chest:${cellKey(chest)}`) && (parts.flint || parts.obsidian > 0)) {
      visits.visited.add(`chest:${cellKey(chest)}`);
      return lootChest(chest, ['flint_and_steel', 'obsidian', 'flint', 'iron_ingot'], '荒廃したポータルの箱へ行く');
    }
    const frame = Number(/黒曜石(\d+)個/u.exec(portal.extra)?.[1] ?? 0);
    if (parts.obsidian > 0 && frame > 0 && !visits.visited.has(`portal:${cellKey(portal.at)}`)) {
      visits.visited.add(`portal:${cellKey(portal.at)}`);
      const dig: MinecraftWorkItem = { tool: 'mc.mine-block', input: { blockName: 'obsidian', count: Math.min(parts.obsidian, frame), searchRadius: 16 },
        why: '荒廃したポータルの枠の黒曜石を掘る', expectMs: 12_000 * Math.min(parts.obsidian, frame), key: `portal:dig:${cellKey(portal.at)}` };
      return doing({ tool: 'mc.move-to', input: { ...portal.at, goalType: 'near', range: 6 }, why: '荒廃したポータルへ行く', expectMs: 60_000,
        key: `portal:walk:${cellKey(portal.at)}`, then: () => dig, chain: 2 });
    }
  }
  return null;
}

/** A village's smith's chest (iron, obsidian, bread, sometimes diamonds) within `within` m, once a task. */
export function smithChest(facts: MinecraftProcedureFacts, visits: MapVisits, within = 160): McMove | null {
  for (const village of structures(facts, '村').filter(item => item.distance <= within)) {
    const chest = /鍛冶屋の箱/u.test(village.extra) ? firstCell(village.extra) : null;
    if (!chest || visits.visited.has(`chest:${cellKey(chest)}`)) continue;
    visits.visited.add(`chest:${cellKey(chest)}`);
    return lootChest(chest, ['iron_ingot', 'obsidian', 'diamond', 'bread'], '村の鍛冶屋の箱へ行く');
  }
  return null;
}

/** The nearest village within `within` m, walked into once a task: its beds then show as needs in reach (taken by the bed's rule). */
export function villageVisit(facts: MinecraftProcedureFacts, visits: MapVisits, within = 128): McMove | null {
  const village = structures(facts, '村').find(item => item.distance <= within && !visits.visited.has(`village:${cellKey(item.at)}`));
  if (!village) return null;
  visits.visited.add(`village:${cellKey(village.at)}`);
  return doing({ tool: 'mc.move-to', input: { ...village.at, goalType: 'near', range: 8 }, why: '村のベッドと食べ物を取りに行く', expectMs: 60_000,
    key: `village:walk:${cellKey(village.at)}` });
}
