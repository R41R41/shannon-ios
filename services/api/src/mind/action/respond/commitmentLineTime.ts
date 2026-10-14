/**
 * Whether the times, dates and counts in a promise's line agree with the promise's facts (owner rule: a fact is never wrong;
 * review of b867e66c). Each time is read as a time, by position: its hour against the hour and its minute against the minute
 * (「9時20分」, 「9:20」, 「09:20」, 「九時二十分」, 「9時半」 for 09:30), never as a loose set of numbers (「20時だよ」 and 「20時9分」 are not
 * 09:20). A day word other than today (明日, 明後日, 昨日 …), a weekday or a date that is not the promise's day, an hour count, a
 * lateness that is not the promise's, or any other number that the promise's own words do not hold makes the line untrusted, and
 * the caller falls back to the neutral factual line. When unsure, untrusted.
 *
 * Morning and evening: a time with 午前/朝 or 午後/夜/夕方/晩/昼 is read in that half of the day. A bare hour is read as written
 * (24-hour), or, for a promise due from noon on, as its 12-hour form too: 「9時20分」 for 21:20 is accepted, because the line is said
 * at the promise's own time, when the evening's 9:20 is the only one it can mean (Japanese says the evening's hours that way).
 * The other direction is never accepted: 「21時20分」 and 「午後9時20分」 are not 09:20.
 */
export interface CommitmentClockFacts {
  /** The promise's own words (a verbatim quote of them is not read as a claim of the line). */
  title: string;
  /** Owner-local 「HH:MM」 when the promise has a clock time; anything else (「今日」) means it has none. */
  when: string | null;
  overdueMinutes: number | null;
  /** The owner-local day it is due: month, day and the weekday's one character (火). Absent: no day or weekday may be named. */
  dueOn?: { month: number; day: number; weekday: string };
}

const KANJI_DIGITS: Readonly<Record<string, number>> = Object.freeze({ 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

/** A kanji number up to 99 (九, 十, 二十, 二十五), or null. */
function kanjiNumber(text: string): number | null {
  if (!/^[〇零一二三四五六七八九十]{1,3}$/u.test(text)) return null;
  const ten = text.indexOf('十');
  if (ten < 0) return text.length === 1 ? KANJI_DIGITS[text]! : null;
  const tens = ten === 0 ? 1 : KANJI_DIGITS[text.slice(0, ten)] ?? null;
  const rest = text.slice(ten + 1);
  const ones = rest === '' ? 0 : KANJI_DIGITS[rest] ?? null;
  return tens === null || ones === null ? null : tens * 10 + ones;
}

const shape = (text: string) => text.normalize('NFKC').replace(/[\s「」『』、。！？!?・]/gu, '').toLowerCase()
  .replace(/[〇零一二三四五六七八九十]{1,3}(?=時|分|日|月|曜)/gu, match => String(kanjiNumber(match) ?? match));

const OTHER_DAY = /明後日|明日|あした|あす|あさって|一昨日|昨日|きのう|おととい|明朝|明晩|昨夜|昨晩|来週|先週|来月|先月/u;
const PM = new Set(['午後', '夜', '夕方', '晩', '昼']);
const AM = new Set(['午前', '朝']);

/** What a clock time in the line says, in 24 hours, or every reading of a bare hour. */
function readings(period: string | undefined, hour: number): number[] {
  if (period && PM.has(period)) return hour > 12 ? [] : [hour === 12 ? 12 : hour + 12];
  if (period && AM.has(period)) return hour > 12 ? [] : [hour === 12 ? 0 : hour];
  return [hour];
}

function clockOf(when: string | null): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(when ?? '');
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** The numbers left in a text once its clock times are taken out (the promise's own counts, never its time). */
function numbersApartFromTimes(text: string): number[] {
  return (text.replace(/\d{1,2}:\d{2}|\d{1,2}時(?!間)(?:\d{1,2}分|半)?/gu, ' ').match(/\d+/gu) ?? []).map(Number);
}

const PERIOD = '(?:(午前|午後|朝|夜|夕方|晩|昼)の?)?';
const COLON_TIME = new RegExp(`${PERIOD}(\\d{1,2}):(\\d{2})`, 'gu');
const KANJI_TIME = new RegExp(`${PERIOD}(\\d{1,2})時(?!間)(?:(\\d{1,2})分|(半))?`, 'gu');

/** Days, weekdays and dates named in the line, each checked against the due day; the rest of the line, or null when one is wrong. */
function withoutDays(text: string, due: CommitmentClockFacts['dueOn']): string | null {
  if (OTHER_DAY.test(text)) return null;
  for (const match of text.matchAll(/([月火水木金土日])曜/gu)) if (!due || match[1] !== due.weekday) return null;
  let rest = text.replace(/[月火水木金土日]曜日?/gu, ' ');
  for (const match of rest.matchAll(/(\d{1,2})月(\d{1,2})日/gu)) if (!due || Number(match[1]) !== due.month || Number(match[2]) !== due.day) return null;
  rest = rest.replace(/\d{1,2}月\d{1,2}日/gu, ' ');
  for (const match of rest.matchAll(/(\d{1,2})日/gu)) if (!due || Number(match[1]) !== due.day) return null;
  return rest.replace(/\d{1,2}日/gu, ' ');
}

/** Whether one clock time of the line is the promise's: its minute, and its hour in the half of the day it names. */
function sameTime(time: { period: string | undefined; hour: number; minute: number }, clock: { hour: number; minute: number }): boolean {
  if (time.minute !== clock.minute) return false;
  const hours = readings(time.period, time.hour);
  // A bare hour of a promise due from noon on may be its 12-hour form (said at that very time; see above).
  if (!time.period && clock.hour >= 12 && time.hour + 12 === clock.hour) hours.push(clock.hour);
  return hours.includes(clock.hour);
}

/** Clock times of the line, each checked by position; the rest of the line, or null when one is wrong. */
function withoutTimes(text: string, when: string | null): string | null {
  const clock = clockOf(when);
  const times = [
    ...[...text.matchAll(COLON_TIME)].map(match => ({ period: match[1], hour: Number(match[2]), minute: Number(match[3]) })),
    ...[...text.matchAll(KANJI_TIME)].map(match => ({ period: match[1], hour: Number(match[2]), minute: match[4] ? 30 : match[3] ? Number(match[3]) : 0 })),
  ];
  if (times.some(time => !clock || !sameTime(time, clock))) return null;
  return text.replace(COLON_TIME, ' ').replace(KANJI_TIME, ' ');
}

export function commitmentTimesGrounded(line: string, facts: CommitmentClockFacts): boolean {
  const title = shape(facts.title);
  // A verbatim quote of the promise is its name, not a claim of the line about a day or a time.
  const quoted = title ? shape(line).split(title).join(' ') : shape(line);
  const days = withoutDays(quoted, facts.dueOn);
  const rest = days === null ? null : withoutTimes(days, facts.when);
  if (rest === null) return false;
  // An hour count is never a fact of the promise; a lateness in minutes must be its own.
  if (/\d+時間/u.test(rest)) return false;
  for (const match of rest.matchAll(/(\d+)分/gu)) if (facts.overdueMinutes === null || Number(match[1]) !== facts.overdueMinutes) return false;
  // Any other number is one of the promise's own counts (never its time), or the line is untrusted.
  const known = new Set(numbersApartFromTimes(title));
  return (rest.replace(/\d+分/gu, ' ').match(/\d+/gu) ?? []).map(Number).every(value => known.has(value));
}
