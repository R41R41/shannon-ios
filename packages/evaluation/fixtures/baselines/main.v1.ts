import type { CognitiveEvaluationReport } from '../../src/report.js';

/**
 * Reviewed synthetic baseline captured from the pre-Harness cognition code.
 * Successful assertion detail is omitted; fingerprints bind the full output.
 * This file is never rewritten automatically to make a regression pass.
 */
const resultFingerprints = {
  'state-transaction-atomic': '323acbf4',
  'state-nested-transaction-rejected': '3a85bfa8',
  'state-malformed-restore-safe': '84c8167d',
  'state-interest-limit': '4acd7b02',
  'state-active-memory-limit': '3ae89888',
  'state-unresolved-commitments-preserved': 'a18e342b',
  'memory-forgotten-excluded': 'e86850d1',
  'memory-rejected-excluded': '8d24c7f9',
  'memory-correction-uses-override': 'c1bf98bc',
  'memory-restore-does-not-revive-paraphrase': '61529f0d',
  'memory-pinned-correction-visible': 'd10e86ac',
  'memory-unrelated-evidence-visible': 'b7a0e1f3',
  'recall-word-match': 'eddae9d4',
  'recall-related-term': '9a456ea4',
  'recall-participant': '4d6da979',
  'recall-location': 'b8b072d5',
  'recall-current-goal': '4b6b3057',
  'recall-recency-tie-break': '414d16f4',
  'recall-reversed-input-stable': '7182e579',
  'recall-result-limit': '4dc633f7',
  'affect-positive': 'b9dcf317',
  'affect-negative': 'e477fbee',
  'affect-calm': '011041b6',
  'affect-sleepy': '787769b4',
  'affect-bounds': 'c37e9dc8',
  'affect-baseline-drift': '0fd7d035',
  'intent-current-thread-priority': '805c1d1a',
  'intent-inactive-excluded': '427ffeb0',
  'prompt-plan-is-not-proof': '50ab3348',
  'prompt-verified-work-is-evidence': '0480e943',
  'prompt-hidden-reasoning-excluded': '209c2095',
} as const;

export const mainCognitiveBaselineV1: CognitiveEvaluationReport = Object.freeze({
  schemaVersion: 1,
  implementationRevision: 'ac7397cacd0f914bcda356f8bead2f5feedd9f4a',
  scenarioSetFingerprint: 'f6ee3b30',
  status: 'passed',
  generatedAt: '2026-09-26T00:00:00.000Z',
  results: Object.freeze(Object.entries(resultFingerprints).map(([scenarioId, fingerprint]) => Object.freeze({
    scenarioId,
    status: 'passed' as const,
    assertions: Object.freeze([]),
    fingerprint,
    durationMilliseconds: 0,
  }))),
  totals: Object.freeze({ passed: 31, failed: 0, invalid: 0 }),
});
