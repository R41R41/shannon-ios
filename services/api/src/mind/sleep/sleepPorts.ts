/**
 * The window of the sleep part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): what another part of the mind
 * may import of it (the background service's type, the commitment review's type, the explicit memory proposals).
 */
export { type TurnBackgroundService } from './backgroundUpdates.js';
export { type CommitmentSleepReview } from './sleepCommitmentReview.js';
export { explicitFactStatement } from './sleepConsolidationRules.js';
