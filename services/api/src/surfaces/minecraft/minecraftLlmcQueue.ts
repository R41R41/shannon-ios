import { createQueueProgress } from './minecraftLlmcQueueProgress.js';
import { createQueueAdmission } from './minecraftLlmcQueueAdmission.js';
import { QUEUE_T,START_MARGIN_MS,START_CAP_MS,DEADLINE_CAP_MS,DEADLINE_MARGIN_MS,TROUBLE_SETTLE_MS,decisionTimes,verticalSpeeds,queueWakeMs,
  keep,ioTurn,sleepMs } from './minecraftLlmcQueueState.js';
import type { QueueItem,QueueRecordRow,QueueDeps,RanListener,LlmcQueue } from './minecraftLlmcQueueState.js';
import { createQueueReceiptHandlers } from './minecraftLlmcQueueReceipts.js';
import { readActResult,tunedBy } from '../../contracts/minecraftActContract.js';
import { queueName,type OperationState } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt,MinecraftQueueEnvelope } from '../../contracts/minecraftControlContract.js';
import type { FcaQueueNews,FcaQueueWake } from '../../mind/action/fca/fcaPorts.js';
import { currentActionExecution } from '../../infra/context/actionExecution.js';
import { cleaningNow } from './minecraftControlRecovery.js';
import { eventsOfReceipt,ledgerInputFor,storedPages } from './minecraftControlEvents.js';
import { offer as offerOnceFact } from './minecraftLlmcOnceFacts.js';
import { placementCorrections } from './minecraftLlmcResultWords.js';
import { urgentWatch } from './minecraftLlmc.js';
import { noteItemStart } from './minecraftLlmcNode.js';
import { itemLabel,itemResult,neverRan,queueLines,QUEUE_MAX,unitOfReceipt,unknownResult } from './minecraftLlmcQueueWords.js';
import { correctionWords } from './minecraftLlmcResultWords.js';
import { headBoot as thisHeadBoot } from './minecraftHeadBoot.js';
import { madeInOf,withMadeIn } from './minecraftMadeIn.js';
import { watchBodyEvents } from './minecraftLlmcBodyEvents.js';
import { readingOf } from './store/minecraftOperationState.js';
import { noteResultsRead,noteStageRow } from '../../infra/decisionRecords/decisionRecordNotes.js';
import { eventsRow,receivedRow,correctedRow,unknownNotifiedRow,wokeRow,type RowContext } from './minecraftOperationRows.js';
export { QUEUE_T, queueWakeMs, forgetLlmcQueues } from './minecraftLlmcQueueState.js';
export type { QueueAdd, QueueLedgerInput, QueueRecordRow, QueueDeps, LlmcQueue } from './minecraftLlmcQueueState.js';

/**
 * The head's mirror of the body's item queue (design minebot-task-queue, 2026-10-26). Every `mc.act` is an item:
 * it goes to the body at once
 * (`MinecraftControl.enqueue`) and the tool returns when the body has it, not when the act is done. The body
 * runs the items one after another
 * (one runs, two wait) and decides what a stopped item does to the ones behind it (continue contract 2: the ones
 * that rely on it are
 * dropped, the ones that say they
 * do not are kept). This mirror keeps what the head needs of that: the items in their order, the results as they
 * come, when the next
 * decision is due (`ready`) and
 * the lines of the live state.
 *
 * - The lease, the cancel and the unknown outcome are the step's, as for any body command: an item is a command
 * of the step's lease.
 * An item whose result is
 *   unknown (`settled_unknown`) is told to the model as that, and the head sends a stop at once (continue contract
 * 1); the step is not
 *   settled until the release is
 *   proved, and nothing that moves the body is sent until then.
 * - The next decision is due when no item waits and the running one has `T` seconds left or less (T: the median
 * of the last ten decisions, 2–8 s).
 * - **The head does not take items off because of the order results came in.** What the body dropped or kept is read from its
 * receipts (`droppedBecause`,
 *   `keptDespite`, `startedAt`). The head takes items off only when the model writes `replace` (the ones it names,
 * and the ones behind
 *   them that did not say they rely on
 *   something else) and when the step is stopped or the owner speaks.
 */
export { QUEUE_MAX };

/**
 * The observation a decision read, as the envelope names it (continue contract 2's `madeIn`): see `minecraftMadeIn.ts`, where the
 * head's commands, the reflex adapter's and
 * a decision's answer all read it from.
 */
export { madeInOf };
export function createLlmcQueue(deps: QueueDeps): LlmcQueue {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? sleepMs;
  const headBoot = deps.headBoot ?? deps.control.headBoot() ?? thisHeadBoot();
  const stepKey = deps.step ?? deps.lease.id;
  const name = queueName(deps.taskId, headBoot, stepKey);
  const items: QueueItem[] = [], news: FcaQueueNews[] = [], listeners: RanListener[] = [], noteLines: string[] = [], dropLog: { item:
     string; why: string; at: number }[] = [];
  let stopped = false, version = 0, marked = 0, error: unknown = null, pumpTimer: ReturnType<typeof setInterval> | null = null;
  let droppedSeen = 0, droppedNow = 0, failedSeen = 0, failedNow = 0, troubleAt: number | null = null, furnaceCursor: number | null = null, capped = false;
  let execution: ReturnType<typeof currentActionExecution>;
  const pending = new Set<Promise<unknown>>(), stopCleanup = new AbortController();
  /** The commands whose events (and every page of them) the ledger has taken, and the ones of those the plan's last
 * checkpoint holds
 * (`checkpointed`). */
  const booked = new Set<string>();
  let sealed: string[] = [];
  const open = () => items.filter(item => !item.ended);
  const bump = () => {
    version += 1;
    droppedNow += 1;
  };
  /** The step is settled when nothing is open and no result is left unknown (an unknown result is settled only by
 * the proof of the release). */
  const settleFlag = () => {
    if (execution) execution.stepOutcome = open().length || items.some(item => item.state === 'settled_unknown') ? 'unknown' : 'acknowledged';
  };
  const log = (line: string) => { try { deps.log(line); } catch { /* a log never fails a step */ } };
  const iso = () => new Date(now()).toISOString();
  const rowContext = (item: Pick<QueueItem, 'item' | 'id'> | null): RowContext => ({ run: deps.taskId, queue: name, ...(item ? { item:
     item.item, command: item.id } : {}), headBoot,
    observation: deps.observe(), at: iso() });
  /** The record's row (continue contract 8): to the decision record's recorder unless the caller gives its own; a failure of the
 * recorder is the recorder's. */
  const record = (row: QueueRecordRow) => { try { (deps.record ?? noteStageRow)(row); } catch { /* a record never fails a step */ } };
const { progressOf, remainingMs, dependStateOfRef, tell, aheadMs, nextNumber, wakeNow } = createQueueProgress(deps, { items, open, now });

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
   * The items behind `from` are taken off by the head. Used only when a receipt cannot be had at all (the step is
 * going to end on the error) and by `replace`'s
   * closure; a bad end of an item is never a reason (the body says what it dropped).
   */
  function drop(from: QueueItem, why: string): void {
    const behindIt = open().filter(item => item !== from && items.indexOf(item) > items.indexOf(from));
    for (const later of behindIt) {
      later.because ??= why;
      later.abort.abort('queue_dropped');
    }
  }
  const noteDropped = (item: QueueItem, why: string) => { dropLog.push({ item: item.item, why: `${itemLabel(item)}${why ? `（${why}）` :
     ''}`.slice(0, 120), at: now() }); if (dropLog.length > 32) dropLog.shift(); };
const { sentHands, book, bygone, bygoneContext, lostWithTheBody, onReleased, onHeld, onSettled } = createQueueReceiptHandlers(deps, { name,
   headBoot, items, noteLines, booked, pending, stopCleanup, iso, log, rowContext, record, settleFlag });


  /** Amendment A-6 15: the ms a step a vertical hand measured (`progress.msPerUnit`), kept for the task by the form
 * that ran, for the next estimate. */
  function learnSpeed(item: Pick<QueueItem, 'input'>, receipt: MinecraftControlReceipt): void {
    const result = readActResult(receipt.result);
    if (!result) return;
    let tune = verticalSpeeds.get(deps.taskId) ?? {};
    for (const line of result.lines) tune = tunedBy(tune, item.input.hands[line.i - 1], line.progress?.msPerUnit);
    if (Object.keys(tune).length) keep(verticalSpeeds, deps.taskId, tune);
  }

  /** An item whose real result came (the first receipt, or the one after an unknown that is the correction). */
  function settle(item: QueueItem, receipt: MinecraftControlReceipt): void {
    const stored = deps.control.store.state(item.id);
    const reading = readingOf(receipt);
    if (reading === 'unknown' || stored === 'settled_unknown' || stored === 'released') { settleUnknown(item, receipt, stored);
      return; }
    item.ended = true;
    item.watch?.stop();
    item.state = stored ?? 'settled_known';
    item.unit = unitOfReceipt(receipt);
    const taken = neverRan(receipt, item) || item.because !== null;
    const result = itemResult(item, receipt, item.fixes);
    // A placement the body counted and then found gone (A-5 3): a fact said once, delivered when the request's bytes carry it.
    for (const fact of placementCorrections(item.item, receipt.result)) offerOnceFact(deps.taskId, `placement_corrected:${fact.id}`, fact.text);
    const ms = item.startedAt === null ? 0 : now() - item.startedAt;
    news.push({ kind: taken ? 'dropped' : 'ran', item: item.item, call: item.call, operationId: item.operationId, result, ms, label: itemLabel(item) });
    // The head reads what the body decided; it takes nothing off because an item stopped. A drop the body made
// changes the queue a decision followed (`stale`).
    if (taken) { bump();
      noteDropped(item, item.unit.droppedBecause?.code ?? item.because ?? ''); }
    else if (!result.ok) { failedNow += 1;
      troubleAt ??= now(); }
    if (!taken) { book(item, receipt);
      learnSpeed(item, receipt);
      for (const listener of listeners) tell(listener, item, result, receipt); }
    record(receivedRow(rowContext(item), receipt));
    settleFlag();
    pump();
  }
  /**
   * The result is not known (the body's receipt said so, or none came in time): the model is told so, once, as
 * that; the stop that clears the body is sent at once
   * (a stop discards what waits and stops what runs: what it discards is a result that stands). Nothing the head
 * does here puts the item in the queue again.
   */
  function settleUnknown(item: QueueItem, receipt: MinecraftControlReceipt, stored: OperationState | null): void {
    item.ended = true;
    item.watch?.stop();
    item.unit = unitOfReceipt(receipt);
    const released = stored === 'released';
    item.state = released ? 'released' : 'settled_unknown';
    const ms = item.startedAt === null ? 0 : now() - item.startedAt;
    news.push({ kind: 'ran', item: item.item, call: item.call, operationId: item.operationId, result: unknownResult(item, released), ms,
       label: itemLabel(item) });
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
  deps.control.releasedListeners.add(onReleased);
  deps.control.heldListeners.add(onHeld);
  deps.control.settledListeners.add(onSettled);
  // Continue contract 3 and 4: what the body tells beside its receipts (a reflex's cap, a reflex's use of the pack
// outside any act).
  const unwatch = watchBodyEvents({ control: deps.control, bodyId: deps.bodyId, observe: deps.observe, log,
    ...(deps.applyLedger ? { applyLedger: deps.applyLedger } : {}),
    onReflexCapped: info => {
      capped = true;
      try { deps.onReflexCapped?.(info); } catch { /* the live view never fails a step */ }
    } });
  function fail(item: QueueItem, cause: unknown): void {
    item.ended = true;
    item.watch?.stop();
    error ??= cause;
    drop(item, item.item);
    bump();
  }
const { refusal, makeItem } = createQueueAdmission(deps, { items, open, now });

  // The receipt box (chapter 3): what a head that stopped before its plan was committed had not put to the ledger,
// and the corrections nobody said.
  // And continue contract 1, the head's restart: a command an earlier start of the head left `sent`, or whose
// result is unknown, is cleaned up with a stop before anything moves the body.
  const restoreReceipts = async () => {
    try {
      if (deps.control.store.uncleaned(deps.taskId, headBoot).length) startCleanup('(前の起動の項目)');
      for (const row of deps.control.store.unsaidCorrections(deps.taskId)) {
        noteLines.push(correctionWords(row.id.slice(0, 18), (row.receipt?.result ?? row.receipt?.outcome ?? '').split('\n')[0]?.slice(0, 120) ?? ''));
        deps.control.store.markCorrectionSaid(row.id);
        // A correction that came before this start's queue existed (the real receipt on the first poll of the new head)
// has its row here, once.
        const old = bygone(row.id);
        if (old && row.receipt) record(correctedRow(bygoneContext(old), unitOfReceipt(row.receipt)));
      }
      if (!deps.applyLedger) return;
      const done: string[] = [];
      for (const row of deps.control.store.unprocessed(deps.taskId)) {
const restoreReceipt = (): Promise<void> | undefined => {
        if (!row.receipt) return;
        const { events, more } = eventsOfReceipt(row.receipt);
        const tail = more ? storedPages(deps.control.store, row.id, Math.max(more.nextSeq, 0), more.total) : null;
        const base = { id: row.id, uses: row.uses, connectionId: row.receipt.connectionId, ...(deps.control.store.command(
          row.id)?.queue?.item ? { item: deps.control.store.command(row.id)!.queue!.item } : {}) };
        const sent = sentHands(row.id), result = row.receipt.result;
        deps.applyLedger!(ledgerInputFor({ ...base, events: [...events, ...(tail?.events ?? [])], observation: deps.observe(), result, sent,
           ...(tail?.lost ? { lost: true } : {}) }));
        if (more && tail && !tail.complete) {
return (async () => {

          const got = await deps.control.fetchEvents({ command: row.id, context: deps.context(), lease: deps.lease, fromSeq: tail.nextSeq,
             total: more.total, signal: stopCleanup.signal });
          record(eventsRow({ ...rowContext(null), command: row.id }, got.lost));
          if (got.events.length || got.lost) deps.applyLedger!(ledgerInputFor({ ...base, events: got.events, observation: deps.observe(),
             result, sent, ...(got.lost ? { lost: true } : {}) }));
          if (!got.complete && !got.lost) return;

done.push(row.id);
})();
}
        done.push(row.id);

};
const remaining = restoreReceipt();
if (remaining) await remaining;
}
      // Taken by the ledger of this start, not yet saved: the receipts are marked processed once the plan that holds
// them is saved (`committed`).
      for (const id of done) booked.add(id);
    } catch (cause) { log(`Shannon Minecraft receipt box failed task=${deps.taskId} ${String(cause).slice(0, 120)}`); }
  };
void restoreReceipts();

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
    checkpointed() { sealed = [...booked]; },
    committed() {
      const ids = sealed;
      sealed = [];
      if (!ids.length) return;
      for (const id of ids) booked.delete(id);
      try { deps.control.store.markProcessed(ids); } catch (cause) { log(
        `Shannon Minecraft receipt mark failed task=${deps.taskId} ${String(cause).slice(0, 120)}`); }
    },
    openItems: () => open().map(item => ({ item: item.item, why: itemLabel(item) })),
    mark() { marked = version; },
    stale: () => version !== marked,
    // Once the items are taken off (a stop, the close of the step) an unsettled one is unsafe again: the guard must not look past it.
    openIds: () => stopped ? new Set<string>() : new Set(open().map(item => item.id)),
    open: () => open().length > 0,
    version: () => version,
    tail: () => open().at(-1)?.item ?? null,
    ahead: () => open().map(item => item.input),
    tuning: () => verticalSpeeds.get(deps.taskId) ?? {},
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
      const queueEnvelope = (): MinecraftQueueEnvelope => ({ item: label, after, node: spec.node, ...(spec.pre ? { pre: spec.pre } : {}), maxMs,
        startBy: new Date(item.startBy).toISOString(), queue: name, ...(spec.input.dependsOn !== undefined ? { dependsOn: [...spec.input.dependsOn] } : {}),
        ...(madeIn ? { madeIn } : {}) });
      const envelope: MinecraftQueueEnvelope = queueEnvelope();
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
      const logAddedItem = () => (log(("Shannon Minecraft queue add task=" +
`${deps.taskId}` +
" item=" +
`${label}` +
" after=" +
`${after ?? '-'}` +
" node=" +
`${spec.node ?? '-'}` +
" open=" +
`${open().length}` +
" maxMs=" +
`${maxMs}` +
"")
        + `${spec.pre ? ' pre=1' : ''}${spec.input.done ? ' done=1' : ''}${spec.input.repeat ? ` repeat=${spec.input.repeat}` : ''}`
        + `${spec.input.dependsOn !== undefined ? ` dependsOn=${spec.input.dependsOn.join(',') || '-'}` : ''}`));
      logAddedItem();
      return { ok: true, item: label, after, startInMs };
    },
    async replace(ids, waitMs = 3_000) {
      const all = ids.includes('all');
      const chosen = open().filter(item => all || ids.includes(item.item));
      const unknownReplacements = () => (all ? [] : ids.filter(id => !items.some(item => item.item === id && !item.ended)));
      const unknown = unknownReplacements();
      const first = chosen.length ? Math.min(...chosen.map(item => items.indexOf(item))) : -1;
      // Continue contract 2: what is named goes, and the cancellation reaches the ones behind it like a failure: the
// ones that do not say
// they rely on something
      // (no `dependsOn`) and the ones that rely on something gone go; only an item that wrote `dependsOn` without any
// of them stays, and
// its place is behind the ones before it.
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
      const replacementWords = () => (gone.length ? `消した: ${gone.map(item => item.item).join('・')}${open().length ? '' :
         '（列は空）'}${kept.length ? `。残した（頼っていない）: ${kept.map(item => item.item).join('・')}` : ''}` : '消す物は無かった');
      const named = replacementWords();
      return unknown.length ? `${named}。もう列に無い: ${unknown.join('・')}` : named;
    },
    // In the queue's order, whichever receipt came first.
    take() {
      const taken = news.splice(0).sort((left, right) => Number(left.item.slice(1)) - Number(right.item.slice(1)));
      // Continue contract 8: these results go to the step's history now; the decision records name them in the `reads`
// of the requests that still hold them.
      noteResultsRead(taken.flatMap(entry => { const found = items.find(item => item.item === entry.item);
        return found ? [{ command:
         found.id, probe: `${entry.label}: ` }] : []; }));
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
          // An item ended badly or the body dropped some while others are still open (the ones that do not rely on it):
// the body's drops come in the same breath, so
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
        const currentWake = () => (drain ? null : wakeNow(queue, { ...(messages ? { messages } : {}), ...(alert ? { alert } : {}) }, wake));
        const woken = currentWake();
        if (woken) {
          log(`Shannon Minecraft queue wake task=${deps.taskId} reason=${woken} open=${queue.length} T=${wake}`);
          const recordWake = () => (record(wokeRow(rowContext(queue.length === 1 ? queue[0]! : null), woken === 'remaining' ||
             woken === 'alert' || woken === 'message' ? woken : 'alert',
            woken === 'remaining' ? remainingMs(queue[0]!) : undefined)));
          recordWake();
          return woken;
        }
        await sleep(drain ? 50 : 100);
      }
    },
    lines(frame) {
      const queue = open();
      const first = queue[0];
      return queueLines(queue.map(item => ({ ...item, dependStates: item.dependsOn?.map(ref => [ref, dependStateOfRef(ref)] as const),
         reason: item.reason })), frame, { progress: first ? progressOf(first) : null, leftMs: first ? remainingMs(first) : 0 });
    },
  };
}
