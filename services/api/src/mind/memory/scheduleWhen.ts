/**
 * The owner's words for a span of time (「来週の水曜の午後」「今週末」「10月30日の15時から17時」) as instants in his zone, for
 * the schedule tools (`docs/calendar-contract.md`). Days are counted as civil days (days since 1970-01-01), weeks begin on
 * Monday, and a part of the day becomes a window that every day of the span keeps. Nothing here reads a calendar.
 */
export interface DailyWindow {
  /** Minutes after local midnight; `endMinute` is at most 1440. */
  startMinute: number;
  endMinute: number;
}

export interface ScheduleWindow {
  /** Canonical ISO 8601 (UTC). `until` is exclusive. */
  from: string;
  until: string;
  /** The part of each day the words named (「午後」), when they named one. */
  daily?: DailyWindow;
  /** The span as she can say it back: 「10月28日(水) 12:00〜18:00」. */
  label: string;
}

interface DaySpan { first: number; last: number; fromNow?: true }

const DAY = 86_400_000;
const WEEKDAYS = '日月火水木金土';
const PARTS: ReadonlyArray<[RegExp, DailyWindow]> = [
  [/早朝/u, { startMinute: 4 * 60, endMinute: 7 * 60 }],
  [/朝|今朝/u, { startMinute: 5 * 60, endMinute: 10 * 60 }],
  [/午前/u, { startMinute: 6 * 60, endMinute: 12 * 60 }],
  [/昼|ランチ/u, { startMinute: 11 * 60, endMinute: 14 * 60 }],
  [/日中/u, { startMinute: 9 * 60, endMinute: 18 * 60 }],
  [/夕方/u, { startMinute: 16 * 60, endMinute: 19 * 60 }],
  [/深夜/u, { startMinute: 22 * 60, endMinute: 24 * 60 }],
  [/夜|今晩|晩/u, { startMinute: 18 * 60, endMinute: 24 * 60 }],
  [/午後/u, { startMinute: 12 * 60, endMinute: 18 * 60 }],
];
const CLOCK = '(午前|午後|朝|夜|夕方)?(\\d{1,2})(?:時(?!間)|:)(\\d{2}|半)?分?';
const CLOCK_RANGE = new RegExp(`${CLOCK}(?:から|〜|~|-)${CLOCK}`, 'u');
const CLOCK_AFTER = new RegExp(`${CLOCK}(?:以降|から|すぎ|過ぎ)`, 'u');
const CLOCK_BEFORE = new RegExp(`${CLOCK}(?:まで|前)`, 'u');
const CLOCK_AT = new RegExp(CLOCK, 'u');

/** The span the words name, or null when they name none this reader knows. */
export function resolveScheduleWhen(phrase: string, now: string, timeZone: string): ScheduleWindow | null {
  const text = phrase.normalize('NFKC').replace(/\s+/gu, '');
  if (!text) return null;
  const today = localParts(now, timeZone).civil;
  const daily = dailyWindow(text);
  const named = daySpan(text, today) ?? (daily ? { first: today, last: today } : null);
  if (!named) return null;
  // 「来週末まで」: from today to the last day named (a clock's まで is the daily window's, not the span's).
  const span = /まで$/u.test(text) && !CLOCK_BEFORE.test(text) && !named.fromNow ? { first: today, last: Math.max(today, named.last) } : named;
  return windowOf(span, daily, now, timeZone);
}

function windowOf(span: DaySpan, daily: DailyWindow | null, now: string, timeZone: string): ScheduleWindow {
  if (span.fromNow) return { from: now, until: new Date(Date.parse(now) + 48 * 3_600_000).toISOString(), label: 'これから48時間' };
  const single = span.first === span.last;
  // One day with a part of it is that part; several days keep the whole days and the part as their daily window.
  const timed = single ? daily : null;
  const from = zonedInstant(span.first, timed?.startMinute ?? 0, timeZone);
  const until = timed ? zonedInstant(span.last, timed.endMinute, timeZone) : zonedInstant(span.last + 1, 0, timeZone);
  const days = single ? dayText(span.first) : `${dayText(span.first)}〜${dayText(span.last)}`;
  const part = daily ? `${single ? ' ' : '、各日 '}${clockText(daily.startMinute)}〜${clockText(daily.endMinute)}` : '';
  return { from, until, ...(daily ? { daily } : {}), label: `${days}${part}` };
}

/** The days the words name, earliest and latest. */
function daySpan(text: string, today: number): DaySpan | null {
  return explicitDay(text, today) ?? relativeDay(text, today) ?? weekdaySpan(text, today) ?? weekSpan(text, today) ?? monthSpan(text, today)
    ?? (/これから|このあと|この後|今から/u.test(text) ? { first: today, last: today + 1, fromNow: true } : null);
}

function explicitDay(text: string, today: number): DaySpan | null {
  const date = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/u.exec(text) ?? /(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/u.exec(text);
  if (date) return single(civilDate(date[1], Number(date[2]), Number(date[3]), today));
  const day = /(?<![\d月/])(\d{1,2})日(?!後|間|前|ぶり)/u.exec(text);
  if (!day) return null;
  const { year, month } = civilParts(today);
  const inMonth = civilOf(year, month, Number(day[1]));
  return single(inMonth !== null && inMonth >= today ? inMonth : civilOf(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, Number(day[1])));
}

function relativeDay(text: string, today: number): DaySpan | null {
  const after = /(\d{1,2})日後/u.exec(text);
  if (after) return single(today + Number(after[1]));
  const words: ReadonlyArray<[RegExp, number]> = [
    [/明々後日|しあさって/u, 3], [/明後日|あさって/u, 2], [/明日|あした|あす/u, 1], [/今日|本日|きょう|今夜|今晩|今朝/u, 0],
  ];
  const found = words.find(([pattern]) => pattern.test(text));
  return found ? single(today + found[1]) : null;
}

function weekdaySpan(text: string, today: number): DaySpan | null {
  const match = /(再来週|来週|今週|今度|次)?の?([月火水木金土日])曜/u.exec(text);
  if (!match) return null;
  const target = WEEKDAYS.indexOf(match[2]!);
  const monday = today - mondayOffset(today);
  const inWeek = monday + (target + 6) % 7;
  const weeks: Readonly<Record<string, number>> = { 今週: 0, 来週: 7, 再来週: 14 };
  if (match[1] && match[1] in weeks) return single(inWeek + weeks[match[1]]!);
  const ahead = (target - weekday(today) + 7) % 7;
  return single(today + (ahead === 0 && match[1] ? 7 : ahead));
}

function weekSpan(text: string, today: number): DaySpan | null {
  const monday = today - mondayOffset(today);
  const shift = /再来週/u.test(text) ? 14 : /来週/u.test(text) ? 7 : /今週|週末/u.test(text) ? 0 : null;
  if (shift === null) return null;
  if (/週末/u.test(text)) return { first: monday + shift + 5, last: monday + shift + 6 };
  return { first: shift === 0 ? today : monday + shift, last: monday + shift + 6 };
}

function monthSpan(text: string, today: number): DaySpan | null {
  const { year, month } = civilParts(today);
  if (/今月/u.test(text)) return { first: today, last: civilOf(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)! - 1 };
  if (!/来月/u.test(text)) return null;
  const nextYear = month === 12 ? year + 1 : year, next = month === 12 ? 1 : month + 1;
  return { first: civilOf(nextYear, next, 1)!, last: civilOf(next === 12 ? nextYear + 1 : nextYear, next === 12 ? 1 : next + 1, 1)! - 1 };
}

/** The part of each day the words name: a clock range, a clock bound, or a word such as 午後. */
function dailyWindow(text: string): DailyWindow | null {
  const range = CLOCK_RANGE.exec(text);
  if (range) return bounded(clockMinute(range[1], range[2]!, range[3]), clockMinute(range[4] ?? range[1], range[5]!, range[6]));
  const after = CLOCK_AFTER.exec(text);
  if (after) return bounded(clockMinute(after[1], after[2]!, after[3]), 24 * 60);
  const before = CLOCK_BEFORE.exec(text);
  if (before) return bounded(0, clockMinute(before[1], before[2]!, before[3]));
  const at = CLOCK_AT.exec(text);
  if (at) return bounded(clockMinute(at[1], at[2]!, at[3]), clockMinute(at[1], at[2]!, at[3]) + 60);
  return PARTS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function clockMinute(part: string | undefined, hour: string, minute: string | undefined): number {
  const value = Number(hour);
  const afternoon = (part === '午後' || part === '夜' || part === '夕方') && value < 12;
  return (afternoon ? value + 12 : value) * 60 + (minute === '半' ? 30 : Number(minute ?? 0));
}

function bounded(startMinute: number, endMinute: number): DailyWindow | null {
  const end = Math.min(24 * 60, endMinute);
  return startMinute >= 0 && startMinute < end ? { startMinute, endMinute: end } : null;
}

const single = (civil: number | null): DaySpan | null => civil === null ? null : { first: civil, last: civil };

/** A month and day without a year: this year, or next year once the day has passed. */
function civilDate(year: string | undefined, month: number, day: number, today: number): number | null {
  if (year) return civilOf(Number(year), month, day);
  const thisYear = civilOf(civilParts(today).year, month, day);
  return thisYear !== null && thisYear < today ? civilOf(civilParts(today).year + 1, month, day) : thisYear;
}

export function civilOf(year: number, month: number, day: number): number | null {
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  return back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? time / DAY : null;
}

function civilParts(civil: number): { year: number; month: number; day: number } {
  const date = new Date(civil * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 0 for Sunday. 1970-01-01 was a Thursday. */
export const weekday = (civil: number): number => ((civil % 7) + 11) % 7;
const mondayOffset = (civil: number): number => (weekday(civil) + 6) % 7;

/** 「10月28日(水)」 */
export function dayText(civil: number): string {
  const { month, day } = civilParts(civil);
  return `${month}月${day}日(${WEEKDAYS[weekday(civil)]})`;
}

export function clockText(minute: number): string {
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

/** The civil day and the minute of that day an instant shows in a zone. */
export function localParts(at: string, timeZone: string): { civil: number; minute: number } {
  const parts = Object.fromEntries(zoneFormat(timeZone).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const civil = civilOf(Number(parts.year), Number(parts.month), Number(parts.day)) ?? Math.floor(Date.parse(at) / DAY);
  return { civil, minute: Number(parts.hour) % 24 * 60 + Number(parts.minute) };
}

/** The instant a zone's clock shows `minute` minutes after the start of a civil day (1440 is the next midnight). */
export function zonedInstant(civil: number, minute: number, timeZone: string): string {
  const wall = civil * DAY + minute * 60_000;
  let guess = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = localParts(new Date(guess).toISOString(), timeZone);
    guess += wall - (shown.civil * DAY + shown.minute * 60_000);
  }
  return new Date(guess).toISOString();
}

/** `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD`, then midnight) on the owner's clock, as an instant; null for anything else. */
export function localTextInstant(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/u.exec(value);
  if (!match) return null;
  const civil = civilOf(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0);
  return civil === null || hour > 23 || minute > 59 ? null : zonedInstant(civil, hour * 60 + minute, timeZone);
}

/** An instant as the owner's `YYYY-MM-DDTHH:mm`. */
export function instantLocalText(at: string, timeZone: string): string {
  const { civil, minute } = localParts(at, timeZone);
  const { year, month, day } = civilParts(civil);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${year}-${two(month)}-${two(day)}T${two(Math.floor(minute / 60))}:${two(minute % 60)}`;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  const known = FORMATS.get(timeZone);
  if (known) return known;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23' });
  } catch {
    format = zoneFormat('Asia/Tokyo');
  }
  FORMATS.set(timeZone, format);
  return format;
}
