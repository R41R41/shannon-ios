/**
 * The injection window of the memory part (Syzygy ADR-0008 §10; stage 3, pre-deploy review): the check for words like an
 * instruction, for the workspace's data frames. Narrow so that nothing loads more than the check.
 */
export { injectionThreats, neutralizedForFrame, textForInjectionCheck } from './injectionGuard.js';
