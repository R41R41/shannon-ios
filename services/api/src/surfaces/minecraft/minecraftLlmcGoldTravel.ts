/**
 * Which moves the piglins' gate holds (review of 11/4: a `go` back to the gate with 20 health, nothing near and no gold on was refused, and a body in the
 * Nether with no gold could not get back). The gate holds the travel of the search, judged by where the move ends: a move that ends at a place she
 * keeps for the way back (the portal, a table, a chest, a bed, the base: the places the body remembers and the marks of the map in this dimension),
 * or a short hop from where she stands (a step out of lava, into cover, to a meal), is not the search and goes through. Kinds of place, no coordinates.
 */
type Cell = { x: number; y: number; z: number };
const CELL = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/u;
/** The marks of the way back on the map (a mark of another dimension starts with `[`). */
const BACK_MARK = /ポータル|作業台|チェスト|かまど|ベッド|拠点|帰還/u;
export const HOP_BLOCKS = 12;
export const BACK_BLOCKS = 10;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const cellOf = (value: unknown): Cell | null => {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return item && finite(item.x) && finite(item.y) && finite(item.z) ? { x: item.x, y: item.y, z: item.z } : null;
};
const parsed = (text: unknown): Cell[] => {
  const found = typeof text === 'string' ? CELL.exec(text) : null;
  return found ? [{ x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) }] : [];
};
const distance = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The places for the way back in this dimension: what the body remembers (its coordinates come first) and the marks of the map. */
export function backPlaces(world: Record<string, unknown>): Cell[] {
  const remembered = world.rememberedPlaces && typeof world.rememberedPlaces === 'object' ? Object.values(world.rememberedPlaces) : [];
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).filter(line => typeof line === 'string' && !line.startsWith('[') && BACK_MARK.test(line));
  return [...remembered, ...marks].flatMap(parsed);
}

/** Where a go or walk hand ends: its `to`, each of its `goals`, the last point of its `path`. */
function endsOf(hand: Record<string, unknown>): Cell[] {
  const goals = Array.isArray(hand.goals) ? hand.goals.map(cellOf) : [];
  const path = Array.isArray(hand.path) && hand.path.length ? [cellOf(hand.path[hand.path.length - 1])] : [];
  return [cellOf(hand.to), ...goals, ...path].filter((cell): cell is Cell => cell !== null);
}

/** Whether a go or walk hand is the travel of the search (held by the gate): it ends where none of the way-back places is, and not a hop from her feet. */
export function searchTravel(hand: Record<string, unknown>, world: Record<string, unknown>): boolean {
  const ends = endsOf(hand);
  if (!ends.length) return false;
  const feet = cellOf(world.position), back = backPlaces(world);
  return ends.every(end => (!feet || distance(end, feet) > HOP_BLOCKS) && back.every(place => distance(end, place) > BACK_BLOCKS));
}
