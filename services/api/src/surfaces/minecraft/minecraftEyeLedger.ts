import { readActResult } from '../../contracts/minecraftActContract.js';
import {
  bearingBetween,
  compassWord,
  directPoint,
  nearThrowPlace,
  nextThrowPlaces,
  stronghold,
  type DirectPoint,
  type EyeThrow,
  type Fix,
} from './minecraftEyeTriangulation.js';

/**
 * The ledger of the eyes of ender she has thrown in this task (the head's own record; the body reports each flight in its act result,
 * `ActResult.eye`, and keeps no list). It lives in the task's checkpoint, so a summary of the talk, a restart or a new step never
 * loses a throw. From the throws it computes the stronghold (`minecraftEyeTriangulation.ts`) and says it as facts, with how sure it is
 * and where to throw from next; it decides nothing.
 *
 * The body's report (S2, 2026-11-02): where she stood (`origin`, exact), the flight's compass bearing and horizontal unit vector, how far
 * it flew, how it ended (`fate`: dropped with the item's id and place, shattered, unknown), `arrived` (it stopped short of the 12 blocks
 * an eye flies toward a farther stronghold) and `down` (it sank where it was thrown: the stronghold is under that place).
 *
 * Only throws in the overworld count. A throw is kept for `KEEP_MS` (and is not read after it, whenever the ledger is read), and the
 * ledger holds the newest `KEEP_THROWS` of them near the newest one (the stronghold of an earlier trek is not this one).
 */
export const KEEP_THROWS = 8;
const KEEP_MS = 45 * 60_000;
const NEAR_BLOCKS = 4_000;
/** Eyes that dropped can be picked up for this long. */
const DROP_MS = 5 * 60_000;

export type EyeFate = 'dropped' | 'shattered' | 'unknown';
export interface StoredThrow extends EyeThrow {
  id: string;
  at: number;
  /** Where it came down (for picking it up): the dropped item's place when the body saw it, else where the eye was last seen. */
  toX: number;
  toZ: number;
  fate?: EyeFate;
  /** The dropped item's entity id (what `pickup` takes by id). */
  dropId?: number;
}
interface LedgerState {
  v: 1;
  throws: StoredThrow[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const xz = (value: unknown): { x: number; z: number } | null => {
  const item = rec(value);
  return item && finite(item.x) && finite(item.z) ? { x: item.x, z: item.z } : null;
};
const fateOf = (value: unknown): EyeFate | null => value === 'dropped' || value === 'shattered' || value === 'unknown' ? value : null;
/** The optional fields of a throw, from a report or from a checkpoint (the same names). */
function extrasOf(item: Rec): Pick<StoredThrow, 'down' | 'arrived' | 'unit' | 'fate' | 'dropId'> {
  const unit = xz(item.unit);
  const fate = fateOf(item.fate);
  return { ...(item.down === true ? { down: true } : {}), ...(item.arrived === true && item.down !== true ? { arrived: true } : {}),
    ...(unit ? { unit } : {}), ...(fate ? { fate } : {}), ...(finite(item.dropId) ? { dropId: item.dropId } : {}) };
}

function storedOf(raw: unknown): StoredThrow | null {
  const item = rec(raw);
  if (!item || typeof item.id !== 'string' || ![item.x, item.z, item.bearingDeg, item.flew, item.at, item.toX, item.toZ].every(finite)) return null;
  return { id: item.id.slice(0, 80), x: item.x as number, z: item.z as number, bearingDeg: item.bearingDeg as number, flew: item.flew as number,
    broke: item.broke === true, at: item.at as number, toX: item.toX as number, toZ: item.toZ as number, ...extrasOf(item) };
}

/** A flight from an act result (the receipt's JSON), or null when the act threw no eye. */
export function flightOf(resultJson: string | undefined): Omit<StoredThrow, 'id' | 'at'> | null {
  const eye = rec(readActResult(resultJson)?.eye);
  const from = xz(eye?.from);
  const to = xz(eye?.to);
  if (!eye || !from || !to || ![eye.bearingDeg, eye.flew].every(finite)) return null;
  const origin = xz(eye.origin) ?? from;
  const landed = xz(rec(eye.drop)?.at) ?? to;
  const dropId = rec(eye.drop)?.id;
  return { x: origin.x, z: origin.z, bearingDeg: eye.bearingDeg as number, flew: eye.flew as number, broke: eye.broke === true || eye.fate === 'shattered',
    toX: landed.x, toZ: landed.z, ...extrasOf({ ...eye, dropId }) };
}

const place = (x: number, z: number): string => `(${Math.round(x)},${Math.round(z)})`;
const grouped = (value: number): string => Math.round(value).toLocaleString('en-US');
const tenth = (value: number): string => String(Math.round(value * 10) / 10);
const FRAME_SEARCH = '枠は mc_probe kind=frames（x z にその所・radius 128）で探す。部屋は入口から 7〜72 ブロック離れていた（隔離ラボの 5 世界）';

function pickWords(item: StoredThrow, now: number): string {
  if (item.broke) return '（割れた）';
  if (item.fate === 'unknown') return '（落ちたか割れたか見えなかった）';
  if (now - item.at >= DROP_MS) return '（落ちた: 拾える期限が過ぎたかもしれない）';
  return `（落ちた: ${place(item.toX, item.toZ)} で拾える${item.dropId === undefined ? '' : `・pickup target=#${item.dropId}`}）`;
}

function throwWords(item: StoredThrow, now: number): string {
  if (item.down) return `${place(item.x, item.z)} から投げたら真下へ沈んだ${pickWords(item, now)}`;
  const flight = `方位 ${tenth(item.bearingDeg)}°（${compassWord(item.bearingDeg)}）に ${Math.round(item.flew)} 飛んだ`;
  return `${place(item.x, item.z)} から ${flight}${item.arrived ? '（そこで止まった）' : ''}${pickWords(item, now)}`;
}

/** The lines the throws say: the count, the latest ones, the point they give (or why none) and where to throw from next. */
export function ledgerLines(throws: readonly StoredThrow[], feet: { x: number; z: number } | null, now: number): string[] {
  if (!throws.length) return [];
  const broke = throws.filter(item => item.broke).length;
  const head = `目玉の帳簿: 投げた ${throws.length} 個（割れた ${broke}）。新しい順: ${throws.slice(-3).reverse().map(item => throwWords(item, now)).join(' / ')}`;
  const direct = directPoint(throws);
  if (direct) return [head, directLine(direct, feet)];
  const fix = stronghold(throws);
  if (!fix) return [head, noFixLine(throws, throws[throws.length - 1]!)];
  return [head, ...fixLines(fix, feet)];
}

function noFixLine(throws: readonly StoredThrow[], last: StoredThrow): string {
  const why = throws.length < 2 ? '線が 1 本だけ' : '線が近すぎるか、誤差が大きい（誤差 600m 超）';
  const places = nextThrowPlaces(last, throws.length - 1);
  if (!places.length) return `交点はまだ無い（${why}）`;
  const where = places.map(item => place(item.x, item.z)).join(' か ');
  return `交点はまだ無い（${why}）。次に投げる場所の案: 最後の線の横 ${places[0]!.from}m の ${where}（2 本の線が離れて交わるほど誤差が小さい）`;
}

/** A sunk or a stopped eye: the place itself, with no lines. */
function directLine(direct: DirectPoint, feet: { x: number; z: number } | null): string {
  const spot = place(direct.x, direct.z);
  const there = feet ? `あなたから ${compassWord(bearingBetween(feet, direct))} ${grouped(Math.hypot(direct.x - feet.x, direct.z - feet.z))}m。` : '';
  if (direct.kind === 'down') return `目玉が真下へ沈んだ ${spot}: 要塞はその真下かすぐ近く（地下）。${there}${FRAME_SEARCH}`;
  return `目玉が ${Math.round(direct.from.flew)}m で止まった: 要塞の入口は止まった先 ${spot}（12m 以内だと目玉は入口まで行って止まる。隔離ラボで 6/6）。`
    + `${there}${FRAME_SEARCH}`;
}

function fixLines(fix: Fix, feet: { x: number; z: number } | null): string[] {
  const ring = Math.round(Math.hypot(fix.x, fix.z));
  const there = feet ? `あなたから ${compassWord(bearingBetween(feet, fix))} ${grouped(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m。` : '';
  const far = fix.errorBlocks > 150 ? '誤差が大きい間は方角の目安。近づいてから投げ直す。' : '';
  const line = `交点 ${place(fix.x, fix.z)}（計算上の見積り ±${fix.errorBlocks}m・${fix.throws} 本が一致）。${there}${far}`
    + `原点から ${grouped(ring)}m（最初の 3 つの要塞は 1,280〜2,816m の輪）`;
  const near = feet ? nearThrowPlace(feet, fix, Math.max(60, fix.errorBlocks)) : null;
  return near ? [line, `近づいたら、交点の ${Math.max(60, fix.errorBlocks)}m 手前 ${place(near.x, near.z)} から投げ直すと誤差が小さくなる`] : [line];
}

/** The throws still worth reading at `now` (all of them when no time is given). */
const alive = (throws: readonly StoredThrow[], now: number | undefined): readonly StoredThrow[] =>
  now === undefined ? throws : throws.filter(item => now - item.at <= KEEP_MS);

/** The ledger of one task. `saved` is what the checkpoint held (`checkpoint()`), read with care: a malformed one is a fresh ledger. */
export function createEyeLedger(saved: unknown) {
  const raw = saved && typeof saved === 'object' ? (saved as { v?: unknown; throws?: unknown }) : null;
  let state: LedgerState = { v: 1, throws: raw?.v === 1 && Array.isArray(raw.throws)
    ? raw.throws.map(storedOf).filter((item): item is StoredThrow => item !== null).slice(-KEEP_THROWS) : [] };
  return {
    /** An act's result came back: its thrown eye (if it threw one in the overworld) goes in the ledger once. True when it was added. */
    note(id: string | undefined, resultJson: string | undefined, dimension: string | null, now: number): boolean {
      const flight = dimension === 'overworld' ? flightOf(resultJson) : null;
      if (!flight) return false;
      // The key is cut to what is stored, so the same result noted again (a long command id) is found.
      const key = `${id ?? 'none'}:${Math.round(flight.x)}:${Math.round(flight.z)}:${flight.bearingDeg}`.slice(0, 80);
      if (state.throws.some(item => item.id === key)) return false;
      const newest: StoredThrow = { ...flight, id: key, at: now };
      const kept = alive(state.throws, now).filter(item => Math.hypot(item.x - flight.x, item.z - flight.z) <= NEAR_BLOCKS);
      state = { v: 1, throws: [...kept, newest].slice(-KEEP_THROWS) };
      return true;
    },
    throws: (now?: number): readonly StoredThrow[] => alive(state.throws, now),
    fix: (now?: number): Fix | null => stronghold(alive(state.throws, now)),
    lines: (feet: { x: number; z: number } | null, now: number): string[] => ledgerLines(alive(state.throws, now), feet, now),
    /** The room was found or the End entered: the throws are of no more use. */
    clear(): void {
      state = { v: 1, throws: [] };
    },
    checkpoint: () => ({ minecraftEyes: { v: state.v, throws: state.throws.map(item => ({ ...item })) } }),
  };
}
export type EyeLedger = ReturnType<typeof createEyeLedger>;
