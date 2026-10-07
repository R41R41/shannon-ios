/**
 * The window of the workspace part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind or a surface may import of it. The workspace is the shared place of a turn (`[いまの場]`, the
 * notices and the data frames), held in the API process behind `MindHost` (owner answer 1; it moves to `mindWorker.ts` in
 * stage 4). Her own time never imports it (rule `own-time-without-private-stores`). Core: response path.
 *
 * Stage 3, step 0: the part exists so that the core map covers every file of it from the start; whether it runs is
 * `mindSwitches(...).workspace`.
 */
export { mindSwitches, type MindSwitches } from '@shannon/mind';
