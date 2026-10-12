export function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The owner's configured time zone (`SHANNON_AUTONOMY_TIMEZONE`, the zone of his days), Asia/Tokyo when unset or unknown. */
export function ownerTimeZone(values: Readonly<Record<string, string | undefined>>): string {
  const zone = values.SHANNON_AUTONOMY_TIMEZONE?.trim() || 'Asia/Tokyo';
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: zone });
    return zone;
  } catch {
    return 'Asia/Tokyo';
  }
}

/** An instant as the owner reads his clock, e.g. 2026年10月13日火曜日 2:40, so that 今日 and 明日 are his days, not UTC's. */
export function ownerLocalClock(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(at));
}
