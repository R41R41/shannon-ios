import { describe, expect, it } from 'vitest';
import { VOICE_SKILLS } from '../src/voiceDecision.js';
import { voiceDecisionEvaluationCases } from './voiceDecisionEvaluationCases.js';

describe('voice decision evaluation catalog', () => {
  it('covers at least twenty named conversation patterns without duplicate IDs', () => {
    expect(voiceDecisionEvaluationCases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(voiceDecisionEvaluationCases.map(item => item.id)).size)
      .toBe(voiceDecisionEvaluationCases.length);
  });

  it('covers every selectable skill and every response class', () => {
    const skills = new Set(voiceDecisionEvaluationCases.flatMap(item => item.expectedSkills));
    expect([...skills].sort()).toEqual([...VOICE_SKILLS].sort());
    const classes = new Set(voiceDecisionEvaluationCases.flatMap(item => item.expectedClasses));
    expect([...classes].sort()).toEqual([
      'direct', 'greeting', 'no_response', 'skill_complex', 'skill_simple',
    ]);
  });
});
