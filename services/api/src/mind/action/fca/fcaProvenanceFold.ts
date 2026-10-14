import { createHash } from 'node:crypto';
import type { TaskSource } from '../taskRuntime/taskRuntimePorts.js';

type MemoryRow = Extract<TaskSource, { kind: 'memory' }>;
type ProvenanceGroup = { at: string; stepId: string; recalled: Set<string>; read: Set<string> };

/**
 * A task's provenance in the form one check walks, with the same verdict as its rows. A task observes memory every step (its
 * recall packet and the skill index, each one row of its own however often the same ids recur), and inherits its parent's rows,
 * so their number grows with its steps; the distinct ids barely do (2026-10-14: 65 rows, 64 ids). Conversation turns are kept
 * as they are: each is judged as its own turn.
 *
 * Memory rows become one source per time: each recalled and each read id at the earliest time any row observed it, and the
 * earliest time of all (where the task's own words are judged) even without an id. Every rule that depends on that time
 * (a correction's boundary, a withholding rule's boundary: `observedAt <= boundary`) withholds an earlier observation whenever it
 * withholds a later one, and the rest (a forget, a source that went away) do not depend on it; so the earliest is the strictest,
 * and nothing a row would withhold is shown.
 *
 * Over `limit` sources, consecutive times fold into one at the earliest of them: stricter still (an id observed only after a
 * correction may be judged as before it, closed), never weaker. Only a task the cap applies to passes a finite limit: the root,
 * a conversation and the sleep task are never hidden by the cap, so they are never folded either (review of 6f6b6f80).
 */
export function foldFcaProvenance(rows: readonly TaskSource[], limit: number, cache?: FcaProvenanceFoldCache): TaskSource[] {
  const kept = rows.filter(row => row.kind !== 'memory'), memory = rows.filter((row): row is MemoryRow => row.kind === 'memory');
  if (memory.length < 2) return [...rows];
  const room = Math.max(1, limit - kept.length);
  return [...kept, ...(cache ? cache.fold(memory, room) : foldMemory(memory, room))];
}

/**
 * The folded memory part of recent checks, so that a check repeated over the same rows (every tool call and gate of a step asks)
 * does not walk every id of every row again: 2,000 rows of 2,000 ids took ~164 ms a call (review of 6f6b6f80). Keyed by the rows'
 * identity: a memory row (`fca_task_sources`, primary key `step_id`) is written once and never changed (`TaskSourceStore.observe`
 * only inserts; `bind` and `fail` touch pending conversation rows only), so its step id, time and id counts name its content.
 * The key costs one pass over the rows, not over their ids.
 */
export class FcaProvenanceFoldCache {
  private readonly entries = new Map<string, MemoryRow[]>();
  /** How many folds were computed (not reused); read by tests. */
  misses = 0;
  constructor(private readonly kept = 64) {}
  fold(memory: readonly MemoryRow[], room: number): MemoryRow[] {
    const hash = createHash('sha256').update(String(room));
    for (const row of memory) {
      hash.update(`\u0000${row.stepId}\u0001${row.observedAt}\u0001${row.recalledMemoryIds.length}\u0001${row.readSourceIds?.length ?? 0}`);
    }
    const key = hash.digest('hex'), known = this.entries.get(key);
    if (known) {
      this.entries.delete(key); // most recently used last
      this.entries.set(key, known);
      return known;
    }
    this.misses += 1;
    const folded = foldMemory(memory, room);
    if (this.entries.size >= this.kept) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, folded);
    return folded;
  }
}

function foldMemory(memory: readonly MemoryRow[], room: number): MemoryRow[] {
  // Every row's time, its step the first of its rows (deterministic); then each id at the earliest row that observed it.
  const groups = new Map<string, ProvenanceGroup>();
  for (const row of memory) {
    const known = groups.get(row.observedAt);
    if (!known) groups.set(row.observedAt, { at: row.observedAt, stepId: row.stepId, recalled: new Set(), read: new Set() });
    else if (row.stepId < known.stepId) known.stepId = row.stepId;
  }
  for (const [id, at] of earliestObservations(memory, row => row.recalledMemoryIds)) groups.get(at)!.recalled.add(id);
  for (const [id, at] of earliestObservations(memory, row => row.readSourceIds ?? [])) groups.get(at)!.read.add(id);
  const times = [...groups.keys()].sort(), first = times[0]!;
  let ordered = times.map(at => groups.get(at)!).filter(item => item.at === first || item.recalled.size || item.read.size);
  if (ordered.length > room) {
    const all = ordered;
    ordered = Array.from({ length: room }, (_, index) => {
      const bucket = all.slice(Math.floor(index * all.length / room), Math.floor((index + 1) * all.length / room));
      const union = (pick: (item: ProvenanceGroup) => Set<string>) => new Set(bucket.flatMap(item => [...pick(item)]));
      return { at: bucket[0]!.at, stepId: bucket[0]!.stepId, recalled: union(item => item.recalled), read: union(item => item.read) };
    });
  }
  return ordered.map((item): MemoryRow => ({ kind: 'memory', stepId: item.stepId, experienceId: null, threadId: null,
    observedAt: item.at, recalledMemoryIds: [...item.recalled].sort(),
    ...(item.read.size ? { readSourceIds: [...item.read].sort() } : {}) }));
}

/** Each id with the earliest time any row observed it. */
function earliestObservations(rows: readonly MemoryRow[], ids: (row: MemoryRow) => readonly string[]): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const row of rows) {
    for (const id of ids(row)) {
      const known = earliest.get(id);
      if (known === undefined || row.observedAt < known) earliest.set(id, row.observedAt);
    }
  }
  return earliest;
}

/**
 * Whether a walk of `candidate` that the guard would make is implied by a walk of `verified` that found it visible, both folded with
 * the same limit (`foldFcaProvenance`) for the same task, scope and moment and the same `pendingStepId` (none, for the evidence store).
 *
 * A walk is an AND of independent checks, each of one source and a time: a conversation turn on its own (existence, thread,
 * withholding of the turn, of its message and of the task's words at its time); for each folded memory source at time t, each
 * recalled id read and not withheld at t, each read receipt available at t, and the task's own words not withheld at t. A rule that
 * depends on the time withholds an earlier observation whenever it withholds a later one (`foldFcaProvenance` above, which rests on
 * the same fact), so a check that passed at t' passes at every t >= t'. Hence the candidate is visible when every one of its
 * checks was made by the verified walk at the same or an earlier time:
 * - every conversation source of the candidate is a source of the verified list, field for field;
 * - every memory source of the candidate is no earlier than the verified list's earliest memory source (the task's words);
 * - each of its recalled ids and read receipts was folded in the verified list at the same or an earlier time.
 *
 * Plain inclusion of the rows is not enough: past the limit consecutive times are folded into their earliest (`foldMemory`), and
 * the buckets of a shorter list need not align with the longer one's, so a subset can judge an id earlier (stricter) than its
 * superset did. Such a candidate is not covered here and is walked in full.
 */
export function foldedProvenanceCovers(verified: readonly TaskSource[], candidate: readonly TaskSource[]): boolean {
  const known = coverageOf(verified);
  for (const source of candidate) {
    if (source.kind !== 'memory') {
      if (!known.turns.has(canonicalSource(source))) return false;
      continue;
    }
    if (known.earliest === null || source.observedAt < known.earliest) return false;
    if (!earlierOrSame(known.recalled, source.recalledMemoryIds, source.observedAt)) return false;
    if (!earlierOrSame(known.read, source.readSourceIds ?? [], source.observedAt)) return false;
  }
  return true;
}

type Coverage = { turns: ReadonlySet<string>; earliest: string | null; recalled: ReadonlyMap<string, string>; read: ReadonlyMap<string, string> };
/** Per verified list (the fold cache hands back the same array while its rows are the same). */
const COVERAGE = new WeakMap<readonly TaskSource[], Coverage>();
function coverageOf(verified: readonly TaskSource[]): Coverage {
  const known = COVERAGE.get(verified);
  if (known) return known;
  const memory = verified.filter((row): row is MemoryRow => row.kind === 'memory');
  const turns = new Set(verified.filter(row => row.kind !== 'memory').map(canonicalSource));
  const earliest = memory.reduce<string | null>((first, row) => first === null || row.observedAt < first ? row.observedAt : first, null);
  const coverage = { turns, earliest, recalled: earliestObservations(memory, row => row.recalledMemoryIds),
    read: earliestObservations(memory, row => row.readSourceIds ?? []) };
  COVERAGE.set(verified, coverage);
  return coverage;
}
function earlierOrSame(known: ReadonlyMap<string, string>, ids: readonly string[], at: string): boolean {
  return ids.every(id => {
    const first = known.get(id);
    return first !== undefined && first <= at;
  });
}
/** A source as one comparable string, whatever the order its fields were written in. */
function canonicalSource(source: TaskSource): string {
  return JSON.stringify(source, Object.keys(source).sort());
}
