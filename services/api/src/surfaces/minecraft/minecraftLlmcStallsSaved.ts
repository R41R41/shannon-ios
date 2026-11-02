import type { DeathCounter } from '../../contracts/continueContract.js';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import type { ProgressSnapshot, TaskStalls } from './minecraftLlmcStalls.js';

/**
 * The stalls of a task as a checkpoint holds them (`stallsCheckpoint`), read back after a worker restart. A checkpoint is a file: what is
 * not what the head wrote (a wrong type, an absurd size, a clock reading from the year 10^300) is left behind and the task counts afresh,
 * where trusting it would make every later look throw, or hold a wait for ever.
 */
/** How much evidence of the objective a node keeps, and how many observed gains a checkpoint keeps (the newest). */
export const PURPOSE_KEYS = 256;
export const GAINS_KEPT = 256;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const posOf = (value: unknown): ActPos | null => {
  const at = value as Partial<ActPos> | null | undefined;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
};
/** A saved clock reading (a wait's deadline) is believed only up to two days ahead of now: a larger one is a damaged file, not a wait. */
export const believableDeadline = (value: unknown): value is number => finite(value) && value <= Date.now() + 48 * 3_600_000;

const strings = (value: unknown, max: number): boolean => Array.isArray(value) && value.length <= max
  && value.every(item => typeof item === 'string' && item.length <= 512);
const numbers = (value: unknown, max: number): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= max && entries.every(([key, count]) => key.length <= 256 && finite(count));
};
const optionally = (value: unknown, fits: (value: unknown) => boolean): boolean => value === undefined || fits(value);
const textOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length <= 512);
/** A progress snapshot as the head writes it into a checkpoint, or null when a field is not what the head writes. */
function readSnapshot(value: unknown): ProgressSnapshot | null {
  const s = value as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.node !== 'string' || s.node.length > 64 || !finite(s.items)) return null;
  const lists = optionally(s.reached, list => strings(list, 64)) && optionally(s.externalWork, list => strings(list, 64));
  const maps = optionally(s.inventory, map => numbers(map, 512)) && optionally(s.purpose, map => numbers(map, PURPOSE_KEYS));
  return textOrNull(s.state) && textOrNull(s.milestone) && lists && maps && optionally(s.waitUntil, believableDeadline)
    ? s as unknown as ProgressSnapshot : null;
}
/** A place a counter is kept at (`spot`, `explained`, `seen`): absent, or a position with the counter's own field. */
function placeFits(value: unknown, field: 'stops' | 'n' | 'code'): boolean {
  if (value === null || value === undefined) return true;
  const place = value as { at?: unknown } & Record<string, unknown>;
  const counter = place[field];
  const fieldFits = field === 'code' ? typeof counter === 'string' && counter.length <= 128 : Number.isSafeInteger(counter);
  return typeof value === 'object' && posOf(place.at) !== null && fieldFits;
}
/** The node entry of a saved task: `null` when it had none, `undefined` when what is saved is not a node entry. */
function readSavedNode(value: unknown): TaskStalls['node'] | undefined {
  if (value === null || value === undefined) return null;
  const saved = value as { snapshot?: unknown; since?: unknown };
  const snapshot = readSnapshot(saved.snapshot);
  return snapshot && finite(saved.since) ? { snapshot, since: saved.since } : undefined;
}
/** The death counter of a saved task: `null` when it had seen none, `undefined` when what is saved is not a counter. */
function readSavedDeaths(value: unknown): DeathCounter | null | undefined {
  if (value === null || value === undefined) return null;
  const counter = value as { deathEpoch?: unknown; deathSeq?: unknown };
  return typeof counter.deathEpoch === 'string' && finite(counter.deathSeq) ? { deathEpoch: counter.deathEpoch, deathSeq: counter.deathSeq } : undefined;
}
const savedFits = (v: { [key: string]: unknown } | null): v is { [key: string]: unknown } => !!v && typeof v === 'object'
  && v.version === 1 && typeof v.quiet === 'boolean' && Array.isArray(v.gains) && Number.isSafeInteger(v.waits) && Number.isSafeInteger(v.refusals)
  && placeFits(v.spot, 'stops') && placeFits(v.explained, 'code') && placeFits(v.seen, 'n');
/** The stalls of a task as a checkpoint holds them, or null (the task then starts counting afresh) when anything is not what the head wrote. */
export function readSavedStalls(saved: unknown): TaskStalls | null {
  const v = saved as { [key: string]: unknown } | null;
  const node = readSavedNode(v?.node), deaths = readSavedDeaths(v?.deaths);
  if (!savedFits(v) || node === undefined || deaths === undefined) return null;
  const gains = (v.gains as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256).slice(-GAINS_KEPT);
  return { quiet: v.quiet as boolean, node, spot: (v.spot ?? null) as TaskStalls['spot'], explained: (v.explained ?? null) as TaskStalls['explained'],
    seen: (v.seen ?? null) as TaskStalls['seen'], waits: v.waits as number, gains: new Set<string>(gains), refusals: v.refusals as number, deaths };
}
