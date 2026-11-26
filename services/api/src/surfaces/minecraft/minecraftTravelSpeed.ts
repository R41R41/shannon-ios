/**
 * The speed over the ground and the water, in metres a second, as the lines that say a trip in seconds read it (a reading, not a measure: it moves with the share of water on the way).
 * Provisional here: the eye ledger (`minecraftEyeLedger.ts`, `WALK_FAST` / `WALK_SLOW`) owns these numbers; when its unit exports them this file re-exports those and the
 * numbers below are removed, so that a trip is said with one ruler in every line.
 */
export const TRAVEL_FAST_MPS = 4;
export const TRAVEL_SLOW_MPS = 2;
