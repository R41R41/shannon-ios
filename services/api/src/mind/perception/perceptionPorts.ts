/**
 * The window of the perception part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind, an integration or a surface may import of it. Perception turns what a surface received into one
 * `mind.event.v1` and copies the surface's audience decision, never recomputing it. Core: response path.
 *
 * Stage 3, step 0: the part exists so that the core map covers every file of it from the start; whether it runs is
 * `mindSwitches(...).mindEvents`.
 */
export { mindSwitches, type MindSwitches } from '@shannon/mind';
