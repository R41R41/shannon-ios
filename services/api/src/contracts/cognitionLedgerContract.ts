/**
 * The shared vocabulary of the prediction record and the cognition ledger (Syzygy ADR-0006, ADR-0008 stage 1;
 * `docs/prediction-shadow-contract.md`, `docs/cognition-ledger-contract.md`): what a stored value must match, the owner-local
 * quarter of the day, and the port a touch's prediction is handed. No store, no clock of its own.
 */

/** Closed vocabulary values: ASCII letters, digits and `_.:-`, starting with a letter. */
export const PREDICTION_SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;
/** Identifiers of source records. */
export const PREDICTION_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u;

const bandHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' });

/** The owner-local quarter of the day an instant is in. */
export function dayBand(at: string): 'night' | 'morning' | 'afternoon' | 'evening' {
  const hour = Number(bandHour.format(new Date(Date.parse(at) || 0)));
  return hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** What a touch's prediction is handed (ADR-0008 stage 1): open one about a burst, match it with her stance, or void it (null). */
export interface TouchLedger {
  open(scopeKey: string, touch: { key: string; context: string; burstId: string }, at: string): string | null;
  settle(scopeKey: string, predictionId: string, stance: number | null, at: string): void;
}
