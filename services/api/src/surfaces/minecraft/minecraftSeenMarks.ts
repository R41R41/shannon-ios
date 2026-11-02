/**
 * What the body's marks say is in view now (the done-conditions `see:<name>` of the plan, and the facts of the places she found).
 *
 * The body writes the marks it scans in `world.mapLandmarks` (one line each, `記号 名前 (x,y,z) 方角距離・上下 注記`, only the dimension
 * she is in; a place of another dimension starts with that dimension in brackets) and the structure she stands in or beside in `world.inside`.
 * The names are the body's own fixed labels (`mapMarks.ts`). Nothing here guesses a place from anything else.
 */
export const SEEN_NAMES = ['fortress', 'bastion', 'spawner', 'blaze_spawner', 'nether_portal', 'end_portal_frame', 'end_portal', 'stronghold',
  'village'] as const;
export type SeenName = typeof SEEN_NAMES[number];
export const isSeenName = (name: string): name is SeenName => (SEEN_NAMES as readonly string[]).includes(name);
/** What a status says is not in view yet. */
export const SEEN_WORDS: Readonly<Record<SeenName, string>> = Object.freeze({
  fortress: 'ネザー要塞（ネザーレンガ）', bastion: '砦の遺跡', spawner: 'スポナー', blaze_spawner: 'ブレイズのスポナー', nether_portal: 'ネザーポータル',
  end_portal_frame: 'エンドポータルの枠', end_portal: '開いたエンドポータル', stronghold: 'ストロングホールドの中', village: '村',
});

export interface Mark {
  /** The label the body gave it (`ネザー要塞`). */
  label: string;
  x: number;
  y: number;
  z: number;
  /** The rest of the line after the place (direction, distance, the body's note). */
  rest: string;
}

const LINE = /^\S+\s+(.+?)\s+\((-?\d+),(-?\d+),(-?\d+)\)\s*(.*)$/u;

/** The marks of the dimension she is in, from the landmark lines (lines of another dimension, in brackets, are left out). */
export function marksOf(landmarks: unknown): Mark[] {
  if (!Array.isArray(landmarks)) return [];
  return landmarks.flatMap(line => {
    if (typeof line !== 'string' || line.startsWith('[')) return [];
    const found = LINE.exec(line);
    return found ? [{ label: found[1]!, x: Number(found[2]), y: Number(found[3]), z: Number(found[4]), rest: found[5] ?? '' }] : [];
  });
}

/** The names a label stands for (a spawner is also a blaze spawner when the body says what it spawns). */
export function namesOf(mark: Mark): SeenName[] {
  const { label, rest } = mark;
  if (label === 'ネザー要塞') return ['fortress'];
  if (label.startsWith('砦の遺跡')) return ['bastion'];
  if (label === 'スポナー') return /blaze/u.test(rest) ? ['spawner', 'blaze_spawner'] : ['spawner'];
  if (label === 'ネザーポータル') return ['nether_portal'];
  if (label === 'エンドポータルの枠') return ['end_portal_frame'];
  if (label === 'エンドポータル') return ['end_portal'];
  return label === '村' ? ['village'] : [];
}

/** What is in view: the names of the marks, and the structure she is in (`inside`). */
export function seenMarks(world: Record<string, unknown>): ReadonlySet<SeenName> {
  const seen = new Set<SeenName>(marksOf(world.mapLandmarks).flatMap(namesOf));
  const inside = typeof world.inside === 'string' ? world.inside : '';
  if (/ネザー要塞/u.test(inside)) seen.add('fortress');
  if (/砦の遺跡/u.test(inside)) seen.add('bastion');
  if (/ストロングホールド/u.test(inside)) seen.add('stronghold');
  return seen;
}

/** The end crystals left on the End island, when the body counts them (`world.crystals.remaining`); null when it does not say. */
export function crystalsLeft(world: Record<string, unknown>): number | null {
  const crystals = world.crystals;
  const remaining = crystals && typeof crystals === 'object' ? (crystals as { remaining?: unknown }).remaining : undefined;
  return typeof remaining === 'number' && Number.isInteger(remaining) && remaining >= 0 && remaining <= 99 ? remaining : null;
}

/** The first mark of a name, nearest first as the body wrote them. */
export function firstMark(world: Record<string, unknown>, name: SeenName): Mark | null {
  return marksOf(world.mapLandmarks).find(mark => namesOf(mark).includes(name)) ?? null;
}

/** The frames of the portal room as the body counts them in a mark's note (`×12 アイ入り 3`): how many, and how many hold an eye. */
export function framesOf(world: Record<string, unknown>): { frames: number; eyes: number; at: Mark } | null {
  const mark = firstMark(world, 'end_portal_frame');
  const count = mark ? /×(\d+)/u.exec(mark.rest) : null;
  if (!mark || !count) return null;
  const eyes = /アイ入り\s*(\d+)/u.exec(mark.rest);
  return { frames: Number(count[1]), eyes: eyes ? Number(eyes[1]) : 0, at: mark };
}
