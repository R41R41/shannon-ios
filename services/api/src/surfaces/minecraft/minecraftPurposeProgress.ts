import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { acquired, carried, doneFacts, validCondition } from './minecraftConditions.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { materialsOf } from './minecraftLlmcRecipes.js';
import { BODY_SMELTING_INPUT } from './minecraftSmelting.generated.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { endViewOf } from './minecraftEndView.js';

/** Objective evidence, never total inventory or distance travelled. Unknown objectives earn no invented credit. */
export function purposeEvidence(node: PlanNode | undefined, frame: BodyObservation | null): Record<string, number> {
  const facts = doneFacts(frame), evidence: Record<string, number> = {};
  if (!node || !facts) return evidence;
  const clauses = parseDoneWhen(node.doneWhen)?.flat() ?? [];
  const targets = node.target ? [node.target] : clauses.flatMap(c => c.kind === 'have' ? [{ item: c.item, count: c.count }] : []);
  for (const target of targets) {
    evidence[`have:${target.item}`] = Math.min(target.count, acquired(facts.counts, target.item));
    const recipe = materialsOf(target.item, target.count, { chain: true, pack: new Map() });
    for (const part of recipe.spends) {
      const raw = BODY_SMELTING_INPUT[part.item];
      const amount = carried(facts.counts, part.item) + (raw ? carried(facts.counts, raw) : 0);
      evidence[`material:${target.item}:${part.item}`] = Math.min(part.count, amount);
    }
  }
  for (const c of clauses) {
    if (c.kind === 'food') evidence.food = Math.min(c.points, facts.food);
    if (c.kind === 'at' && facts.feet && c.dimension === facts.dimension) {
      const distance = Math.hypot(facts.feet.x - c.x, facts.feet.y - c.y, facts.feet.z - c.z);
      evidence[`approach:${c.x},${c.y},${c.z}@${c.dimension}`] = -Math.ceil(Math.max(0, distance - c.r) / 2);
    }
  }
  return evidence;
}

export interface ObservedWait { key: string; remainingMs: number }
/** Only the body-accepted, running movement can supply a travel goal. A queued intention is not progress. */
export function travelEvidence(input: ActInput | null, frame: BodyObservation | null): Record<string, number> {
  const facts = doneFacts(frame), values: Record<string, number> = {};
  if (!facts?.feet || !facts.dimension) return values;
  for (const hand of input?.hands ?? []) {
    const h = hand as unknown as { do: string; to?: { x: number; y: number; z: number }; path?: { x: number; y: number; z: number }[] };
    const to = h.do === 'go' ? h.to : h.do === 'walk' ? h.path?.at(-1) ?? h.to : null;
    if (!to || ![to.x, to.y, to.z].every(Number.isFinite)) continue;
    values[`travel:${facts.dimension}:${to.x},${to.y},${to.z}`] = -Math.ceil(Math.hypot(
      facts.feet.x - to.x, facts.feet.y - to.y, facts.feet.z - to.z) / 2);
  }
  return values;
}
const SEARCH_KINDS = new Set(['wood', 'food', 'village', 'iron', 'diamond', 'water', 'lava', 'obsidian', 'fortress', 'stronghold', 'chest', 'pearl', 'blaze']);
export function explorationEvidence(node: PlanNode | undefined, input: ActInput | null, frame: BodyObservation | null): Record<string, number> {
  if (!node?.kind || !SEARCH_KINDS.has(node.kind) || !input?.hands.some(h => h.do === 'go' || h.do === 'walk' || h.do === 'vertical')) return {};
  const world = frame?.state.world as Record<string, unknown> | undefined, facts = doneFacts(frame);
  if (!facts?.feet || !facts.dimension || typeof world?.localMap !== 'string') return {};
  if ((node.kind === 'food' || node.kind === 'village') && !/^地図 v1[^\n]*方式=surface/u.test(world.localMap)) return {};
  const { x, y, z } = facts.feet;
  return { [`explore:${facts.dimension}:${Math.floor(x / 16)},${Math.floor(y / 8)},${Math.floor(z / 16)}`]: 1 };
}
/**
 * The fight in the End as progress: the damage done to the dragon and the crystals destroyed (numbers that only go up). The body's own
 * count (`state.end.dragon.health`, `state.end.crystals.remaining`); nothing when it does not say, so a fight the body does not report earns no credit.
 */
export function endFightEvidence(frame: BodyObservation | null): Record<string, number> {
  const end = endViewOf(frame), health = end?.dragon?.health ?? null, left = end?.crystals.remaining ?? null;
  return { ...(health !== null ? { 'dragon:damage': Math.max(0, 200 - health) } : {}),
    ...(left !== null ? { 'crystals:down': Math.max(0, 10 - left) } : {}) };
}
/** A reason string cannot grant more waiting time. Only an explicit predicate and an observed clock/job can. */
function waitForDay(clauses: import('../../contracts/minecraftActCondition.js').ActClause[], world: Record<string, unknown>): ObservedWait | null {
  const day = clauses.some(c => c.k === 'time' && c.t === 'day');
  const tick = world.timeOfDay;
  if (day && world.dimension === 'overworld' && typeof tick === 'number' && Number.isFinite(tick)
    && !/thunder|雷/u.test(String(world.weather ?? ''))) {
    const time = tick % 24000;
    if (time >= 12542 && time < 23460) return { key: 'time:day', remainingMs: (23460 - time) * 50 + 15000 };
  }
  return null;
}
export function observedWait(done: unknown, frame: BodyObservation | null): ObservedWait | null {
  if (!validCondition(done) || done.length !== 1) return null;
  const world = frame?.state.world as Record<string, unknown> | undefined;
  if (!world) return null;
  const dayWait = waitForDay(done[0]!, world);
  if (dayWait) return dayWait;
  const furnace = done[0]!.find(c => c.k === 'furnace');
  if (!furnace || furnace.k !== 'furnace' || !Array.isArray(world.jobs)) return null;
  const job = world.jobs.find(j => j?.position?.x === furnace.x && j?.position?.y === furnace.y && j?.position?.z === furnace.z);
  if (job?.status !== 'waiting_external' || typeof job.remainingEstimateMs !== 'number'
    || !Number.isFinite(job.remainingEstimateMs) || job.remainingEstimateMs <= 0 || job.remainingEstimateMs > 640000) return null;
  return { key: JSON.stringify([world.dimension, furnace.x, furnace.y, furnace.z, job.id ?? job.startedAt ?? null, job.input, job.count]),
    remainingMs: job.remainingEstimateMs + 15000 };
}

/** Persist the first deadline. Repeated stale estimates and a reconnect never renew it. */
export function createWaitLedger(saved: unknown) {
  const deadlines: Record<string, number> = Object.create(null);
  if (saved && typeof saved === 'object') for (const [key, value] of Object.entries(saved)) {
    if (key.length <= 256 && typeof value === 'number' && Number.isFinite(value)) deadlines[key] = value;
  }
  return {
    observeDay(frame: BodyObservation | null): boolean {
      const world = frame?.state.world as Record<string, unknown> | undefined, tick = world?.timeOfDay;
      if (!frame?.connected || world?.dimension !== 'overworld' || typeof tick !== 'number' || !Number.isFinite(tick)) return false;
      const time = ((tick % 24000) + 24000) % 24000;
      if (time >= 12542 && time < 23460) return false;
      for (const key of Object.keys(deadlines)) if (key.endsWith(':time:day')) delete deadlines[key];
      return true;
    },
    until(purpose: string, wait: ObservedWait | null, activeMs: number): number | undefined {
      if (!wait) return undefined;
      const key = `${purpose}:${wait.key}`;
      if (!(key in deadlines)) {
        if (Object.keys(deadlines).length >= 128) return undefined;
        deadlines[key] = activeMs + wait.remainingMs;
      }
      return deadlines[key];
    },
    checkpoint: () => ({ minecraftWaitDeadlines: { ...deadlines } }),
  };
}
