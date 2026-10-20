import type { ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { block, cellKey, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { doing, type McMove } from './minecraftProcedureMoves.js';
import type { RouteLeg } from './minecraftRoutePlanner.js';

/**
 * The procedures' use of the body's map (mb-map, 2026-10-20; `world.mapSummary`): the cave entrances walked down instead of a stair dug
 * (`洞窟の入口 …: 28m 南 (262,65,250) → 底 (279,48,258)`), a ruined portal's frame and chest before lava and gravel, a village with a
 * smith's chest before more digging, and the ores and lava pools it remembers when none is in sight. Only cells, distances and counts
 * are read from the map's words.
 *
 * A place is marked gone to (`visited`, for the task) when its walk worked; one whose walk failed (`memory`, for the run) is passed
 * over for the next. A reflex that cut a walk in is not counted (`passingFailure`), so that place is walked to again.
 */
export interface MapVisits { visited: Set<string> }
export interface MapPlace { distance: number; at: Cell; extra: string }

const N = '(-?\\d+)';
const CELL = `\\(${N},\\s*${N},\\s*${N}\\)`;
/** The places the map's lines list are this far at most worth a walk: further, the planner decides. */
const MAP_WALK_LIMIT = 200;
const cellOf = (match: RegExpMatchArray, at: number): Cell => block({ x: Number(match[at]), y: Number(match[at + 1]), z: Number(match[at + 2]) });
const line = (facts: MinecraftProcedureFacts, head: string) => facts.map.split('\n').find(item => item.trimStart().startsWith(head)) ?? '';
const overworld = (facts: MinecraftProcedureFacts) => facts.dimension === 'overworld';

/** Each place of a list in the map's words, `<m>m <方角> (x,y,z)` with the words in its brackets after it. */
function placesIn(text: string, limit = 8): MapPlace[] {
  const pattern = new RegExp(`(\\d+)m\\s+\\S+\\s+${CELL}(（[^）]*）)?`, 'gu');
  return [...text.matchAll(pattern)].slice(0, limit).map(match => ({ distance: Number(match[1]), at: cellOf(match, 2), extra: match[5] ?? '' }));
}

/** The part of a line the map splits by `／` that starts with `name` (`ダイヤ 2か所（…）`, `荒廃したポータル: …`). */
function part(facts: MinecraftProcedureFacts, head: string, name: string): string {
  return line(facts, head).replace(new RegExp(`^\\s*${head}[^:：]*[:：]\\s*`, 'u'), '').split('／').find(item => item.trimStart().startsWith(name)) ?? '';
}

/** The entrances the map lists (nearest first): where to stand, how far, and the bottom its hollow leads to. */
export function caveEntrances(facts: MinecraftProcedureFacts): Array<{ distance: number; mouth: Cell; bottom: Cell }> {
  const pattern = new RegExp(`(\\d+)m\\s+\\S+\\s+${CELL}\\s*→\\s*底\\s*${CELL}`, 'gu');
  return [...line(facts, '洞窟の入口').matchAll(pattern)].slice(0, 8)
    .map(match => ({ distance: Number(match[1]), mouth: cellOf(match, 2), bottom: cellOf(match, 5) }));
}

/** One kind of structure in the map's `構造物` line (`村`, `荒廃したポータル`). */
export const structures = (facts: MinecraftProcedureFacts, name: string): MapPlace[] => placesIn(part(facts, '構造物', `${name}:`), 4);
/** One ore of the map's `鉱石` line, by the map's name for it (`ダイヤ`, `鉄`). */
export const orePlaces = (facts: MinecraftProcedureFacts, name: string): MapPlace[] => placesIn(part(facts, '鉱石', `${name} `));
/** The water sources of the map's `水源` line (`水源 3か所: 95m 北 (x,y,z)、…`). */
export const waterPlaces = (facts: MinecraftProcedureFacts): MapPlace[] => placesIn(line(facts, '水源').replace(/^[^:：]*[:：]/u, ''));
/** The lava pools of the map's `溶岩の溜まり` line. */
export const lavaPlaces = (facts: MinecraftProcedureFacts): MapPlace[] => placesIn(line(facts, '溶岩の溜まり').replace(/^[^:：]*[:：]/u, ''));

const firstCell = (text: string): Cell | null => {
  const match = new RegExp(CELL, 'u').exec(text);
  return match ? cellOf(match, 1) : null;
};

/** A place not gone to in this task, whose walk has not failed in this run. */
const fresh = (visits: MapVisits, memory: ProcedureMemory, place: string, walk: string) => !visits.visited.has(place) && memory.failed(walk) === 0;
/** The walk's `then`: the place is gone to, then the rest of the chain. */
const arrived = (visits: MapVisits, place: string, next: MinecraftWorkItem | null = null) => () => {
  visits.visited.add(place);
  return next;
};

/**
 * A walk down a cave entrance to its bottom instead of a stair dug (mb-map: 8 of 10 walks reached it, 34-38 steps in 11-14 s): a
 * mouth within `within` m and not above her, a bottom inside `depth`, and a drop worth the walk (at least twelve, and a third of the
 * walk); the deepest drop first.
 */
export function caveDescent(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory,
  parts: { within: number; depth: [number, number]; why: string }): McMove | null {
  if (!facts.at || !overworld(facts)) return null;
  const y = facts.at.y;
  const way = caveEntrances(facts).filter(item => item.distance <= parts.within && item.mouth.y <= y + 8 && item.bottom.y <= y - 12
    && item.bottom.y >= parts.depth[0] && item.bottom.y <= parts.depth[1] && (y - item.bottom.y) * 3 >= item.distance
    && fresh(visits, memory, `cave:${cellKey(item.bottom)}`, `cave:mouth:${cellKey(item.mouth)}`)).sort((a, b) => a.bottom.y - b.bottom.y)[0];
  if (!way) return null;
  const place = `cave:${cellKey(way.bottom)}`;
  const down: MinecraftWorkItem = { tool: 'mc.move-to', input: { ...way.bottom, goalType: 'near', range: 3 }, why: '洞窟の底へ歩いて下りる', expectMs: 40_000,
    key: `cave:down:${cellKey(way.bottom)}`, resumable: true };
  return doing({ tool: 'mc.move-to', input: { ...way.mouth, goalType: 'near', range: 2 }, why: `${parts.why}（洞窟の入口へ）`, expectMs: 30_000,
    key: `cave:mouth:${cellKey(way.mouth)}`, resumable: true, then: arrived(visits, place, down), chain: 2 });
}

/**
 * A place of the map not gone to yet, walked to (within `MAP_WALK_LIMIT` m and `rise` m of her height): an ore or a lava pool
 * remembered when none is in sight. The procedure looks again from there.
 */
export function towardMapped(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory,
  place: { places: MapPlace[]; note: string; why: string; rise?: number }): McMove | null {
  const y = facts.at?.y ?? 0;
  const target = place.places.find(item => item.distance <= MAP_WALK_LIMIT && Math.abs(item.at.y - y) <= (place.rise ?? 64)
    && fresh(visits, memory, `${place.note}:${cellKey(item.at)}`, `${place.note}:map:${cellKey(item.at)}`));
  if (!target) return null;
  return doing({ tool: 'mc.move-to', input: { ...target.at, goalType: 'near', range: 4 }, why: place.why, expectMs: 120_000, resumable: true,
    key: `${place.note}:map:${cellKey(target.at)}`, then: arrived(visits, `${place.note}:${cellKey(target.at)}`) });
}

/**
 * The place the route names for a step (`legs` with x, y, z: the planner of the task's start chose it from this same map), walked to
 * when nothing of the step's kind is in sight, once a task, if it is more than 40 m off and within `MAP_WALK_LIMIT`. Run 20's procedures
 * never read the route's places: the iron stood 55 m south by the route and was looked for 48 m round wherever she happened to be.
 * On the surface for a place far below, the walk is on the surface above it (the shaft is dug there).
 */
export function towardRoute(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory, leg: RouteLeg | undefined, why: string): McMove | null {
  if (!leg || leg.x === undefined || leg.y === undefined || leg.z === undefined || !facts.at || !overworld(facts)) return null;
  const at = block({ x: leg.x, y: leg.y, z: leg.z });
  const distance = Math.hypot(at.x - facts.at.x, at.z - facts.at.z);
  const place = `route:${leg.milestone}:${cellKey(at)}`;
  if (distance <= 40 || distance > MAP_WALK_LIMIT || !fresh(visits, memory, place, `route:map:${leg.milestone}:${cellKey(at)}`)) return null;
  const above = facts.at.y >= 50 && at.y < facts.at.y - 20;
  return doing({ tool: 'mc.move-to', input: { ...at, goalType: above ? 'nearxz' : 'near', range: above ? 8 : 6 }, why, expectMs: 60_000, resumable: true,
    key: `route:map:${leg.milestone}:${cellKey(at)}`, then: arrived(visits, place) });
}

/** A chest walked to, looked into, and the wanted items in it taken (each that it holds), in the order given. */
function lootChest(visits: MapVisits, chest: Cell, wanted: readonly string[], why: string): McMove {
  const takeFrom = (contents: string, left: readonly string[]): MinecraftWorkItem | null => {
    const item = left.find(name => new RegExp(`(?:^|[^a-z_])${name}(?:[^a-z_]|$)`, 'u').test(contents));
    if (!item) return null;
    const rest = left.slice(left.indexOf(item) + 1);
    return { tool: 'mc.withdraw-from-container', input: { ...chest, itemName: item }, why: `箱から${item}を取る`, expectMs: 3_000,
      key: `chest:take:${cellKey(chest)}:${item}`, then: () => takeFrom(contents, rest) };
  };
  const look: MinecraftWorkItem = { tool: 'mc.check-container', input: { ...chest }, why: '箱の中を見る', expectMs: 3_000, key: `chest:look:${cellKey(chest)}`,
    then: contents => takeFrom(contents, wanted) };
  return doing({ tool: 'mc.move-to', input: { ...chest, goalType: 'block' }, why, expectMs: 60_000, resumable: true, key: `chest:walk:${cellKey(chest)}`,
    then: arrived(visits, `chest:${cellKey(chest)}`, look), chain: 2 + wanted.length });
}

/** The obsidian of the map's `黒曜石` line (`黒曜石 2か所: 118m 北東 (-136,-55,457) ×14`): the place and how many were seen together. */
export function obsidianPlaces(facts: MinecraftProcedureFacts): Array<MapPlace & { count: number }> {
  const text = line(facts, '黒曜石').replace(/^[^:：]*[:：]/u, '');
  const pattern = new RegExp(`(\\d+)m\\s+\\S+\\s+${CELL}(?:\\s*×(\\d+))?`, 'gu');
  return [...text.matchAll(pattern)].slice(0, 6).map(match => ({ distance: Number(match[1]), at: cellOf(match, 2), extra: '', count: Number(match[5] ?? 1) }));
}

/** How far a remembered obsidian or portal is worth a walk. */
const OBSIDIAN_WALK = 130;

/**
 * The obsidian the map remembers on the surface (or near her), not gone to yet, nearest first: what to take before any lava (mb-r20).
 * Obsidian down in the rock far off is not this one: it is dug last, by the body's own tunnelling (`obsidianMove`).
 */
export function obsidianAhead(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory): (MapPlace & { count: number }) | null {
  if (!overworld(facts)) return null;
  return obsidianPlaces(facts).filter(place => place.distance <= OBSIDIAN_WALK && (place.at.y >= 50 || place.distance <= 60)
    && fresh(visits, memory, `obsidian:${cellKey(place.at)}`, `obsidian:walk:${cellKey(place.at)}`)).sort((a, b) => a.distance - b.distance)[0] ?? null;
}

/** The walk to a remembered obsidian and the dig of what is there (`count` at most), once a task. */
export function mappedObsidian(visits: MapVisits, place: MapPlace & { count: number }, wanted: number): McMove {
  const dig: MinecraftWorkItem = { tool: 'mc.mine-block', input: { blockName: 'obsidian', count: Math.max(1, Math.min(wanted, place.count)), searchRadius: 16 },
    why: '地図で覚えている黒曜石を掘る', expectMs: 12_000 * Math.min(wanted, place.count), key: `obsidian:dig:${cellKey(place.at)}` };
  return doing({ tool: 'mc.move-to', input: { ...place.at, goalType: 'near', range: 6 }, why: '地図で覚えている黒曜石の所へ歩く', expectMs: 60_000, resumable: true,
    key: `obsidian:walk:${cellKey(place.at)}`, then: arrived(visits, `obsidian:${cellKey(place.at)}`, dig), chain: 2 });
}

/** The ruined portal a visit is due at, as `ruinedPortal` chooses it (its chest to take from, or its frame to dig), nearest first; null when none. */
export function portalAhead(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory,
  parts: { obsidian: number; flint: boolean; within?: number }): MapPlace | null {
  if (!overworld(facts)) return null;
  for (const portal of structures(facts, '荒廃したポータル').filter(item => item.distance <= (parts.within ?? 130))) {
    const chest = /箱/u.test(portal.extra) ? firstCell(portal.extra.slice(portal.extra.indexOf('箱'))) : null;
    if (chest && (parts.flint || parts.obsidian > 0) && fresh(visits, memory, `chest:${cellKey(chest)}`, `chest:walk:${cellKey(chest)}`)) return portal;
    const frame = Number(/黒曜石(\d+)個/u.exec(portal.extra)?.[1] ?? 0);
    if (parts.obsidian > 0 && frame > 0 && fresh(visits, memory, `portal:${cellKey(portal.at)}`, `portal:walk:${cellKey(portal.at)}`)) return portal;
  }
  return null;
}

/** A ruined portal's chest (a flint and steel about half the time) and its frame's obsidian, nearest first, each once a task. */
export function ruinedPortal(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory,
  parts: { obsidian: number; flint: boolean; within?: number }): McMove | null {
  if (!overworld(facts)) return null;
  for (const portal of structures(facts, '荒廃したポータル').filter(item => item.distance <= (parts.within ?? 130))) {
    const chest = /箱/u.test(portal.extra) ? firstCell(portal.extra.slice(portal.extra.indexOf('箱'))) : null;
    if (chest && (parts.flint || parts.obsidian > 0) && fresh(visits, memory, `chest:${cellKey(chest)}`, `chest:walk:${cellKey(chest)}`)) {
      return lootChest(visits, chest, parts.flint ? ['flint_and_steel', 'obsidian', 'flint', 'iron_ingot'] : ['obsidian'], '荒廃したポータルの箱へ行く');
    }
    const frame = Number(/黒曜石(\d+)個/u.exec(portal.extra)?.[1] ?? 0);
    const place = `portal:${cellKey(portal.at)}`;
    if (parts.obsidian <= 0 || frame <= 0 || !fresh(visits, memory, place, `portal:walk:${cellKey(portal.at)}`)) continue;
    const count = Math.min(parts.obsidian, frame);
    const dig: MinecraftWorkItem = { tool: 'mc.mine-block', input: { blockName: 'obsidian', count, searchRadius: 16 }, why: '荒廃したポータルの枠の黒曜石を掘る',
      expectMs: 12_000 * count, key: `portal:dig:${cellKey(portal.at)}` };
    return doing({ tool: 'mc.move-to', input: { ...portal.at, goalType: 'near', range: 6 }, why: '荒廃したポータルへ行く', expectMs: 60_000, resumable: true,
      key: `portal:walk:${cellKey(portal.at)}`, then: arrived(visits, place, dig), chain: 2 });
  }
  return null;
}

/** A village's smith's chest (iron, obsidian, sometimes diamonds) within `within` m, once a task. */
export function smithChest(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory, within = 100): McMove | null {
  if (!overworld(facts)) return null;
  for (const village of structures(facts, '村').filter(item => item.distance <= within)) {
    const chest = /鍛冶屋の箱/u.test(village.extra) ? firstCell(village.extra) : null;
    if (!chest || !fresh(visits, memory, `chest:${cellKey(chest)}`, `chest:walk:${cellKey(chest)}`)) continue;
    return lootChest(visits, chest, ['iron_ingot', 'obsidian', 'diamond', 'bread'], '村の鍛冶屋の箱へ行く');
  }
  return null;
}

/** The nearest village within `within` m, walked into once a task: its beds then show as needs in reach (taken by the bed's rule). */
export function villageVisit(facts: MinecraftProcedureFacts, visits: MapVisits, memory: ProcedureMemory, within = 128): McMove | null {
  if (!overworld(facts)) return null;
  const village = structures(facts, '村').find(item => item.distance <= within
    && fresh(visits, memory, `village:${cellKey(item.at)}`, `village:walk:${cellKey(item.at)}`));
  if (!village) return null;
  return doing({ tool: 'mc.move-to', input: { ...village.at, goalType: 'near', range: 8 }, why: '村のベッドと食べ物を取りに行く', expectMs: 60_000, resumable: true,
    key: `village:walk:${cellKey(village.at)}`, then: arrived(visits, `village:${cellKey(village.at)}`) });
}
