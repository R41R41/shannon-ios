import { describe, expect, it } from 'vitest';
import { answerShapeNoted, FCA_ANSWER_SHAPE_NOTES } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';

const base = (transient?: Record<string, unknown>): FcaModelInput => ({
  task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], history: [], tools: [], ...(transient ? { transient } : {}),
});

describe('the request asked again after an answer that called no tool (end1108a S7: four word-only answers failed the task)', () => {
  it('says in the live state what the last answer was, and keeps the rest of the live state', () => {
    const noted = answerShapeNoted(base({ observation: 'here' }), 'no_decision');
    expect(noted.transient).toEqual({ observation: 'here', lastAnswer: FCA_ANSWER_SHAPE_NOTES.no_decision });
    expect(String(noted.transient?.lastAnswer)).toContain('道具');
    expect(answerShapeNoted(base({}), 'truncated').transient?.lastAnswer).toBe(FCA_ANSWER_SHAPE_NOTES.truncated);
  });

  it('leaves the history and a request without a live state as they are, and adds nothing for a provider failure', () => {
    const legacy = base();
    expect(answerShapeNoted(legacy, 'no_decision')).toBe(legacy);
    const live = base({ observation: 'here' });
    expect(answerShapeNoted(live, 'http_529')).toBe(live);
    expect(answerShapeNoted(live, 'no_decision').history).toBe(live.history);
  });
});
