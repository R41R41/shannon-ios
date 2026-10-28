import { createHash } from 'node:crypto';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import { actRemainingMilliseconds, readActResult, type ActInput, type ActPos } from '../../contracts/minecraftActContract.js';
import { dependStateOf, queueName, unitView, type DependState, type ItemOutcome, type MadeIn, type OperationState, type StageRow, type TraceIds } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt, MinecraftQueueEnvelope, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import type { FcaBodyQueue, FcaQueueNews, FcaQueueWake, FcaToolCall } from '../../mind/action/fca/fcaPorts.js';
import type { LedgerInput, UsesSnapshot } from './minecraftLlmcPromises.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { currentActionExecution } from '../../infra/context/actionExecution.js';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
import type { MinecraftControl, ReleasedEvent, SettledEvent } from './minecraftControl.js';
import { cleaningNow } from './minecraftControlRecovery.js';
import { eventsOfReceipt, ledgerInputFor, storedPages } from './minecraftControlEvents.js';
import { feetOf, urgentWatch } from './minecraftLlmc.js';
import { noteItemStart } from './minecraftLlmcNode.js';
import { itemLabel, itemResult, neverRan, queueLines, QUEUE_MAX, unitOfReceipt, unknownResult } from './minecraftLlmcQueueWords.js';
import { correctionWords, heldWords, releasedWords } from './minecraftLlmcResultWords.js';
import { headBoot as thisHeadBoot } from './minecraftHeadBoot.js';
import { madeInOf, withMadeIn } from './minecraftMadeIn.js';
import { watchBodyEvents, type ReflexCapped } from './minecraftLlmcBodyEvents.js';
import { readingOf } from './store/minecraftOperationState.js';
import { noteResultsRead, noteStageRow } from '../../infra/decisionRecords/decisionRecordNotes.js';
import { eventsRow, receivedRow, releasedRow, correctedRow, unknownNotifiedRow, wokeRow, type RowContext } from './minecraftOperationRows.js';

/**
 * The head's mirror of the body's item queue (design minebot-task-queue, 2026-10-26). Every `mc.act` is an item: it goes to the body at once
 * (`MinecraftControl.enqueue`) and the tool returns when the body has it, not when the act is done. The body runs the items one after another
 * (one runs, two wait) and decides what a stopped item does to the ones behind it (continue contract 2: the ones that rely on it are dropped, the ones that say they
 * do not are kept). This mirror keeps what the head needs of that: the items in their order, the results as they come, when the next decision is due (`ready`) and
 * the lines of the live state.
 *
 * - The lease, the cancel and the unknown outcome are the step's, as for any body command: an item is a command of the step's lease. An item whose result is
 *   unknown (`settled_unknown`) is told to the model as that, and the head sends a stop at once (continue contract 1); the step is not settled until the release is
 *   proved, and nothing that moves the body is sent until then.
 * - The next decision is due when no item waits and the running one has `T` seconds left or less (T: the median of the last ten decisions, 2–8 s).
 * - **The head does not take items off because of the order results came in.** What the body dropped or kept is read from its receipts (`droppedBecause`,
 *   `keptDespite`, `startedAt`). The head takes items off only when the model writes `replace` (the ones it names, and the ones behind them that did not say they rely on
 *   something else) and when the step is stopped or the owner speaks.
 */
export { QUEUE_MAX };
export const QUEUE_T = Object.freeze({ minMs: 2_000, maxMs: 8_000, defaultMs: 5_000, kept: 10 });
/** The longest an item's wait to start (the sum of the items ahead of it and a margin). */
const START_MARGIN_MS = 10_000, START_CAP_MS = 360_000, DEADLINE_CAP_MS = 630_000, DEADLINE_MARGIN_MS = 5_000;
/** How long a failure or a drop is looked at before the model is asked again with items still open (the body's drops come in the same breath). */
const TROUBLE_SETTLE_MS = 250;

const decisionTimes = new Map<string, number[]>();
const counters = new Map<string, number>();
/** T for a task: the median of its last decisions' seconds, within `QUEUE_T`. */
export function queueWakeMs(taskId: string): number {
  const times = decisionTimes.get(taskId) ?? [];
  if (!times.length) return QUEUE_T.defaultMs;
  const sorted = [...times].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(Math.min(QUEUE_T.maxMs, Math.max(QUEUE_T.minMs, median)));
}
/** For tests: no task has a record of its decisions or its item numbers. */
export function forgetLlmcQueues(): void {
  decisionTimes.clear();
  counters.clear();
}
/** A bounded per-task record: the newest keys kept. */
function keep<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 32) map.delete(map.keys().next().value as string);
}

/**
 * The observation a decision read, as the envelope names it (continue contract 2's `madeIn`): see `minecraftMadeIn.ts`, where the head's commands, the reflex adapter's and
 * a decision's answer all read it from.
 */
export { madeInOf };

interface QueueItem {
  item: string; id: string; operationId: string; call: FcaToolCall; node: string | null; current: string | null; why: string; input: ActInput;
  pre: ActCondition | undefined; done: ActCondition | undefined; maxMs: number; startBy: number; from: ActPos | null;
  enqueuedAt: number; startedAt: number | null; ended: boolean; abort: AbortController; watch: ReturnType<typeof urgentWatch> | null;
  fixes: readonly string[]; because: string | null;
  /** The hand (and pass) the body last said it runs, and when the head first saw it: the time left within a hand counts down from then. */
  handKey: string | null; handSince: number;
  reason(): string | null;
  /** Continue contract 1: the item's result state (the store's), the unit of its receipt, and whether it relies on anything. */
  state: OperationState; unit: ItemOutcome | null; dependsOn: string[] | undefined; uses: UsesSnapshot[];
  resume: { item: string; command: string } | undefined;
}
export interface QueueAdd {
  call: FcaToolCall; operationId: string; input: ActInput; arguments: Record<string, unknown>; skill: string; pre?: ActCondition;
  /** The plan's current node when the model sent it (the plan follows the work only under the same one). */
  current?: string | null;
  node: string | null; why: string; fixes: readonly string[]; maxMs: number;
  /** Run 45's resume: this item sends a held one again (the item's mark and its command's id). Its result says so. */
  resumeOf?: { item: string; command: string };
  /** Continue contract 5: the observation the decision read (`madeIn`). Absent (a resumed act, a test): the newest frame at the moment of adding. */
  madeIn?: MadeIn | null;
}
/** The ledger's input the plan's owner takes (`FcaPlanPort.applyLedger`). */
export type QueueLedgerInput = Omit<LedgerInput, 'nodes' | 'at'> & { at?: string };
/** A row of the decision record: the contract's `StageRow`, or one of the rows the judge asks for beside them (`minecraftOperationRows.ts`). */
export type QueueRecordRow = StageRow | { ev: string; at: string; ids: TraceIds; [key: string]: unknown };
export interface QueueDeps {
  control: MinecraftControl; bodyId(): string; context(): BodyTaskContext; lease: ActionLease; taskId: string;
  observe(): BodyObservation | null; log(line: string): void; now?(): number; sleep?(ms: number): Promise<void>;
  /** This start of the head and this step (the queue's name is `taskId:headBoot:step`). Defaults: the process's boot and the lease's id. */
  headBoot?: string; step?: string | number;
  /** The plan's one way into the ledger (chapter 3). Absent: the events are not booked (a test). */
  applyLedger?(input: QueueLedgerInput): unknown;
  /** The definitions of the promises as they are now, for the numbers an act says it uses (`snapshotUses` over the plan's promises). */
  snapshotUses?(ids: readonly number[]): UsesSnapshot[];
  /** A cleanup that did not prove the release in time: the operator's hold (the incident port) is asked for. */
  onHeld?(info: { item: string; command: string; why: string }): void;
  /** The decision record's rows (continue contract 8). Absent: the installed recorder's (`noteStageRow`). Never throws into the queue. */
  record?(row: QueueRecordRow): void;
  /** A reflex hit its cap (the body's `reflex.capped` event, continue contract 4): told to the live state, beside the queue's own `reflex_capped` wake. */
  onReflexCapped?(info: ReflexCapped): void;
}
type AddResult = { ok: true; item: string; after: string | null; startInMs: number } | { ok: false; text: string };

const ioTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const sleepMs = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
const sameWork = (left: ActInput, right: ActInput): boolean =>
  JSON.stringify([left.hands, left.repeat, left.done]) === JSON.stringify([right.hands, right.repeat, right.done]);
type RanListener = (item: { call: FcaToolCall; why: string }, result: ToolResult, receipt?: MinecraftControlReceipt) => void;

/** The queue as the head's tools and lifecycle use it (`FcaBodyQueue` is what the runner sees of it). */
export interface LlmcQueue extends FcaBodyQueue {
  add(spec: QueueAdd): Promise<AddResult>;
  /** The items asked to be taken off, and the ones behind them that do not say they rely on something else; resolves when the body has answered for them (at most `waitMs`). */
  replace(ids: readonly string[], waitMs?: number): Promise<string>;
  /** The item the next one would follow (the last open one), or null. */
  tail(): string | null;
  /** The lines of the live state. */
  lines(frame: BodyObservation | null): string[];
  /** The input of the items ahead of a new one, in order (the act preflight reads them as the hands that come first). */
  ahead(): ActInput[];
  /** A decision's request is built now: a drop after this makes it stale (`stale`). */
  mark(): void;
  stale(): boolean;
  /** Told of each item the body ran when it ends, with its result (her feelings read it). */
  onRan(listener: RanListener): void;
  /** The furnaces that came due since the last look (the body's `furnace.done` events, run 39): one line each, once. */
  furnaceNews(): string[];
  /**
   * Words of the result states that came after an item was told (the cleanup proved the release, the cleanup did not, a real result corrected an unknown one):
   * one line each, once. The step shows them to the next decision.
   */
  notes(): string[];
  /** The items the body dropped or the head took off since `since` (a ms clock): their marks and why, for a held act's record (chapter 8's 再開). */
  droppedSince(since: number): { item: string; why: string }[];
  /** A reflex hit its cap (`reflex_capped`): the next `ready` says so once. The queue calls it itself when the body's `reflex.capped` event comes. */
  noteReflexCapped(): void;
  /** The items still open (their marks and labels): the ones a hold is about to take off (chapter 8's 再開: the record of a hold that came again). */
  openItems(): { item: string; why: string }[];
  stop(): void;
  /** Waits (at most `waitMs`) until every item the body was given has answered, and the cleanup after an unknown result has ended: a step that ends is closed only after them. */
  settled(waitMs?: number): Promise<void>;
}
export function createLlmcQueue(deps: QueueDeps): LlmcQueue {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? sleepMs;
  const headBoot = deps.headBoot ?? deps.control.headBoot() ?? thisHeadBoot();
  const stepKey = deps.step ?? deps.lease.id;
  const name = queueName(deps.taskId, headBoot, stepKey);
  const items: QueueItem[] = [], news: FcaQueueNews[] = [], listeners: RanListener[] = [], noteLines: string[] = [], dropLog: { item: string; why: string; at: number }[] = [];
  let stopped = false, version = 0, marked = 0, error: unknown = null, pumpTimer: ReturnType<typeof setInterval> | null = null;
  let droppedSeen = 0, droppedNow = 0, failedSeen = 0, failedNow = 0, troubleAt: number | null = null, furnaceCursor: number | null = null, capped = false;
  let execution: ReturnType<typeof currentActionExecution>;
  const pending = new Set<Promise<unknown>>(), stopCleanup = new AbortController();
  const open = () => items.filter(item => !item.ended);
  const bump = () => {
    version += 1;
    droppedNow += 1;
  };
  /** The step is settled when nothing is open and no result is left unknown (an unknown result is settled only by the proof of the release). */
  const settleFlag = () => {
    if (execution) execution.stepOutcome = open().length || items.some(item => item.state === 'settled_unknown') ? 'unknown' : 'acknowledged';
  };
  const log = (line: string) => { try { deps.log(line); } catch { /* a log never fails a step */ } };
  const iso = () => new Date(now()).toISOString();
  const rowContext = (item: Pick<QueueItem, 'item' | 'id'> | null): RowContext => ({ run: deps.taskId, queue: name, ...(item ? { item: item.item, command: item.id } : {}), headBoot,
    observation: deps.observe(), at: iso() });
  /** The record's row (continue contract 8): to the decision record's recorder unless the caller gives its own; a failure of the recorder is the recorder's. */
  const record = (row: QueueRecordRow) => { try { (deps.record ?? noteStageRow)(row); } catch { /* a record never fails a step */ } };

  /** The body's progress of an item, when it is the one running. */
  const progressOf = (item: QueueItem): MinecraftQueueProgress | null => {
    const progress = deps.control.progress(deps.bodyId());
    return progress && progress.id === item.id ? progress : null;
  };
  /** The time an item likely has left: the hands from the one the body runs, less what that hand has run; without the progress, the whole less what has run. */
  const remainingMs = (item: QueueItem): number => {
    const mine = progressOf(item);
    const key = mine ? `${mine.iteration}/${mine.hand}` : null;
    if (key !== item.handKey) {
      item.handKey = key;
      item.handSince = now();
    }
    if (!mine) return actRemainingMilliseconds(item.input, item.from, null, item.startedAt === null ? 0 : now() - item.startedAt);
    return Math.max(0, actRemainingMilliseconds(item.input, item.from, { hand: mine.hand, iteration: mine.iteration }, 0) - (now() - item.handSince));
  };
  /** The first open item is the one the body runs: its clock starts and its watch for a hostile comes near. */
  function pump(): void {
    const first = open()[0];
    if (first && first.startedAt === null) {
      first.startedAt = now();
      noteItemStart(deps.taskId, first.node, first.current);
      const watch = urgentWatch(first.input, deps.observe, first.abort.signal, 250);
      first.watch = watch;
      watch.signal.addEventListener('abort', () => first.abort.abort(watch.signal.reason), { once: true });
    }
    if (first) remainingMs(first);
    if (!open().length && pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = null;
    }
  }
  /**
   * The items behind `from` are taken off by the head. Used only when a receipt cannot be had at all (the step is going to end on the error) and by `replace`'s
   * closure; a bad end of an item is never a reason (the body says what it dropped).
   */
  function drop(from: QueueItem, why: string): void {
    const behindIt = open().filter(item => item !== from && items.indexOf(item) > items.indexOf(from));
    for (const later of behindIt) {
      later.because ??= why;
      later.abort.abort('queue_dropped');
    }
  }
  const noteDropped = (item: QueueItem, why: string) => { dropLog.push({ item: item.item, why: `${itemLabel(item)}${why ? `（${why}）` : ''}`.slice(0, 120), at: now() }); if (dropLog.length > 32) dropLog.shift(); };

  /** What the ledger is given of a command that ended with a real result (chapter 3): its events once each, the rest by pages, the definitions it was sent with. */
  function book(item: Pick<QueueItem, 'id' | 'item' | 'uses'>, receipt: MinecraftControlReceipt): void {
    if (!deps.applyLedger || readActResult(receipt.result) === null) return;
    const { events, more } = eventsOfReceipt(receipt);
    const apply = (input: ReturnType<typeof ledgerInputFor>) => { try { void deps.applyLedger!(input); } catch (cause) { log(`Shannon Minecraft ledger failed task=${deps.taskId} item=${item.item} ${String(cause).slice(0, 120)}`); } };
    const base = { id: item.id, item: item.item, uses: item.uses, connectionId: receipt.connectionId };
    apply(ledgerInputFor({ ...base, events, observation: deps.observe() }));
    if (!more) return;
    const fetch = (async () => {
      const row = deps.control.store.row(item.id);
      const got = await deps.control.fetchEvents({ command: item.id, context: deps.context(), lease: deps.lease, fromSeq: Math.max(more.nextSeq, row?.fetchSeq ?? 0), total: more.total,
        signal: stopCleanup.signal });
      record(eventsRow(rowContext(item), got.lost));
      if (got.events.length || got.lost) apply(ledgerInputFor({ ...base, events: got.events, observation: deps.observe(), lost: got.lost }));
    })().catch(() => undefined);
    pending.add(fetch);
    void fetch.finally(() => pending.delete(fetch));
  }

  /** An item whose real result came (the first receipt, or the one after an unknown that is the correction). */
  function settle(item: QueueItem, receipt: MinecraftControlReceipt): void {
    const stored = deps.control.store.state(item.id);
    const reading = readingOf(receipt);
    if (reading === 'unknown' || stored === 'settled_unknown' || stored === 'released') { settleUnknown(item, receipt, stored); return; }
    item.ended = true;
    item.watch?.stop();
    item.state = stored ?? 'settled_known';
    item.unit = unitOfReceipt(receipt);
    const taken = neverRan(receipt, item) || item.because !== null;
    const result = itemResult(item, receipt, item.fixes);
    const ms = item.startedAt === null ? 0 : now() - item.startedAt;
    news.push({ kind: taken ? 'dropped' : 'ran', item: item.item, call: item.call, operationId: item.operationId, result, ms, label: itemLabel(item) });
    // The head reads what the body decided; it takes nothing off because an item stopped. A drop the body made changes the queue a decision followed (`stale`).
    if (taken) { bump(); noteDropped(item, item.unit.droppedBecause?.code ?? item.because ?? ''); }
    else if (!result.ok) { failedNow += 1; troubleAt ??= now(); }
    if (!taken) { book(item, receipt); for (const listener of listeners) tell(listener, item, result, receipt); }
    record(receivedRow(rowContext(item), receipt));
    settleFlag();
    pump();
  }
  /**
   * The result is not known (the body's receipt said so, or none came in time): the model is told so, once, as that; the stop that clears the body is sent at once
   * (a stop discards what waits and stops what runs: what it discards is a result that stands). Nothing the head does here puts the item in the queue again.
   */
  function settleUnknown(item: QueueItem, receipt: MinecraftControlReceipt, stored: OperationState | null): void {
    item.ended = true;
    item.watch?.stop();
    item.unit = unitOfReceipt(receipt);
    const released = stored === 'released';
    item.state = released ? 'released' : 'settled_unknown';
    const ms = item.startedAt === null ? 0 : now() - item.startedAt;
    news.push({ kind: 'ran', item: item.item, call: item.call, operationId: item.operationId, result: unknownResult(item, released), ms, label: itemLabel(item) });
    failedNow += 1;
    troubleAt ??= now();
    deps.control.store.markTold(item.id);
    record(unknownNotifiedRow(rowContext(item)));
    record(receivedRow(rowContext(item), receipt));
    settleFlag();
    pump();
    if (!released) startCleanup(item.item);
  }
  /** The cleanup stop of the task's unresolved commands; ends in `released`, or in a hold for the operator. */
  function startCleanup(label: string): void {
    try {
      const work = deps.control.cleanup({ taskId: deps.taskId, context: deps.context(), lease: deps.lease, signal: stopCleanup.signal })
        .then(outcome => { log(`Shannon Minecraft queue cleanup task=${deps.taskId} item=${label} outcome=${outcome}`); }, () => undefined);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    } catch (cause) { log(`Shannon Minecraft queue cleanup failed task=${deps.taskId} item=${label} ${String(cause).slice(0, 120)}`); }
  }
  /**
   * A command an EARLIER start of the head sent is not among this queue's items (the memory went with the process), but the store has it and the cleanup of this start is about it:
   * what the listeners need of it (its mark, its words, the definitions it was sent with) is read from there. Only the task's acts; null for anything else.
   */
  const bygone = (id: string) => {
    const command = deps.control.store.command(id);
    if (!command || command.kind !== 'skill' || command.skill !== 'act' || command.context.taskId !== deps.taskId) return null;
    const input = (command.arguments ?? {}) as Partial<ActInput>;
    return { id, item: command.queue?.item ?? id.slice(0, 18), node: command.queue?.node ?? null, why: String(input.why ?? ''), queueName: command.queue?.queue ?? name, input: input as ActInput,
      uses: deps.control.store.row(id)?.uses ?? [], startedAt: null, because: null, resume: undefined, pre: undefined, done: undefined, reason: () => null };
  };
  const bygoneContext = (old: NonNullable<ReturnType<typeof bygone>>): RowContext => ({ run: deps.taskId, queue: old.queueName, item: old.item, command: old.id, headBoot, observation: deps.observe(), at: iso() });
  /** The control told us a command of this queue was released without a receipt of its own (the cleanup, or the new connection). */
  const onReleased = ({ row }: ReleasedEvent) => {
    const item = items.find(entry => entry.id === row.id);
    if (!item) {
      const old = bygone(row.id);
      if (old) record(releasedRow(bygoneContext(old), 'cleanup', true));
      return;
    }
    item.state = 'released';
    // An item still waiting for its receipt is told when that comes (as a released one); one already told as unknown gets the note.
    if (item.ended) noteLines.push(releasedWords(itemLabel(item)));
    // The new connection's first poll proves the release as the cleanup does (`releasedRow`): both are the head's proof, not the command's own receipt.
    record(releasedRow(rowContext(item), 'cleanup', true));
    settleFlag();
  };
  const onHeld = ({ row, why }: { row: { id: string }; why: string }) => {
    const item = items.find(entry => entry.id === row.id);
    if (!item) {
      const old = bygone(row.id);
      if (!old) return;
      noteLines.push(heldWords(itemLabel(old)));
      log(`Shannon Minecraft queue held task=${deps.taskId} item=${old.item} why=${why} (an earlier start's)`);
      try { deps.onHeld?.({ item: old.item, command: old.id, why }); } catch { /* the operator's hold never fails the queue */ }
      return;
    }
    noteLines.push(heldWords(itemLabel(item)));
    log(`Shannon Minecraft queue held task=${deps.taskId} item=${item.item} why=${why}`);
    try { deps.onHeld?.({ item: item.item, command: item.id, why }); } catch { /* the operator's hold never fails the queue */ }
  };
  /** A real result after an unknown one the model was told: the correction is said once and the events are booked once. */
  const onSettled = (event: SettledEvent) => {
    const item = items.find(entry => entry.id === event.id);
    if (!item) {
      // The receipt of a command the earlier start sent: the row of its arrival, and, when the model was told it was unknown, the correction (said once, in the record and to the
      // model) and its events in the ledger once (continue contract 1, the head's restart).
      const old = bygone(event.id);
      if (!old) return;
      record(receivedRow(bygoneContext(old), event.receipt));
      if (event.to === 'corrected') {
        const unit = unitOfReceipt(event.receipt);
        const text = itemResult(old, event.receipt, []).text.split('\n').find(line => line.trim() !== '' && !line.startsWith('（頭が形を直して')) ?? event.receipt.outcome;
        noteLines.push(correctionWords(itemLabel(old), text));
        deps.control.store.markCorrectionSaid(old.id);
        record(correctedRow(bygoneContext(old), unit));
        book(old, event.receipt);
      }
      return;
    }
    if (event.to !== 'corrected') return;
    item.state = 'corrected';
    item.unit = unitOfReceipt(event.receipt);
    const text = itemResult(item, event.receipt, []).text.split('\n').find(line => line.trim() !== '' && !line.startsWith('（頭が形を直して')) ?? event.receipt.outcome;
    noteLines.push(correctionWords(itemLabel(item), text));
    deps.control.store.markCorrectionSaid(item.id);
    record(correctedRow(rowContext(item), item.unit));
    book(item, event.receipt);
    settleFlag();
  };
  deps.control.releasedListeners.add(onReleased);
  deps.control.heldListeners.add(onHeld);
  deps.control.settledListeners.add(onSettled);
  // Continue contract 3 and 4: what the body tells beside its receipts (a reflex's cap, a reflex's use of the pack outside any act).
  const unwatch = watchBodyEvents({ control: deps.control, bodyId: deps.bodyId, observe: deps.observe, log,
    ...(deps.applyLedger ? { applyLedger: deps.applyLedger } : {}),
    onReflexCapped: info => {
      capped = true;
      try { deps.onReflexCapped?.(info); } catch { /* the live view never fails a step */ }
    } });

  /** What the item `ref` is to one that relies on it, by the contract's order (`dependStateOf`): a mark this queue does not remember is unknown. */
  const dependStateOfRef = (ref: string): DependState => {
    const found = items.find(entry => entry.item === ref);
    return dependStateOf(found ? unitView(found.ended ? found.unit ?? undefined : undefined) : { remembered: false, ended: true });
  };
  /** Her feelings read each result; they never fail a step. */
  function tell(listener: RanListener, item: QueueItem, result: ToolResult, receipt: MinecraftControlReceipt): void {
    try { listener({ call: item.call, why: item.why }, result, receipt); } catch { /* feelings never fail a step */ }
  }
  function fail(item: QueueItem, cause: unknown): void {
    item.ended = true;
    item.watch?.stop();
    error ??= cause;
    drop(item, item.item);
    bump();
  }
  const aheadMs = (): number => open().reduce((sum, item) => sum + item.maxMs, 0);
  const nextNumber = (): number => {
    const number = (counters.get(deps.taskId) ?? 0) + 1;
    keep(counters, deps.taskId, number);
    return number;
  };
  /** Why a new item is not put in the queue, or null. */
  function refusal(spec: QueueAdd): string | null {
    const blocked = deps.control.motorBlocked(deps.taskId);
    if (blocked) {
      const mine = items.find(entry => entry.id === blocked.id);
      return `送らなかった: ${mine ? mine.item : 'さっきの項目'} の結果が不明で、体を止めたことをまだ確かめていない`
        + `（${blocked.hold === 'held' ? '保留中' : '片付け中'}）。体を動かす項目は、解放を確かめるまで送れない。見るだけの操作は送れる`;
    }
    const waiting = open();
    if (waiting.length >= QUEUE_MAX) {
      return `送らなかった: 列がいっぱい（実行中を含めて ${QUEUE_MAX} つ）。差し替えるなら replace に ${waiting.at(-1)!.item} などを書く`;
    }
    const same = waiting.find(item => sameWork(item.input, spec.input));
    if (same) return `送らなかった: ${same.item} と同じ手が列にある（${waiting[0] === same ? '実行中' : '待ち'}）。列は live の queue`;
    // Continue contract 2: a mark of another step's queue cannot be relied on (the marks belong to one queue); said now, not as a drop when it should start.
    const unknown = (spec.input.dependsOn ?? []).filter(ref => !items.some(entry => entry.item === ref));
    if (unknown.length) {
      const usable = (waiting.length ? waiting : items.slice(-3)).map(entry => entry.item);
      return `送らなかった: dependsOn の ${unknown.join('・')} は前の段の列（今の列で頼れるのは ${usable.length ? usable.join('・') : 'まだ無い'}）`;
    }
    return null;
  }
  function makeItem(spec: QueueAdd, label: string, maxMs: number, startInMs: number): QueueItem {
    const at = now();
    const item: QueueItem = { item: label, id: `skill:${createHash('sha256').update(spec.operationId).digest('hex')}`, operationId: spec.operationId,
      call: spec.call, node: spec.node, current: spec.current ?? null, why: spec.why, input: spec.input, pre: spec.pre, done: spec.input.done, maxMs,
      startBy: at + startInMs,
      from: feetOf(deps.observe()), enqueuedAt: at, startedAt: null, ended: false, abort: new AbortController(), watch: null,
      fixes: spec.fixes, because: null, handKey: null, handSince: at, reason: () => item.watch?.reason() ?? null,
      state: 'sent', unit: null, dependsOn: spec.input.dependsOn ? [...spec.input.dependsOn] : undefined, uses: [], resume: spec.resumeOf };
    return item;
  }
  /** Why the queue has no more to wait for: the step wakes for it (a message, a surprise) or the running one is nearly done. */
  function wakeNow(queue: readonly QueueItem[], options: { messages?(): boolean; alert?(): boolean }, wake: number): FcaQueueWake | null {
    if (options.messages?.()) return 'message';
    if (options.alert?.()) return 'alert';
    return queue.length === 1 && remainingMs(queue[0]!) <= wake ? 'remaining' : null;
  }

  // The receipt box (chapter 3): what a head that stopped before its plan was committed had not put to the ledger, and the corrections nobody said.
  // And continue contract 1, the head's restart: a command an earlier start of the head left `sent`, or whose result is unknown, is cleaned up with a stop before anything moves the body.
  void (async () => {
    try {
      if (deps.control.store.uncleaned(deps.taskId, headBoot).length) startCleanup('(前の起動の項目)');
      for (const row of deps.control.store.unsaidCorrections(deps.taskId)) {
        noteLines.push(correctionWords(row.id.slice(0, 18), (row.receipt?.result ?? row.receipt?.outcome ?? '').split('\n')[0]?.slice(0, 120) ?? ''));
        deps.control.store.markCorrectionSaid(row.id);
        // A correction that came before this start's queue existed (the real receipt on the first poll of the new head) has its row here, once.
        const old = bygone(row.id);
        if (old && row.receipt) record(correctedRow(bygoneContext(old), unitOfReceipt(row.receipt)));
      }
      if (!deps.applyLedger) return;
      const done: string[] = [];
      for (const row of deps.control.store.unprocessed(deps.taskId)) {
        if (!row.receipt) continue;
        const { events, more } = eventsOfReceipt(row.receipt);
        const tail = more ? storedPages(deps.control.store, row.id, Math.max(more.nextSeq, 0), more.total) : null;
        const base = { id: row.id, uses: row.uses, connectionId: row.receipt.connectionId, ...(deps.control.store.command(row.id)?.queue?.item ? { item: deps.control.store.command(row.id)!.queue!.item } : {}) };
        deps.applyLedger(ledgerInputFor({ ...base, events: [...events, ...(tail?.events ?? [])], observation: deps.observe(), ...(tail?.lost ? { lost: true } : {}) }));
        if (more && tail && !tail.complete) {
          const got = await deps.control.fetchEvents({ command: row.id, context: deps.context(), lease: deps.lease, fromSeq: tail.nextSeq, total: more.total, signal: stopCleanup.signal });
          record(eventsRow({ ...rowContext(null), command: row.id }, got.lost));
          if (got.events.length || got.lost) deps.applyLedger(ledgerInputFor({ ...base, events: got.events, observation: deps.observe(), ...(got.lost ? { lost: true } : {}) }));
          if (!got.complete && !got.lost) continue;
        }
        done.push(row.id);
      }
      deps.control.store.markProcessed(done);
    } catch (cause) { log(`Shannon Minecraft receipt box failed task=${deps.taskId} ${String(cause).slice(0, 120)}`); }
  })();

  return {
    onRan(listener) { listeners.push(listener); },
    furnaceNews() {
      const log = deps.control.working(deps.bodyId());
      if (!log) return [];
      furnaceCursor ??= log.cursor();
      const since = log.since(furnaceCursor);
      furnaceCursor = since.cursor;
      return since.events.filter(event => event.kind === 'furnace.done').map(event => String(event.data.text ?? `かまど ${event.subject} の焼きが終わった`));
    },
    notes: () => noteLines.splice(0),
    droppedSince: since => dropLog.filter(entry => entry.at >= since).map(({ item, why }) => ({ item, why })),
    noteReflexCapped() { capped = true; },
    openItems: () => open().map(item => ({ item: item.item, why: itemLabel(item) })),
    mark() { marked = version; },
    stale: () => version !== marked,
    // Once the items are taken off (a stop, the close of the step) an unsettled one is unsafe again: the guard must not look past it.
    openIds: () => stopped ? new Set<string>() : new Set(open().map(item => item.id)),
    open: () => open().length > 0,
    version: () => version,
    tail: () => open().at(-1)?.item ?? null,
    ahead: () => open().map(item => item.input),
    noteDecision(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
      keep(decisionTimes, deps.taskId, [...(decisionTimes.get(deps.taskId) ?? []), milliseconds].slice(-QUEUE_T.kept));
    },
    async add(spec) {
      const refused = refusal(spec);
      if (refused) return { ok: false, text: refused };
      const label = `q${nextNumber()}`, after = open().at(-1)?.item ?? null, ahead = aheadMs();
      const maxMs = Math.max(1_000, Math.min(180_000, spec.maxMs)), startInMs = Math.min(START_CAP_MS, ahead + START_MARGIN_MS);
      const item = makeItem(spec, label, maxMs, startInMs);
      item.uses = deps.snapshotUses?.(spec.input.uses ?? []) ?? [];
      const madeIn = spec.madeIn === undefined ? madeInOf(deps.observe(), headBoot) : spec.madeIn;
      const envelope: MinecraftQueueEnvelope = { item: label, after, node: spec.node, ...(spec.pre ? { pre: spec.pre } : {}), maxMs,
        startBy: new Date(item.startBy).toISOString(), queue: name, ...(spec.input.dependsOn !== undefined ? { dependsOn: [...spec.input.dependsOn] } : {}),
        ...(madeIn ? { madeIn } : {}) };
      items.push(item);
      if (items.length > 16) items.splice(0, items.length - 16);
      execution ??= currentActionExecution();
      if (execution) execution.stepOutcome = 'unknown';
      const handle = deps.control.enqueue({ id: item.id, context: withMadeIn(deps.context(), madeIn), lease: deps.lease, kind: 'skill', skill: spec.skill,
        arguments: spec.arguments, milliseconds: Math.min(DEADLINE_CAP_MS, ahead + maxMs + DEADLINE_MARGIN_MS), queue: envelope,
        ...(item.uses.length ? { uses: item.uses } : {}), ...(spec.resumeOf ? { resumeOf: spec.resumeOf.command } : {}) }, item.abort.signal);
      handle.receipt.then(receipt => settle(item, receipt), cause => fail(item, cause));
      if (!pumpTimer) {
        pumpTimer = setInterval(pump, 150);
        pumpTimer.unref?.();
      }
      pump();
      // An item refused at once (no body, a lease gone) throws here, as the body command of an act did.
      await ioTurn();
      await ioTurn();
      if (item.ended && error) throw error;
      log(`Shannon Minecraft queue add task=${deps.taskId} item=${label} after=${after ?? '-'} node=${spec.node ?? '-'} open=${open().length} maxMs=${maxMs}`
        + `${spec.pre ? ' pre=1' : ''}${spec.input.done ? ' done=1' : ''}${spec.input.repeat ? ` repeat=${spec.input.repeat}` : ''}`
        + `${spec.input.dependsOn !== undefined ? ` dependsOn=${spec.input.dependsOn.join(',') || '-'}` : ''}`);
      return { ok: true, item: label, after, startInMs };
    },
    async replace(ids, waitMs = 3_000) {
      const all = ids.includes('all');
      const chosen = open().filter(item => all || ids.includes(item.item));
      const unknown = all ? [] : ids.filter(id => !items.some(item => item.item === id && !item.ended));
      const first = chosen.length ? Math.min(...chosen.map(item => items.indexOf(item))) : -1;
      // Continue contract 2: what is named goes, and the cancellation reaches the ones behind it like a failure: the ones that do not say they rely on something
      // (no `dependsOn`) and the ones that rely on something gone go; only an item that wrote `dependsOn` without any of them stays, and its place is behind the ones before it.
      const gone: QueueItem[] = [];
      if (chosen.length) {
        for (const item of open()) {
          if (items.indexOf(item) < first) continue;
          const named = chosen.includes(item);
          const relies = item.dependsOn === undefined || item.dependsOn.some(ref => gone.some(entry => entry.item === ref));
          if (named || relies) gone.push(item);
        }
      }
      for (const item of gone) {
        item.because ??= '差し替え';
        item.abort.abort('replaced');
      }
      if (gone.length) bump();
      const until = now() + waitMs;
      while (gone.some(item => !item.ended) && now() < until && !error) await sleep(50);
      // The decision chose this itself: the drops it made are not a change it has not seen.
      if (gone.length) marked = version;
      const kept = open().filter(item => items.indexOf(item) > first && first >= 0);
      const named = gone.length ? `消した: ${gone.map(item => item.item).join('・')}${open().length ? '' : '（列は空）'}${kept.length ? `。残した（頼っていない）: ${kept.map(item => item.item).join('・')}` : ''}` : '消す物は無かった';
      return unknown.length ? `${named}。もう列に無い: ${unknown.join('・')}` : named;
    },
    // In the queue's order, whichever receipt came first.
    take() {
      const taken = news.splice(0).sort((left, right) => Number(left.item.slice(1)) - Number(right.item.slice(1)));
      // Continue contract 8: these results go to the step's history now; the decision records name them in the `reads` of the requests that still hold them.
      noteResultsRead(taken.flatMap(entry => { const found = items.find(item => item.item === entry.item); return found ? [{ command: found.id, probe: `${entry.label}: ` }] : []; }));
      return taken;
    },
    dropWaiting() {
      const waiting = open().slice(1);
      for (const item of waiting) {
        item.because ??= '依頼者の言葉';
        item.abort.abort('message');
      }
      if (waiting.length) bump();
      return waiting.length;
    },
    cancelAll() {
      stopped = true;
      for (const item of open()) item.abort.abort('stop');
    },
    async settled(waitMs = 8_000) {
      const until = now() + waitMs;
      while ((open().length || cleaningNow(deps.taskId) || pending.size) && now() < until) await sleep(25);
    },
    stop() {
      stopped = true;
      stopCleanup.abort();
      deps.control.releasedListeners.delete(onReleased);
      deps.control.heldListeners.delete(onHeld);
      deps.control.settledListeners.delete(onSettled);
      unwatch();
      if (pumpTimer) clearInterval(pumpTimer);
      pumpTimer = null;
      for (const item of items) item.watch?.stop();
    },
    async ready({ signal, drain, messages, alert }): Promise<FcaQueueWake> {
      const wake = queueWakeMs(deps.taskId);
      for (;;) {
        signal.throwIfAborted();
        if (error) throw error;
        pump();
        const queue = open();
        if (!queue.length) {
          const wasDropped = droppedNow > droppedSeen;
          droppedSeen = droppedNow;
          failedSeen = failedNow;
          troubleAt = null;
          capped = false;
          if (wasDropped) record(wokeRow(rowContext(null), 'failure'));
          return wasDropped ? 'dropped' : 'empty';
        }
        if (!drain && capped) {
          capped = false;
          record(wokeRow(rowContext(null), 'reflex_capped'));
          return 'reflex_capped';
        }
        if (!drain && (droppedNow > droppedSeen || failedNow > failedSeen)) {
          // An item ended badly or the body dropped some while others are still open (the ones that do not rely on it): the body's drops come in the same breath, so
          // wait a moment and then ask the model with the items that remain.
          troubleAt ??= now();
          if (now() - troubleAt >= TROUBLE_SETTLE_MS) {
            droppedSeen = droppedNow;
            failedSeen = failedNow;
            troubleAt = null;
            log(`Shannon Minecraft queue wake task=${deps.taskId} reason=alert(trouble) open=${queue.length} T=${wake}`);
            record(wokeRow(rowContext(null), 'failure'));
            return 'alert';
          }
        }
        const woken = drain ? null : wakeNow(queue, { ...(messages ? { messages } : {}), ...(alert ? { alert } : {}) }, wake);
        if (woken) {
          log(`Shannon Minecraft queue wake task=${deps.taskId} reason=${woken} open=${queue.length} T=${wake}`);
          record(wokeRow(rowContext(queue.length === 1 ? queue[0]! : null), woken === 'remaining' || woken === 'alert' || woken === 'message' ? woken : 'alert',
            woken === 'remaining' ? remainingMs(queue[0]!) : undefined));
          return woken;
        }
        await sleep(drain ? 50 : 100);
      }
    },
    lines(frame) {
      const queue = open();
      const first = queue[0];
      return queueLines(queue.map(item => ({ ...item, dependStates: item.dependsOn?.map(ref => [ref, dependStateOfRef(ref)] as const), reason: item.reason })), frame, { progress: first ? progressOf(first) : null, leftMs: first ? remainingMs(first) : 0 });
    },
  };
}
