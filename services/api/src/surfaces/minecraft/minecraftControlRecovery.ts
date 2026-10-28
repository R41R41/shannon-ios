import { createHash } from 'node:crypto';
import type { ActionLease } from '../../contracts/actionThreadContract.js';
import type { BodyTaskContext } from '../../contracts/bodyControlContract.js';
import { CLEANUP_LIMIT_MS, type InventoryEvent } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt } from '../../contracts/minecraftControlContract.js';
import type { ControlCommandInput } from './minecraftControl.js';
import { eventsCommandId, EVENTS_PAGE, EVENTS_SKILL, readEventsReply } from './minecraftControlEvents.js';
import type { MinecraftControlStore, OperationRow } from './store/minecraftControlStore.js';

/**
 * What the head does when a command's result is not known (continue contract 1, 「不明の結果」) and when the events of a result did not fit (chapter 3). It sends
 * through the control (`RecoveryPort.command`), so the lease, the frame and the body's receipts are the control's; the store keeps the states.
 */
export interface RecoveryPort {
  store: MinecraftControlStore;
  command(input: ControlCommandInput, signal?: AbortSignal): Promise<MinecraftControlReceipt>;
  now(): number;
  /** The cleanup of this command proved the release (from the cleanup's receipt, now or late). */
  released(row: OperationRow, by: 'cleanup'): void;
  /** The cleanup did not prove the release in time (or could not be sent): the command is held for the operator. */
  held(row: OperationRow, why: string): void;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
const iso = (port: RecoveryPort) => new Date(port.now()).toISOString();

/** The cleanups under way, by task: one stop at a time clears every unresolved command of the task, so a second asker waits for the first. */
const cleaning = new Map<string, Promise<CleanupOutcome>>();
export type CleanupOutcome = 'released' | 'held' | 'nothing';
/** For a test: nothing is being cleaned. */
export function forgetCleanups(): void { cleaning.clear(); }
/** Whether a cleanup of this task is under way (a queue that closes waits for it). */
export const cleaningNow = (taskId: string): boolean => cleaning.has(taskId);

/**
 * The cleanup after a result is unknown (and when the head starts and finds commands it cannot account for): a stop is handed in at once, with `CLEANUP_LIMIT_MS`
 * (5 s, provisional, not a guarantee) from the moment it is handed in. A stop that proves the inputs released ends every listed command `released` (their results stay
 * unknown). A stop that does not prove it in time, or could not be sent (no connection), makes them `held`: the operator resumes or cancels. A stop that proves it after
 * the time still ends them `released`; the hold stays until the operator ends it. The stop discards what waits and stops what runs (the body's `cleanup_stop`): what it
 * discarded is a settled result, and nothing here brings it back.
 */
export function cleanupOperations(port: RecoveryPort, input: { taskId: string; context: BodyTaskContext; lease: ActionLease; ids: readonly string[];
  limitMs?: number; signal?: AbortSignal }): Promise<CleanupOutcome> {
  const running = cleaning.get(input.taskId);
  if (running) return running;
  const rows = input.ids.flatMap(id => { const row = port.store.row(id); return row && (row.state === 'sent' || row.state === 'settled_unknown') ? [row] : []; });
  if (!rows.length) return Promise.resolve('nothing');
  const limit = input.limitMs ?? CLEANUP_LIMIT_MS;
  const key = hash(`${rows.map(row => row.id).join(',')}:${port.now()}`);
  const requestId = `cleanup:${key}`, stopId = `stop:cleanup-${key}`;
  const context: BodyTaskContext = { ...input.context, sessionId: requestId };
  const proves = (receipt: MinecraftControlReceipt) => receipt.stop?.state === 'stopped' && receipt.stop.inputsReleased === true && receipt.inputsReleased === true
    && receipt.outcome !== 'unknown';
  // A store that is gone (the process is closing) is not a cleanup's to fail on.
  const settleReleased = () => { try { for (const row of rows) if (port.store.release(row.id, 'cleanup', iso(port), stopId)) port.released(port.store.row(row.id) ?? row, 'cleanup'); } catch { /* closing */ } };
  // The operator is told once a command is held, not again at each try.
  const settleHeld = (why: string) => {
    try { for (const row of rows) { const before = port.store.holdOf(row.id); if (port.store.holdEvent(row.id, { kind: 'cleanup_failed' }) === 'held' && before !== 'held') port.held(port.store.row(row.id) ?? row, why); } } catch { /* closing */ }
  };
  const work = (async (): Promise<CleanupOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = port.command({ id: stopId, context, lease: input.lease, kind: 'stop', stop: { context, requestId, reason: 'cancel' }, milliseconds: limit }, input.signal);
    const late = stop.then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), limit); timer.unref?.(); });
    const first = await Promise.race([late, timedOut]);
    clearTimeout(timer);
    if (first !== 'timeout' && 'receipt' in first && proves(first.receipt)) { settleReleased(); return 'released'; }
    settleHeld(first === 'timeout' ? 'cleanup_timeout' : 'error' in first ? 'cleanup_unsent' : 'cleanup_not_released');
    // A stop that proves the release after the time still ends the commands released; the hold is the operator's to end.
    void late.then(result => { if ('receipt' in result && proves(result.receipt)) settleReleased(); });
    return 'held';
  })();
  cleaning.set(input.taskId, work);
  void work.finally(() => { if (cleaning.get(input.taskId) === work) cleaning.delete(input.taskId); });
  return work;
}

/**
 * Takes the pages of a command's events the receipt could not carry (chapter 3), from `fromSeq`, through the internal `events` command, one page at a time. Each page's
 * receipt is in the store (the command's id is the page's) before the control acknowledges it, and the next `deliverySeq` to fetch is kept on the command's row; a
 * range asked twice gives the same events. `lost` is the body's word that it lost its record (a restart): what the events do not explain is that. A page that cannot be
 * taken ends the loop (`complete` false) and the position stays, so the next call goes on from it.
 */
export async function fetchEventPages(port: RecoveryPort, input: { command: string; context: BodyTaskContext; lease: ActionLease; fromSeq: number; total: number;
  max?: number; signal?: AbortSignal }): Promise<{ events: InventoryEvent[]; lost: boolean; complete: boolean; nextSeq: number }> {
  const events: InventoryEvent[] = [];
  let from = input.fromSeq;
  for (let pages = 0; pages < 200 && from < input.total; pages += 1) {
    let reply;
    try {
      // A page already in the store is read from there (asking again would also meet a different context: the same id with other words is a conflict).
      const kept = port.store.receipt(eventsCommandId(input.command, from));
      const receipt = kept && kept.outcome === 'completed' && kept.inputsReleased ? kept : await port.command({ id: eventsCommandId(input.command, from), context: input.context, lease: input.lease, kind: 'skill', skill: EVENTS_SKILL,
        arguments: { command: input.command, fromSeq: from, max: input.max ?? EVENTS_PAGE }, milliseconds: 5_000 }, input.signal);
      reply = readEventsReply(receipt.result);
    } catch { return { events, lost: false, complete: false, nextSeq: from }; }
    if (!reply || reply.command !== input.command) return { events, lost: false, complete: false, nextSeq: from };
    if (reply.lost) return { events, lost: true, complete: true, nextSeq: reply.nextSeq };
    events.push(...reply.events);
    port.store.setFetchSeq(input.command, reply.nextSeq);
    if (reply.done || reply.nextSeq <= from) return { events, lost: false, complete: reply.done, nextSeq: reply.nextSeq };
    from = reply.nextSeq;
  }
  return { events, lost: false, complete: from >= input.total, nextSeq: from };
}
