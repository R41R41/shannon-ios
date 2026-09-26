import { describe, expect, it } from 'vitest';
import { coreScenarios } from '../fixtures/scenarios/core.v1.js';
import { mainCognitiveBaselineV1 } from '../fixtures/baselines/main.v1.js';
import {
  compareCognitiveEvaluationReports,
  runCognitiveEvaluation,
} from '../src/index.js';

const context = {
  implementationRevision: 'ac7397cacd0f914bcda356f8bead2f5feedd9f4a',
  generatedAt: '2026-09-26T00:00:00.000Z',
};

describe('Cognitive Evaluation Harness v0', () => {
  it('passes at least 24 synthetic characterization scenarios', () => {
    const report = runCognitiveEvaluation(coreScenarios, context);
    expect(coreScenarios.length).toBeGreaterThanOrEqual(24);
    expect(report.status).toBe('passed');
    expect(report.totals).toEqual({ passed: coreScenarios.length, failed: 0, invalid: 0 });
  });

  it('is deterministic for the same inputs', () => {
    const first = runCognitiveEvaluation(coreScenarios, context);
    const second = runCognitiveEvaluation(coreScenarios, context);
    expect(second).toEqual(first);
  });

  it('matches the reviewed main baseline', () => {
    const report = runCognitiveEvaluation(coreScenarios, context);
    expect(coreScenarios).toHaveLength(mainCognitiveBaselineV1.totals.passed);
    expect(report.implementationRevision).toBe(mainCognitiveBaselineV1.implementationRevision);
    expect(report.scenarioSetFingerprint).toBe(mainCognitiveBaselineV1.scenarioSetFingerprint);
    expect(report.results.map(result => [result.scenarioId, result.fingerprint])).toEqual(
      mainCognitiveBaselineV1.results.map(result => [result.scenarioId, result.fingerprint]),
    );
    expect(compareCognitiveEvaluationReports(mainCognitiveBaselineV1, report).regressions).toEqual([]);
  });

  it('keeps the scenario-set fingerprint stable when scenario order changes', () => {
    const first = runCognitiveEvaluation(coreScenarios, context);
    const reversed = runCognitiveEvaluation([...coreScenarios].reverse(), context);
    expect(reversed.scenarioSetFingerprint).toBe(first.scenarioSetFingerprint);
  });

  it('changes the scenario-set fingerprint when a scenario definition changes', () => {
    const first = runCognitiveEvaluation(coreScenarios.slice(0, 1), context);
    const changed = runCognitiveEvaluation([{
      ...coreScenarios[0],
      description: `${coreScenarios[0]!.description} changed`,
    }], context);
    expect(changed.scenarioSetFingerprint).not.toBe(first.scenarioSetFingerprint);
  });

  it('rejects malformed fixtures and unknown expectation types', () => {
    const malformed = { schemaVersion: 1, id: 'malformed', input: { now: 'not-a-date' }, expected: [] };
    const unknown = {
      ...coreScenarios[0], id: 'unknown-expectation',
      expected: [{ type: 'model-judge', value: true }],
    };
    const report = runCognitiveEvaluation([malformed, unknown], context);
    expect(report.status).toBe('invalid');
    expect(report.totals.invalid).toBe(2);
  });

  it.each([
    ['selected-memory-ids', { type: 'selected-memory-ids', value: ['valid', 3] }],
    ['excluded-memory-ids', { type: 'excluded-memory-ids', value: 'memory-1' }],
    ['primary-intent-id', { type: 'primary-intent-id', value: 3 }],
    ['state-equals', { type: 'state-equals' }],
    ['number-in-range', { type: 'number-in-range', path: 'emotion.valence', minimum: 2, maximum: 1 }],
    ['text-includes', { type: 'text-includes', value: false }],
    ['text-excludes', { type: 'text-excludes' }],
    ['collection-limit', { type: 'collection-limit', path: 'state.activeMemories', maximum: -1 }],
  ])('marks malformed %s expectation payloads invalid without throwing', (_type, expectation) => {
    const scenario = {
      ...coreScenarios[0],
      id: `malformed-${_type}`,
      expected: [expectation],
    };
    expect(() => runCognitiveEvaluation([scenario], context)).not.toThrow();
    const report = runCognitiveEvaluation([scenario], context);
    expect(report.status).toBe('invalid');
    expect(report.totals).toEqual({ passed: 0, failed: 0, invalid: 1 });
  });

  it('rejects duplicate scenario IDs', () => {
    const report = runCognitiveEvaluation([coreScenarios[0], coreScenarios[0]], context);
    expect(report.status).toBe('invalid');
    expect(report.results.every(result => result.status === 'invalid')).toBe(true);
  });

  it('classifies regressions, improvements, unchanged, and incomparable results', () => {
    const baseline = runCognitiveEvaluation(coreScenarios.slice(0, 3), context);
    const candidate = structuredClone(baseline);
    candidate.implementationRevision = 'candidate';
    candidate.results = [
      { ...candidate.results[0]!, status: 'failed' },
      { ...candidate.results[1]!, status: 'passed' },
      { ...candidate.results[2]!, status: 'invalid' },
    ];
    const comparison = compareCognitiveEvaluationReports(baseline, candidate);
    expect(comparison.regressions).toEqual([baseline.results[0]!.scenarioId]);
    expect(comparison.unchanged).toEqual([baseline.results[1]!.scenarioId]);
    expect(comparison.incomparable).toEqual([baseline.results[2]!.scenarioId]);

    const failedBaseline = structuredClone(candidate);
    failedBaseline.results = [{ ...candidate.results[1]!, status: 'failed' }];
    const improved = compareCognitiveEvaluationReports(failedBaseline, {
      ...candidate, results: [{ ...candidate.results[1]!, status: 'passed' }],
    });
    expect(improved.improvements).toEqual([candidate.results[1]!.scenarioId]);
  });

  it('fails closed when the same scenario status has a different result fingerprint', () => {
    const baseline = runCognitiveEvaluation(coreScenarios.slice(0, 1), context);
    const candidate = structuredClone(baseline);
    candidate.implementationRevision = 'candidate';
    candidate.results = [{ ...candidate.results[0]!, fingerprint: 'changed-result' }];

    const comparison = compareCognitiveEvaluationReports(baseline, candidate);
    expect(comparison.unchanged).toEqual([]);
    expect(comparison.incomparable).toEqual([baseline.results[0]!.scenarioId]);
  });

  it('fails closed when scenario-set fingerprints differ', () => {
    const baseline = runCognitiveEvaluation(coreScenarios.slice(0, 2), context);
    const candidate = {
      ...structuredClone(baseline),
      implementationRevision: 'candidate',
      scenarioSetFingerprint: 'changed-scenario-set',
    };

    const comparison = compareCognitiveEvaluationReports(baseline, candidate);
    expect(comparison.unchanged).toEqual([]);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.improvements).toEqual([]);
    expect(comparison.incomparable).toEqual(baseline.results.map(result => result.scenarioId).sort());
  });

  it('does not copy scenario input, conversations, or credentials into reports', () => {
    const secret = 'synthetic-secret-must-not-be-reported';
    const source = {
      ...coreScenarios[0], id: 'report-redaction',
      description: secret,
      input: { ...coreScenarios[0]!.input, credential: secret },
    };
    const serialized = JSON.stringify(runCognitiveEvaluation([source], context));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('input');
  });
});
