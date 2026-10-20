/**
 * The window of the recall part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): what another part of the mind
 * may import of it (the replay window, impression recall, the knowledge a turn may use). Her own time never imports it
 * (rule `own-time-without-private-stores`).
 */
export {
  REPLAY_SUMMARY_CHARACTERS, nextWindowStart, replayRule, replayWindow, summaryCoverRule, type ReplayRule, type ReplayWindow,
  afterLongSilence, voiceReplayGap, conversationReplay,
} from './conversationWindow.js';
export { VOICE_HISTORY, VOICE_SUMMARY_CHARACTERS, coversLive, isOperatorNote, voiceHistorySummaryOn } from './voiceHistory.js';
export { ImpressionEvidenceCheck, impressionSubject, impressionText, recallImpressions, usableImpression } from './impressionRecall.js';
export { type MemoryModelGateway } from './memoryModels.js';
export { type TurnMemoryRecall } from './turnMemoryRecall.js';

export { usableKnowledgeFor } from './turnKnowledgeRecall.js';

export { platformImpressionLines } from './impressionRecall.js';
