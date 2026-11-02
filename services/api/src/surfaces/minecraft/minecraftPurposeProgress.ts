import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, doneFacts, validCondition } from './minecraftConditions.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { materialsOf, smeltingInputOf } from './minecraftLlmcRecipes.js';
import { believableDeadline } from './minecraftLlmcStallsSaved.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';

/** How much of a recipe part she holds, counting the rawer form it is made from: planks from logs (4 each), sticks from planks (2 each),
 * a smelted item from its input. Ore dug for an ingot, logs cut for a table: the work toward the part, before the part exists. */
function heldAs(part: string, counts: ReadonlyMap<string, number>): number {
  const own = carried(counts, part);
  if (part === 'planks') return own + 4 * carried(counts, 'log');
  if (part === 'stick') return own + 2 * (carried(counts, 'planks') + 4 * carried(counts, 'log'));
  const raw = smeltingInputOf(part);
  return own + (raw ? carried(counts, raw) : 0);
}
/** What one target gives: the item itself, each material it is made of (bounded by the count it needs, so surplus earns nothing), and,
 * for an item that is only smelted, the input it is smelted from. The keys depend on the target alone, never on what is held. */
function targetEvidence(target: { item: string; count: number }, counts: ReadonlyMap<string, number>): Record<string, number> {
  const evidence: Record<string, number> = { [`have:${target.item}`]: Math.min(target.count, carried(counts, target.item)) };
  for (const part of materialsOf(target.item, target.count, { chain: true, pack: new Map() }).spends) {
    evidence[`material:${target.item}:${part.item}`] = Math.min(part.count, heldAs(part.item, counts));
  }
  const raw = smeltingInputOf(target.item);
  if (raw) evidence[`material:${target.item}:${raw}`] = Math.min(target.count, carried(counts, raw));
  return evidence;
}

/** Objective evidence, never total inventory or distance travelled. Unknown objectives earn no invented credit. */
export function purposeEvidence(node: PlanNode | undefined, frame: BodyObservation | null): Record<string, number> {
  const facts = doneFacts(frame), evidence: Record<string, number> = {};
  if (!node || !facts) return evidence;
  const clauses = parseDoneWhen(node.doneWhen)?.flat() ?? [];
  const targets = node.target ? [node.target] : clauses.flatMap(c => c.kind === 'have' ? [{ item: c.item, count: c.count }] : []);
  for (const target of targets) Object.assign(evidence, targetEvidence(target, facts.counts));
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
const SEARCH_KINDS = new Set(['wood', 'food', 'village', 'iron', 'diamond', 'water', 'lava', 'obsidian', 'fortress', 'stronghold', 'chest']);
export function explorationEvidence(node: PlanNode | undefined, input: ActInput | null, frame: BodyObservation | null): Record<string, number> {
  if (!node?.kind || !SEARCH_KINDS.has(node.kind) || !input?.hands.some(h => h.do === 'go' || h.do === 'walk' || h.do === 'vertical')) return {};
  const world = frame?.state.world as Record<string, unknown> | undefined, facts = doneFacts(frame);
  if (!facts?.feet || !facts.dimension || typeof world?.localMap !== 'string') return {};
  if ((node.kind === 'food' || node.kind === 'village') && !/^地図 v1[^\n]*方式=surface/u.test(world.localMap)) return {};
  const { x, y, z } = facts.feet;
  return { [`explore:${facts.dimension}:${Math.floor(x / 16)},${Math.floor(y / 8)},${Math.floor(z / 16)}`]: 1 };
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

/** The wait a step was in when its checkpoint was written, if the file still holds a believable one (a node and a deadline within two days). */
export function readActiveWait(saved: unknown): { node: string; until: number } | undefined {
  const wait = saved as { node?: unknown; until?: unknown } | null | undefined;
  if (!wait || typeof wait !== 'object' || typeof wait.node !== 'string' || wait.node.length > 64) return undefined;
  return believableDeadline(wait.until) ? { node: wait.node, until: wait.until } : undefined;
}

/** Persist the first deadline. Repeated stale estimates and a reconnect never renew it. A saved deadline is read only when it is believable. */
export function createWaitLedger(saved: unknown) {
  const deadlines: Record<string, number> = Object.create(null);
  if (saved && typeof saved === 'object') for (const [key, value] of Object.entries(saved).slice(0, 128)) {
    if (key.length <= 256 && believableDeadline(value)) deadlines[key] = value;
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
