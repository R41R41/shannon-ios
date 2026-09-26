import type { CognitiveEvaluationReport } from './report.js';

export interface CognitiveEvaluationComparison {
  baselineRevision: string;
  candidateRevision: string;
  unchanged: readonly string[];
  regressions: readonly string[];
  improvements: readonly string[];
  incomparable: readonly string[];
}

export function compareCognitiveEvaluationReports(
  baseline: CognitiveEvaluationReport,
  candidate: CognitiveEvaluationReport,
): CognitiveEvaluationComparison {
  const baselineResults = new Map(baseline.results.map(result => [result.scenarioId, result]));
  const candidateResults = new Map(candidate.results.map(result => [result.scenarioId, result]));
  const ids = [...new Set([...baselineResults.keys(), ...candidateResults.keys()])].sort();
  const unchanged: string[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];
  const incomparable: string[] = [];
  if (baseline.scenarioSetFingerprint !== candidate.scenarioSetFingerprint) {
    return {
      baselineRevision: baseline.implementationRevision,
      candidateRevision: candidate.implementationRevision,
      unchanged,
      regressions,
      improvements,
      incomparable: ids,
    };
  }
  for (const id of ids) {
    const before = baselineResults.get(id);
    const after = candidateResults.get(id);
    if (!before || !after || before.status === 'invalid' || after.status === 'invalid') {
      incomparable.push(id);
    } else if (before.status === 'passed' && after.status === 'failed') {
      regressions.push(id);
    } else if (before.status === 'failed' && after.status === 'passed') {
      improvements.push(id);
    } else if (before.fingerprint !== after.fingerprint) {
      incomparable.push(id);
    } else {
      unchanged.push(id);
    }
  }
  return {
    baselineRevision: baseline.implementationRevision,
    candidateRevision: candidate.implementationRevision,
    unchanged, regressions, improvements, incomparable,
  };
}
