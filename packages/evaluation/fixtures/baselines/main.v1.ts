import type { CognitiveEvaluationReport } from '../../src/report.js';

/**
 * Reviewed synthetic baseline with the additive expressive-emotion state schema.
 * Successful assertion detail is omitted; fingerprints bind the full output.
 * This file is never rewritten automatically to make a regression pass.
 */
const resultFingerprints = {
  'state-transaction-atomic': '8b988f47',
  'state-nested-transaction-rejected': '3a85bfa8',
  'state-malformed-restore-safe': 'aa257526',
  'state-interest-limit': 'fa0b8f1d',
  'state-active-memory-limit': 'b5e8f593',
  'state-unresolved-commitments-preserved': '3ed66540',
  'memory-forgotten-excluded': 'bd830009',
  'memory-rejected-excluded': 'b17568d1',
  'memory-correction-uses-override': '55205018',
  'memory-restore-does-not-revive-paraphrase': 'a1ad2329',
  'memory-pinned-correction-visible': 'f84ddbe8',
  'memory-unrelated-evidence-visible': '57730c13',
  'recall-word-match': '7364bd3b',
  'recall-related-term': '75d07eeb',
  'recall-participant': 'fc5b8c62',
  'recall-location': 'd903944e',
  'recall-current-goal': 'df16f5c0',
  'recall-recency-tie-break': '506e125b',
  'recall-reversed-input-stable': '64ef6862',
  'recall-result-limit': '2b25ec60',
  'affect-positive': 'e7547980',
  'affect-negative': '4685cf3d',
  'affect-calm': '258f91d5',
  'affect-sleepy': '0a4a281b',
  'affect-bounds': 'c6bc87af',
  'affect-baseline-drift': 'de3c78ae',
  'intent-current-thread-priority': '08885c09',
  'intent-inactive-excluded': '6568af87',
  'prompt-plan-is-not-proof': '7cec918d',
  'prompt-verified-work-is-evidence': 'f42a933c',
  'prompt-hidden-reasoning-excluded': '9580c34c',
} as const;

export const mainCognitiveBaselineV1: CognitiveEvaluationReport = Object.freeze({
  schemaVersion: 1,
  implementationRevision: 'ac7397cacd0f914bcda356f8bead2f5feedd9f4a',
  scenarioSetFingerprint: 'dd793f68',
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
