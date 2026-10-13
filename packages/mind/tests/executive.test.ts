import { describe, expect, it } from 'vitest';
import {
  catalogProblems, checkedDeliberationAnswer, checkedGoalEvidence, checkedGoalPredicate, coarseMood, deliberationMaterial, estimatedGoalProgress,
  evaluateGoalPredicate, goalPredicateSummary, goalProgressLabel, goalsOverCap, mergedGoalEvidence, rankOfChoice, staggeredReviews, valueRank,
  type Capability, type DeliberationCandidate, type GoalEvidence,
} from '../src/index.js';

const at = '2026-10-13T00:00:00.000Z';
const note = (ref: string): GoalEvidence => ({ kind: 'note_written', ref, at });

describe('goal predicates (ADR-0009 stage 2, E2)', () => {
  it('accepts only the closed types', () => {
    expect(checkedGoalPredicate({ type: 'piece_shown', minVersion: 2 })).toEqual({ type: 'piece_shown', minVersion: 2 });
    expect(checkedGoalPredicate({ type: 'task_completed', capability: 'research.read' })).toEqual({ type: 'task_completed', capability: 'research.read' });
    for (const bad of [{ type: 'done' }, { type: 'notes_count', n: 0 }, { type: 'piece_shown' }, { type: 'task_completed', capability: 'DROP TABLE' }, null, []]) {
      expect(checkedGoalPredicate(bad)).toBeNull();
    }
    expect(checkedGoalEvidence({ kind: 'note_written', ref: 'p1', at })).toEqual(note('p1'));
    expect(checkedGoalEvidence({ kind: 'note_written', ref: 'p1', at: 'x' })).toBeNull();
  });

  it('is met only by matching evidence, or by the owner', () => {
    expect(evaluateGoalPredicate({ type: 'notes_count', n: 3 }, [note('a'), note('a'), note('b')])).toMatchObject({ met: false, used: ['a', 'b'] });
    expect(evaluateGoalPredicate({ type: 'notes_count', n: 2 }, [note('a'), note('b')]).met).toBe(true);
    const shown = (version: number): GoalEvidence => ({ kind: 'piece_shown', ref: 'piece', version, at });
    expect(evaluateGoalPredicate({ type: 'piece_shown', minVersion: 3 }, [shown(2)]).met).toBe(false);
    expect(evaluateGoalPredicate({ type: 'piece_shown', minVersion: 3 }, [shown(3)]).met).toBe(true);
    const unclear: GoalEvidence = { kind: 'owner_reaction', ref: 'r', reaction: 'unclear', at };
    expect(evaluateGoalPredicate({ type: 'owner_reaction', positive: true }, [unclear]).met).toBe(false);
    expect(evaluateGoalPredicate({ type: 'owner_reaction', positive: false }, [unclear]).met).toBe(true);
    expect(evaluateGoalPredicate({ type: 'owner_confirm' }, [note('a')]).met).toBe(false);
    expect(evaluateGoalPredicate({ type: 'research_report' }, [{ kind: 'owner_confirm', ref: 'owner', at }])).toMatchObject({ met: true, progress: 1 });
    expect(evaluateGoalPredicate({ type: 'task_completed', capability: 'research.read' }, [{ kind: 'task_completed', ref: 't', capability: 'create.note', at }]).met).toBe(false);
  });

  it('keeps evidence per ref, bounded; says the predicate in words', () => {
    expect(mergedGoalEvidence([note('a')], [note('a'), note('b')])).toHaveLength(2);
    expect(goalPredicateSummary({ type: 'notes_count', n: 5 })).toBe('メモを5件書く');
    expect(goalProgressLabel({ type: 'notes_count', n: 5 }, [note('a'), note('b'), note('b')])).toBe('2/5');
    expect(goalProgressLabel(null, [])).toBeNull();
  });

  it('spreads reviews over seven days oldest first, estimates progress below 1, and keeps the most recently worked active', () => {
    const reviews = staggeredReviews(['old', 'mid', 'new'], at);
    expect([...reviews.values()]).toEqual(['2026-10-15T08:00:00.000Z', '2026-10-17T16:00:00.000Z', '2026-10-20T00:00:00.000Z']);
    expect(estimatedGoalProgress({ stories: 9, shownStories: 9, reactedStories: 9, notes: 99, readings: 99 })).toBe(0.8);
    expect(estimatedGoalProgress({ stories: 0, shownStories: 0, reactedStories: 0, notes: 0, readings: 0 })).toBe(0);
    const goals = Array.from({ length: 10 }, (_, index) => ({ id: `g${index}`, lastWorkedAt: index < 5 ? `2026-10-0${index + 1}T00:00:00Z` : null, updatedAt: at }));
    expect(goalsOverCap(goals)).toEqual(['g8', 'g9']);
    expect(goalsOverCap(goals, 'g9')).toEqual(['g7', 'g8']);
  });
});

describe('deliberation material (plan §1)', () => {
  const candidate = (capability: string, mean: number | null, goalId?: string): DeliberationCandidate =>
    ({ capability, ...(goalId ? { goalId } : {}), value: mean === null ? null : { mean, sd: 0.1, n: 3 }, recent: ['success', 'failure', 'unknown', 'success'] });

  it('bounds the material and ranks by value, unvalued last', () => {
    const material = deliberationMaterial({
      at, dayBand: 'night', presence: 'alone', budgetLeftYen: 120.4, freeSlots: 1, mood: coarseMood({ valence: -0.5, arousal: -0.5 }), ownerReactions7d: {},
      goals: Array.from({ length: 8 }, (_, index) => ({ id: `g${index}`, progress: 2, predicate: null, reviewAt: `2026-10-1${index}T00:00:00Z`, interestId: null })),
      interests: [], candidates: [candidate('create.story', 0.2, 'g0'), candidate('create.story', 0.2, 'g0'), candidate('create.note', 0.1, 'g7'), candidate('rest', null)],
    });
    expect(material.goals).toHaveLength(6);
    expect(material.goals[0]!.progress).toBe(1);
    expect(material.candidates.map(item => item.capability)).toEqual(['create.story', 'rest']);
    expect(material.candidates[0]!.recent).toHaveLength(3);
    expect(material.mood).toBe('tired');
    const ranked = valueRank([candidate('a.b', 0.1), candidate('rest', null), candidate('c.d', 0.5)]);
    expect(ranked.map(item => [item.capability, item.rank])).toEqual([['c.d', 1], ['a.b', 2], ['rest', 3]]);
    expect(rankOfChoice(ranked, { capability: 'x.y' })).toBeNull();
  });

  it('checks an answer against the catalog and marks a choice outside the candidates', () => {
    const known = new Set(['create.story', 'rest']);
    const answer = checkedDeliberationAnswer({ capability: 'rest', reason: ' 少し\n休む '.repeat(30), nextThinkMinutes: 5, goalProposal: 'drop' }, known, [candidate('create.story', 0.1)], new Set());
    expect(answer).toMatchObject({ capability: 'rest', nextThinkMinutes: 20, outsideCandidates: true });
    expect(answer!.reason.length).toBe(80);
    expect(answer!.goalProposal).toBeUndefined();
    expect(checkedDeliberationAnswer({ capability: 'tool.web.search' }, known, [], new Set())).toBeNull();
    expect(checkedDeliberationAnswer({ capability: 'create.story', goalId: 'missing' }, known, [], new Set())).toBeNull();
  });
});

describe('capability shape (E1)', () => {
  it('reports malformed and duplicate entries', () => {
    const good: Capability = {
      name: 'rest', label: '休む', purpose: '休む', level: 'activity', executor: 'none', preconditions: [], longRunning: false, stop: 'not_needed',
      resumable: false, idempotency: 'idempotent', retry: 'none', slotClass: 'other', costYen: 0, effect: 'none', effectClass: 'none',
      permission: { gateDomain: 'thinking', policy: 'free' }, observables: [],
    };
    expect(catalogProblems([{ ...good, name: 'rest.now' }])).toEqual([]);
    expect(catalogProblems([good])).toEqual([]);
    expect(catalogProblems([{ ...good, name: 'Rest!' }])).toEqual(['Rest!: name']);
    expect(catalogProblems([{ ...good, name: 'web.search', level: 'tool' }])).toEqual(['web.search: tool_prefix']);
    expect(catalogProblems([{ ...good, name: 'a.b' }, { ...good, name: 'a.b', costYen: -1 }])).toEqual(['a.b: cost', 'a.b: duplicate']);
  });
});
