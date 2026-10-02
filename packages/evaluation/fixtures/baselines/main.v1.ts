import type { CognitiveEvaluationReport } from '../../src/report.js';

/**
 * Reviewed synthetic baseline with the additive expressive-emotion state schema.
 * Successful assertion detail is omitted; fingerprints bind the full output.
 * This file is never rewritten automatically to make a regression pass.
 *
 * 2026-10-02: the six memory-* fingerprints were re-recorded by hand. Their
 * output is the state prompt, whose text changed on purpose: the trait line is
 * split into evidence-driven and fixed traits, and the conversational-feeling
 * line now appears only when the caller supplies a turn clock. Every scenario
 * still passes its own assertions.
 *
 * 2026-10-02 (awake clock): three fingerprints were re-recorded by hand.
 * `state-transaction-atomic`: an emotion event now starts her awake clock, so the
 * output state carries `emotionClock` and an empty `lingering`. `affect-bounds`
 * and `affect-baseline-drift`: on the awake clock the mood returns to its baseline
 * with awake time in the reducer, so the per-turn projection is the stimulus alone,
 * scaled by the room left toward the bound. Every scenario still passes its own
 * assertions.
 */
const resultFingerprints = {
  'state-transaction-atomic': '858b6d1a',
  'state-nested-transaction-rejected': '3a85bfa8',
  'state-malformed-restore-safe': 'aa257526',
  'state-interest-limit': 'fa0b8f1d',
  'state-active-memory-limit': 'b5e8f593',
  'state-unresolved-commitments-preserved': '3ed66540',
  'memory-forgotten-excluded': '9f99fbf3',
  'memory-rejected-excluded': '1950227b',
  'memory-correction-uses-override': '0ac69dbc',
  'memory-restore-does-not-revive-paraphrase': '79d935cd',
  'memory-pinned-correction-visible': 'fa8fb30c',
  'memory-unrelated-evidence-visible': '1cc355c5',
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
  'affect-bounds': '440ab202',
  'affect-baseline-drift': '005850b0',
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
