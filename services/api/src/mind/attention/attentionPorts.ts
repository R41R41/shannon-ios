/**
 * The window of the attention part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind may import of it. Attention orders what was perceived by salience and never silences
 * (`voiceSilence` stays the only silencer); the proactive gate holds her own messages at the delivery points. Core: response
 * path (the gate: guard).
 *
 * Step F4: the proactive gate at the delivery points (`proactiveDelivery.ts`, its store handed by wiring). Whether the part runs is
 * `mindSwitches(...).attention` and `.proactiveGate`.
 */
export {
  PROACTIVE_GATE_V1, PROACTIVE_HOLD_CODES, SALIENCE_V1, admit, decodeSignature, encodeSignature, minHashSignature, mindSwitches, novelty, orderedItems,
  ownerActiveHoldMilliseconds, persistenceOf, proactiveVerdict, salience,
  type AttentionItem, type MindSwitches, type ProactiveHistory, type ProactiveHoldCode, type ProactiveIntent, type ProactiveReason, type ProactiveVerdict, type SalienceInputs,
} from '@shannon/mind';
export {
  PROACTIVE_POINTS, PROACTIVE_POINT_TOOL, closedSubject, createProactiveGate,
  type ProactiveDeliveryGate, type ProactiveDeliveryHold, type ProactiveDeliveryIntent, type ProactiveDeliveryVerdict, type ProactiveGateDependencies, type ProactivePoint,
} from './proactiveDelivery.js';
export type { ProactiveTopicRow, SQLiteProactiveTopics } from './store/proactiveTopicsStore.js';
export { type ClaimedReachOut, type ReachOutClaim, type SQLiteReachOutClaims, type UnreadReachOut } from './store/reachOutClaims.js';
export { type ReachOutReportResult, type SQLiteReachOutReports } from './store/reachOutReports.js';
