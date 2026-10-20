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
export const FOOD_ORDER = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'cooked_rabbit', 'bread',
  'baked_potato', 'golden_carrot', 'apple', 'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon',
  'dried_kelp', 'potato'];
const BED_STEP = '食料と羊とベッド';
const SURFACE = new Set(['木', '木と石のツルハシ', '石の斧', '木材', BED_STEP]);
const ARMOR: ReadonlyArray<{ piece: string; destination: string }> = [
  { piece: 'chestplate', destination: 'torso' }, { piece: 'leggings', destination: 'legs' }, { piece: 'helmet', destination: 'head' },
  { piece: 'boots', destination: 'feet' },
];

/**
 * A meal when hungry: the first food of the order that she carries and that did not fail for this hunger already (run 20: a raw beef
 * the body would not let her eat at 12 of 20 held the next meal back, twice; the next food is tried, and none failing ends nothing).
 */
function eat(facts: MinecraftProcedureFacts, memory?: ProcedureMemory): McDo | null {
  if (facts.food === null || facts.food > PROCEDURE_UPKEEP.eatAt) return null;
  const food = FOOD_ORDER.find(name => (facts.pack.get(name) ?? 0) > 0 && !(memory && (memory.failed(`eat:${facts.food}:${name}`) > 0
    || memory.lastFailure(`eat:${facts.food}:${name}`))));
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

/**
 * Night in the overworld with a bed carried and nothing hostile near: sleep, and leave the bed where it stands (mb-r20). Run 20 took the
 * bed up again after the night, died an hour of play later 400 m from where she slept, and came back at the world's first spawn with the
 * bed in the drops of her death. A bed left standing is where she wakes after a death; at most one night falls inside the half hour that
 * is asked for, so there is no later night to carry it to.
 */
function sleep(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McDo | null {
  if (!facts.night || facts.dimension !== 'overworld' || !inPack(facts, BED_ITEM) || facts.threats.some(threat => threat.distance <= 12)) return null;
  // Once a run: a sleep that failed (an enemy near, no room for the bed) is the planner's, at the night's stop below.
  return memory.failed('sleep') ? null
    : doing({ tool: 'mc.sleep-in-bed', input: { isTakeBed: false }, why: '夜をベッドで飛ばす（ベッドは置いたまま）', expectMs: 12_000, key: 'sleep' });
}

/** The moment's upkeep, each kind left for the rest of the run once it failed (an upkeep never ends a run). */
export function minecraftUpkeep(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McDo | null {
  if (!facts.observation) return null;
  const fresh = (move: McDo | null) => move && !memory.failed(move.key) && !memory.lastFailure(move.key) ? move : null;
  return fresh(eat(facts, memory)) ?? fresh(wear(facts)) ?? sleep(facts, memory);
}

/** Failures the planner must see at once: the body's night gate, a full pack, no tool or a broken one, a bed that explodes. */
const FINAL = new Set(['night_unprepared', 'inventory_full', 'missing_tool', 'tool_broke', 'tool_durability_low', 'bed_explodes', 'not_offered']);
export const finalFailure = (failure: string) => FINAL.has(failure);
/**
 * The body's reflex cut in (a fight, a fall): the work is tried again once before it counts; a danger that stays is a stop. rel23: so is
 * `not_consumed` (eating refused because she is full): it does not stop the procedure.
 */
const PASSING = new Set(['interrupted_by_reflex', 'not_consumed']);
export const passingFailure = (failure: string) => PASSING.has(failure);

export interface StopParts {
  /** A message came into the task's inbox after the decision that started the run. */
  pending?(): boolean;
  /** When the task began (ms): a step's time budget counts from it. */
  taskStartedAt?: number;
  now(): number;
  /** The steps already told late in this task (once each). */
  toldLate: Set<string>;
  /**
   * The steps this run found already late when it first came to them (true) or not (false) (mb-r20). A step that is late from its first
   * look is not told late: the planner called it knowing (the line of its budget says so at every decision), and run 20's iron step went
   * back at once, 0 items and 18 s of a route asked again for nothing. Absent: every late step is told, as before.
   */
  lateAtStart?: Map<string, boolean>;
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

/** How far past its budget a step is by the clock, or null when it has no budget or the task's start is not known. */
function lateness(procedure: string, parts: StopParts): { target: number; seconds: number; past: boolean } | null {
  const target = parts.targetSeconds?.(procedure) ?? milestoneTargetSeconds(procedure);
  if (target === undefined || parts.taskStartedAt === undefined) return null;
  const seconds = Math.round((parts.now() - parts.taskStartedAt) / 1000);
  return { target, seconds, past: seconds > target + PROCEDURE_UPKEEP.lateBy };
}

function late(procedure: string, parts: StopParts): string | null {
  const late = lateness(procedure, parts);
  if (!late || !late.past || parts.toldLate.has(procedure) || parts.lateAtStart?.get(procedure) === true) return null;
  parts.toldLate.add(procedure);
  return `「${procedure}」の目安${late.target}秒を${late.seconds - late.target}秒過ぎた（いま${late.seconds}秒）`;
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
  // The first look at a step in this run says whether it began late (whatever else holds the turn back now).
  if (parts.lateAtStart && !parts.lateAtStart.has(procedure)) parts.lateAtStart.set(procedure, lateness(procedure, parts)?.past === true);
  if (parts.pending?.()) return '新しい伝言が届いた';
  // No frame for a while (`MinecraftControl.frame`): nothing here is known, so nothing is planned from it.
  if (!facts.observation) return '体の観測が届いていない';
  const near = danger(facts);
  if (near) return near;
  // The food's own procedure hunts: hunger is the planner's only elsewhere.
  if (facts.food !== null && facts.food <= 6 && !eat(facts) && procedure !== BED_STEP) return `空腹（${facts.food}）で食べ物を持っていない`;
  return nightStop(facts, procedure) ?? late(procedure, parts);
}
