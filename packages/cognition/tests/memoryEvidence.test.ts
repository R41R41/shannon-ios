import { afterEach, describe, expect, it } from 'vitest';
import {
  createInitialCompanionState,
  freezeSnapshot,
  isMemoryEvidenceVisible,
  memoryControlFor,
  memoryEvidenceCacheSize,
  memoryEvidenceCounters,
  resetMemoryEvidenceCache,
  visibleMemoryText,
  withoutMemoryEvidenceCache,
  type CompanionStateSnapshot,
  type MemoryControl,
} from '../src/index.js';

/** `isMemoryEvidenceVisible` as it was before its verdicts were remembered (b73cbd23): the oracle. */
function reference(snapshot: CompanionStateSnapshot, evidence: string, exceptMemoryId?: string): boolean {
  if (!snapshot.memoryControls.some(control => control.status !== 'active' || control.overrideText)) return true;
  const normalize = (value: string) => value.replace(/[\s。、]/gu, '');
  const quote = normalize(evidence);
  if (quote.length < 3) return true;
  const overlaps = (value: string | undefined) => {
    const original = normalize(value ?? '');
    return original.length >= 3 && (original.includes(quote) || quote.includes(original));
  };
  if (snapshot.memoryControls.some(control => control.memoryId !== exceptMemoryId
    && (control.status !== 'active' || control.overrideText) && (
    overlaps(control.sourceEvidence)
    || overlaps(snapshot.userFacts.find(item => item.id === control.memoryId)?.evidence)
    || overlaps(snapshot.relationships.find(item => item.id === control.memoryId)?.evidence)
  ))) return false;
  return !snapshot.prospectiveMemories.some(memory => {
    const control = memoryControlFor(snapshot, memory.id);
    const parent = memory.sourceExperienceId ? memoryControlFor(snapshot, memory.sourceExperienceId) : undefined;
    const blocked = (value: typeof control) => value && value.memoryId !== exceptMemoryId
      && (value.status !== 'active' || value.overrideText);
    if (!blocked(control) && !blocked(parent)) return false;
    const original = normalize(memory.evidence ?? memory.summary);
    return original.length >= 3 && (original.includes(quote) || quote.includes(original));
  });
}

/** A small deterministic generator (synthetic data only). */
function random(seed: number) {
  let value = seed;
  return () => { value = (Math.imul(value, 1_103_515_245) + 12_345) >>> 0; return value / 2 ** 32; };
}
const WORDS = ['紅茶', '太宰府', '写真の整理', 'ギター', '京都', '猫の名前', 'Xcode', '散歩', '母の誕生日', '転職'];

function world(seed: number): { state: CompanionStateSnapshot; quotes: string[]; ids: string[] } {
  const next = random(seed), pick = <T>(rows: readonly T[]) => rows[Math.floor(next() * rows.length)]!;
  const sentence = () => `${pick(['僕は', '私は', 'ライ氏は', ''])}${pick(WORDS)}${pick(['が好き', 'の話', 'を忘れて', '、。 です'])}`;
  const at = '2026-10-14T00:00:00.000Z';
  const facts = Array.from({ length: 12 }, (_, index) => ({ id: `fact-${index}`, statement: sentence(), confidence: 0.8, observedAt: at,
    ...(next() < 0.8 ? { evidence: sentence() } : {}), ...(next() < 0.5 ? { sourceExperienceId: `turn-${index % 5}` } : {}) }));
  const relationships = Array.from({ length: 4 }, (_, index) => ({ id: `rel-${index}`, statement: sentence(), confidence: 0.7, observedAt: at,
    ...(next() < 0.7 ? { evidence: sentence() } : {}) }));
  const promises = Array.from({ length: 8 }, (_, index) => ({ id: `promise-${index}`, summary: sentence(), status: 'pending' as const,
    createdAt: at, updatedAt: at, ...(next() < 0.6 ? { evidence: next() < 0.2 ? '' : sentence() } : {}),
    ...(next() < 0.6 ? { sourceExperienceId: `turn-${index % 5}` } : {}) }));
  const ids = [...facts.map(item => item.id), ...relationships.map(item => item.id), ...promises.map(item => item.id),
    'turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'];
  const controls: MemoryControl[] = Array.from({ length: 10 }, () => {
    const roll = next();
    return { memoryId: pick(ids), kind: 'user-fact' as const, pinned: false, updatedAt: at, changeReason: 'owner',
      status: roll < 0.4 ? 'forgotten' as const : roll < 0.55 ? 'rejected' as const : 'active' as const,
      ...(roll >= 0.55 && roll < 0.8 ? { overrideText: sentence() } : {}), ...(next() < 0.6 ? { sourceEvidence: sentence() } : {}) };
  });
  const state = freezeSnapshot({ ...createInitialCompanionState('owner', at), userFacts: facts, relationships, prospectiveMemories: promises,
    memoryControls: controls });
  const quotes = [...Array.from({ length: 40 }, sentence), ...WORDS, 'あ', '紅', ' 。、', '', `${pick(WORDS)}${pick(WORDS)}${pick(WORDS)}`];
  return { state, quotes, ids };
}

afterEach(() => resetMemoryEvidenceCache());

describe('remembered evidence verdicts', () => {
  it('give the verdict of the previous implementation for every quote, excepted item and state, cold and warm', () => {
    let hidden = 0, checked = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const { state, quotes, ids } = world(seed);
      const thawed = structuredClone(state) as CompanionStateSnapshot;
      for (const pass of ['cold', 'warm'] as const) {
        for (const quote of quotes) for (const except of [undefined, ...ids.slice(0, 6), 'turn-0', 'promise-1']) {
          const expected = reference(state, quote, except);
          expect(isMemoryEvidenceVisible(state, quote, except), `${seed} ${pass} ${quote} ${except}`).toBe(expected);
          expect(isMemoryEvidenceVisible(thawed, quote, except)).toBe(expected);
          expect(withoutMemoryEvidenceCache(() => isMemoryEvidenceVisible(state, quote, except))).toBe(expected);
          hidden += expected ? 0 : 1; checked += 1;
        }
      }
      for (const id of ids) {
        expect(visibleMemoryText(state, id, quotes[0]!)).toBe(withoutMemoryEvidenceCache(() => visibleMemoryText(thawed, id, quotes[0]!)));
      }
    }
    // The worlds exercise both answers.
    expect(hidden).toBeGreaterThan(checked / 20);
    expect(checked - hidden).toBeGreaterThan(checked / 20);
  });

  it('never serves a verdict remembered before a forget, and gives the earlier one back after the restore', () => {
    const at = '2026-10-14T00:00:00.000Z';
    const base = { ...createInitialCompanionState('owner', at), userFacts: [{ id: 'fact-tea', statement: 'ライ氏は紅茶が好き', confidence: 0.9,
      observedAt: at, evidence: '僕は紅茶が好きです' }] };
    const control = (status: MemoryControl['status'], extra: Partial<MemoryControl> = {}): MemoryControl => ({ memoryId: 'fact-tea',
      kind: 'user-fact', status, pinned: false, updatedAt: at, changeReason: 'owner', ...extra });
    const quote = '昨日も言ったけど、僕は紅茶が好きです。', other = 'ギターの弦を替えた';
    // An unrelated forgotten item keeps the heavy path active, as in production.
    const unrelated = control('forgotten', { memoryId: 'turn-9', sourceEvidence: '散歩コースの話' });
    const before = freezeSnapshot({ ...base, memoryControls: [unrelated] });
    expect(isMemoryEvidenceVisible(before, quote)).toBe(true);
    expect(isMemoryEvidenceVisible(before, other)).toBe(true);
    const forgotten = freezeSnapshot({ ...base, memoryControls: [unrelated, control('forgotten')] });
    expect(isMemoryEvidenceVisible(forgotten, quote)).toBe(false);
    expect(isMemoryEvidenceVisible(forgotten, other)).toBe(true);
    // The same state read again (a new object, a newer version): the remembered verdicts, nothing compared again.
    const reread = freezeSnapshot({ ...forgotten, version: forgotten.version + 1 });
    const compared = memoryEvidenceCounters.compared;
    expect(isMemoryEvidenceVisible(reread, quote)).toBe(false);
    expect(isMemoryEvidenceVisible(reread, other)).toBe(true);
    expect(memoryEvidenceCounters.compared).toBe(compared);
    const rejected = freezeSnapshot({ ...base, memoryControls: [unrelated, control('rejected')] });
    expect(isMemoryEvidenceVisible(rejected, quote)).toBe(false);
    const corrected = freezeSnapshot({ ...base, memoryControls: [unrelated, control('active', { overrideText: '僕はコーヒーが好き' })] });
    expect(isMemoryEvidenceVisible(corrected, quote)).toBe(false);
    expect(isMemoryEvidenceVisible(corrected, quote, 'fact-tea')).toBe(true);
    const restored = freezeSnapshot({ ...base, memoryControls: [unrelated, control('active', { contextInvalidatedAt: at })] });
    expect(isMemoryEvidenceVisible(restored, quote)).toBe(true);
    // A new forgotten item that quotes the other text: a new key, a fresh verdict.
    const more = freezeSnapshot({ ...base, memoryControls: [unrelated, control('active'), control('forgotten', { memoryId: 'turn-3',
      sourceEvidence: 'ギターの弦を替えた' })] });
    expect(isMemoryEvidenceVisible(more, other)).toBe(false);
  });

  it('keeps a verdict apart by which item withholds the evidence, when one item is excepted', () => {
    const at = '2026-10-14T00:00:00.000Z';
    const control = (memoryId: string, sourceEvidence: string): MemoryControl => ({ memoryId, kind: 'user-fact', status: 'forgotten',
      pinned: false, updatedAt: at, changeReason: 'owner', sourceEvidence });
    const evidence = '僕は紅茶が好きです', quote = '昨日、僕は紅茶が好きですと言った';
    // The same withheld text: once withheld only by the excepted item, once by another item.
    const byExcepted = freezeSnapshot({ ...createInitialCompanionState('owner', at), memoryControls: [control('fact-tea', evidence)] });
    const byOther = freezeSnapshot({ ...createInitialCompanionState('owner', at), memoryControls: [control('fact-other', evidence)] });
    const byBoth = freezeSnapshot({ ...createInitialCompanionState('owner', at),
      memoryControls: [control('fact-tea', evidence), control('fact-other', evidence)] });
    for (const order of [[byExcepted, byOther, byBoth], [byOther, byExcepted, byBoth], [byBoth, byOther, byExcepted]]) {
      resetMemoryEvidenceCache();
      for (const state of order) {
        expect(isMemoryEvidenceVisible(state, quote, 'fact-tea')).toBe(reference(state, quote, 'fact-tea'));
        expect(isMemoryEvidenceVisible(state, quote)).toBe(false);
      }
    }
    expect(reference(byExcepted, quote, 'fact-tea')).toBe(true);
    expect(reference(byOther, quote, 'fact-tea')).toBe(false);
    expect(reference(byBoth, quote, 'fact-tea')).toBe(false);
    // A promise withheld through its own control or its source turn: excepting one of them leaves the other.
    const promise = { id: 'promise-tea', summary: '紅茶を買う', status: 'pending' as const, createdAt: at, updatedAt: at,
      evidence: '紅茶を買っておいて', sourceExperienceId: 'turn-tea' };
    const both = freezeSnapshot({ ...createInitialCompanionState('owner', at), prospectiveMemories: [promise],
      memoryControls: [control('promise-tea', '散歩の話'), control('turn-tea', '散歩の話')] });
    const parentOnly = freezeSnapshot({ ...createInitialCompanionState('owner', at), prospectiveMemories: [promise],
      memoryControls: [control('turn-tea', '散歩の話')] });
    resetMemoryEvidenceCache();
    for (const state of [parentOnly, both, parentOnly]) {
      for (const except of [undefined, 'promise-tea', 'turn-tea']) {
        expect(isMemoryEvidenceVisible(state, '紅茶を買っておいて', except)).toBe(reference(state, '紅茶を買っておいて', except));
      }
    }
    expect(isMemoryEvidenceVisible(parentOnly, '紅茶を買っておいて', 'turn-tea')).toBe(true);
    expect(isMemoryEvidenceVisible(both, '紅茶を買っておいて', 'turn-tea')).toBe(false);
  });

  it('gathers a state that is not frozen again on every question, so a change made in place is seen', () => {
    const at = '2026-10-14T00:00:00.000Z';
    const quote = '僕は紅茶が好きです';
    const controls: MemoryControl[] = [{ memoryId: 'turn-9', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
      changeReason: 'owner', sourceEvidence: '散歩コースの話' }];
    const facts = [{ id: 'fact-tea', statement: 'ライ氏は紅茶が好き', confidence: 0.9, observedAt: at, evidence: '猫の名前の話' }];
    const state = { ...createInitialCompanionState('owner', at), memoryControls: controls, userFacts: facts } as CompanionStateSnapshot;
    expect(isMemoryEvidenceVisible(state, quote)).toBe(true);
    expect(isMemoryEvidenceVisible(state, quote)).toBe(true);
    // A new forgotten control pushed into the same array.
    controls.push({ memoryId: 'fact-tea', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' });
    expect(isMemoryEvidenceVisible(state, '猫の名前の話')).toBe(false);
    expect(isMemoryEvidenceVisible(state, quote)).toBe(reference(state, quote));
    expect(isMemoryEvidenceVisible(state, quote)).toBe(true);
    // An evidence text changed in place.
    facts[0]!.evidence = quote;
    expect(isMemoryEvidenceVisible(state, quote)).toBe(false);
    controls[0]!.sourceEvidence = 'ギターの弦の話';
    expect(isMemoryEvidenceVisible(state, 'ギターの弦の話')).toBe(false);
    // Restored in place: nothing of the item is withheld any more.
    controls[1]!.status = 'active';
    expect(isMemoryEvidenceVisible(state, quote)).toBe(true);
    expect(isMemoryEvidenceVisible(state, quote)).toBe(reference(state, quote));
  });

  it('stays bounded: many states and quotes keep at most the configured verdicts', () => {
    const at = '2026-10-14T00:00:00.000Z';
    for (let index = 0; index < 30; index += 1) {
      const state = freezeSnapshot({ ...createInitialCompanionState('owner', at), memoryControls: [{ memoryId: `m-${index}`, kind: 'experience',
        status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner', sourceEvidence: `忘れる話${index}番` }] });
      for (let quote = 0; quote < 3_000; quote += 1) {
        expect(isMemoryEvidenceVisible(state, `質問${quote}番の${index}`)).toBe(reference(state, `質問${quote}番の${index}`));
      }
      expect(isMemoryEvidenceVisible(state, `忘れる話${index}番`)).toBe(false);
      const size = memoryEvidenceCacheSize();
      expect(size.states).toBeLessThanOrEqual(8);
      expect(size.entries).toBeLessThanOrEqual(40_000);
      expect(size.characters).toBeLessThanOrEqual(4_000_000);
    }
    expect(memoryEvidenceCacheSize().entries).toBeGreaterThan(0);
  });
});
