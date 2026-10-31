import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { lifeViewOf } from './minecraftMadeIn.js';
import { readinessOf, feetIn, foodLeads } from './minecraftLlmcReadiness.js';

type Point = { x: number; y: number; z: number };
interface Survey { cell: string; point: Point; at: number; lead: string }
interface Journey { bodyId: string; life: number; dimension: string; at: number; open: Point | null; points: Point[]; surveys: Survey[]; maxFood: number }
const point = (v: unknown): Point | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Point;
  return [p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n))
    ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
};
const at = (p: Point) => `(${p.x},${p.y},${p.z})`;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cell = (p: Point) => `${Math.floor(p.x / 24)}:${Math.floor(p.z / 24)}`;
const surface = (world: Record<string, unknown>) => typeof world.localMap === 'string' && /^地図 v1[^\n]*方式=surface/u.test(world.localMap);

function surveyNotes(state: Journey, feet: Point): string[] {
  const old = state.surveys.filter(s => s.cell !== cell(feet)).sort((a, b) => distance(a.point, feet) - distance(b.point, feet)).slice(0, 3);
  return old.length ? ['食料探索の過去観測（当時の範囲だけ。動物の現在地・未走査の範囲は未確認）:',
    ...old.map(s => `${at(s.point)}・${Math.max(0, Math.round((state.at - s.at) / 1000))}秒前: ${s.lead}`)] : [];
}

function recordSurvey(state: Journey, feet: Point, world: Record<string, unknown>) {
  if (!surface(world) || !Array.isArray(world.nearbyEntities)) return;
  const here = cell(feet);
  state.surveys = [...state.surveys.filter(s => s.cell !== here),
    { cell: here, point: point(feet)!, at: state.at, lead: foodLeads(world, 'overworld').slice(0, 220) }].slice(-12);
}

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
    ...(state.maxFood < 40 ? [`下降前の食料確保は、この記録の範囲では未確認: 携帯食料40点以上を未観測（観測最大${state.maxFood}点・現在${facts.food}点）。計画の省略記録と、食料を確保した観測は別`] : []),
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
      const surveys = Array.isArray(v.surveys) ? v.surveys.filter(s => s && typeof s.cell === 'string' && point(s.point)
        && Number.isFinite(s.at) && typeof s.lead === 'string' && s.lead.length <= 220).slice(-12) : [];
      const maxFood = Number.isFinite(v.maxFood) && v.maxFood >= 0 ? v.maxFood : 0;
      state = { bodyId: v.bodyId, life: v.life, dimension: v.dimension, at: v.at, open: point(v.open), points: v.points.map(p => point(p)!), surveys, maxFood };
    }
  }
  return {
    read(observation: BodyObservation | null): string[] {
      const frame = journeyFrame(observation);
      if (!frame) return [];
      const { facts, life, feet, time, bodyId } = frame;
      if (!state || state.bodyId !== bodyId || state.life !== life.life || state.dimension !== life.dimension) {
        state = { bodyId, life: life.life, dimension: life.dimension, at: time, open: null, points: [], surveys: [], maxFood: 0 };
      }
      if (time < state.at) return []; // a stale observation must not move the trail backwards
      state.at = time;
      state.maxFood = Math.max(state.maxFood, facts.food);
      const last = state.points.at(-1);
      if (!last || distance(last, feet) >= 8 || Math.abs(last.y - feet.y) >= 4) {
        state.points = [...state.points, point(feet)!].slice(-12);
      }
      if (surface(facts.world)) state.open = point(feet);
      if (facts.dimension === 'overworld') recordSurvey(state, feet, facts.world);
      return [...journeyNotes(state, feet, facts), ...(facts.dimension === 'overworld' && facts.food < 40 ? surveyNotes(state, feet) : [])];
    },
    checkpoint: () => ({ minecraftJourney: state ? JSON.parse(JSON.stringify(state)) as Journey : null }),
  };
}
