import { DatabaseSync } from 'node:sqlite';
import { MemoryWithholding } from '../../src/mind/memory/memoryVisibility.js';

/**
 * Counts of the questions a piece of work asks, which do not move with the machine (the loop-stall budgets are held on these in CI; the
 * seconds they come to are measured by `tests/perf/loopStallBudget.ts`, where a loaded machine cannot fail a suite).
 */
type Method = (...args: unknown[]) => unknown;

/** The methods of `MemoryWithholding` a walk of the recall graph asks over and over. */
export const WITHHOLDING_QUESTIONS = ['withholdsReply', 'recalledWithheldWithin', 'provenanceWithheld', 'sourceVisible', 'withholdsExperience'] as const;

/** Counts calls of the named methods of every `MemoryWithholding`, and (`statements`) of `DatabaseSync.prepare`, while `work` runs. */
export function counting<T>(names: readonly string[], work: () => T, options: { statements?: boolean } = {}): { value: T; counts: Record<string, number> } {
  const stop = startCounting(names, options.statements === true);
  try { return { value: work(), counts: stop.counts }; } finally { stop.restore(); }
}

/** The same for work that is asynchronous: the counts run until it settles. */
export async function countingAsync<T>(names: readonly string[], work: () => Promise<T>, options: { statements?: boolean } = {}): Promise<{ value: T; counts: Record<string, number> }> {
  const stop = startCounting(names, options.statements === true);
  try { return { value: await work(), counts: stop.counts }; } finally { stop.restore(); }
}

function startCounting(names: readonly string[], statements: boolean) {
  const proto = MemoryWithholding.prototype as unknown as Record<string, Method>;
  const counts: Record<string, number> = {}, originals = new Map<string, Method>();
  for (const name of names) {
    const original = proto[name]!; originals.set(name, original); counts[name] = 0;
    proto[name] = function (this: unknown, ...args: unknown[]) { counts[name]! += 1; return original.apply(this, args); };
  }
  const database = DatabaseSync.prototype as unknown as Record<string, Method>, prepare = database.prepare!;
  if (statements) {
    counts.prepare = 0;
    database.prepare = function (this: unknown, ...args: unknown[]) { counts.prepare! += 1; return prepare.apply(this, args); };
  }
  return { counts, restore() {
    for (const [name, original] of originals) proto[name] = original;
    if (statements) database.prepare = prepare;
  } };
}
