/**
 * The one way a message she starts on her own leaves (owner decision 2026-10-02): its vocabulary (`reachOutVocabulary.ts`) and the
 * speaker that writes it, with the proactive gate where it would be written (`store/reachOutSpeaker.ts`). Split so in Syzygy
 * ADR-0008 stage 3 (S2) that only a store opens SQLite; nothing of either changed.
 */
export { REACH_OUT_SOURCE_PREFIX, REACH_OUT_SOURCE_TITLE, REACH_OUT_FOLLOW_UP_KEY_PREFIX, REACH_OUT_CALL_KEY_PREFIX, REACH_OUT_FOLLOW_UP_SEEN_SOURCE_PREFIX, reachOutOfSource, type ReachOutDelivery, REACH_OUT_OTHERS_AUDIENCE } from './reachOutVocabulary.js';
export { SQLiteReachOutSpeaker, reachOutFace } from './store/reachOutSpeaker.js';
