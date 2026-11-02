import { readActResult } from '../../contracts/minecraftActContract.js';
import {
  bearingBetween,
  compassWord,
  nearThrowPlace,
  nextThrowPlaces,
  stronghold,
  type EyeThrow,
  type Fix,
} from './minecraftEyeTriangulation.js';

/**
 * The ledger of the eyes of ender she has thrown in this task (the head's own record; the body reports each flight in its act result,
 * `EnderEyeFlight`, and keeps no list). It lives in the task's checkpoint, so a summary of the talk, a restart or a new step never
 * loses a throw. From the throws it computes the stronghold (`minecraftEyeTriangulation.ts`) and says it as facts, with how sure it is
 * and where to throw from next; it decides nothing.
 *
 * Only throws in the overworld count. A throw is kept for `KEEP_MS`, and the ledger holds the newest `KEEP_THROWS` of them near
 * the newest one (the stronghold of an earlier trek is not this one).
 */
export const KEEP_THROWS = 8;
const KEEP_MS = 45 * 60_000;
const NEAR_BLOCKS = 4_000;
/** Eyes that dropped can be picked up for this long. */
const DROP_MS = 5 * 60_000;

export interface StoredThrow extends EyeThrow {
  id: string;
  at: number;
  /** Where it came down (for picking it up). */
  toX: number;
  toZ: number;
}
interface LedgerState {
  v: 1;
  throws: StoredThrow[];
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function storedOf(raw: unknown): StoredThrow | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!item || typeof item.id !== 'string' || ![item.x, item.z, item.bearingDeg, item.flew, item.at, item.toX, item.toZ].every(finite)) return null;
  return { id: item.id.slice(0, 80), x: item.x as number, z: item.z as number, bearingDeg: item.bearingDeg as number, flew: item.flew as number,
    broke: item.broke === true, ...(item.down === true ? { down: true } : {}), at: item.at as number, toX: item.toX as number, toZ: item.toZ as number };
}

/** A flight from an act result (the receipt's JSON), or null when the act threw no eye. */
export function flightOf(resultJson: string | undefined): { x: number; z: number; bearingDeg: number; flew: number; broke: boolean; down: boolean;
  toX: number; toZ: number } | null {
  const eye = readActResult(resultJson)?.eye as (Record<string, unknown> & { from?: Record<string, unknown>; to?: Record<string, unknown> }) | undefined;
  const { from, to } = eye ?? {};
  if (!eye || !from || !to || ![from.x, from.z, to.x, to.z, eye.bearingDeg, eye.flew].every(finite)) return null;
  return { x: from.x as number, z: from.z as number, bearingDeg: eye.bearingDeg as number, flew: eye.flew as number, broke: eye.broke === true,
    down: eye.down === true, toX: to.x as number, toZ: to.z as number };
}

const place = (x: number, z: number): string => `(${Math.round(x)},${Math.round(z)})`;
const grouped = (value: number): string => Math.round(value).toLocaleString('en-US');

function throwWords(item: StoredThrow, now: number): string {
  const fate = item.down ? '（真下へ沈んだ）' : item.broke ? '（割れた）'
    : now - item.at < DROP_MS ? `（落ちた: ${place(item.toX, item.toZ)} で拾える）` : '（落ちた: 拾える期限が過ぎたかもしれない）';
  return `${place(item.x, item.z)} から 方位 ${item.bearingDeg}°（${compassWord(item.bearingDeg)}）に ${Math.round(item.flew)} 飛んだ${fate}`;
}

/** The lines the throws say: the count, the latest ones, the point they give (or why none) and where to throw from next. */
export function ledgerLines(throws: readonly StoredThrow[], feet: { x: number; z: number } | null, now: number): string[] {
  if (!throws.length) return [];
  const broke = throws.filter(item => item.broke).length;
  const head = `目玉の帳簿: 投げた ${throws.length} 個（割れた ${broke}）。新しい順: ${throws.slice(-3).reverse().map(item => throwWords(item, now)).join(' / ')}`;
  const fix = stronghold(throws);
  const last = throws[throws.length - 1]!;
  if (!fix) return [head, noFixLine(throws, last)];
  return [head, ...fixLines(fix, feet), ...downLine(throws)];
}

function noFixLine(throws: readonly StoredThrow[], last: StoredThrow): string {
  const why = throws.length < 2 ? '線が 1 本だけ' : '線が近すぎるか、誤差が大きい（交わる角度 8° 未満・誤差 300m 超）';
  const next = nextThrowPlaces(last, throws.length - 1).map(item => place(item.x, item.z)).join(' か ');
  return `交点はまだ無い（${why}）。次に投げる場所の案: 最後の線の横 ${nextThrowPlaces(last, throws.length - 1)[0]?.from ?? 100}m の ${next}（2 本の線が離れて交わるほど誤差が小さい）`;
}

function fixLines(fix: Fix, feet: { x: number; z: number } | null): string[] {
  const ring = Math.round(Math.hypot(fix.x, fix.z));
  const there = feet ? ` あなたから ${compassWord(bearingBetween(feet, fix))} ${grouped(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m。` : '';
  const line = `交点 ${place(fix.x, fix.z)}（計算上の見積り ±${fix.errorBlocks}m・${fix.throws} 本が一致）。${there}原点から ${grouped(ring)}m（最初の 3 つの要塞は 1,280〜2,816m の輪）`;
  const near = feet ? nearThrowPlace(feet, fix, Math.max(60, fix.errorBlocks)) : null;
  return near ? [line, `近づいたら、交点の ${Math.max(60, fix.errorBlocks)}m 手前 ${place(near.x, near.z)} から投げ直すと誤差が小さくなる`] : [line];
}

function downLine(throws: readonly StoredThrow[]): string[] {
  const sank = throws.filter(item => item.down).at(-1);
  return sank ? [`目玉が真下へ沈んだ ${place(sank.toX, sank.toZ)}: 部屋はその真下かすぐ近く（地下 y=10〜40 前後）`] : [];
}

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
      const key = `${id ?? 'none'}:${Math.round(flight.x)}:${Math.round(flight.z)}:${flight.bearingDeg}`;
      if (state.throws.some(item => item.id === key)) return false;
      const newest: StoredThrow = { ...flight, id: key.slice(0, 80), at: now, ...(flight.down ? { down: true } : {}) };
      const kept = state.throws.filter(item => now - item.at <= KEEP_MS && Math.hypot(item.x - flight.x, item.z - flight.z) <= NEAR_BLOCKS);
      state = { v: 1, throws: [...kept, newest].slice(-KEEP_THROWS) };
      return true;
    },
    throws: (): readonly StoredThrow[] => state.throws,
    fix: (): Fix | null => stronghold(state.throws),
    lines: (feet: { x: number; z: number } | null, now: number): string[] => ledgerLines(state.throws, feet, now),
    /** The room was found or the End entered: the throws are of no more use. */
    clear(): void {
      state = { v: 1, throws: [] };
    },
    checkpoint: () => ({ minecraftEyes: { v: state.v, throws: state.throws.map(item => ({ ...item })) } }),
  };
}
export type EyeLedger = ReturnType<typeof createEyeLedger>;
