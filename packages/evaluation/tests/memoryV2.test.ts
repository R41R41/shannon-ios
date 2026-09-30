import { describe, expect, it } from 'vitest';
import { memoryV2Scenarios } from '../fixtures/scenarios/memory.v2.js';
import { runCognitiveEvaluation } from '../src/index.js';

const context = { implementationRevision: 'memory-v2', generatedAt: '2026-09-30T00:00:00.000Z' };

describe('Memory V2 deterministic evaluation', () => {
  it('passes every synthetic Memory V2 scenario', () => {
    const report = runCognitiveEvaluation(memoryV2Scenarios, context);
    const failures = report.results.filter(result => result.status !== 'passed').map(result => result.scenarioId);
    expect(failures).toEqual([]);
    expect(report.status).toBe('passed');
  });

  it('is deterministic', () => {
    expect(runCognitiveEvaluation(memoryV2Scenarios, context)).toEqual(runCognitiveEvaluation(memoryV2Scenarios, context));
  });
});
