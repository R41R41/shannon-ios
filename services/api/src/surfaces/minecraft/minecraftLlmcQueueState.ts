import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import { type ActInput, type ActPos, type ActTimeTuning } from '../../contracts/minecraftActContract.js';
import { type ItemOutcome, type MadeIn, type OperationState, type StageRow, type TraceIds } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt } from '../../contracts/minecraftControlContract.js';
import type { FcaBodyQueue, FcaToolCall } from '../../mind/action/fca/fcaPorts.js';
import type { LedgerInput, UsesSnapshot } from './minecraftLlmcPromises.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
import type { MinecraftControl } from './minecraftControl.js';
import { urgentWatch } from './minecraftLlmc.js';
import { type ReflexCapped } from './minecraftLlmcBodyEvents.js';

export const QUEUE_T = Object.freeze({ minMs: 2_000, maxMs: 8_000, defaultMs: 5_000, kept: 10 });

/** The longest an item's wait to start (the sum of the items ahead of it and a margin). */
export const START_MARGIN_MS = 10_000,
  START_CAP_MS = 360_000,
  DEADLINE_CAP_MS = 630_000,
  DEADLINE_MARGIN_MS = 5_000;

/** How long a failure or a drop is looked at before the model is asked again with items still open (the body's
 * drops come in the same breath). */
export const TROUBLE_SETTLE_MS = 250;

export const decisionTimes = new Map<string, number[]>();

export const counters = new Map<string, number>();

/** Amendment A-6 15: the ms a step the body measured for each form of a vertical hand (`progress.msPerUnit` of
 * its results), by task,
 * in place of the first guesses of an estimate. */
export const verticalSpeeds = new Map<string, ActTimeTuning>();

/** T for a task: the median of its last decisions' seconds, within `QUEUE_T`. */
export function queueWakeMs(taskId: string): number {
  const times = decisionTimes.get(taskId) ?? [];
  if (!times.length) return QUEUE_T.defaultMs;
  const sorted = [...times].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(Math.min(QUEUE_T.maxMs, Math.max(QUEUE_T.minMs, median)));
}

/** For tests: no task has a record of its decisions or its item numbers. */
export function forgetLlmcQueues(): void {
  decisionTimes.clear();
  counters.clear();
  verticalSpeeds.clear();
}

/** A bounded per-task record: the newest keys kept. */
export function keep<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 32) map.delete(map.keys().next().value as string);
}

export interface QueueItem {
  item: string;
  id: string;
  operationId: string;
  call: FcaToolCall;
  node: string | null;
  current: string | null;
  why: string;
  input: ActInput;
  pre: ActCondition | undefined;
  done: ActCondition | undefined;
  maxMs: number;
  startBy: number;
  from: ActPos | null;
  enqueuedAt: number;
  startedAt: number | null;
  ended: boolean;
  abort: AbortController;
  watch: ReturnType<typeof urgentWatch> | null;
  fixes: readonly string[];
  because: string | null;
  /** The hand (and pass) the body last said it runs, and when the head first saw it: the time left within a hand
   * counts down from then. */
  handKey: string | null;
  handSince: number;
  reason(): string | null;
  /** Continue contract 1: the item's result state (the store's), the unit of its receipt, and whether it relies on anything. */
  state: OperationState;
  unit: ItemOutcome | null;
  dependsOn: string[] | undefined;
  uses: UsesSnapshot[];
  resume: { item: string; command: string } | undefined;
}

export interface QueueAdd {
  call: FcaToolCall;
  operationId: string;
  input: ActInput;
  arguments: Record<string, unknown>;
  skill: string;
  pre?: ActCondition;
  /** The plan's current node when the model sent it (the plan follows the work only under the same one). */
  current?: string | null;
  node: string | null;
  why: string;
  fixes: readonly string[];
  maxMs: number;
  /** Run 45's resume: this item sends a held one again (the item's mark and its command's id). Its result says so. */
  resumeOf?: { item: string; command: string };
  /** Continue contract 5: the observation the decision read (`madeIn`). Absent (a resumed act, a test): the newest
   * frame at the moment of adding. */
  madeIn?: MadeIn | null;
}

/** The ledger's input the plan's owner takes (`FcaPlanPort.applyLedger`). */
export type QueueLedgerInput = Omit<LedgerInput, 'nodes' | 'at'> & { at?: string };

/** A row of the decision record: the contract's `StageRow`, or one of the rows the judge asks for beside them
 * (`minecraftOperationRows.ts`). */
export type QueueRecordRow = StageRow | { ev: string; at: string; ids: TraceIds; [key: string]: unknown };

export interface QueueDeps {
  control: MinecraftControl;
  bodyId(): string;
  context(): BodyTaskContext;
  lease: ActionLease;
  taskId: string;
  /** A pending incident take prevents new motor commands, including answers from an already running decision. */
  holdPending?(): boolean;
  observe(): BodyObservation | null;
  log(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** This start of the head and this step (the queue's name is `taskId:headBoot:step`). Defaults: the process's
   * boot and the lease's id. */
  headBoot?: string;
  step?: string | number;
  /** The plan's one way into the ledger (chapter 3). Absent: the events are not booked (a test). */
  applyLedger?(input: QueueLedgerInput): unknown;
  /** The definitions of the promises as they are now, for the numbers an act says it uses (`snapshotUses` over the
   * plan's promises). */
  snapshotUses?(ids: readonly number[]): UsesSnapshot[];
  /** A cleanup that did not prove the release in time: the operator's hold (the incident port) is asked for. */
  onHeld?(info: { item: string; command: string; why: string }): void;
  /** The decision record's rows (continue contract 8). Absent: the installed recorder's (`noteStageRow`). Never
   * throws into the queue. */
  record?(row: QueueRecordRow): void;
  /** A reflex hit its cap (the body's `reflex.capped` event, continue contract 4): told to the live state, beside the queue's own
   * `reflex_capped` wake. */
  onReflexCapped?(info: ReflexCapped): void;
}

export type AddResult = { ok: true; item: string; after: string | null; startInMs: number } | { ok: false; text: string };

export const ioTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export const sameWork = (left: ActInput, right: ActInput): boolean =>
  JSON.stringify([left.hands, left.repeat, left.done]) === JSON.stringify([right.hands, right.repeat, right.done]);

export type RanListener = (item: { call: FcaToolCall; why: string }, result: ToolResult, receipt?: MinecraftControlReceipt) => void;

/** The queue as the head's tools and lifecycle use it (`FcaBodyQueue` is what the runner sees of it). */
export interface LlmcQueue extends FcaBodyQueue {
  add(spec: QueueAdd): Promise<AddResult>;
  /** The items asked to be taken off, and the ones behind them that do not say they rely on something else;
   * resolves when the body has
   * answered for them (at most `waitMs`). */
  replace(ids: readonly string[], waitMs?: number): Promise<string>;
  /** The item the next one would follow (the last open one), or null. */
  tail(): string | null;
  /** The lines of the live state. */
  lines(frame: BodyObservation | null): string[];
  /** The input of the items ahead of a new one, in order (the act preflight reads them as the hands that come first). */
  ahead(): ActInput[];
  /** What the body measured of a step of each vertical form in this task (`progress.msPerUnit`), for the time a vertical hand that
   * names none is given. */
  tuning(): ActTimeTuning;
  /** A decision's request is built now: a drop after this makes it stale (`stale`). */
  mark(): void;
  stale(): boolean;
  /** Told of each item the body ran when it ends, with its result (her feelings read it). */
  onRan(listener: RanListener): void;
  /** The furnaces that came due since the last look (the body's `furnace.done` events, run 39): one line each, once. */
  furnaceNews(): string[];
  /**
   * Words of the result states that came after an item was told (the cleanup proved the release, the cleanup did
   * not, a real result
   * corrected an unknown one):
   * one line each, once. The step shows them to the next decision.
   */
  notes(): string[];
  /** The items the body dropped or the head took off since `since` (a ms clock): their marks and why, for a held
   * act's record (chapter 8's 再開). */
  droppedSince(since: number): { item: string; why: string }[];
  /** A reflex hit its cap (`reflex_capped`): the next `ready` says so once. The queue calls it itself when the
   * body's `reflex.capped` event comes. */
  noteReflexCapped(): void;
  /** The items still open (their marks and labels): the ones a hold is about to take off (chapter 8's 再開: the
   * record of a hold that came again). */
  openItems(): { item: string; why: string }[];
  stop(): void;
  /**
   * The plan's checkpoint was taken (the step is about to save it): the receipts the ledger has taken so far are
   * in it. And the plan
   * was saved: those receipts are marked processed
   * in the store (amendment A-6 12), not before: a head that stops between the two reads them again and the ledger
   * keeps each event
   * from being put twice.
   */
  checkpointed(): void;
  committed(): void;
  /** Waits (at most `waitMs`) until every item the body was given has answered, and the cleanup after an unknown
   * result has ended: a
   * step that ends is closed only after them. */
  settled(waitMs?: number): Promise<void>;
}
