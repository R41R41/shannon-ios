import { readActResult } from '../../contracts/minecraftActContract.js';
import { progressEvents } from './minecraftProgressEvents.js';
import { carried } from './minecraftConditions.js';

/**
 * The blaze camp said as causes and numbers (the arrival scenes of 11/3: with six blazes left every decision of the model stayed in cover and
 * fought on; a clean-up it was never told the reason for was chosen 0 of 4 times). A spawner holds back while six of its kind are around
 * it, so waiting there adds no kill; the lab saw the survivors gone, and the spawn back, after 150 s farther than 32 blocks away (0 to 3
 * left). The head keeps two things for the line: when the blazes came near, and the kills since (the body's `target_killed` and the rush's
 * confirmed death). Numbers and the cause only; it names no hand.
 */
export const SPAWN_HELD_AT = 6;
const LONG_WATCH_MS = 5 * 60_000;
const SHOW_AFTER_MS = 2 * 60_000;
const QUIET_MS = 3 * 60_000;
const NEAR_BLOCKS = 32;
const KEEP_KILLS = 40;
const RODS = 7;

interface WatchState { v: 1; since: number | null; lastNear: number; kills: Array<{ key: string; at: number }> }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The blazes in the frame's threat list within reach of the camp (the body lists what is near; the count box is a few blocks around the spawner). */
export function blazesNear(world: Record<string, unknown>): number {
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  return list.filter(item => {
    const entry = item && typeof item === 'object' ? item as { name?: unknown; distance?: unknown } : null;
    return entry?.name === 'blaze' && (!finite(entry.distance) || entry.distance <= NEAR_BLOCKS);
  }).length;
}

function storedOf(saved: unknown): WatchState {
  const raw = saved && typeof saved === 'object' ? saved as Partial<WatchState> : null;
  const kills = raw?.v === 1 && Array.isArray(raw.kills)
    ? raw.kills.filter(item => item && typeof item.key === 'string' && finite(item.at)).slice(-KEEP_KILLS) : [];
  return { v: 1, since: raw?.v === 1 && finite(raw.since) ? raw.since : null, lastNear: raw?.v === 1 && finite(raw.lastNear) ? raw.lastNear : 0, kills };
}

export function createBlazeWatch(saved: unknown) {
  let state = storedOf(saved);
  return {
    /** An act's result came back: its confirmed kills are counted once each (the receipt's id and the lines' order name them). */
    note(id: string | undefined, resultJson: string | undefined, now: number): void {
      const result = readActResult(resultJson);
      if (!result || state.since === null) return;
      const killed = progressEvents([], result.lines).filter(event => event === 'kill').length;
      for (let index = 0; index < killed; index += 1) {
        const key = `${id ?? 'none'}:${index}`.slice(0, 80);
        if (!state.kills.some(item => item.key === key)) state.kills = [...state.kills, { key, at: now }].slice(-KEEP_KILLS);
      }
    },
    /** The frame of a decision: the watch starts when blazes are near in the Nether and ends when none were for a while or she left. */
    line(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, now: number): string | null {
      const near = dimension === 'the_nether' ? blazesNear(world) : 0;
      if (near > 0) {
        if (state.since === null) state = { ...state, since: now, kills: [] };
        state.lastNear = now;
      } else if (state.since !== null && (dimension !== 'the_nether' || now - state.lastNear > QUIET_MS)) {
        state = { v: 1, since: null, lastNear: 0, kills: [] };
      }
      if (state.since === null || near === 0) return null;
      return watchLine(near, now - state.since, state.kills.length, carried(counts, 'blaze_rod'));
    },
    checkpoint: () => ({ minecraftBlazeWatch: { v: state.v, since: state.since, lastNear: state.lastNear, kills: state.kills.map(item => ({ ...item })) } }),
  };
}
export type BlazeWatch = ReturnType<typeof createBlazeWatch>;

/** The line from the numbers (pure). */
export function watchLine(near: number, elapsedMs: number, kills: number, rods: number): string | null {
  if (rods >= RODS) return null;
  const minutes = Math.floor(elapsedMs / 60_000), seconds = Math.floor(elapsedMs / 1000) % 60;
  const spent = elapsedMs >= SHOW_AFTER_MS ? `湧き場の近くで ${minutes} 分 ${seconds} 秒: 撃破 ${kills} 体・棒 ${rods}/${RODS}。` : '';
  if (near >= SPAWN_HELD_AT) {
    return `${spent}ブレイズ ${near} 体が残っている: スポナーは止まっている（周りに ${SPAWN_HELD_AT} 体いると新しく湧かない）。ここで待っても撃破は増えない。`
      + '32 マスより遠くで 150 秒待つと生き残りが消え、湧きが戻る（ラボ実測: 戻った時 0〜3 体）';
  }
  if (kills === 0 && elapsedMs >= LONG_WATCH_MS) return `${spent}いま周りに ${near} 体（${SPAWN_HELD_AT} 体いると新しく湧かない）`;
  return spent ? spent.slice(0, -1) : null;
}
