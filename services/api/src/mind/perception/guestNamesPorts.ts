/**
 * The guest-names window of the perception part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S3): how a name heard
 * or read is cleaned and keyed, moved from the voice surface into perception. Kept apart from `perceptionPorts.ts` so that people
 * memory, in the worker, loads nothing more than it did.
 */
export { cleanPersonName, establishedGuestName, personNameKey } from './voiceGuestNames.js';
