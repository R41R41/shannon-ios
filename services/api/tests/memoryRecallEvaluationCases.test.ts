import { describe, expect, it } from 'vitest';
import { memoryRecallEvaluationCases, syntheticHistory } from './memoryRecallEvaluationCases.js';

describe('live memory-recall evaluation catalog', () => {
  it('has 30-50 synthetic cases across every category with resolvable expectations', () => {
    const keys = new Set(syntheticHistory.map(item => item.key));
    expect(memoryRecallEvaluationCases.length).toBeGreaterThanOrEqual(30);
    expect(memoryRecallEvaluationCases.length).toBeLessThanOrEqual(50);
    expect(new Set(memoryRecallEvaluationCases.map(item => item.category)).size).toBe(5);
    expect(new Set(memoryRecallEvaluationCases.map(item => item.id)).size).toBe(memoryRecallEvaluationCases.length);
    for (const item of memoryRecallEvaluationCases) {
      expect([...item.expected, ...item.forbidden ?? []].every(key => keys.has(key)), item.id).toBe(true);
    }
  });
});
