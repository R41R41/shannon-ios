/**
 * The speed over dry land and rough ground, in metres a second, as the lines that say a trip in seconds read it (a reading, not a measure).
 * The eye ledger (`minecraftEyeLedger.ts`, `WALK_FAST` / `WALK_SLOW`) owns the numbers; this file only gives them the names the furnace-wait lines use,
 * so that a trip is said with one ruler in every line.
 */
export { WALK_FAST as TRAVEL_FAST_MPS, WALK_SLOW as TRAVEL_SLOW_MPS } from './minecraftEyeLedger.js';
