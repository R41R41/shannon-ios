/**
 * The temporal rules of people facts (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`; after Graphiti). A fact carries
 * when it was true in the world (`validAt`, `invalidAt`) and when she stopped believing it (`expiredAt`), with the episodes it came
 * from. A contradiction closes the older fact and never deletes it; a duplicate adds its episodes and changes no text.
 *
 * Pure: the caller hands the rows, the writer's judgement (which rows the new fact duplicates or contradicts) and the time.
 */
export const TEMPORAL_FACTS_V1 = Object.freeze({ version: 'temporal.v1', maximumEpisodes: 32 });

export interface TemporalFact {
  id: string;
  /** When it became true in the world, or null when unknown (taken as always). */
  validAt: string | null;
  /** When it stopped being true in the world, or null while it is. */
  invalidAt: string | null;
  /** When she stopped believing it (a contradiction, the owner's correction), or null. */
  expiredAt: string | null;
  episodeIds: readonly string[];
  /** Counts every change of the row, for the writer's compare-and-set. */
  revision: number;
}

const time = (value: string | null) => (value === null ? null : Date.parse(value));

/** Whether the fact holds at `at`: not expired by then, and `at` inside [validAt, invalidAt). Recall leaves out the rest. */
export function factCurrent(fact: Pick<TemporalFact, 'validAt' | 'invalidAt' | 'expiredAt'>, at: string): boolean {
  const now = Date.parse(at);
  const expired = time(fact.expiredAt);
  if (expired !== null && expired <= now) return false;
  const valid = time(fact.validAt);
  const invalid = time(fact.invalidAt);
  return (valid === null || valid <= now) && (invalid === null || invalid > now);
}

/** The episode lists joined, first seen first, without repeats, at most 32 (the newest kept). */
export function joinedEpisodes(left: readonly string[], right: readonly string[]): readonly string[] {
  const joined = [...new Set([...left, ...right])];
  return Object.freeze(joined.slice(Math.max(0, joined.length - TEMPORAL_FACTS_V1.maximumEpisodes)));
}

/** A duplicate: the older row gains the episodes and nothing else (its text is not rewritten). */
export function duplicateOf(older: TemporalFact, episodeIds: readonly string[]): TemporalFact {
  const episodes = joinedEpisodes(older.episodeIds, episodeIds);
  if (episodes.length === older.episodeIds.length && episodes.every((id, index) => id === older.episodeIds[index])) return older;
  return Object.freeze({ ...older, episodeIds: episodes, revision: older.revision + 1 });
}

/**
 * A contradiction between an older and a newer fact (Graphiti's rule): the one that began earlier is closed where the other begins
 * (`invalidAt` = the other's `validAt`, `expiredAt` = now). When the older one began after the newer (the newer tells of an
 * earlier time), the newer is the one closed. A fact already closed earlier keeps its earlier end. Nothing is deleted.
 */
export function contradiction(older: TemporalFact, newer: TemporalFact, now: string): { older: TemporalFact; newer: TemporalFact } {
  const olderValid = time(older.validAt);
  const newerValid = time(newer.validAt);
  const close = (fact: TemporalFact, at: string | null): TemporalFact => {
    const end = at ?? now;
    const invalidAt = fact.invalidAt !== null && Date.parse(fact.invalidAt) <= Date.parse(end) ? fact.invalidAt : end;
    return Object.freeze({ ...fact, invalidAt, expiredAt: fact.expiredAt ?? now, revision: fact.revision + 1 });
  };
  if (olderValid !== null && newerValid !== null && olderValid > newerValid) return { older, newer: close(newer, older.validAt) };
  return { older: close(older, newer.validAt), newer };
}

export interface FactJudgement {
  /** Ids of rows the new fact repeats. */
  duplicates: readonly string[];
  /** Ids of rows the new fact contradicts. */
  contradicts: readonly string[];
}

export interface FactResolution {
  /** Rows to write back (compare-and-set on their revision before this change). */
  updates: readonly TemporalFact[];
  /** The new fact to insert, or null when it only repeated a row. */
  insert: TemporalFact | null;
}

/**
 * Applies the writer's judgement to the person's rows: a duplicate appends the new fact's episodes to the first row it repeats and
 * inserts nothing; otherwise every contradicted row (among the given rows, current ones only) is closed and the new fact inserted.
 * Ids the judgement names that are not among the rows are ignored.
 */
export function resolvedFact(rows: readonly TemporalFact[], incoming: TemporalFact, judgement: FactJudgement, now: string): FactResolution {
  const byId = new Map(rows.map(row => [row.id, row]));
  const repeated = judgement.duplicates.map(id => byId.get(id)).find((row): row is TemporalFact => row !== undefined && row.expiredAt === null);
  if (repeated) {
    const updated = duplicateOf(repeated, incoming.episodeIds);
    return { updates: Object.freeze(updated === repeated ? [] : [updated]), insert: null };
  }
  const updates: TemporalFact[] = [];
  let inserted = incoming;
  for (const id of [...new Set(judgement.contradicts)]) {
    const row = byId.get(id);
    if (!row || row.expiredAt !== null || row.id === incoming.id) continue;
    const result = contradiction(row, inserted, now);
    if (result.older !== row) updates.push(result.older);
    inserted = result.newer;
  }
  return { updates: Object.freeze(updates), insert: inserted };
}

/** The values a row written before stage 3 is given (the additive backfill): valid since it was written, open, no episodes. */
export function backfilledFact(id: string, createdAt: string): TemporalFact {
  return Object.freeze({ id, validAt: createdAt, invalidAt: null, expiredAt: null, episodeIds: Object.freeze([]), revision: 0 });
}
