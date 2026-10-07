import { describe, expect, it } from 'vitest';
import { TEMPORAL_FACTS_V1, backfilledFact, contradiction, duplicateOf, factCurrent, joinedEpisodes, resolvedFact, type TemporalFact } from '../src/index.js';

const NOW = '2026-10-07T03:00:00.000Z';
const fact = (id: string, fields: Partial<TemporalFact> = {}): TemporalFact => ({ id, validAt: '2026-01-01T00:00:00.000Z', invalidAt: null, expiredAt: null, episodeIds: [], revision: 0, ...fields });

describe('temporal rules of people facts', () => {
  it('holds a fact inside [validAt, invalidAt) until it expires', () => {
    const open = fact('a');
    expect(factCurrent(open, NOW)).toBe(true);
    expect(factCurrent(open, '2025-12-31T00:00:00.000Z')).toBe(false);
    expect(factCurrent(fact('a', { validAt: null }), '2000-01-01T00:00:00.000Z')).toBe(true);
    expect(factCurrent(fact('a', { invalidAt: '2026-05-01T00:00:00.000Z' }), NOW)).toBe(false);
    expect(factCurrent(fact('a', { invalidAt: '2026-05-01T00:00:00.000Z' }), '2026-04-30T00:00:00.000Z')).toBe(true);
    expect(factCurrent(fact('a', { expiredAt: NOW }), NOW)).toBe(false);
    expect(factCurrent(fact('a', { expiredAt: '2027-01-01T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('joins episodes without repeats and keeps the newest 32', () => {
    expect(joinedEpisodes(['e1', 'e2'], ['e2', 'e3'])).toEqual(['e1', 'e2', 'e3']);
    const many = Array.from({ length: 40 }, (_, index) => `e${index}`);
    expect(joinedEpisodes(many, [])).toHaveLength(TEMPORAL_FACTS_V1.maximumEpisodes);
    expect(joinedEpisodes(many, []).at(-1)).toBe('e39');
  });

  it('a duplicate appends its episodes and changes nothing else; the same episodes change nothing', () => {
    const older = fact('a', { episodeIds: ['e1'], revision: 2 });
    const updated = duplicateOf(older, ['e2']);
    expect(updated).toEqual({ ...older, episodeIds: ['e1', 'e2'], revision: 3 });
    expect(duplicateOf(older, ['e1'])).toBe(older);
  });

  it('a contradiction closes the older fact where the newer begins and never deletes it', () => {
    const older = fact('lives-tokyo', { validAt: '2025-01-01T00:00:00.000Z', revision: 1 });
    const newer = fact('lives-osaka', { validAt: '2026-09-01T00:00:00.000Z' });
    const result = contradiction(older, newer, NOW);
    expect(result.older).toEqual({ ...older, invalidAt: '2026-09-01T00:00:00.000Z', expiredAt: NOW, revision: 2 });
    expect(result.newer).toBe(newer);
    expect(factCurrent(result.older, NOW)).toBe(false);
    // As of August it was true in the world and she believed it: the closed row keeps that history.
    expect(factCurrent(result.older, '2026-08-01T00:00:00.000Z')).toBe(true);
  });

  it('closes the newer fact instead when it tells of an earlier time', () => {
    const older = fact('lives-osaka', { validAt: '2026-09-01T00:00:00.000Z' });
    const newer = fact('lived-tokyo', { validAt: '2025-01-01T00:00:00.000Z' });
    const result = contradiction(older, newer, NOW);
    expect(result.older).toBe(older);
    expect(result.newer).toMatchObject({ invalidAt: '2026-09-01T00:00:00.000Z', expiredAt: NOW, revision: 1 });
  });

  it('closes at now when the newer fact has no validity, and keeps an earlier end', () => {
    expect(contradiction(fact('a'), fact('b', { validAt: null }), NOW).older.invalidAt).toBe(NOW);
    const ended = fact('a', { invalidAt: '2026-03-01T00:00:00.000Z' });
    expect(contradiction(ended, fact('b', { validAt: '2026-09-01T00:00:00.000Z' }), NOW).older.invalidAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('resolves the writer\'s judgement: a duplicate inserts nothing, contradictions close and the new fact is inserted', () => {
    const rows = [fact('a', { episodeIds: ['e1'] }), fact('b'), fact('c', { expiredAt: '2026-02-01T00:00:00.000Z' })];
    const incoming = fact('n', { validAt: '2026-09-01T00:00:00.000Z', episodeIds: ['e9'] });
    expect(resolvedFact(rows, incoming, { duplicates: ['a'], contradicts: ['b'] }, NOW)).toEqual({ updates: [{ ...rows[0], episodeIds: ['e1', 'e9'], revision: 1 }], insert: null });
    const closed = resolvedFact(rows, incoming, { duplicates: [], contradicts: ['b', 'b', 'c', 'missing'] }, NOW);
    expect(closed.updates).toEqual([{ ...rows[1], invalidAt: '2026-09-01T00:00:00.000Z', expiredAt: NOW, revision: 1 }]);
    expect(closed.insert).toBe(incoming);
    expect(resolvedFact(rows, incoming, { duplicates: ['c'], contradicts: [] }, NOW)).toEqual({ updates: [], insert: incoming });
    expect(resolvedFact([], incoming, { duplicates: [], contradicts: [] }, NOW)).toEqual({ updates: [], insert: incoming });
  });

  it('backfills a row written before stage 3 as valid since it was written', () => {
    expect(backfilledFact('a', '2026-05-01T00:00:00.000Z')).toEqual({ id: 'a', validAt: '2026-05-01T00:00:00.000Z', invalidAt: null, expiredAt: null, episodeIds: [], revision: 0 });
  });
});
