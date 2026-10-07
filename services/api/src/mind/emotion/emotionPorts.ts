/**
 * The window of the emotion part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): what another part of the mind
 * may import of it. Her own time never imports it (rule `own-time-without-private-stores`); the awake clock is reached by the
 * worker alone (rule `awake-clock-from-worker`).
 */
export { ownerDay, presentCompanionState, sharedTimeEvent, type PresentedCompanionState } from './companionPresence.js';
export { emotionTiming } from './emotionTiming.js';
