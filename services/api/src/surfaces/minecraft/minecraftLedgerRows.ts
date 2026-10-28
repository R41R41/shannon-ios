import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { FcaPlanPort } from '../../mind/action/fca/fcaPlanTools.js';
import { carried, doneFacts } from './minecraftConditions.js';
import { ledgerRow, ledgerUnexplainedRow, type RowContext } from './minecraftOperationRows.js';
import type { QueueRecordRow } from './minecraftLlmcQueue.js';

/**
 * The decision record's `ledger` and `ledger_unexplained` rows (continue contract 8; the judge's boundary 3 reads them): what the ledger took of one call (the ids of the
 * events it applied, once each), the counts of the promises it holds and the counts the observation shows, and the difference no event explains. The ledger is the plan's
 * (`FcaPlanPort.applyLedger`, the one way in); this only looks at what it did, before and after, and says so in the record. It changes nothing the ledger returns.
 */
export interface LedgerRecording {
  /** The run (the task's id), the head's boot and the queue's name (a call from a reflex has no command). */
  run: string; headBoot: string; queue?: string;
  record(row: QueueRecordRow): void;
  now?(): number;
}

type Input = Parameters<FcaPlanPort['applyLedger']>[0];

/** What she carries of a promise's item in a frame, as the ledger counts it (the food points for `food`). */
function observedHave(item: string, observation: BodyObservation | null): number | null {
  const facts = doneFacts(observation);
  return facts ? (item === 'food' ? facts.food : carried(facts.counts, item)) : null;
}

/** `port.applyLedger(input)`, with its rows written to the record. A recorder that fails never fails the ledger. */
export function recordedLedger(port: Pick<FcaPlanPort, 'applyLedger' | 'ledgerSeen' | 'tree'>, input: Input, recording: LedgerRecording): ReturnType<FcaPlanPort['applyLedger']> {
  let before: Set<string> | null = null;
  try { before = new Set(port.ledgerSeen().eventIds); } catch { /* the row is left out */ }
  const added = port.applyLedger(input);
  try {
    if (!before) return added;
    const command = input.by?.command, item = input.by?.item;
    const context: RowContext = { run: recording.run, ...(recording.queue ? { queue: recording.queue } : {}), ...(command ? { command } : {}), ...(item ? { item } : {}),
      headBoot: recording.headBoot, observation: input.observation, at: new Date((recording.now ?? Date.now)()).toISOString() };
    const applied = [...new Set(input.events.map(event => event?.id).filter((id): id is string => typeof id === 'string' && !before!.has(id)))];
    // The counts are told only when the ledger took this very observation (an older one leaves `have` where it was: there is nothing to compare it with).
    const seen = port.ledgerSeen().lastObs, took = !!input.observation && !!seen && seen.obsSeq === input.observation.sequence;
    const have: Record<string, number> = {}, observed: Record<string, number> = {};
    if (took) {
      for (const promise of port.tree().promises) {
        const now = observedHave(promise.item, input.observation);
        if (promise.state === 'closed' || promise.have === undefined || now === null) continue;
        have[promise.item] = promise.have;
        observed[promise.item] = now;
      }
    }
    const declared = added.find(line => line.declared);
    if (applied.length || added.length || Object.keys(have).length) {
      recording.record(ledgerRow(context, { applied, have, observed, ...(declared ? { promiseRev: declared.promiseRev } : {}) }));
    }
    // A loss under a death is the death's, not a mystery: only what no event and no death explains is told.
    const unexplained = added.filter(line => line.kind === 'unexplained');
    if (unexplained.length) recording.record(ledgerUnexplainedRow(context, unexplained.reduce((sum, line) => sum + Math.abs(line.count), 0)));
  } catch { /* a record never fails the ledger */ }
  return added;
}
