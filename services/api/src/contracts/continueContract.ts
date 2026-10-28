/**
 * The contract "continue" (version 3.1, `docs/continue-contracts.md`), the head's copy: the types both sides share and the pure rules both
 * sides read from the same table (`tests/fixtures/continue/continue/dependency-table.json` is the master; this file implements it and the
 * tests read the table). The body has the same names in `backend/src/services/minebot/integration/commonFca/continueContract.ts`.
 *
 * Nothing here decides for the model: the rules below only say what a stopped item means for the ones that wait behind it.
 */
import type { ActCondition, Dim } from './minecraftActCondition.js';
import type { ActPos } from './minecraftActContract.js';

export const CONTINUE_CONTRACT_VERSION = '3.1' as const;

// ---- 1. results (goal x end) ----------------------------------------------------------------------------------------------------------------
/** What the unit aimed at, and how it stands now. */
export type GoalOutcome = 'done' | 'already' | 'partial' | 'not_started' | 'failed' | 'unknown';
/** How the unit's run ended. */
export type RunEnd = 'finished' | 'cut' | 'not_run' | 'unknown';
export type CutBy = 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall'
  | 'death' | 'stale_life' | 'dimension_changed' | 'lease_expired' | 'connection_changed' | 'operator_stop' | 'handover';
export const GOAL_OUTCOMES: readonly GoalOutcome[] = ['done', 'already', 'partial', 'not_started', 'failed', 'unknown'];
export const RUN_ENDS: readonly RunEnd[] = ['finished', 'cut', 'not_run', 'unknown'];

export interface Progress {
  unit: 'step' | 'block' | 'item' | 'meter' | 'blow' | 'second';
  done: number; left: number | null; at?: ActPos; msPerUnit?: number;
  work?: { dug: number; placed?: number; placeAttempts?: number; stockUsed?: number; placedConfirmed?: number };
  fromStopM?: number; searchEndM?: number;
  lastSearch?: { status: 'success' | 'partial' | 'timeout' | 'no_path'; len: number; nodes: number; ms: number; endM?: number;
    blockedAround?: { at: ActPos; block: string; diggable: boolean }[] };
}

export interface HandOutcome {
  goal: GoalOutcome; end: RunEnd; cutBy?: CutBy; code?: string; progress?: Progress; delta?: InventoryEvent[]; pass?: number;
}
export interface ActOutcome { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy; life: number }

export interface QueueRef { queue: string; item: string }
export interface ItemOutcome {
  goal: GoalOutcome; end: RunEnd; released: boolean;
  droppedBecause?: { code: CutBy | 'depends_failed' | 'depends_unknown'; item?: QueueRef };
  keptDespite?: { item: QueueRef; code: string };
  startedAt?: string;
}

/** One command's state in the store (the unknown outcome's single movement; the hold is another axis). */
export type OperationState = 'sent' | 'settled_known' | 'settled_unknown' | 'released' | 'corrected';
export type HoldState = 'none' | 'held' | 'resumed' | 'cancelled';
export const OPERATION_STATES: readonly OperationState[] = ['sent', 'settled_known', 'settled_unknown', 'released', 'corrected'];
export const HOLD_STATES: readonly HoldState[] = ['none', 'held', 'resumed', 'cancelled'];
/** The cleanup after an unknown receipt may take this long from the stop being handed in (provisional; not a guarantee). */
export const CLEANUP_LIMIT_MS = 5_000;

// ---- 2. continuing: the invalidation order, the dependency table -----------------------------------------------------------------------------
export interface MadeIn { life: number; dim: Dim; dimSince: string; bodyBoot: string; connectionId: string; headBoot: string; obsSeq: number }
export type DependState = 'succeeded' | 'failed' | 'pending' | 'unknown';

/** What the head knows of a unit it may be asked to depend on. */
export interface UnitView {
  /** false: the mark is not remembered (another queue, forgotten). */
  remembered: boolean;
  /** false: still running or waiting. */
  ended: boolean;
  goal?: GoalOutcome; end?: RunEnd; released?: boolean;
}

/**
 * The state of what a unit depends on, by the first rule that holds (the table's `dependStatePriority`): not remembered, unknown; not ended,
 * pending; release not confirmed, unknown; end unknown, unknown; done or already and finished, succeeded; else failed.
 */
export function dependStateOf(view: UnitView): DependState {
  if (!view.remembered) return 'unknown';
  if (!view.ended) return 'pending';
  if (view.released !== true) return 'unknown';
  if (view.end === 'unknown') return 'unknown';
  if ((view.goal === 'done' || view.goal === 'already') && view.end === 'finished') return 'succeeded';
  return 'failed';
}

export type KeepDecision = 'keep' | 'drop:depends_failed' | 'drop:depends_unknown';
/** Whether a waiting item stays in the queue: every dependency succeeded or pending keeps it; a failed one drops it; an unknown one drops it (unknown first when both). */
export function keepDecision(states: readonly DependState[]): KeepDecision {
  if (states.includes('failed')) return 'drop:depends_failed';
  if (states.includes('unknown')) return 'drop:depends_unknown';
  return 'keep';
}
export type StartDecision = 'start' | 'wait' | 'not_started:precondition' | 'not_started:precondition_unknown';
/** Whether a kept item may start now: all dependencies succeeded, its `pre` true, the body not held. */
export function startDecision(states: readonly DependState[], pre: boolean | null | undefined, bodyHeld: boolean): StartDecision {
  if (states.includes('pending') || bodyHeld) return 'wait';
  if (pre === false) return 'not_started:precondition';
  if (pre === null) return 'not_started:precondition_unknown';
  return 'start';
}

/** A hand's facts, for the act's goal. */
export interface HandFacts { goal: GoalOutcome; motorOps: number }
/** The act's (and so a queue item's) goal from its hands' goals, by the first rule that holds (the table's `aggregate`). */
export function aggregateGoal(hands: readonly HandFacts[], doneMet: boolean): GoalOutcome {
  if (doneMet) return 'done';
  const all = (goals: readonly GoalOutcome[]) => hands.length > 0 && hands.every(hand => goals.includes(hand.goal));
  if (all(['done', 'already'])) return hands.some(hand => hand.goal === 'done') ? 'done' : 'already';
  if (hands.some(hand => hand.goal === 'unknown')) return 'unknown';
  if (hands.some(hand => hand.goal === 'done' || hand.goal === 'partial')) return 'partial';
  if (hands.some(hand => hand.motorOps > 0)) return 'failed';
  return 'not_started';
}

/** The old words of a receipt for a unit (the table's `outcomes`), to read what is written by a body or a test that has no `unit`. */
export function unitFromOutcome(outcome: 'completed' | 'failed' | 'cancelled' | 'unknown', inputsReleased: boolean): ItemOutcome {
  if (outcome === 'unknown') return { goal: 'unknown', end: 'unknown', released: inputsReleased };
  if (outcome === 'completed') return inputsReleased ? { goal: 'done', end: 'finished', released: true } : { goal: 'done', end: 'finished', released: false };
  if (outcome === 'cancelled') return { goal: 'partial', end: 'cut', released: inputsReleased };
  return { goal: 'failed', end: 'finished', released: inputsReleased };
}

/** A unit as a dependency, from the receipt's unit. */
export function unitView(unit: ItemOutcome | undefined, remembered = true): UnitView {
  return unit ? { remembered, ended: true, goal: unit.goal, end: unit.end, released: unit.released } : { remembered, ended: false };
}

/** The pairs (goal, end) the table does not allow. */
const NOT_ALLOWED: readonly [GoalOutcome, RunEnd][] = [['already', 'cut'], ['done', 'not_run'], ['partial', 'not_run'], ['failed', 'not_run']];
export const allowedOutcome = (goal: GoalOutcome, end: RunEnd): boolean => !NOT_ALLOWED.some(([g, e]) => g === goal && e === end);

/** Why a hand's `dependsOn` list is wrong (self, a later hand, out of range, duplicate), or null. `index` is the hand's own number (1 up). */
export function handDependsProblem(index: number, dependsOn: readonly number[] | undefined, count: number): string | null {
  if (dependsOn === undefined) return null;
  const seen = new Set<number>();
  for (const number of dependsOn) {
    if (!Number.isInteger(number) || number < 1 || number > count) return `dependsOn の ${number} は手の番号の範囲外（1〜${count}）`;
    if (number === index) return `手 ${index} が自分に頼っている`;
    if (number > index) return `手 ${index} がまだ先の手 ${number} に頼っている`;
    if (seen.has(number)) return `dependsOn に ${number} が 2 度ある`;
    seen.add(number);
  }
  return null;
}

// ---- 3. promises' events (written by the body) ------------------------------------------------------------------------------------------------
export interface InventoryEvent {
  id: string; obsSeq: number; item: string; count: number;
  reason: 'ingredient' | 'fuel' | 'food' | 'placed' | 'thrown' | 'tool_broke' | 'crafted' | 'picked' | 'mined' | 'smelted' | 'reflex_eat' | 'reflex_armor' | 'death' | 'unexplained'
    | 'stored' | 'retrieved';   // amendment A-1 4: a chest hand puts into / takes out of a box (the item changed place; a promise's ledger says so, not 'consumed')
  intermediate?: boolean;
  /** The order the body gave it within its command (0 up, across passes and hands). */
  deliverySeq?: number;
}
export interface EventsMore { command: string; nextSeq: number; total: number }
/** The internal read-only command `events` and its reply. */
export const EVENTS_SKILL = 'events' as const;
export interface EventsRequest { command: string; fromSeq: number; max: number }
export interface EventsReply { command: string; from: number; to: number; total: number; nextSeq: number; done: boolean; lost: boolean; events: InventoryEvent[] }

// ---- 4. control ------------------------------------------------------------------------------------------------------------------------------
export type ControlHolder =
  | { kind: 'idle' }
  | { kind: 'command'; actionId: string; command: string; item?: string; life: number; since: string }
  | { kind: 'reflex'; actionId: string; reflex: string; priority: number; target?: number; since: string; episode?: boolean }
  | { kind: 'bridge'; after: string; hold: 'shield' | 'step_back'; target?: number; since: string; until: string }
  | { kind: 'cleanup'; command: string; since: string };
export interface ControlView {
  holder: ControlHolder;
  reflexEpisode?: { reflex: string; target?: number; hands: number; hits: number; since: string };
  combatMark?: { skill: string; target?: number; until: string };
  waiting: { command: string; since: string; behind: string }[];
}
export interface Handover { from: string; target: number; waitedMs: number; reflexSettledAt: string; confirmed: boolean; shield: 'kept' | 'lowered' | 'none' }
export interface ReflexCappedData { limit: 'melee_hands' | 'melee_hits' | 'budget_arrow' | 'budget_eat' | 'budget_armor'; count: number; bridge: 'shield' | 'step_back' | 'none'; until: string | null }

// ---- 5. life ---------------------------------------------------------------------------------------------------------------------------------
export interface LifeView {
  life: number; advancedBy?: 'death' | 'file_unreadable'; deathEpoch?: string; deathSeq?: number; since: string; alive: boolean;
  diedAt?: string; deathCause?: string; dimension: Dim; dimensionSince: string;
}
export interface BodyRun { bodyBoot: string; connectionId: string }

/** The head's memory of the body's death counter (one per body), and what a new observation does to it. */
export interface DeathCounter { deathEpoch: string; deathSeq: number }
/**
 * Whether the body died between the two readings: only a rise of `deathSeq` within one `deathEpoch`. A new epoch starts at 0 whatever the head
 * saw, so the first reading of an epoch that is above 0 is a death too; the change of epoch itself is not (the file was made again; the pack
 * is whole). Returns the counter to remember.
 */
export function deathBetween(known: DeathCounter | null, now: { deathEpoch?: unknown; deathSeq?: unknown }): { death: boolean; counter: DeathCounter | null } {
  if (typeof now.deathEpoch !== 'string' || !Number.isSafeInteger(now.deathSeq)) return { death: false, counter: known };
  const counter: DeathCounter = { deathEpoch: now.deathEpoch, deathSeq: now.deathSeq as number };
  const base = known !== null && known.deathEpoch === counter.deathEpoch ? known.deathSeq : 0;
  if (known === null) return { death: false, counter };
  return { death: counter.deathSeq > base, counter };
}

// ---- 8. measurement --------------------------------------------------------------------------------------------------------------------------
export interface TraceIds {
  run: string; decision?: string; reads?: string[]; command?: string; queue?: string; item?: string; hand?: number; pass?: number;
  life: number; bodyBoot?: string; headBoot?: string; obsSeq: number; obsAt: string;
}
export interface BodyTimes {
  acceptedAt: string; startedAt?: string; lockAt?: string; firstMotorAt?: string; failedAt?: string; endedAt: string; reflexWaitMs?: number; motorOps?: number;
}
export interface HandStart {
  ids: TraceIds; at: string; pos: ActPos; hp: number; food: number; saturation: number; inventory: string; holder: ControlHolder;
  lastOps: { at: string; op: string; detail?: string }[];
}
export interface BodyVersion { revision: string; catalogHash: string }
export type StageRow =
  | { ev: 'received'; at: string; ids: TraceIds; receipt: { outcome: string; unit?: ItemOutcome }; bodyTimes?: BodyTimes }
  | { ev: 'released'; at: string; ids: TraceIds; by: 'receipt' | 'cleanup'; ok: boolean }
  | { ev: 'corrected'; at: string; ids: TraceIds; was: 'unknown'; now: ItemOutcome }
  | { ev: 'woke'; at: string; ids: TraceIds; why: 'failure' | 'remaining' | 'message' | 'alert' | 'furnace' | 'reflex_capped'; predictedRemainingMs?: number }
  | { ev: 'live'; at: string; ids: TraceIds; raw: string; shown: string; dropped: { field: string; count: number; why: string }[]; bytes: number }
  | { ev: 'input_change'; at: string; ids: TraceIds; promptHash: string; thinkingDropped?: { reason: string; count: number }; historyChanged?: 'resume' | 'summary' | 'none' };

/** The version of a command's context the head writes (a queue's name is per task, per head start, per step). */
export const queueName = (taskId: string, headBoot: string, step: number | string): string => `${taskId}:${headBoot}:${step}`;
export const sameRef = (left: QueueRef, right: QueueRef): boolean => left.queue === right.queue && left.item === right.item;

/** The act condition type, re-exported for the readers of this contract. */
export type { ActCondition };
