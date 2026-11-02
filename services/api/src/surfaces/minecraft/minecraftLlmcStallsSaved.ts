import type { DeathCounter } from '../../contracts/continueContract.js';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import type { ProgressSnapshot, TaskStalls } from './minecraftLlmcStalls.js';

/**
 * The stalls of a task as a checkpoint holds them (`stallsCheckpoint`), read back after a worker restart. A checkpoint is a file: a part of it
 * that is not what the head wrote (a wrong type, an absurd size, a clock reading from the year 10^300) is left behind and counted afresh,
 * where trusting it would make every later look throw, or hold a wait for ever. The parts are read one by one: a damaged node entry must not
 * take the death counter with it, or a death while the worker was down would be taken for the first one seen.
 */
/** How many observation cells and how many destinations a node remembers (the oldest are forgotten first, each kind on its own), how many
 * keys its evidence may hold in all (those two and the objective's own), how long its lists are kept, and how many observed gains a
 * checkpoint keeps (the newest). */
export const EXPLORE_KEYS = 192;
export const TRAVEL_KEYS = 48;
export const PURPOSE_KEYS = 320;
export const LIST_KEPT = 64;
export const GAINS_KEPT = 256;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const posOf = (value: unknown): ActPos | null => {
  const at = value as Partial<ActPos> | null | undefined;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
};
/** A saved clock reading (a wait's deadline, a node's start) is believed only up to two days ahead of now: a larger one is a damaged file. */
export const believableDeadline = (value: unknown): value is number => finite(value) && value <= Date.now() + 48 * 3_600_000;

/** The newest `max` texts of a saved list, or null when it is not a list. A list the node grew past `max` is cut, not refused. */
const newest = (value: unknown, max: number): string[] | null => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length <= 512).slice(-max) : null;
const numbers = (value: unknown, max: number): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= max && entries.every(([key, count]) => key.length <= 256 && finite(count));
};
const optionally = (value: unknown, fits: (value: unknown) => boolean): boolean => value === undefined || fits(value);
const textOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length <= 512);
/** A progress snapshot as the head writes it into a checkpoint, or null when a field is not what the head writes. Lists are cut to the
 * newest `LIST_KEPT`; a wait deadline that is not believable is dropped (the node then has no wait to hold it open). */
function readSnapshot(value: unknown): ProgressSnapshot | null {
  const s = value as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !scalarsFit(s) || !mapsFit(s)) return null;
  const reached = s.reached === undefined ? undefined : newest(s.reached, LIST_KEPT);
  const externalWork = s.externalWork === undefined ? undefined : newest(s.externalWork, LIST_KEPT);
  if (reached === null || externalWork === null) return null;
  const { waitUntil, ...rest } = s;
  return { ...rest, ...(reached ? { reached } : {}), ...(externalWork ? { externalWork } : {}),
    ...(believableDeadline(waitUntil) ? { waitUntil } : {}) } as unknown as ProgressSnapshot;
}
/** The plain fields of a saved snapshot are what the head writes (a node id, a count, texts or nothing). */
const scalarsFit = (s: Record<string, unknown>): boolean => typeof s.node === 'string' && s.node.length <= 64 && finite(s.items)
  && textOrNull(s.state) && textOrNull(s.milestone);
/** Its maps (the pack, the evidence of the objective) are numbers under bounded keys, and not more of them than a node keeps. */
const mapsFit = (s: Record<string, unknown>): boolean => optionally(s.inventory, map => numbers(map, 512))
  && optionally(s.purpose, map => numbers(map, PURPOSE_KEYS));
/** A place a counter is kept at (`spot`, `explained`, `seen`): a position with the counter's own field, or null. */
function readPlace<T>(value: unknown, field: 'stops' | 'n' | 'code'): T | null {
  const place = value as ({ at?: unknown } & Record<string, unknown>) | null | undefined;
  if (!place || typeof place !== 'object') return null;
  const counter = place[field];
  const fits = field === 'code' ? typeof counter === 'string' && counter.length <= 128 : Number.isSafeInteger(counter);
  return fits && posOf(place.at) !== null ? place as T : null;
}
/** The node entry of a saved task, or null (the node's window then starts again) when it is not one. */
function readSavedNode(value: unknown): TaskStalls['node'] {
  const saved = value as { snapshot?: unknown; since?: unknown } | null | undefined;
  if (!saved || typeof saved !== 'object') return null;
  const snapshot = readSnapshot(saved.snapshot);
  return snapshot && believableDeadline(saved.since) ? { snapshot, since: saved.since } : null;
}
/** The death counter of a saved task, or null (the first death count seen is then the one counted from) when it is not one. */
function readSavedDeaths(value: unknown): DeathCounter | null {
  const counter = value as { deathEpoch?: unknown; deathSeq?: unknown } | null | undefined;
  const fits = !!counter && typeof counter.deathEpoch === 'string' && counter.deathEpoch.length <= 128
    && Number.isSafeInteger(counter.deathSeq) && (counter.deathSeq as number) >= 0;
  return fits ? { deathEpoch: counter.deathEpoch as string, deathSeq: counter.deathSeq as number } : null;
}
const savedFits = (v: { [key: string]: unknown } | null): v is { [key: string]: unknown } => !!v && typeof v === 'object'
  && v.version === 1 && typeof v.quiet === 'boolean' && Array.isArray(v.gains) && Number.isSafeInteger(v.waits) && Number.isSafeInteger(v.refusals);
/** The stalls of a task as a checkpoint holds them, or null (the task then starts counting afresh) when it is not a checkpoint of this version.
 * Inside one, each part that is not what the head wrote is counted afresh on its own. */
export function readSavedStalls(saved: unknown): TaskStalls | null {
  const v = saved as { [key: string]: unknown } | null;
  if (!savedFits(v)) return null;
  const gains = (v.gains as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256).slice(-GAINS_KEPT);
  return { quiet: v.quiet as boolean, node: readSavedNode(v.node), spot: readPlace(v.spot, 'stops'), explained: readPlace(v.explained, 'code'),
    seen: readPlace(v.seen, 'n'), waits: v.waits as number, gains: new Set<string>(gains), refusals: v.refusals as number,
    deaths: readSavedDeaths(v.deaths) };
}
