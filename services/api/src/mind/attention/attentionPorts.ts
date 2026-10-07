/**
 * The window of the attention part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind may import of it. Attention orders what was perceived by salience and never silences
 * (`voiceSilence` stays the only silencer); the proactive gate holds her own messages at the delivery points. Core: response
 * path (the gate: guard).
 *
 * Stage 3, step 0: the part exists so that the core map covers every file of it from the start; whether it runs is
 * `mindSwitches(...).attention` and `.proactiveGate`.
 */
export { mindSwitches, type MindSwitches } from '@shannon/mind';
