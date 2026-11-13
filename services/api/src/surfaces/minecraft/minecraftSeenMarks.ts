/**
 * What the body's marks say is in view now (the done-conditions `see:<name>` of the plan, and the facts of the places she found).
 *
 * The body writes the marks it scans in `world.mapLandmarks` (one line each, `記号 名前 (x,y,z) 方角距離・上下 注記`, only the dimension
 * she is in; a place of another dimension starts with that dimension in brackets) and the structure she stands in or beside in `world.inside`.
 * The names are the body's own fixed labels (`mapMarks.ts`). Nothing here guesses a place from anything else.
 */
export const SEEN_NAMES = ['fortress', 'bastion', 'spawner', 'blaze_spawner', 'nether_portal', 'end_portal_frame', 'end_portal', 'stronghold',
  'village', 'warped_forest', 'gate_spawn'] as const;
export type SeenName = typeof SEEN_NAMES[number];
export const isSeenName = (name: string): name is SeenName => (SEEN_NAMES as readonly string[]).includes(name);
/** What a status says is not in view yet. */
export const SEEN_WORDS: Readonly<Record<SeenName, string>> = Object.freeze({
  fortress: 'ネザー要塞（ネザーレンガ）', bastion: '砦の遺跡', spawner: 'スポナー', blaze_spawner: 'ブレイズのスポナー', nether_portal: 'ネザーポータル',
  end_portal_frame: 'エンドポータルの枠', end_portal: '開いたエンドポータル', stronghold: 'ストロングホールドの中', village: '村', warped_forest: '歪んだ森',
  gate_spawn: 'ゲートのそばのリスポーン地点（ベッドを use）',
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

/** A warped forest the body reports: a place it remembered (`rememberedPlaces.warped_forest`), a landmark labelled so, or a biome of
 * `world.biomesSeen` (`warped_forest 西 150m`; `warped_forest 未見` is not a sighting). The head reads only the body's words. */
export function warpedForestIn(world: Record<string, unknown>): boolean {
  const places = world.rememberedPlaces;
  if (places && typeof places === 'object' && !Array.isArray(places) && typeof (places as Record<string, unknown>).warped_forest === 'string') return true;
  if (marksOf(world.mapLandmarks).some(mark => mark.label.startsWith('歪んだ森'))) return true;
  return typeof world.biomesSeen === 'string' && /warped_forest(?!\s*未見)/u.test(world.biomesSeen);
}

/** How near the respawn bed stands to the gate to be the gate's (the bed is set down 2 to 4 m in front of the frame). */
export const GATE_SPAWN_M = 8;
const CELL = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u;
const cellOf = (value: unknown): { x: number; y: number; z: number } | null => {
  const found = typeof value === 'string' ? CELL.exec(value) : null;
  return found ? { x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) } : null;
};
/**
 * Run 10 (11/14, the owner): she died in the Nether after 7 rods and came back far off; the rods, diamond tools and armour lay by the
 * blazes for their 5 minutes. A bed used by the gate (overworld side, not slept in) is where she comes back, 4 s from the Nether.
 * True when the body's own respawn bed (`rememberedPlaces.respawn`, this dimension's) is within `GATE_SPAWN_M` of a nether portal it
 * sees (a landmark) or remembers (`rememberedPlaces.nether_portal`).
 */
export function gateSpawnIn(world: Record<string, unknown>): boolean {
  const raw = world.rememberedPlaces;
  const places = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const bed = cellOf(places?.respawn);
  if (!bed) return false;
  const remembered = cellOf(places?.nether_portal);
  const portals = [...marksOf(world.mapLandmarks).filter(mark => namesOf(mark).includes('nether_portal')), ...(remembered ? [remembered] : [])];
  return portals.some(cell => Math.hypot(cell.x - bed.x, cell.y - bed.y, cell.z - bed.z) <= GATE_SPAWN_M);
}

/** What is in view: the names of the marks, and the structure she is in (`inside`). */
export function seenMarks(world: Record<string, unknown>): ReadonlySet<SeenName> {
  const seen = new Set<SeenName>(marksOf(world.mapLandmarks).flatMap(namesOf));
  const inside = typeof world.inside === 'string' ? world.inside : '';
  if (/ネザー要塞/u.test(inside)) seen.add('fortress');
  if (/砦の遺跡/u.test(inside)) seen.add('bastion');
  if (/ストロングホールド/u.test(inside)) seen.add('stronghold');
  if (warpedForestIn(world)) seen.add('warped_forest');
  if (gateSpawnIn(world)) seen.add('gate_spawn');
  return seen;
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
