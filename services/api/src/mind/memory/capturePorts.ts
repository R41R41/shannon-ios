/**
 * The captures window of the memory part (Syzygy ADR-0008 §6 and §10; stage 3, S2): the keys and owner-facing words of a turn's
 * captures, moved out of the captures store, for the background updates. Kept apart from `memoryPorts.ts` so that the worker loads
 * nothing more than it did.
 */
export { intentCaptureKey, ownerFacingStatement, turnCaptureId } from './turnCaptureKeys.js';
