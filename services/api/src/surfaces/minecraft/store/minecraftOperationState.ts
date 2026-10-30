import type { HoldState, OperationState } from '../../../contracts/continueContract.js';

/**
 * One body operation's states (continue contract 1, 「不明の結果」): the result axis (`sent`, `settled_known`, `settled_unknown`,
 * `released`, `corrected`) and the hold
 * axis (`none`, `held`, `resumed`, `cancelled`) move independently. This is the one table the store, the safe test, the queue and
 * the ledger all read; nothing here
 * touches a database, so a test can drive it with the events of the contract's fixtures (`result/unknown-state-machine.json`,
 * `result/held-two-axes.json`).
 */
export interface OperationAxes {
  state: OperationState;
  hold: HoldState;
  /** The model has been told that the result was unknown: only then does a later real receipt count as a correction (12 章の決め 5). */
  told: boolean;
}

/** Whether a receipt gives a known result: it did not end `unknown` and the inputs were released. */
export type ReceiptReading = 'known' | 'unknown';
export const readingOf = (receipt: { outcome: string; inputsReleased: boolean }): ReceiptReading =>
  receipt.outcome !== 'unknown' && receipt.inputsReleased === true ? 'known' : 'unknown';

export type OperationEvent =
  /** A receipt of the body (read as known or unknown). */
  | { kind: 'receipt'; reading: ReceiptReading }
  /** The body's release was proved: the cleanup stop's receipt, the first poll of a new connection with nothing running, or the lease's re-check. */
  | { kind: 'release_proved' }
  /** The cleanup stop did not prove the release in `CLEANUP_LIMIT_MS`, or could not be sent. */
  | { kind: 'cleanup_failed' }
  | { kind: 'operator_resume' }
  | { kind: 'operator_cancel' };

/** What the event does to the two axes. An event that changes nothing returns the axes as they are. */
export function stepAxes(current: OperationAxes, event: OperationEvent): OperationAxes {
  const { state, hold, told } = current;
  switch (event.kind) {
    case 'receipt': return receiptAxes(current, event.reading);
    case 'release_proved': return state === 'sent' || state === 'settled_unknown' ? { ...current, state: 'released' } : current;
    case 'cleanup_failed': return hold === 'none' || hold === 'resumed' ? { ...current, hold: 'held' } : current;
    case 'operator_resume': return hold === 'held' ? { ...current, hold: 'resumed' } : current;
    case 'operator_cancel': return { ...current, hold: 'cancelled' };
  }
}

/** The states in which the operation's result is settled for the lifecycle's `safe` (the hold axis is the
 * operator's, not the safe test's). */
export const RESOLVED_STATES: readonly OperationState[] = ['settled_known', 'released', 'corrected'];
export const isResolved = (state: OperationState): boolean => RESOLVED_STATES.includes(state);

/** The table's `safe` column: `sent` is unresolved (an item the step itself still waits for is excluded by the caller),
 * `settled_unknown` is unresolved. */
export const isSafeState = (state: OperationState, openItem = false): boolean => isResolved(state) || (state === 'sent' && openItem);

/** The result state of a row that has none yet (a database made before this column), from what the row had. */
export function stateFromLegacy(row: { hasReceipt: boolean; reconciled: boolean; outcome?: string | null; inputsReleased?: boolean | null }): OperationState {
  if (!row.hasReceipt) return 'sent';
  if (row.reconciled) return 'released';
  return row.outcome === 'unknown' || row.inputsReleased !== true ? 'settled_unknown' : 'settled_known';
}

/** 受領結果だけが状態軸へ与える変化。保持軸はそのまま。 */
function receiptAxes(current: OperationAxes, reading: Extract<OperationEvent, { kind: 'receipt' }>['reading']): OperationAxes {
  const { state, told } = current;

      if (reading === 'unknown') return state === 'sent' ? { ...current, state: 'settled_unknown' } : current;
      if (state === 'sent') return { ...current, state: 'settled_known' };
      // A real result after an unknown one: a correction when the model was told the unknown, else it is the ordinary result.
      if (state === 'settled_unknown' || state === 'released') return { ...current, state: told ? 'corrected' : 'settled_known' };
      return current;
    }
