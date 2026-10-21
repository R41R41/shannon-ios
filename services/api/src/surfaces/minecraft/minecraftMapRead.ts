/**
 * The body's map of the world it has seen (`world.mapSummary`, a line a kind, each place `<m>m <方角> (x,y,z)` with the words in its brackets
 * after it), read from the text alone: the route planner, the wood advice and the decision's lines read it here without the procedure's
 * facts (mb-r24, Minecraft run 24: the planner never saw a tree because the map carries none, and the route's old coordinates were read
 * as stronger than the lava in sight).
 */
export interface MapCell { x: number; y: number; z: number }
export interface MapEntry { distance: number; direction: string; at: MapCell; extra: string; times: number | null }

const N = '(-?\\d+)';
/** `<m>m <方角> (x,y,z)`, then the words in brackets and a count (`×14`, `oak_log×12`) when there are any. */
const ENTRY = new RegExp(`(\\d+)m\\s+(\\S+)\\s+\\(${N},\\s*${N},\\s*${N}\\)(（[^）]*）)?(?:\\s*[a-z_]*×(\\d+))?`, 'gu');

/** The map's text, or '' for anything else. */
export const mapText = (value: unknown): string => typeof value === 'string' ? value : '';

/** The first line of the map that starts with `head` (`鉱石`, `構造物`, `溶岩の溜まり`), or ''. */
export function mapLine(map: string, head: string): string {
  return map.split('\n').find(item => item.trimStart().startsWith(head)) ?? '';
}

/** The places a piece of text lists, in its order (at most `limit`). */
export function entriesIn(text: string, limit = 8): MapEntry[] {
  return [...text.matchAll(ENTRY)].slice(0, limit).map(match => ({ distance: Number(match[1]), direction: match[2]!,
    at: { x: Number(match[3]), y: Number(match[4]), z: Number(match[5]) }, extra: match[6] ?? '', times: match[7] ? Number(match[7]) : null }));
}

/** The part of a line after its heading's colon. */
const afterHead = (line: string) => line.replace(/^[^:：]*[:：]\s*/u, '');

/** The places of one line of the map (`溶岩の溜まり`, `水源`, `黒曜石`). */
export const lineEntries = (map: string, head: string, limit = 8): MapEntry[] => entriesIn(afterHead(mapLine(map, head)), limit);

/** The places of one part (split by `／`) of a line, e.g. the `鉱石` line's `ダイヤ 2か所（…）: …`. */
export function partEntries(map: string, head: string, part: string, limit = 6): MapEntry[] {
  return entriesIn(afterHead(mapLine(map, head)).split('／').find(item => item.trimStart().startsWith(part)) ?? '', limit);
}

/** The structures of the map's `構造物` line named like one of `names`, nearest first: `村: 91m 東 (x,y,z)（…）／難破船: …`. */
export function structureEntries(map: string, names: readonly string[]): Array<MapEntry & { name: string }> {
  const parts = afterHead(mapLine(map, '構造物')).split('／');
  return parts.flatMap(part => {
    const name = names.find(item => part.trimStart().startsWith(item));
    return name ? entriesIn(part, 4).map(entry => ({ ...entry, name })) : [];
  }).sort((a, b) => a.distance - b.distance);
}

/**
 * The trees the body lists (`木: 112m 北 (x,y,z) oak_log×12`, a line the body writes once it counts the logs of the surface), nearest first;
 * empty when the map has none (and when it has no such line at all).
 */
export function treeEntries(map: string): Array<MapEntry & { count: number }> {
  const line = map.split('\n').find(item => /^\s*(?:原木|木)\s*[:：]/u.test(item)) ?? '';
  return entriesIn(afterHead(line), 6).map(entry => ({ ...entry, count: entry.times ?? 1 })).sort((a, b) => a.distance - b.distance);
}

/** What the body says of one lava pool: how many sources it holds and whether rock covers it (null: not said). */
export interface LavaTraits { size: number | null; covered: boolean | null }
export function lavaTraits(extra: string): LavaTraits {
  const size = /(?:水源|溜まり|大きさ|規模)\s*[:：]?\s*(\d+)|(\d+)\s*(?:個|か所|ヶ所)|×\s*(\d+)/u.exec(extra);
  const open = /開けて(?:いる|る)|露出|表に出て|覆いなし|覆われていない/u.test(extra);
  const shut = /覆われて(?:いる|る)|岩に覆|覆い(?:あり|つき)|上が塞|掘って開ける/u.test(extra);
  const count = size ? Number(size[1] ?? size[2] ?? size[3]) : null;
  return { size: count !== null && Number.isFinite(count) ? count : null, covered: open ? false : shut ? true : null };
}

/** A position from the world's `position` (whole blocks), or null. */
export function positionOf(world: unknown): MapCell | null {
  const at = world && typeof world === 'object' && !Array.isArray(world) ? (world as Record<string, unknown>).position : null;
  const value = at && typeof at === 'object' ? at as Record<string, unknown> : null;
  const [x, y, z] = [value?.x, value?.y, value?.z].map(item => typeof item === 'number' && Number.isFinite(item) ? item : null);
  return x !== null && y !== null && z !== null ? { x: Math.floor(x!), y: Math.floor(y!), z: Math.floor(z!) } : null;
}
