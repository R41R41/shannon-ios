import { createHash } from 'node:crypto';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import { actRemainingMilliseconds, type ActInput, type ActPos } from '../../contracts/minecraftActContract.js';
import type { MinecraftControlReceipt, MinecraftQueueEnvelope, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import type { FcaBodyQueue, FcaQueueNews, FcaQueueWake, FcaToolCall } from '../../mind/action/fca/fcaPorts.js';
import type { ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { currentActionExecution } from '../../infra/context/actionExecution.js';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
import type { MinecraftControl } from './minecraftControl.js';
import { feetOf, urgentWatch } from './minecraftLlmc.js';
import { noteItemStart } from './minecraftLlmcNode.js';
import { itemLabel, itemResult, neverRan, queueLines, QUEUE_MAX } from './minecraftLlmcQueueWords.js';

/**
 * The head's mirror of the body's item queue (design minebot-task-queue, 2026-10-26). Every `mc.act` is an item: it goes to the body at once
 * (`MinecraftControl.enqueue`) and the tool returns when the body has it, not when the act is done. The body runs the items one after another
 * (one runs, two wait) and drops what waits when the running one ends badly. This mirror keeps what the head needs of that: the items in their
 * order, the results as they come, when the next decision is due (`ready`) and the lines of the live state.
 *
 * - The lease, the cancel and the unknown outcome are the step's, as for any body command: an item is a command of the step's lease; a receipt that
 *   cannot be had throws in the step, and the step ends only when no item is open (the lifecycle's `safe` does not count the open ones).
 * - The next decision is due when no item waits and the running one has `T` seconds left or less (T: the median of the last ten decisions, 2–8 s).
 * - An item that ends badly, is replaced or expires drops the ones behind it (`version` changes): a decision asked before that is thrown away.
 */
export { QUEUE_MAX };
export const QUEUE_T = Object.freeze({ minMs: 2_000, maxMs: 8_000, defaultMs: 5_000, kept: 10 });
/** The longest an item's wait to start (the sum of the items ahead of it and a margin). */
const START_MARGIN_MS = 10_000, START_CAP_MS = 360_000, DEADLINE_CAP_MS = 630_000, DEADLINE_MARGIN_MS = 5_000;

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

interface QueueItem {
  item: string; id: string; operationId: string; call: FcaToolCall; node: string | null; current: string | null; why: string; input: ActInput;
  pre: ActCondition | undefined; done: ActCondition | undefined; maxMs: number; startBy: number; from: ActPos | null;
  enqueuedAt: number; startedAt: number | null; ended: boolean; abort: AbortController; watch: ReturnType<typeof urgentWatch> | null;
  fixes: readonly string[]; because: string | null;
  /** The hand (and pass) the body last said it runs, and when the head first saw it: the time left within a hand counts down from then. */
  handKey: string | null; handSince: number;
  reason(): string | null;
}
export interface QueueAdd {
  call: FcaToolCall; operationId: string; input: ActInput; arguments: Record<string, unknown>; skill: string; pre?: ActCondition;
  /** The plan's current node when the model sent it (the plan follows the work only under the same one). */
  current?: string | null;
  node: string | null; why: string; fixes: readonly string[]; maxMs: number;
}
export interface QueueDeps {
  control: MinecraftControl; bodyId(): string; context(): BodyTaskContext; lease: ActionLease; taskId: string;
  observe(): BodyObservation | null; log(line: string): void; now?(): number; sleep?(ms: number): Promise<void>;
}
type AddResult = { ok: true; item: string; after: string | null; startInMs: number } | { ok: false; text: string };

const ioTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const sleepMs = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });
const sameWork = (left: ActInput, right: ActInput): boolean =>
  JSON.stringify([left.hands, left.repeat, left.done]) === JSON.stringify([right.hands, right.repeat, right.done]);
type RanListener = (item: { call: FcaToolCall; why: string }, result: ToolResult) => void;

/** The queue as the head's tools and lifecycle use it (`FcaBodyQueue` is what the runner sees of it). */
export interface LlmcQueue extends FcaBodyQueue {
  add(spec: QueueAdd): Promise<AddResult>;
  /** The items asked to be taken off, and the ones behind them; resolves when the body has answered for them (at most `waitMs`). */
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
  stop(): void;
  /** Waits (at most `waitMs`) until every item the body was given has answered: a step that ends is closed only after them. */
  settled(waitMs?: number): Promise<void>;
}
export function createLlmcQueue(deps: QueueDeps): LlmcQueue {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? sleepMs;
  const items: QueueItem[] = [], news: FcaQueueNews[] = [], listeners: RanListener[] = [];
  let stopped = false, version = 0, marked = 0, error: unknown = null, pumpTimer: ReturnType<typeof setInterval> | null = null;
  let droppedSeen = 0, droppedNow = 0, furnaceCursor: number | null = null;
  let execution: ReturnType<typeof currentActionExecution>;
  const open = () => items.filter(item => !item.ended);
  const bump = () => {
    version += 1;
    droppedNow += 1;
  };
  const settleFlag = () => { if (execution) execution.stepOutcome = open().length ? 'unknown' : 'acknowledged'; };
  const log = (line: string) => { try { deps.log(line); } catch { /* a log never fails a step */ } };

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
  /** The items behind `from` are taken off: the head cancels them (the body drops what waits behind a bad end on its own too). */
  function drop(from: QueueItem, why: string): void {
    const behindIt = open().filter(item => item !== from && items.indexOf(item) > items.indexOf(from));
    for (const later of behindIt) {
      later.because ??= why;
      later.abort.abort('queue_dropped');
    }
  }
  function settle(item: QueueItem, receipt: MinecraftControlReceipt): void {
    item.ended = true;
    item.watch?.stop();
    const taken = neverRan(receipt, item) || item.because !== null;
    const result = itemResult(item, receipt, item.fixes);
    const ms = item.startedAt === null ? 0 : now() - item.startedAt;
    news.push({ kind: taken ? 'dropped' : 'ran', item: item.item, call: item.call, operationId: item.operationId, result, ms, label: itemLabel(item) });
    if (!result.ok) {
      bump();
      drop(item, item.item);
    } else if (taken) bump();
    if (!taken) for (const listener of listeners) tell(listener, item, result);
    settleFlag();
    pump();
  }
  /** Her feelings read each result; they never fail a step. */
  function tell(listener: RanListener, item: QueueItem, result: ToolResult): void {
    try { listener({ call: item.call, why: item.why }, result); } catch { /* feelings never fail a step */ }
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
    const waiting = open();
    if (waiting.length >= QUEUE_MAX) {
      return `送らなかった: 列がいっぱい（実行中を含めて ${QUEUE_MAX} つ）。差し替えるなら replace に ${waiting.at(-1)!.item} などを書く`;
    }
    const same = waiting.find(item => sameWork(item.input, spec.input));
    return same ? `送らなかった: ${same.item} と同じ手が列にある（${waiting[0] === same ? '実行中' : '待ち'}）。列は live の queue` : null;
  }
  function makeItem(spec: QueueAdd, label: string, maxMs: number, startInMs: number): QueueItem {
    const at = now();
    const item: QueueItem = { item: label, id: `skill:${createHash('sha256').update(spec.operationId).digest('hex')}`, operationId: spec.operationId,
      call: spec.call, node: spec.node, current: spec.current ?? null, why: spec.why, input: spec.input, pre: spec.pre, done: spec.input.done, maxMs,
      startBy: at + startInMs,
      from: feetOf(deps.observe()), enqueuedAt: at, startedAt: null, ended: false, abort: new AbortController(), watch: null,
      fixes: spec.fixes, because: null, handKey: null, handSince: at, reason: () => item.watch?.reason() ?? null };
    return item;
  }
  /** Why the queue has no more to wait for: the step wakes for it (a message, a surprise) or the running one is nearly done. */
  function wakeNow(queue: readonly QueueItem[], options: { messages?(): boolean; alert?(): boolean }, wake: number): FcaQueueWake | null {
    if (options.messages?.()) return 'message';
    if (options.alert?.()) return 'alert';
    return queue.length === 1 && remainingMs(queue[0]!) <= wake ? 'remaining' : null;
  }

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
      const envelope: MinecraftQueueEnvelope = { item: label, after, node: spec.node, ...(spec.pre ? { pre: spec.pre } : {}), maxMs,
        startBy: new Date(item.startBy).toISOString() };
      items.push(item);
      if (items.length > 16) items.splice(0, items.length - 16);
      execution ??= currentActionExecution();
      if (execution) execution.stepOutcome = 'unknown';
      const handle = deps.control.enqueue({ id: item.id, context: deps.context(), lease: deps.lease, kind: 'skill', skill: spec.skill,
        arguments: spec.arguments, milliseconds: Math.min(DEADLINE_CAP_MS, ahead + maxMs + DEADLINE_MARGIN_MS), queue: envelope }, item.abort.signal);
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
        + `${spec.pre ? ' pre=1' : ''}${spec.input.done ? ' done=1' : ''}${spec.input.repeat ? ` repeat=${spec.input.repeat}` : ''}`);
      return { ok: true, item: label, after, startInMs };
    },
    async replace(ids, waitMs = 3_000) {
      const all = ids.includes('all');
      const chosen = open().filter(item => all || ids.includes(item.item));
      const unknown = all ? [] : ids.filter(id => !items.some(item => item.item === id && !item.ended));
      const first = chosen.length ? Math.min(...chosen.map(item => items.indexOf(item))) : -1;
      const gone = chosen.length ? open().filter(item => items.indexOf(item) >= first) : [];
      for (const item of gone) {
        item.because ??= '差し替え';
        item.abort.abort('replaced');
      }
      if (gone.length) bump();
      const until = now() + waitMs;
      while (gone.some(item => !item.ended) && now() < until && !error) await sleep(50);
      // The decision chose this itself: the drops it made are not a change it has not seen.
      if (gone.length) marked = version;
      const named = gone.length ? `消した: ${gone.map(item => item.item).join('・')}${open().length ? '' : '（列は空）'}` : '消す物は無かった';
      return unknown.length ? `${named}。もう列に無い: ${unknown.join('・')}` : named;
    },
    // In the queue's order, whichever receipt came first.
    take() { return news.splice(0).sort((left, right) => Number(left.item.slice(1)) - Number(right.item.slice(1))); },
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
      while (open().length && now() < until) await sleep(25);
    },
    stop() {
      stopped = true;
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
        if (!queue.length) return droppedNow > droppedSeen ? (droppedSeen = droppedNow, 'dropped') : 'empty';
        if (!drain && droppedNow > droppedSeen) {
          // The ones behind a bad end are being taken off: the step ends once every receipt is in.
          droppedSeen = droppedNow;
          return 'dropped';
        }
        const woken = drain ? null : wakeNow(queue, { ...(messages ? { messages } : {}), ...(alert ? { alert } : {}) }, wake);
        if (woken) {
          log(`Shannon Minecraft queue wake task=${deps.taskId} reason=${woken} open=${queue.length} T=${wake}`);
          return woken;
        }
        await sleep(drain ? 50 : 100);
      }
    },
    lines(frame) {
      const queue = open();
      const first = queue[0];
      return queueLines(queue, frame, { progress: first ? progressOf(first) : null, leftMs: first ? remainingMs(first) : 0 });
    },
  };
}
