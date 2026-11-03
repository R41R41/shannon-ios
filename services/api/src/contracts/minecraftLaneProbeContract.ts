import type { ActPos } from './minecraftActContract.js';

/** A bounded reading of S2's huntLane.ts/laneProbeFields, v1. Missing observations stay unknown, never zero.
 * Only candidates[0] contributes geometry and build rows. The other three contribute direction and total only.
 * cells: [x,y,z,name,state]; build: [fact,partIndex,supportAfterCell,flags,standAtCell,group].
 * facts and standFacts are not needed for this projection; their contents never enter the model's answer. */
export type LaneDirection = 'east' | 'west' | 'south' | 'north';
export type LanePair = readonly [ActPos | null, ActPos | null];
export interface LaneRequired {
  total: number | null;
  enclosure: number | null;
  roof: number | null;
  plug: number | null;
  lid: number | null;
  unknown: number | null;
  complete: boolean | null;
}
export interface LaneAlternative {
  direction: LaneDirection | null;
  total: number | null;
}
export interface LaneCandidateReading {
  direction: LaneDirection | null;
  required: LaneRequired;
  plug: ActPos | null;
  waiting: LanePair;
  lane: LanePair[];
  stands: ActPos[] | null;
  marks: { outOfReach: number; invisible: number; noSupport: number; unknown: number } | null;
  clear: number | null;
  hazards: number | null;
  remainingOutsideLane: number | null;
  unknownOutsideLane: number | null;
}
export interface LaneProbeReading {
  text: string;
  found: boolean | null;
  spawner: ActPos | null;
  spawn: { spaces: number | null; unknown: number | null };
  blaze: { count: number | null; limit: number | null; atLimit: boolean | null };
  best: LaneCandidateReading | null;
  others: LaneAlternative[];
}

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const length = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
const direction = (value: unknown): LaneDirection | null =>
  value === 'east' || value === 'west' || value === 'south' || value === 'north' ? value : null;

/** Wire coordinates are numbers, with no coercion, rounding or inferred neighbouring cells. */
function position(value: unknown): ActPos | null {
  const p = object(value);
  if (!p || ![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: p.x as number, y: p.y as number, z: p.z as number };
}
function cell(cells: unknown[], ref: unknown): ActPos | null {
  const index = count(ref);
  if (index === null) return null;
  const row = list(cells[index]);
  return position({ x: row[0], y: row[1], z: row[2] });
}
function pair(cells: unknown[], value: unknown): LanePair {
  const row = list(value);
  return [cell(cells, row[0]), cell(cells, row[1])];
}
function required(value: unknown): LaneRequired {
  const r = object(value);
  return { total: count(r?.total), enclosure: count(r?.enclosure), roof: count(r?.roof), plug: count(r?.plug),
    lid: count(r?.lid), unknown: count(r?.unknown), complete: bool(r?.complete) };
}
function buildReading(cells: unknown[], value: unknown): Pick<LaneCandidateReading, 'stands' | 'marks'> {
  if (!Array.isArray(value)) return { stands: null, marks: null };
  const marks = { outOfReach: 0, invisible: 0, noSupport: 0, unknown: 0 };
  const stands: ActPos[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = list(item);
    const flags = count(row[3]);
    if (flags === null || flags > 7) marks.unknown++;
    else {
      if (!(flags & 1)) marks.outOfReach++;
      if (!(flags & 2)) marks.invisible++;
      if (flags & 4) marks.noSupport++;
    }
    const at = cell(cells, row[4]);
    const key = at ? `${at.x},${at.y},${at.z}` : '';
    if (at && stands.length < 3 && !seen.has(key)) {
      stands.push(at);
      seen.add(key);
    }
  }
  return { stands, marks };
}
function candidate(value: unknown, cells: unknown[]): LaneCandidateReading | null {
  const c = object(value);
  if (!c) return null;
  return { direction: direction(c.direction), required: required(c.required), plug: cell(cells, c.plug),
    waiting: pair(cells, c.waiting), lane: list(c.lane).slice(0, 3).map(row => pair(cells, row)),
    ...buildReading(cells, c.build), clear: length(c.clear), hazards: length(c.hazards),
    remainingOutsideLane: count(c.remainingOutsideLane), unknownOutsideLane: count(c.unknownOutsideLane) };
}

/** Accept an incomplete lane answer without reading any other candidate's geometry or the shared fact tables. */
export function readLaneProbeResult(value: unknown): LaneProbeReading | null {
  const r = object(value);
  if (r?.kind !== 'lane') return null;
  const spawn = object(r.spawn);
  const blaze = object(r.blaze);
  const candidates = list(r.candidates);
  const found = bool(r.found);
  const others = found === false ? [] : candidates.slice(1, 4).map(item => {
    const c = object(item);
    return { direction: direction(c?.direction), total: count(object(c?.required)?.total) };
  });
  return { text: typeof r.text === 'string' ? r.text : '', found, spawner: position(r.spawner),
    spawn: { spaces: count(spawn?.spaces), unknown: count(spawn?.unknown) },
    blaze: { count: count(blaze?.count), limit: count(blaze?.limit), atLimit: bool(blaze?.atLimit) },
    best: found === false ? null : candidate(candidates[0], list(r.cells)), others };
}
