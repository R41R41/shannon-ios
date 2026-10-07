/**
 * The owner-local calendar day (Syzygy ADR-0008 stage 3, S3: moved unchanged from the API's `companionPresence.ts`, so her own time,
 * the budget and the prediction record read the day without reaching the emotion part). Pure: the caller hands the instant.
 */
const DEFAULT_TIME_ZONE = 'Asia/Tokyo';
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The owner-local calendar day (YYYY-MM-DD) of an instant. */
export function ownerDay(at: string, timeZone?: string): string {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return ownerDay(at, DEFAULT_TIME_ZONE);
    }
    dayFormatters.set(zone, formatter);
  }
  const time = Date.parse(at);
  return formatter.format(new Date(Number.isFinite(time) ? time : 0));
}
