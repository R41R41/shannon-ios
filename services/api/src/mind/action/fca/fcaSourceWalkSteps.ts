import type { Steps, TaskMemory, TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { TaskSource } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaWalkTiming } from './fcaWalkTiming.js';

/**
 * The FCA source guard's walk in turns of the loop (`FcaSourceGuard.warm`, recall-yield 2026-10-22; production run 31: the check of a body
 * recall's 315 sources walked 862 ms at once). Its parts that need nothing of the guard's own: the walk under its withholdings, each held
 * open for it, and a memory source's ids read 40 at a time, as reads in steps (`TaskMemory.steps`) or at once.
 */
export function* walkInTurns(timing: FcaWalkTiming, monotonic: () => number, walked: readonly TaskSource[],
  holds: ReadonlyArray<() => () => void>, steps: Steps<boolean>): Steps<boolean> {
  if (!walked.length) return true;
  const started = monotonic(), releases = holds.map(hold => hold());
  try {
    return yield* steps;
  } finally {
    for (const release of releases.reverse()) release();
    timing.add('walk', monotonic() - started);
  }
}

/** Whether every one of `ids` reads (40 at a time, as the walk at once reads them); `inTurns`: each a read in steps. */
export function* everyIdReads(memory: TaskMemory, scopeKey: string, ids: readonly string[], shared: TaskMemoryReadSnapshot,
  inTurns: boolean): Steps<boolean> {
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const read = inTurns ? yield* memory.steps!.read(scopeKey, chunk, { kind: 'owner' }, shared, { provenance: false })
      : memory.read(scopeKey, chunk, { kind: 'owner' }, shared, { provenance: false });
    if (read.length !== chunk.length) return false;
  }
  return true;
}
