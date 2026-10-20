import type { WorkingNeed } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { minecraftCalm, minecraftFrameNeeds } from './minecraftWorkingArbiter.js';

/**
 * The small work of the moment, decided by rules from the latest frame (session mb-arch, owner 2026-10-20: "while the furnace runs, dig
 * the iron and coal around, use two furnaces, one for iron and one for meat"). Two kinds:
 *
 * - `nextFiller`: while she only waits (a furnace, a timer), what to do in the time left: take out a furnace that is done, take a
 *   standing bed, start a second furnace for raw meat, dig an ore that is still needed, hunt a food animal. Each is short and fits the
 *   time left with room to spare.
 * - `afterCallWork`: when a call she asked for has ended, one short detour for a thing worth it right there (a standing bed, coal or
 *   iron within a few steps while still needed, a food animal while food is short).
 *
 * The planner is shown what was done, not asked: run 19 showed she does what a hint says, so a rule here does the obvious small thing
 * itself, once, and the planner's turn stays for the plan.
 */
export interface MinecraftWorkItem {
  tool: string;
  input: Record<string, unknown>;
  /** Fixed words: why it is done now. */
  why: string;
  /** About how long it takes, for fitting it in a wait. */
  expectMs: number;
  /** The same work by this key is not done twice in a row (the executor remembers it for a while). */
  key: string;
  /** The next step of a chain (a furnace placed, then filled), from this one's result text; null ends it. */
  then?: (result: string) => MinecraftWorkItem | null;
  /** How many items the whole chain from here takes (1 when absent): a chain is started only when it fits. */
  chain?: number;
  /**
   * A walk that may take more than one call (mb-r20): when it ran out of time and the body says it was getting nearer ("同じ目標で再実行すれば
   * 続きから進めます"), the procedure does not count it as a failure and makes it again (the chain after it waits for the arrival).
   */
  resumable?: boolean;
  /** Called when the item failed for good (not a walk that was getting nearer): the procedure's own memory of what cannot be reached. */
  onFail?(failure: string, text: string): void;
  /**
   * A failure that is the item's success in the body's own words (mb-r21): a furnace taken from before its batch was done answers
   * `waiting_external` with "完成済みの…を回収しました", having given what was ready. True: the item is counted as done.
   */
  accepts?(failure: string, text: string): boolean;
}

const RAW_FOOD = ['porkchop', 'beef', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
const IRON_INPUT = /raw_iron|iron_ore/u;
/**
 * rel23: a second furnace is set within 8 m of the first. The body picks the spot within ~4.5 m of where it stands, so standing further
 * than this (3 m) from the first furnace, she walks to it before placing the second (3 m + 4.5 m reach < 8 m).
 */
export const FURNACE_WALK_FROM = 3;

/** `count`: the batch's size when the body says it (`world.jobs[].count`), else null. */
interface Job { position: { x: number; y: number; z: number }; remainingEstimateMs: number; input: string; count: number | null }

const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function worldOf(observation: BodyObservation | null): Record<string, unknown> {
  return record(observation ? (observation.state as { world?: unknown }).world : null) ?? {};
}

/** What she carries, by item name. */
export function carriedOf(observation: BodyObservation | null): Map<string, number> {
  const out = new Map<string, number>();
  const items = worldOf(observation).inventory;
  for (const item of Array.isArray(items) ? items : []) {
    const entry = record(item);
    if (entry && typeof entry.name === 'string' && typeof entry.count === 'number') out.set(entry.name, (out.get(entry.name) ?? 0) + entry.count);
  }
  return out;
}

/** The furnaces at work (`world.jobs`): where, how long still, what. */
export function jobsOf(observation: BodyObservation | null): Job[] {
  const jobs = worldOf(observation).jobs;
  return (Array.isArray(jobs) ? jobs : []).flatMap(item => {
    const job = record(item), position = record(job?.position);
    if (!job || !position || typeof job.remainingEstimateMs !== 'number') return [];
    if (![position.x, position.y, position.z].every(value => typeof value === 'number')) return [];
    return [{ position: { x: position.x as number, y: position.y as number, z: position.z as number }, remainingEstimateMs: job.remainingEstimateMs,
      input: String(job.input ?? ''), count: typeof job.count === 'number' && Number.isFinite(job.count) && job.count >= 0 ? job.count : null }];
  });
}

function distanceTo(observation: BodyObservation | null, cell: { x: number; y: number; z: number }): number {
  const at = record(worldOf(observation).position);
  if (!at || typeof at.x !== 'number' || typeof at.y !== 'number' || typeof at.z !== 'number') return Infinity;
  return Math.hypot(cell.x - at.x, cell.y - at.y, cell.z - at.z);
}

const cellKey = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;

/** A furnace that is done (or nearly) within reach: take out what it made. */
function furnaceDone(observation: BodyObservation | null, except: string | null): MinecraftWorkItem | null {
  const job = jobsOf(observation).find(item => item.remainingEstimateMs <= 2_000 && cellKey(item.position) !== except
    && distanceTo(observation, item.position) <= 24);
  return job ? { tool: 'mc.withdraw-from-furnace', input: { ...job.position }, why: 'かまどの仕事が終わった', expectMs: 6_000,
    key: `withdraw@${cellKey(job.position)}` } : null;
}

/** The fuel to burn: coal or charcoal, else planks or logs. */
function fuelOf(carried: Map<string, number>): string | null {
  for (const name of ['coal', 'charcoal']) if ((carried.get(name) ?? 0) > 0) return name;
  return [...carried.keys()].find(name => (carried.get(name) ?? 0) >= 2 && /_(planks|log)$/u.test(name)) ?? null;
}

/**
 * A second furnace for raw meat while the first smelts iron (the owner's two furnaces): three or more raw pieces carried, no furnace
 * on food yet, fuel, and a furnace carried or eight cobblestone to make one. A chain: make it, place it (the body picks the spot),
 * fill it at the spot the body names.
 */
function secondFurnace(observation: BodyObservation | null, carried: Map<string, number>): MinecraftWorkItem | null {
  const jobs = jobsOf(observation);
  if (!jobs.some(job => IRON_INPUT.test(job.input) && job.remainingEstimateMs >= 20_000)) return null;
  if (jobs.some(job => RAW_FOOD.includes(job.input))) return null;
  const raw = RAW_FOOD.find(name => (carried.get(name) ?? 0) >= 3);
  const fuel = fuelOf(carried);
  if (!raw || !fuel) return null;
  const fill = (result: string): MinecraftWorkItem | null => {
    const at = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)に設置/u.exec(result);
    return at ? { tool: 'mc.start-smelting', input: { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]), inputItem: raw, fuelItem: fuel,
      count: carried.get(raw) }, why: '2 つ目のかまどで肉を焼く', expectMs: 3_000, key: 'second-furnace:fill' } : null;
  };
  const place: MinecraftWorkItem = { tool: 'mc.place-block-at', input: { blockName: 'furnace' }, why: '2 つ目のかまどを置く', expectMs: 3_000,
    key: 'second-furnace:place', then: fill, chain: 2 };
  // rel23: the second furnace stands within 8 m of the first (`FURNACE_WALK_FROM`).
  const first = jobs.find(job => IRON_INPUT.test(job.input) && job.remainingEstimateMs >= 20_000);
  const walk: MinecraftWorkItem | null = first && distanceTo(observation, first.position) > FURNACE_WALK_FROM
    ? { tool: 'mc.move-to', input: { ...first.position, range: 3 }, why: '先のかまどの近くへ寄る', expectMs: 10_000, key: 'second-furnace:walk',
      then: () => place, chain: 3 }
    : null;
  if ((carried.get('furnace') ?? 0) > 0) return walk ?? place;
  if ((carried.get('cobblestone') ?? 0) + (carried.get('cobbled_deepslate') ?? 0) < 8) return null;
  return { tool: 'mc.craft-one', input: { itemName: 'furnace' }, why: '2 つ目のかまどを作る', expectMs: 3_000, key: 'second-furnace:craft',
    then: () => walk ?? place, chain: walk ? 4 : 3 };
}

/** How to take one need, as one item (a bed: walk to it, then dig it, keeping it). */
export function takeNeed(need: WorkingNeed): MinecraftWorkItem | null {
  const key = `${need.need}@${need.id}`;
  const d = need.data;
  switch (need.need) {
    case 'bed': {
      if (typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number') return null;
      const dig: MinecraftWorkItem = { tool: 'mc.dig-block-at', input: { x: d.x, y: d.y, z: d.z, takeEquipment: true }, why: '置かれたベッドを持つ',
        expectMs: 4_000, key: `${key}:dig` };
      return { tool: 'mc.move-to', input: { x: d.x, y: d.y, z: d.z, goalType: 'block' }, why: '置かれたベッドへ寄る', expectMs: 20_000, key,
        then: () => dig, chain: 2 };
    }
    case 'iron': return { tool: 'mc.mine-block', input: { blockName: need.name, count: 3, searchRadius: 16 }, why: 'まだ要る鉄が近い', expectMs: 20_000, key };
    case 'fuel': return { tool: 'mc.mine-block', input: { blockName: need.name, count: 3, searchRadius: 16 }, why: '燃料の石炭が近い', expectMs: 15_000, key };
    case 'wood': return { tool: 'mc.mine-block', input: { blockName: need.name, count: 3, searchRadius: 16 }, why: '木材が足りない', expectMs: 15_000, key };
    case 'food': return { tool: 'mc.attack-continuously', input: { entityName: need.name, maxKills: 1 }, why: '食べ物が足りない', expectMs: 12_000, key };
    case 'bed_wool': {
      const color = typeof d.color === 'string' ? { color: d.color } : {};
      return { tool: 'mc.attack-continuously', input: { entityName: 'sheep', maxKills: 1, ...color }, why: 'ベッドの羊毛', expectMs: 12_000, key };
    }
    default: return null;
  }
}

/** The order needs are taken in a wait, and how near each must be. */
const IN_A_WAIT: ReadonlyArray<{ need: string; within: number }> = [
  { need: 'bed', within: 24 }, { need: 'iron', within: 16 }, { need: 'fuel', within: 16 }, { need: 'food', within: 12 }, { need: 'bed_wool', within: 16 },
];

/**
 * What to do in the `remainingMs` a wait still has, or null: something that fits with five seconds to spare and was not done just now
 * (`recent` keys). The furnace being waited for (`waitingCell`) is left to the wait itself.
 */
export function nextFiller(observation: BodyObservation | null,
  parts: { remainingMs: number; recent: ReadonlySet<string>; waitingCell: string | null }): MinecraftWorkItem | null {
  const fits = (item: MinecraftWorkItem | null) => item && item.expectMs + 5_000 <= parts.remainingMs && !parts.recent.has(item.key) ? item : null;
  const done = fits(furnaceDone(observation, parts.waitingCell));
  if (done) return done;
  // Away from the furnace only by day and with nothing hostile near (a wait at night is often a shelter's).
  if (!minecraftCalm(observation)) return null;
  const needs = minecraftFrameNeeds(observation).filter(need => need.canReach);
  const bed = IN_A_WAIT.slice(0, 1).flatMap(rule => needs.filter(need => need.need === rule.need && (need.distance ?? Infinity) <= rule.within));
  const bedItem = bed.length ? fits(takeNeed(bed[0]!)) : null;
  if (bedItem) return bedItem;
  const furnace = fits(secondFurnace(observation, carriedOf(observation)));
  if (furnace) return furnace;
  for (const rule of IN_A_WAIT.slice(1)) {
    const need = needs.find(item => item.need === rule.need && (item.distance ?? Infinity) <= rule.within);
    const item = need ? fits(takeNeed(need)) : null;
    if (item) return item;
  }
  return null;
}

/** Calls after which she stays where she is: a shelter, sleep, a way out of water or danger, a bed just dug. */
const AFTER_NONE: ReadonlySet<string> = new Set(['mc.dig-shelter', 'mc.sleep-in-bed', 'mc.build-around-self', 'mc.leave-water', 'mc.tower-up',
  'mc.flee-from', 'mc.dig-block-at']);

/** Whether a wait's small work would take this need (its kind, near enough): the arbiter leaves such a need to it. */
export function fillable(need: WorkingNeed): boolean {
  return IN_A_WAIT.some(rule => rule.need === need.need && (need.distance ?? Infinity) <= rule.within) && need.canReach;
}

/** After a call she asked for: these are worth one detour right there, each within its distance. */
const AFTER_A_CALL: ReadonlyArray<{ need: string; within: number; ask?: boolean }> = [
  { need: 'bed', within: 24 }, { need: 'fuel', within: 8 }, { need: 'iron', within: 8 }, { need: 'bed_wool', within: 12 },
  { need: 'food', within: 8, ask: true },
];

/**
 * One short detour after a call, or null. Not after a failed call (the planner sees the failure first), nor for what the call itself
 * was doing (an ore she was digging), nor what was done just now. `ask`: worth asking Jev (a food animal is not always worth it).
 */
export function afterCallWork(observation: BodyObservation | null,
  parts: { call: { name: string; input: unknown }; ok: boolean; recent: ReadonlySet<string> }): { item: MinecraftWorkItem; ask: boolean } | null {
  if (!parts.ok || AFTER_NONE.has(parts.call.name) || !minecraftCalm(observation)) return null;
  const doing = record(parts.call.input)?.blockName ?? record(parts.call.input)?.entityName;
  const needs = minecraftFrameNeeds(observation).filter(need => need.canReach);
  for (const rule of AFTER_A_CALL) {
    const need = needs.find(item => item.need === rule.need && (item.distance ?? Infinity) <= rule.within && item.name !== doing);
    const item = need ? takeNeed(need) : null;
    if (item && !parts.recent.has(item.key)) return { item, ask: rule.ask === true };
  }
  return null;
}
