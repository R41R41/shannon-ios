import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { lifeViewOf } from './minecraftMadeIn.js';
import { readinessOf, feetIn } from './minecraftLlmcReadiness.js';

type Point = { x: number; y: number; z: number };
interface Journey { bodyId: string; life: number; dimension: string; at: number; open: Point | null; points: Point[] }
const point = (v: unknown): Point | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Point;
  return [p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n))
    ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
};
const at = (p: Point) => `(${p.x},${p.y},${p.z})`;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function journeyFrame(observation: BodyObservation | null) {
  const facts = readinessOf(observation), life = lifeViewOf(observation), feet = facts ? feetIn(facts.world) : null;
  if (!observation?.connected || !life || !feet || !facts) return null;
  const time = Date.parse(observation.stateAt);
  return Number.isFinite(time) ? { facts, life, feet, time, bodyId: observation.bodyId } : null;
}

function journeyNotes(state: Journey, feet: Point, facts: { dimension: string | null; food: number }): string[] {
  const open = state.open;
  if (facts.dimension !== 'overworld' || facts.food >= 40 || !open || open.y - feet.y < 4) return [];
  const horizontal = Math.round(Math.hypot(open.x - feet.x, open.z - feet.z));
  const higher = state.points.filter(p => p.y >= feet.y + 2 && distance(p, feet) >= 2)
    .sort((a, b) => distance(a, feet) - distance(b, feet)).slice(0, 2);
  return [
    `帰還の観測記録: 地図がsurfaceだった地点 ${at(open)}（今より上${open.y - feet.y}、水平${horizontal}m）。現在の地上・水面・帰路の安全は未確認`,
    ...(higher.length ? [`以前に通過した高い位置（近い順）: ${higher.map(at).join(' → ')}。間の道と逆向きの通行可否は未確認`] : []),
  ];
}

/** Observed waypoints, never a claim that the reverse route is safe or connected. Task-checkpoint owned. */
export function createMinecraftJourney(saved: unknown) {
  let state: Journey | null = null;
  if (saved && typeof saved === 'object') {
    const v = saved as Journey;
    if (typeof v.bodyId === 'string' && Number.isSafeInteger(v.life)
      && typeof v.dimension === 'string' && Number.isFinite(v.at)
      && Array.isArray(v.points) && v.points.length <= 12 && v.points.every(p => point(p))) {
      state = { bodyId: v.bodyId, life: v.life, dimension: v.dimension, at: v.at, open: point(v.open), points: v.points.map(p => point(p)!) };
    }
  }
  return {
    read(observation: BodyObservation | null): string[] {
      const frame = journeyFrame(observation);
      if (!frame) return [];
      const { facts, life, feet, time, bodyId } = frame;
      if (!state || state.bodyId !== bodyId || state.life !== life.life || state.dimension !== life.dimension) {
        state = { bodyId, life: life.life, dimension: life.dimension, at: time, open: null, points: [] };
      }
      if (time < state.at) return []; // a stale observation must not move the trail backwards
      state.at = time;
      const last = state.points.at(-1);
      if (!last || distance(last, feet) >= 8 || Math.abs(last.y - feet.y) >= 4) {
        state.points = [...state.points, point(feet)!].slice(-12);
      }
      if (typeof facts.world.localMap === 'string' && /^地図 v1[^\n]*方式=surface/u.test(facts.world.localMap)) state.open = point(feet);
      return journeyNotes(state, feet, facts);
    },
    checkpoint: () => ({ minecraftJourney: state ? JSON.parse(JSON.stringify(state)) as Journey : null }),
  };
}
