/**
 * The body's scan is taken once, at a spawn, and kept until the next spawn (nothing in the land updates it). Every place that said one of its rows
 * as a fact of now (the village's food, where food is, the descent note, the survey, the first plan) showed a field that had been read minutes
 * before, with the scan's direction and distance as if from her feet, under a name (「村の食べ物」) that did not say it came from a scan; one
 * such row stayed in 369 of 369 decisions and she walked to a place that was bare cobblestone 47 times.
 *
 * This is the one place that judges a scan row: by the scan's own time and base point (`at`, `center`), against the observation's time and her feet.
 * A row that outlived its time is dropped (fields and crops change within minutes; a bell, hay or ore stays put much longer). A row that is kept is
 * said with the scan's age and base, and its direction and distance are worked out again from her feet (the scan's were from the base).
 * Nothing here says a row is false: only that it was read then and is not read now.
 */
type Point = { x: number; y: number; z: number };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const pointOf = (value: unknown): Point | null => {
  const at = record(value), x = num(at?.x), y = num(at?.y), z = num(at?.z);
  return x !== null && y !== null && z !== null ? { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } : null;
};

/** Fields and crops change within minutes (planted, trampled, grown, dug): their rows are dropped after this long, or when she is this far from the base. */
export const SCAN_FIELD_MS = 5 * 60_000, SCAN_FIELD_METERS = 32;
/** The rest of the rows (a bell, hay, ore, water, a portal) stay put: dropped after this long. */
export const SCAN_STILL_MS = 90 * 60_000;
const VOLATILE_ROW = /^(?:畑|作物)/u;
const DIRECTION = /\((-?\d+),(-?\d+),(-?\d+)\) [東西南北]{1,2}\s?\d+m(?:・[上下]\s?\d+)?/gu;

export interface AgedScan {
  /** The rows still worth saying, each with the direction and distance from her feet when she is known. */
  rows: string[];
  /** 「走査 8 分前・基点 (x,y,z)・今は未確認」; null when there is no scan. */
  mark: string | null;
  /** How many rows were dropped for their age or distance. */
  dropped: number;
  /** Minutes since the scan, null when either time is unknown. */
  minutes: number | null;
}

/** The direction and distance of each `(x,y,z)` of a row from her feet, in place of the scan's (from its base). */
function fromFeet(row: string, feet: Point | null): string {
  if (!feet) return row;
  return row.replace(DIRECTION, (_whole, x: string, y: string, z: string) => {
    const dx = Number(x) - feet.x, dy = Number(y) - feet.y, dz = Number(z) - feet.z;
    const flat = Math.round(Math.hypot(dx, dz)), up = Math.round(dy);
    return `(${x},${y},${z}) 今の足元から水平 ${flat}m${up === 0 ? '' : `・${up > 0 ? '上' : '下'} ${Math.abs(up)}`}`;
  });
}

/** The scan's rows as of `nowMs` (the observation's time; null when unknown) for her at `feet`; see the file's note. */
export function agedScan(scan: unknown, nowMs: number | null, feet: Point | null): AgedScan {
  const value = record(scan);
  if (!value) return { rows: [], mark: null, dropped: 0, minutes: null };
  const took = typeof value.at === 'string' ? Date.parse(value.at) : NaN;
  const ageMs = nowMs !== null && Number.isFinite(took) ? Math.max(0, nowMs - took) : null;
  const base = pointOf(value.center);
  const away = feet && base ? Math.hypot(feet.x - base.x, feet.z - base.z) : null;
  const all = (Array.isArray(value.rows) ? value.rows : []).filter((row): row is string => typeof row === 'string');
  let dropped = 0;
  const rows = all.filter(row => {
    const volatile = VOLATILE_ROW.test(row);
    const old = ageMs !== null && ageMs > (volatile ? SCAN_FIELD_MS : SCAN_STILL_MS);
    const far = volatile && away !== null && away > SCAN_FIELD_METERS;
    if (old || far) { dropped += 1; return false; }
    return true;
  }).map(row => fromFeet(row, feet));
  const minutes = ageMs === null ? null : Math.floor(ageMs / 60_000);
  const mark = `走査 ${minutes === null ? '時刻不明' : `${minutes} 分前`}${base ? `・基点 (${base.x},${base.y},${base.z})` : ''}・今は未確認`;
  return { rows, mark, dropped, minutes };
}
