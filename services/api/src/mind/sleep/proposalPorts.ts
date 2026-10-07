/**
 * The proposals window of the sleep part (Syzygy ADR-0008 §6 and §10; stage 3, S3): the explicit memory proposals a turn yields,
 * for people memory on platforms. Kept apart from `sleepPorts.ts` so that nothing loads more than it did.
 */
export { extractExplicitMemoryProposals } from './sleepConsolidation.js';
