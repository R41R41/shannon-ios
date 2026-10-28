import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ItemOutcome, StageRow, TraceIds } from '../../contracts/continueContract.js';
import { unitFromOutcome } from '../../contracts/continueContract.js';
import type { MinecraftControlReceipt } from '../../contracts/minecraftControlContract.js';

/**
 * The rows the head writes into the decision record for a command's result (continue contract 8: `received`, `released`, `corrected`) and the rows the judge asks for
 * beside them (`tools/continue-verify/judge.ts`: `head_boot`, `unknown_notified`, `events`, `ledger`). **Pure**: they build the row from what the queue knows; the
 * records' owner connects them to the recorder (`decisionRecorder`), which writes them in `events.jsonl`. The queue calls `deps.record(row)` at each place marked
 * the places the queue records.
 */
export interface RowContext {
  /** The run (the task's id, which is also the decision record's folder name). */
  run: string;
  queue?: string; item?: string; command?: string; headBoot?: string;
  /** The newest observation the head has: the life, the observation's number and time. */
  observation: BodyObservation | null;
  at: string;
}

/** The numbers that join the records (continue contract 8's `TraceIds`); `life` is -1 when the observation has none. */
export function idsOf(context: RowContext): TraceIds {
  const state = context.observation?.state as { life?: { life?: unknown }; bodyRun?: { bodyBoot?: unknown } } | undefined;
  const life = state?.life?.life, bodyBoot = state?.bodyRun?.bodyBoot;
  return { run: context.run, ...(context.command ? { command: context.command } : {}), ...(context.queue ? { queue: context.queue } : {}),
    ...(context.item ? { item: context.item } : {}), life: Number.isSafeInteger(life) ? life as number : -1, ...(typeof bodyBoot === 'string' ? { bodyBoot } : {}),
    ...(context.headBoot ? { headBoot: context.headBoot } : {}), obsSeq: context.observation?.sequence ?? -1, obsAt: context.observation?.stateAt ?? context.at };
}

/** A receipt came in (the first one, or the one after an unknown): its outcome, its unit (the old words read as one when it has none) and the body's times. */
export function receivedRow(context: RowContext, receipt: MinecraftControlReceipt): Extract<StageRow, { ev: 'received' }> {
  const unit: ItemOutcome = receipt.unit ?? unitFromOutcome(receipt.outcome, receipt.inputsReleased);
  return { ev: 'received', at: context.at, ids: idsOf(context), receipt: { outcome: receipt.outcome, unit }, ...(receipt.bodyTimes ? { bodyTimes: receipt.bodyTimes } : {}) };
}
/** The body's release of a command was proved (`receipt`: its own receipt; `cleanup`: the stop the head sent after an unknown result, or the new connection's first poll). */
export const releasedRow = (context: RowContext, by: 'receipt' | 'cleanup', ok: boolean): Extract<StageRow, { ev: 'released' }> =>
  ({ ev: 'released', at: context.at, ids: idsOf(context), by, ok });
/** A real result came after an unknown one the model had been told. */
export const correctedRow = (context: RowContext, now: ItemOutcome): Extract<StageRow, { ev: 'corrected' }> =>
  ({ ev: 'corrected', at: context.at, ids: idsOf(context), was: 'unknown', now });

/** The queue asked the model to decide: why (`remaining`: the running item has about `predictedRemainingMs` left; the others are the wake's own reasons). */
export const wokeRow = (context: RowContext, why: Extract<StageRow, { ev: 'woke' }>['why'], predictedRemainingMs?: number): Extract<StageRow, { ev: 'woke' }> =>
  ({ ev: 'woke', at: context.at, ids: idsOf(context), why, ...(predictedRemainingMs !== undefined ? { predictedRemainingMs: Math.round(predictedRemainingMs) } : {}) });
/** The model was told that the command's result is unknown (the judge reads it to tell a correction from an ordinary result after a head restart). */
export const unknownNotifiedRow = (context: RowContext) => ({ ev: 'unknown_notified' as const, at: context.at, ids: idsOf(context) });
/** The head registered its start with the body (the first reply of a poll carried `headBoot`). */
export const headBootRow = (context: RowContext, headBoot: string) => ({ ev: 'head_boot' as const, at: context.at, headBoot, ids: idsOf({ ...context, headBoot }) });
/** The internal `events` command answered (`lost`: the body lost its record). */
export const eventsRow = (context: RowContext, lost: boolean) => ({ ev: 'events' as const, at: context.at, ids: idsOf(context), lost });
/** The ledger took these events: their ids, the promises' counts it holds and the counts the observation shows. */
export const ledgerRow = (context: RowContext, parts: { applied: string[]; have: Record<string, number>; observed: Record<string, number>; promiseRev?: number }) =>
  ({ ev: 'ledger' as const, at: context.at, ids: idsOf(context), ...parts });
/** What the ledger shows no event explains (the sum of its lines of kind `unexplained`): the judge's boundary 8 asks for it after a body that lost its record. */
export const ledgerUnexplainedRow = (context: RowContext, count: number) => ({ ev: 'ledger_unexplained' as const, at: context.at, ids: idsOf(context), count });
