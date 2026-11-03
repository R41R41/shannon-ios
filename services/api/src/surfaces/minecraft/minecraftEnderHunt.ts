import { readActResult } from '../../contracts/minecraftActContract.js';
import { carried } from './minecraftConditions.js';
import { PEARL_TARGET } from './minecraftPearlFacts.js';

/**
 * The enderman hunt said as numbers (11/3, the pearl forest scenes: with 18 gold and two endermen in ten minutes the model fought on and never set
 * the wait against the other ways). The head keeps three things, from the frame and the fights it saw: when endermen came near, the pearls
 * carried then, and the deaths since. An enderman drops 0 or 1 pearl, 0.5 on average. The line is numbers and that average; it names no place and no hand.
 */
const PEARLS_PER_KILL = 0.5;
const NEAR_BLOCKS = 32;
const SHOW_AFTER_MS = 2 * 60_000;
const QUIET_MS = 3 * 60_000;
const KEEP_KILLS = 40;

interface HuntState { v: 1; since: number | null; lastNear: number; pearls0: number; kills: Array<{ key: string; at: number }> }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pearlsOf = (counts: ReadonlyMap<string, number>): number => carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');

/** The endermen in the frame within reach (both lists, an id counted once), nearest first. */
export function endermenNear(world: Record<string, unknown>): Array<{ id: unknown; distance: number }> {
  const seen = new Set<unknown>();
  const out: Array<{ id: unknown; distance: number }> = [];
  for (const list of [world.nearbyThreats, world.nearbyEntities]) {
    for (const item of Array.isArray(list) ? list : []) {
      const entry = item && typeof item === 'object' ? item as { id?: unknown; name?: unknown; distance?: unknown } : null;
      if (entry?.name !== 'enderman' || !finite(entry.distance) || entry.distance > NEAR_BLOCKS || (entry.id !== undefined && seen.has(entry.id))) continue;
      seen.add(entry.id);
      out.push({ id: entry.id, distance: entry.distance });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

function storedOf(saved: unknown): HuntState {
  const raw = saved && typeof saved === 'object' && (saved as { v?: unknown }).v === 1 ? saved as Partial<HuntState> : null;
  const kills = Array.isArray(raw?.kills) ? raw.kills.filter(item => item && typeof item.key === 'string' && finite(item.at)).slice(-KEEP_KILLS) : [];
  return { v: 1, since: finite(raw?.since) ? raw.since : null, lastNear: finite(raw?.lastNear) ? raw.lastNear : 0,
    pearls0: finite(raw?.pearls0) ? raw.pearls0 : 0, kills };
}

export function createEnderHunt(saved: unknown) {
  let state = storedOf(saved);
  return {
    /** An act's result came back: the deaths of endermen in it are counted once each. */
    note(id: string | undefined, resultJson: string | undefined, now: number): void {
      const result = readActResult(resultJson);
      if (!result || state.since === null) return;
      const killed = result.lines.filter(line => line.do === 'fight' && line.code === 'target_killed' && /enderman/u.test(line.line));
      killed.forEach((line, index) => {
        const key = `${id ?? 'none'}:${line.i ?? index}`.slice(0, 80);
        if (!state.kills.some(item => item.key === key)) state.kills = [...state.kills, { key, at: now }].slice(-KEEP_KILLS);
      });
    },
    /** The frame of a decision: the hunt starts when an enderman comes near in the Nether or the overworld, and ends when none was near for a while. */
    line(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, now: number): string | null {
      const near = dimension === 'the_nether' || dimension === 'overworld' ? endermenNear(world) : [];
      if (near.length > 0) {
        if (state.since === null) state = { ...state, since: now, pearls0: pearlsOf(counts), kills: [] };
        state.lastNear = now;
      } else if (state.since !== null && (!dimension || now - state.lastNear > QUIET_MS)) {
        state = { v: 1, since: null, lastNear: 0, pearls0: 0, kills: [] };
      }
      if (state.since === null || near.length === 0) return null;
      return huntLine({ near: near.length, nearest: near[0]!.distance, elapsedMs: now - state.since, kills: state.kills.length,
        gained: Math.max(0, pearlsOf(counts) - state.pearls0), have: pearlsOf(counts) });
    },
    checkpoint: () => ({ minecraftEnderHunt: { ...state, kills: state.kills.map(item => ({ ...item })) } }),
  };
}
export type EnderHunt = ReturnType<typeof createEnderHunt>;

export interface HuntNumbers { near: number; nearest: number; elapsedMs: number; kills: number; gained: number; have: number }

/** The line from the numbers (pure): null before two minutes, and once the pearls are enough. */
export function huntLine(n: HuntNumbers): string | null {
  if (n.have >= PEARL_TARGET || n.elapsedMs < SHOW_AFTER_MS) return null;
  const minutes = Math.max(1, Math.round(n.elapsedMs / 60_000));
  const missing = PEARL_TARGET - n.have;
  const base = `エンダーマン狩り ${minutes} 分: いま近くに ${n.near} 体（最寄り ${Math.round(n.nearest)}m）・撃破 ${n.kills} 体`
    + `・パール +${n.gained}（${n.have}/${PEARL_TARGET}）。`
    + `1 体の落とし物は平均 ${PEARLS_PER_KILL} 個（0〜1）`;
  if (n.kills === 0) return base;
  const perMinute = n.kills / (n.elapsedMs / 60_000) * PEARLS_PER_KILL;
  const rate = (n.kills / (n.elapsedMs / 60_000)).toFixed(1);
  return `${base}。この速さ（撃破 ${rate} 体/分）ならあと ${missing} 個に約 ${Math.ceil(missing / perMinute)} 分`;
}
