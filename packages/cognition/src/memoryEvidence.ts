import type { CompanionStateSnapshot, MemoryControl } from './types.js';

/**
 * Whether a quote of the owner's evidence may still be used: it does not overlap the evidence of a forgotten, rejected or corrected
 * item (`isMemoryEvidenceVisible`). Production 2026-10-14: every turn asked this of every remembered turn, each time normalizing
 * every withheld item's evidence again (`visible=500~600ms` per turn with one forgotten item). Now
 *
 * - the withheld evidence of a state is gathered once per state object, and only for a frozen state, which cannot change after;
 * - a verdict is remembered under the exact content of that gathered evidence (its key is the whole of it, not a hash), the
 *   excepted item and the quote, so a re-read state with the same withheld evidence reuses it, and any forget, restore,
 *   correction or new item that changes what is withheld changes the key. Bounded, cleared when full.
 */
interface Blocker {
  /** Normalized withheld evidence, at least three characters (a shorter one never overlaps). */
  text: string;
  /** The items that withhold it: it is skipped only when every one of them is the excepted item. */
  reasons: readonly string[];
}
interface EvidenceIndex { key: string; blockers: readonly Blocker[] }

const normalizeEvidence = (value: string) => value.replace(/[\s。、]/gu, '');
const withholds = (control: MemoryControl | undefined): control is MemoryControl =>
  Boolean(control && (control.status !== 'active' || control.overrideText));

let INDEX_BY_STATE = new WeakMap<CompanionStateSnapshot, EvidenceIndex>();
/** Remembered verdicts per gathered withheld evidence (its whole text is the key), then per excepted item, then per quote. */
interface Verdicts { byExcept: Map<string | undefined, Map<string, boolean>>; characters: number; entries: number }
const VERDICTS = new Map<string, Verdicts>();
const VERDICT_STATES = 8, VERDICT_ENTRIES = 40_000, VERDICT_CHARACTERS = 4_000_000, VERDICT_QUOTE = 20_000;
let verdictEntries = 0, verdictCharacters = 0;
/** False only inside `withoutMemoryEvidenceCache` (tests compare against verdicts gathered fresh for every question). */
let caching = true;
/** How often a quote was normalized and compared (a verdict not remembered). Read by tests of the cost shape. */
export const memoryEvidenceCounters = { compared: 0, indexed: 0 };

function frozenState(snapshot: CompanionStateSnapshot): boolean {
  if (!Object.isFrozen(snapshot)) return false;
  return [snapshot.memoryControls, snapshot.userFacts, snapshot.relationships, snapshot.prospectiveMemories]
    .every(list => Object.isFrozen(list) && list.every(item => Object.isFrozen(item)));
}

function blockersOf(snapshot: CompanionStateSnapshot): Blocker[] {
  const blockers: Blocker[] = [];
  const add = (value: string | undefined, reasons: readonly string[]) => {
    const text = normalizeEvidence(value ?? '');
    if (text.length >= 3) blockers.push({ text, reasons });
  };
  for (const control of snapshot.memoryControls) {
    if (!withholds(control)) continue;
    add(control.sourceEvidence, [control.memoryId]);
    add(snapshot.userFacts.find(item => item.id === control.memoryId)?.evidence, [control.memoryId]);
    add(snapshot.relationships.find(item => item.id === control.memoryId)?.evidence, [control.memoryId]);
  }
  const controlFor = (memoryId: string) => snapshot.memoryControls.find(control => control.memoryId === memoryId);
  for (const memory of snapshot.prospectiveMemories) {
    const control = controlFor(memory.id), parent = memory.sourceExperienceId ? controlFor(memory.sourceExperienceId) : undefined;
    const reasons = [control, parent].filter(withholds).map(item => item.memoryId);
    if (reasons.length) add(memory.evidence ?? memory.summary, reasons);
  }
  return blockers;
}

function evidenceIndex(snapshot: CompanionStateSnapshot): EvidenceIndex {
  const known = caching ? INDEX_BY_STATE.get(snapshot) : undefined;
  if (known) return known;
  memoryEvidenceCounters.indexed += 1;
  const blockers = blockersOf(snapshot);
  const index = { key: JSON.stringify(blockers.map(blocker => [blocker.text, blocker.reasons])), blockers };
  // Only a state that cannot change keeps its index; any other is gathered again on every question.
  if (caching && frozenState(snapshot)) INDEX_BY_STATE.set(snapshot, index);
  return index;
}

function compared(index: EvidenceIndex, evidence: string, exceptMemoryId: string | undefined): boolean {
  memoryEvidenceCounters.compared += 1;
  const quote = normalizeEvidence(evidence);
  if (quote.length < 3) return true;
  return !index.blockers.some(blocker => blocker.reasons.some(reason => reason !== exceptMemoryId)
    && (blocker.text.includes(quote) || quote.includes(blocker.text)));
}

function clearVerdicts(): void {
  VERDICTS.clear();
  verdictEntries = 0;
  verdictCharacters = 0;
}

/** Marks these verdicts the most recently used (the oldest are dropped first). */
function recent(key: string, kept: Verdicts): Verdicts {
  VERDICTS.delete(key);
  VERDICTS.set(key, kept);
  return kept;
}

/** The verdicts remembered under one gathered withheld evidence (most recently used last; at most `VERDICT_STATES`). */
function verdictsOf(key: string): Verdicts {
  let kept = VERDICTS.get(key);
  if (kept) return recent(key, kept);
  if (VERDICTS.size >= VERDICT_STATES) {
    const oldest = VERDICTS.keys().next().value!, dropped = VERDICTS.get(oldest)!;
    VERDICTS.delete(oldest);
    verdictEntries -= dropped.entries;
    verdictCharacters -= dropped.characters;
  }
  VERDICTS.set(key, kept = { byExcept: new Map(), characters: key.length, entries: 0 });
  verdictCharacters += key.length;
  return kept;
}

function remember(key: string, exceptMemoryId: string | undefined, evidence: string, result: boolean): void {
  // Bounded: when full, everything remembered is dropped and asked again.
  if (verdictEntries >= VERDICT_ENTRIES || verdictCharacters + key.length + evidence.length > VERDICT_CHARACTERS) clearVerdicts();
  const kept = verdictsOf(key);
  let verdicts = kept.byExcept.get(exceptMemoryId);
  if (!verdicts) kept.byExcept.set(exceptMemoryId, verdicts = new Map());
  verdicts.set(evidence, result);
  kept.entries += 1;
  kept.characters += evidence.length;
  verdictEntries += 1;
  verdictCharacters += evidence.length;
}

/** The verdict of `isMemoryEvidenceVisible` once at least one item is forgotten, rejected or corrected. */
export function evidenceVisibleUnderControls(snapshot: CompanionStateSnapshot, evidence: string, exceptMemoryId?: string): boolean {
  const index = evidenceIndex(snapshot);
  if (!index.blockers.length) return true;
  if (!caching) return compared(index, evidence, exceptMemoryId);
  const kept = VERDICTS.get(index.key), known = kept?.byExcept.get(exceptMemoryId)?.get(evidence);
  if (known !== undefined) {
    recent(index.key, kept!);
    return known;
  }
  const result = compared(index, evidence, exceptMemoryId);
  if (evidence.length <= VERDICT_QUOTE) remember(index.key, exceptMemoryId, evidence, result);
  return result;
}

/** Test support: how much is remembered (states, verdicts and characters held). */
export function memoryEvidenceCacheSize(): { states: number; entries: number; characters: number } {
  return { states: VERDICTS.size, entries: verdictEntries, characters: verdictCharacters };
}

/** Test support: forget every remembered verdict and state index (a cold process). */
export function resetMemoryEvidenceCache(): void {
  clearVerdicts();
  INDEX_BY_STATE = new WeakMap();
  Object.assign(memoryEvidenceCounters, { compared: 0, indexed: 0 });
}

/** Test support: run `work` with every verdict gathered and compared afresh, nothing read from or written to what is remembered. */
export function withoutMemoryEvidenceCache<T>(work: () => T): T {
  const before = caching;
  caching = false;
  try {
    return work();
  } finally {
    caching = before;
  }
}
