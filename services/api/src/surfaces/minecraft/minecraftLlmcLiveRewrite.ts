import { aroundLines } from './minecraftLlmcAround.js';
import { mergeEnemies, OMIT, relText } from './minecraftLlmcLiveEnemies.js';
import { expandAround, normalizeMap } from './minecraftLlmcLiveMap.js';
import { mapView, readLayers, type MapView } from './minecraftLlmcPreflightMap.js';
import { goalOf, routeLines } from './minecraftLlmcRoute.js';
import { isOpen, noFloor, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2: the live state as the decision reads it (改修案 2.2; 再現台 v9b の `rewriteLive`, the rules in its `rewriteRules.md`). **A pure
 * function of the live state alone** (the object `liveObject` hands the model: `ownerClock`, `waiting`, `observations`, `recall`, `plan`, `body`
 * with `map`, `state`, `inventory`, `landmarks`, `lastResults`…): the decision replay calls it on a recorded live state, the model's request on
 * the one it builds. Nothing is read from a body, a store or the clock; a thing the live state does not hold (an omitted line, an enemy's
 * sight) is not made up. Facts only: nothing here decides a hand.
 *
 * What it does:
 * - leaves out `ownerClock`, `waiting`, `observations` (the generation hash and task id), `recall` (the record of an earlier task and of a
 *   death: the events say the death), `plan.now`/`plan.path` when `body.planNow` says the same node, the plan's repeated rules and a rule
 *   about a cell the map now shows she can stand in, a `biome` the dimension has not, `（undefined マス）`;
 * - joins the enemies by id into one line each (`minecraftLlmcLiveEnemies.ts`), adds up the pack by kind, works out the landmarks' east/west and
 *   north/south from her feet now (the height is the body's as written), writes a stopped hand's surroundings with whole coordinates;
 * - adds `body.around` (`minecraftLlmcAround.ts`) and `body.route` (`minecraftLlmcRoute.ts`) from the map text, and puts every layer of the
 *   map on one range (`minecraftLlmcLiveMap.ts`).
 */
export interface RewriteNotes { dropped: string[]; fixed: string[]; merged: string[]; omitted: number; added: string[] }
type Rec = Record<string, unknown>;
const DIM_BIOMES: Record<string, RegExp> = {
  the_nether: /^(nether_wastes|soul_sand_valley|crimson_forest|warped_forest|basalt_deltas)$/u,
  overworld: /^(?!nether_|soul_sand|crimson|warped|basalt|the_end|end_|small_end|.*_end$)/u,
  the_end: /^(the_end|end_highlands|end_midlands|end_barrens|small_end_islands)$/u,
};
const parsePos = (text: string): P | null => {
  const m = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(text);
  return m ? { x: +m[1]!, y: +m[2]!, z: +m[3]! } : null;
};
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The pack added up by kind (a stack with durability or contents is its own line, as the body writes it). */
export function mergeInventory(list: readonly string[], notes: RewriteNotes): string[] {
  const sums = new Map<string, number>();
  const counted = new Map<string, number>();
  const out: Array<string | { name: string }> = [];
  let omitted = '';
  for (const line of list) {
    const o = OMIT.exec(line);
    if (o) {
      omitted = `ほか${o[1]}件は略`;
      notes.omitted += Number(o[1]);
      continue;
    }
    const m = /^([a-z_0-9]+)×(\d+)$/u.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    if (!sums.has(m[1]!)) out.push({ name: m[1]! });
    sums.set(m[1]!, (sums.get(m[1]!) ?? 0) + Number(m[2]));
    counted.set(m[1]!, (counted.get(m[1]!) ?? 0) + 1);
  }
  const merged = out.map(item => typeof item === 'string' ? item : `${item.name}×${sums.get(item.name)}`);
  const duplicated = [...counted].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicated.length) notes.merged.push(`持ち物の同じ物 ${duplicated.join('・')} を合算`);
  return omitted ? [...merged, omitted] : merged;
}

/** A landmark line's east/west and north/south from her feet now. The height is left as the line has it (the body's feet cell can stand one higher). */
export function fixLandmarks(list: readonly string[], self: P, notes: RewriteNotes): string[] {
  let changed = 0;
  const out = list.map(line => {
    const o = OMIT.exec(line);
    if (o) {
      notes.omitted += Number(o[1]);
      return `ほか${o[1]}件は略`;
    }
    const m = /^(.*? \((-?\d+),(-?\d+),(-?\d+)\)) ((?:[東西南北上下]\d+)(?:・[東西南北上下]\d+)*)(.*)$/u.exec(line);
    if (!m) return line;
    const target = { x: +m[2]!, y: +m[3]!, z: +m[4]! };
    const horizontal = relText({ ...self, y: target.y }, target);
    const vertical = (m[5]!.match(/[上下]\d+/u) ?? [])[0];
    const fresh = [horizontal === '同じマス' ? '' : horizontal, vertical ?? ''].filter(Boolean).join('・') || '同じマス';
    if (fresh !== m[5]) changed += 1;
    return `${m[1]} ${fresh}${m[6]}`;
  });
  if (changed) notes.fixed.push(`目印の相対位置 ${changed} 行を今の足から計算し直した`);
  return out;
}
const dropOmits = (list: readonly string[], notes: RewriteNotes): string[] => list.map(line => {
  const o = OMIT.exec(line);
  if (!o) return line;
  notes.omitted += Number(o[1]);
  return `ほか${o[1]}件は略`;
});

/** A rule about a cell she cannot stand in, when the map now shows she can (feet and head open, a floor): a stale note. */
export function staleStand(rule: string, view: MapView): boolean {
  const m = /^注意: \((-?\d+),(-?\d+),(-?\d+)\): 的そのものには立てない/u.exec(rule);
  if (!m) return false;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = view.symbol(x, y, z), head = view.symbol(x, y + 1, z), floor = view.symbol(x, y - 1, z);
  return at !== undefined && head !== undefined && floor !== undefined && isOpen(at) && isOpen(head) && !noFloor(floor);
}

function rewritePlan(plan: Rec, planNow: string, view: MapView | null, notes: RewriteNotes): Rec {
  const out: Rec = { ...plan };
  if (Array.isArray(out.rules)) {
    const seen = new Set<string>();
    out.rules = (out.rules as unknown[]).filter((rule): rule is string => typeof rule === 'string').filter(rule => {
      if (view && staleStand(rule, view)) {
        notes.fixed.push(`plan.rules の古い注意を外した「${rule.slice(0, 30)}」（今の地図ではそのマスは立てる）`);
        return false;
      }
      const norm = rule.replace(/（p\d+(?:\.\d+)*）/u, '');
      if (seen.has(norm)) {
        notes.merged.push(`plan.rules の重複「${rule.slice(0, 20)}」`);
        return false;
      }
      seen.add(norm);
      return true;
    });
  }
  const id = /^(p\d+(?:\.\d+)*|r\d+)\s/u.exec(String(out.now ?? ''))?.[1];
  if (id && planNow.startsWith(`[${id}]`)) {
    delete out.now;
    delete out.path;
    notes.dropped.push('plan.now・plan.path（body.planNow と同じ）');
  }
  return out;
}

function rewriteState(value: unknown, notes: RewriteNotes): unknown {
  const copy = { ...(rec(value) ?? {}) };
  const biome = String(copy.biome ?? ''), dimension = String(copy.dimension ?? '');
  if (biome && DIM_BIOMES[dimension] && !DIM_BIOMES[dimension]!.test(biome)) {
    delete copy.biome;
    notes.fixed.push(`biome ${biome} は ${dimension} に無い物なので外した`);
  }
  return copy;
}

/** The body's own lines, one key at a time. */
function rewriteBodyKey(key: string, value: unknown, self: P | null, notes: RewriteNotes): unknown {
  if (key === 'state') return rewriteState(value, notes);
  if (key === 'inventory' && Array.isArray(value)) return mergeInventory(strings(value), notes);
  if (key === 'landmarks' && Array.isArray(value)) return self ? fixLandmarks(strings(value), self, notes) : value;
  if ((key === 'near' || key === 'stops') && Array.isArray(value)) return dropOmits(strings(value), notes);
  if (key === 'lastResults' && Array.isArray(value)) {
    return strings(value).map(text => {
      const done = expandAround(text);
      if (done.expanded) notes.fixed.push('止まった手の周りの略記を座標つきに');
      return done.text;
    });
  }
  if (key === 'investigation' && Array.isArray(value)) {
    return strings(value).map(line => {
      const fixed = line.replace(/（undefined マス）/gu, '');
      if (fixed !== line) notes.fixed.push('「undefined マス」を外した');
      return fixed;
    });
  }
  return value;
}

/** The map's place in the body: the facts made from it (`around`, `route`), then the map on one range. */
function mapFields(bodyIn: Rec, value: unknown, notes: RewriteNotes): Rec {
  const map = typeof bodyIn.map === 'string' ? bodyIn.map : undefined;
  const layers = readLayers(map);
  const out: Rec = {};
  if (layers) {
    const view = mapView(layers), planNow = String(bodyIn.planNow ?? '');
    out.around = aroundLines(view, layers.feet);
    notes.added.push('around');
    const goal = goalOf(planNow);
    if (goal) {
      out.route = routeLines(view, layers.feet, goal, /^\[([^\]]+)\]/u.exec(planNow)?.[1] ?? '今の節');
      notes.added.push('route');
    }
  }
  out.map = normalizeMap(map) ?? value;
  return out;
}

function rewriteBody(bodyIn: Rec, notes: RewriteNotes): Rec {
  const self = parsePos(String(rec(bodyIn.state)?.at ?? ''));
  const enemies = self ? mergeEnemies(bodyIn, self) : { urgent: bodyIn.urgent, threats: bodyIn.threats, merged: 0 };
  if (enemies.merged) notes.merged.push(`敵の行 ${enemies.merged} 減らした`);
  const body: Rec = {};
  for (const [key, value] of Object.entries(bodyIn)) {
    if (key === 'unreachable') continue;
    if (key === 'urgent' || key === 'threats') {
      if (enemies[key]) body[key] = enemies[key];
      continue;
    }
    if (key === 'map') {
      Object.assign(body, mapFields(bodyIn, value, notes));
      continue;
    }
    body[key] = rewriteBodyKey(key, value, self, notes);
  }
  return body;
}

/** The live state rewritten (see the file's heading). Never throws: a part that does not read as expected is left as it is. */
export function rewriteLlmcLive(live: Rec): { live: Rec; notes: RewriteNotes } {
  const notes: RewriteNotes = { dropped: [], fixed: [], merged: [], omitted: 0, added: [] };
  const out: Rec = {};
  for (const [key, value] of Object.entries(live)) {
    if (key === 'ownerClock' || key === 'waiting' || key === 'observations') notes.dropped.push(key);
    else if (key === 'recall') notes.dropped.push(`recall(${(Array.isArray(rec(value)?.items) ? (rec(value)!.items as unknown[]).length : 0)})`);
    else out[key] = value;
  }
  const bodyIn = rec(live.body);
  if (!bodyIn) return { live: out, notes };
  const layers = typeof bodyIn.map === 'string' ? readLayers(bodyIn.map) : null;
  const plan = rec(live.plan);
  if (plan) out.plan = rewritePlan(plan, String(bodyIn.planNow ?? ''), layers ? mapView(layers) : null, notes);
  try {
    out.body = rewriteBody(bodyIn, notes);
  } catch {
    out.body = bodyIn;
  }
  return { live: out, notes };
}
