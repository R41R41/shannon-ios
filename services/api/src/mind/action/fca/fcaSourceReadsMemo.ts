import { namedWork } from '../../../infra/observer/eventLoopWatch.js';
import type { Steps } from '../../memory/memoryStepsPorts.js';

/** Every read receipt a verdict consulted: the source's id, the time it was consulted at, and whether it was visible. */
export type ConsultedReads = ReadonlyArray<readonly [string, string, boolean]>;

/** Receipts asked in one step of the walk in turns (a step is a few milliseconds; `inTurns` gives the loop back after `STEP_SLICE_MS`). */
export const FCA_SOURCE_READS_STEP = 16;

/**
 * mb-llmc r9 (run 33: 145 of the API's 208 slow source checks were `mode=partial via=step`, 120–507 ms each, all in `reads`: a base older than
 * a verdict asks every receipt it consulted at every time, thousands (6,624 in the receipt-answer counts), at every use, on the one thread;
 * `source_walk_reads` was 144 of the 260 loop delays and the longest part of them). Two parts, neither changing what is seen:
 * - a check walked in turns of the loop asks them in steps (`askInSteps`, the shape of the recall-yield walk);
 * - a list found unchanged is not asked again while the inputs every answer is made from are the same (`FcaSourceGuard` option
 *   `readFingerprint`: the rows' mark, the state's version, the connections, the skill checks and her skills' mark, the same inputs
 *   `fcaReadSourceAnswers.ts` gives an answer again under): a use that finds the same fingerprint would be given every answer it asked
 *   before, so it is answered at once; one that finds another asks as before. Without the option (or where it says null: inside a
 *   transaction, or a receipt of a family whose answer rests on the clock or an outside store) every use asks, as before.
 *
 * The memo: the fingerprint under which each list of receipts was last found unchanged, by the list itself (a base and the verdicts made
 * with it hold the same list). `every`: it covers every receipt at every time, not one time per source.
 */
export function createReadsMemo<State>(fingerprint: ((scopeKey: string, state: State, receiptIds: readonly string[]) => string | null) | undefined) {
  const memos = new WeakMap<object, { fingerprint: string; every: boolean }>();
  const receiptIds = new WeakMap<object, readonly string[]>();
  return {
    /** The fingerprint of the inputs the answers of `reads` are made from now, or null (no option, empty list, or it cannot be told). */
    of(state: State, scopeKey: string, reads: ConsultedReads): string | null {
      if (!fingerprint || !reads.length) return null;
      let ids = receiptIds.get(reads);
      if (!ids) receiptIds.set(reads, ids = [...new Set(reads.map(read => read[0]))]);
      try { return fingerprint(scopeKey, state, ids); } catch { return null; }
    },
    /** The inputs alone, naming no receipt (to see none moved while a walk was made). */
    inputs(state: State, scopeKey: string): string | null {
      try { return fingerprint?.(scopeKey, state, []) ?? null; } catch { return null; }
    },
    holds(reads: ConsultedReads, print: string | null, every: boolean): boolean {
      const memo = memos.get(reads);
      return print !== null && !!memo && memo.fingerprint === print && (memo.every || !every);
    },
    keep(reads: ConsultedReads, print: string, every: boolean): void { memos.set(reads, { fingerprint: print, every }); },
  };
}

/**
 * The receipts asked again in steps: `check` answers whether a receipt (its id and the time it was consulted at) is as it was; `hold` is the
 * walk's own hold of the snapshot the answers share (released at the end); `add` is told the milliseconds each step took. `false` at the
 * first receipt that changed.
 */
export function* askInSteps(asked: ConsultedReads, check: ((id: string, observedAt: string) => boolean | undefined) | undefined, hold: () => () => void,
  clock: () => number, add?: (milliseconds: number) => void): Steps<boolean> {
  const release = hold();
  try {
    for (let offset = 0; offset < asked.length; offset += FCA_SOURCE_READS_STEP) {
      const started = clock();
      const same = namedWork('source_walk_reads', () => asked.slice(offset, offset + FCA_SOURCE_READS_STEP)
        .every(([id, observedAt, visible]) => check?.(id, observedAt) === visible));
      add?.(clock() - started);
      if (!same) return false;
      yield;
    }
    return true;
  } finally { release(); }
}
