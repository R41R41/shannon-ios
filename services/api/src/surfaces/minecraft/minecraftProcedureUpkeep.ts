import type { ProcedureMemory } from '@shannon/mind';
import { BED_ITEM } from './minecraftItems.js';
import { milestoneTargetSeconds } from './minecraftStage.js';
import { carried, inPack, nearestNeed, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { doing, type McDo } from './minecraftProcedureMoves.js';

/**
 * What the executor does before any procedure's own next move, and when it hands the turn back (session mb-arch). Upkeep: eat when
 * hungry, put on the armour carried, sleep in the bed she carries when night falls. The turn goes back to the planner for what the
 * rules do not settle: a new message, low health, enemies close, hunger with nothing to eat, the night on the surface with no bed, and a
 * step past its time budget (the route's leg or `MILESTONE_TARGET_SECONDS`, once a step), so the planner can choose what to cut.
 */
export const PROCEDURE_UPKEEP = Object.freeze({
  /** Eat at this food level or below (of 20). */
  eatAt: 14,
  /** Health at or below this hands the turn back. */
  lowHealth: 8,
  /** Enemies this close count. */
  closeThreat: 6,
  /** A step this many seconds past its budget is told once. */
  lateBy: 120,
});

/** Food to eat by preference: cooked and ready food first, raw meat that does no harm after; never what poisons. */
const FOOD_ORDER = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'cooked_rabbit', 'bread',
  'baked_potato', 'golden_carrot', 'apple', 'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon',
  'dried_kelp', 'potato'];
const BED_STEP = '食料と羊とベッド';
const SURFACE = new Set(['木', '木と石のツルハシ', '石の斧', '木材', BED_STEP]);
const ARMOR: ReadonlyArray<{ piece: string; destination: string }> = [
  { piece: 'chestplate', destination: 'torso' }, { piece: 'leggings', destination: 'legs' }, { piece: 'helmet', destination: 'head' },
  { piece: 'boots', destination: 'feet' },
];

function eat(facts: MinecraftProcedureFacts): McDo | null {
  if (facts.food === null || facts.food > PROCEDURE_UPKEEP.eatAt) return null;
  const food = FOOD_ORDER.find(name => (facts.pack.get(name) ?? 0) > 0);
  return food ? doing({ tool: 'mc.use-item', input: { itemName: food }, why: `空腹なので${food}を食べる`, expectMs: 3_000, key: `eat:${facts.food}:${food}` }) : null;
}

/** A piece of armour in the pack while none of its kind is worn: put on. */
function wear(facts: MinecraftProcedureFacts): McDo | null {
  for (const { piece, destination } of ARMOR) {
    const kind = new RegExp(`^(?:leather|golden|chainmail|iron|diamond|netherite)_${piece}$`, 'u');
    const worn = carried(facts, kind) - inPack(facts, kind);
    const item = worn > 0 ? null : [...facts.pack.keys()].find(name => kind.test(name));
    if (item) return doing({ tool: 'mc.equip-item', input: { itemName: item, destination }, why: `${item}を着る`, expectMs: 2_000, key: `wear:${item}` });
  }
  return null;
}

/** Night in the overworld with a bed carried and nothing hostile near: sleep, and take the bed up again. */
function sleep(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McDo | null {
  if (!facts.night || facts.dimension !== 'overworld' || !inPack(facts, BED_ITEM) || facts.threats.some(threat => threat.distance <= 12)) return null;
  // Once a run: a sleep that failed (an enemy near, no room for the bed) is the planner's, at the night's stop below.
  return memory.failed('sleep') ? null : doing({ tool: 'mc.sleep-in-bed', input: { isTakeBed: true }, why: '夜をベッドで飛ばす', expectMs: 12_000, key: 'sleep' });
}

/** The moment's upkeep, each kind left for the rest of the run once it failed (an upkeep never ends a run). */
export function minecraftUpkeep(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McDo | null {
  if (!facts.observation) return null;
  const fresh = (move: McDo | null) => move && !memory.failed(move.key) && !memory.lastFailure(move.key) ? move : null;
  return fresh(eat(facts)) ?? fresh(wear(facts)) ?? sleep(facts, memory);
}

/** Failures the planner must see at once: the body's night gate, a full pack, no tool or a broken one, a bed that explodes. */
const FINAL = new Set(['night_unprepared', 'inventory_full', 'missing_tool', 'tool_broke', 'tool_durability_low', 'bed_explodes', 'not_offered']);
export const finalFailure = (failure: string) => FINAL.has(failure);
/** The body's reflex cut in (a fight, a fall): the work is tried again once before it counts; a danger that stays is a stop. */
export const passingFailure = (failure: string) => failure === 'interrupted_by_reflex';

export interface StopParts {
  /** A message came into the task's inbox after the decision that started the run. */
  pending?(): boolean;
  /** When the task began (ms): a step's time budget counts from it. */
  taskStartedAt?: number;
  now(): number;
  /** The steps already told late in this task (once each). */
  toldLate: Set<string>;
  /** A step's time budget: the route's leg (mb-head's route plan) when it has one, else the owner's table. */
  targetSeconds?(milestone: string): number | undefined;
}

function danger(facts: MinecraftProcedureFacts): string | null {
  if (facts.health !== null && facts.health <= PROCEDURE_UPKEEP.lowHealth) return `体力が少ない（${facts.health}）`;
  const close = facts.threats.filter(threat => threat.distance <= PROCEDURE_UPKEEP.closeThreat && threat.canReachMe);
  const weak = facts.health !== null && facts.health <= 14;
  if (close.length >= 2 || (close.length === 1 && weak)) return `敵が近い（${close[0]!.name} ${Math.round(close[0]!.distance)}m、${close.length}体）`;
  return null;
}

function late(procedure: string, parts: StopParts): string | null {
  const target = parts.targetSeconds?.(procedure) ?? milestoneTargetSeconds(procedure);
  if (target === undefined || parts.taskStartedAt === undefined || parts.toldLate.has(procedure)) return null;
  const seconds = Math.round((parts.now() - parts.taskStartedAt) / 1000);
  if (seconds <= target + PROCEDURE_UPKEEP.lateBy) return null;
  parts.toldLate.add(procedure);
  return `「${procedure}」の目安${target}秒を${seconds - target}秒過ぎた（いま${seconds}秒）`;
}

/** The bed's procedure can still end the night itself: three wool of a colour carried, or a standing bed near. */
function bedAtHand(facts: MinecraftProcedureFacts): boolean {
  return [...facts.pack].some(([name, count]) => /_wool$/u.test(name) && count >= 3) || nearestNeed(facts, 'bed', 24) !== null;
}

/** The night on the surface with no bed: the planner's (a shelter), unless the bed's own procedure can make or take one now. */
function nightStop(facts: MinecraftProcedureFacts, procedure: string): string | null {
  if (!facts.night || facts.dimension !== 'overworld' || !SURFACE.has(procedure) || inPack(facts, BED_ITEM)) return null;
  return procedure === BED_STEP && bedAtHand(facts) ? null : '夜になった（ベッドを持っていない）';
}

/** Why the turn goes back to the planner before the next item, or null. */
export function minecraftStopWhy(facts: MinecraftProcedureFacts, procedure: string, parts: StopParts): string | null {
  if (parts.pending?.()) return '新しい伝言が届いた';
  // No frame for a while (`MinecraftControl.frame`): nothing here is known, so nothing is planned from it.
  if (!facts.observation) return '体の観測が届いていない';
  const near = danger(facts);
  if (near) return near;
  // The food's own procedure hunts: hunger is the planner's only elsewhere.
  if (facts.food !== null && facts.food <= 6 && !eat(facts) && procedure !== BED_STEP) return `空腹（${facts.food}）で食べ物を持っていない`;
  return nightStop(facts, procedure) ?? late(procedure, parts);
}
