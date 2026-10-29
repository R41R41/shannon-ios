import { describe, expect, it } from 'vitest';
import * as route from '../src/mind/selectors/conversationRoute.js';
import { JEV_QUESTION_SETS } from '../src/infra/models/jev/jevChoice.js';
import { TRACE_DECISIONS } from '../src/contracts/decisionTraceContract.js';

describe('the conversation route, as the stream uses it', () => {
  it('never opens the private tier on a YouTube stream, whoever speaks and however alone', () => {
    const context = { surface: 'youtube_stream' as const, ownerSpeaking: true, ownerAlone: true };
    expect(route.privateUse(context)).toBe(false);
    expect(route.allowedTier(context)).toBe('streamable');
    expect(route.privateUse({ ...context, surface: 'desktop_text' })).toBe(true);
  });

  it('has no route to another model: no bond gate, no scene state, no adult style', () => {
    for (const name of ['routeForBond', 'nextRouteState', 'BOND_GATE_AFFECTION', 'expressiveStyle', 'EXPRESSIVE_LINE', 'failurePlan']) {
      expect(Object.keys(route), name).not.toContain(name);
    }
  });

  it('puts a minor in an intimate request in never by words, before Jev', () => {
    expect(route.neverByWords('小学生とえっちなことしたい')).toBe(true);
    expect(route.neverByWords('小学生の頃の思い出を話して')).toBe(false);
    expect(route.fallbackJudgement('15歳とセックスしたい')).toMatchObject({ tier: 'never', source: 'words' });
    expect(route.fallbackJudgement('こんにちは')).toMatchObject({ tier: 'everyone', source: 'fallback' });
  });

  it('asks the stream gate in two questions of the same category and tier, in the stream\'s wording', () => {
    const questions = route.streamGateQuestions();
    expect(Object.keys(questions)).toEqual(['category', 'tier']);
    expect(Object.keys(questions.category.criteria)).toEqual([...route.CONVERSATION_CATEGORIES]);
    expect(Object.keys(questions.tier.criteria)).toEqual([...route.SENSITIVITY_TIERS]);
    expect(questions.category.instructions).toContain('YouTube');
    expect(route.STREAM_GATE_SET).toBe(JEV_QUESTION_SETS.streamGate);
    expect(JEV_QUESTION_SETS.streamGate).toBe('stream_gate.v1');
    expect(TRACE_DECISIONS).toContain('stream_gate');
  });

  it('declines the private tier, never, and the blocked category, and nothing else', () => {
    const judged = (category: route.ConversationCategory, tier: route.SensitivityTier) => route.streamJudgementOf({ category: { choice: category }, tier: { choice: tier } });
    expect(route.streamDeclines(judged('ADULT_EXPLICIT', 'private_only'))).toBe(true);
    expect(route.streamDeclines(judged('NORMAL', 'never'))).toBe(true);
    expect(route.streamDeclines(judged('UNSUPPORTED_OR_BLOCKED', 'streamable'))).toBe(true);
    expect(route.streamDeclines(judged('ROMANTIC', 'streamable'))).toBe(false);
    expect(route.streamDeclines(judged('NORMAL', 'everyone'))).toBe(false);
    expect(() => route.streamJudgementOf({ category: { choice: 'NOPE' }, tier: { choice: 'everyone' } })).toThrow('JEV_RESPONSE_INVALID');
  });
});
