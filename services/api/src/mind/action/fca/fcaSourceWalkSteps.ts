import { createTaskMemory, type Steps, type TaskMemory, type TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { TaskSource, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { ShannonExperience } from '../../memory/memoryPorts.js';
import type { FcaSourceGuardParts } from './fcaConversationSources.js';
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

/**
 * Every source of a task visible, in steps (moved from the source guard, mb-llmc r9, to keep its file under the bound): `inTurns`, each chunk of a
 * memory source is a read in steps (`TaskMemory.steps`), else read at once. `checked`: the guard's parts with the walk's own receipt check.
 */
export function* everySourceVisible(checked: FcaSourceGuardParts, scopeKey: string, task: TaskView, sources: readonly TaskSource[],
  pendingStepId: string | undefined, state: CompanionStateSnapshot, withholding: MemoryWithholding, inTurns: boolean): Steps<boolean> {
  // One fresh read of each remembered turn for the whole walk: each 40-id read used to fetch every turn of its lineage again, one
  // query and one parse each. Minecraft run 10 (2026-10-14), profiled on a copy of the production database: 5,366 fetches of
  // 190 distinct turns, 0.9–1.5 s a walk; with one read each, 0.4–0.6 s. The rows are read now, as before, only not again.
  const turns = new Map<string, ShannonExperience | null>();
  const experience = (id: string) => {
    if (!turns.has(id)) turns.set(id, checked.conversations.experiencesById?.(scopeKey, [id])[0] ?? null);
    return turns.get(id)!;
  };
  const shared = { state, withholding, experience };
  const words = [task.title, task.goal, task.completionCriteria, task.summary].join('\n');
  for (const source of sources) {
    if (source.kind === 'memory') {
      const memory = createTaskMemory({ ...checked, now: () => source.observedAt });
      if (!(yield* everyIdReads(memory, scopeKey, [...new Set(source.recalledMemoryIds)], shared, inTurns))) return false;
      if (source.readSourceIds?.some(id => !checked.readSourceVisible?.(scopeKey, id, source.observedAt))
        || withholding.withholdsReply({ text: words, observedAt: source.observedAt, recalledMemoryIds: source.recalledMemoryIds })) return false;
      continue;
    }
    if (!source.experienceId) {
      if (!unboundSourceVisible(source, words, pendingStepId, withholding)) return false;
      continue;
    }
    if (source.readSourceIds?.some(id => !checked.readSourceVisible?.(scopeKey, id, source.observedAt))) return false;
    const turn = checked.conversations.experiencesById?.(scopeKey, [source.experienceId])[0];
    if (!turn || checked.conversations.threadOfTurn?.(scopeKey, source.experienceId) !== source.threadId) return false;
    if (withholding.withholdsExperience({ ...turn, recalledMemoryIds: source.recalledMemoryIds })
      || withholding.withholdsMessage({ id: source.experienceId, sourceExperienceId: source.experienceId, role: 'user', content: turn.userMessage,
        observedAt: source.observedAt })
      || withholding.withholdsReply({ experienceId: source.experienceId, observedAt: source.observedAt, recalledMemoryIds: source.recalledMemoryIds,
        text: words })) return false;
  }
  return true;
}

/**
 * Conversation work made in a turn still in progress runs at once (owner decision 2026-10-13): until the turn binds, the task's
 * own words are judged like any reply, and the bound turn is judged in full on the next check (the verdict key holds the sources).
 */
function unboundSourceVisible(source: TaskSource, words: string, pendingStepId: string | undefined, withholding: MemoryWithholding): boolean {
  if (source.stepId === pendingStepId) return true; // the turn that is asking
  return source.kind !== 'memory' && source.pending === true
    && !withholding.withholdsReply({ observedAt: source.observedAt, recalledMemoryIds: source.recalledMemoryIds, text: words });
}