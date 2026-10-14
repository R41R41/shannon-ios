/**
 * The times, days and dates a promise's line may say, as an allowlist (owner rule: a fact is never wrong; reviews of b867e66c and
 * 508b6288, which found that a parser of times accepts what it does not understand: 「今夜は9時20分」, 「9:20pm」, 「0時20分」 for
 * 12:20, 「翌日」, 「9時20分前」, 「20分後」).
 *
 * The server computes, from the promise's facts alone, the phrases that state its time correctly: the canonical ones her line is
 * told to use (`canonicalTimePhrases`: 「9時20分」 for 09:20, 「夜の9時20分」 or 「21時20分」 for 21:20) and their exact equivalents
 * (`allowedTimePhrases`: 9:20, 09:20, 九時二十分, 9時半 for :30, and only the half-of-day words that are true of it: 午前/朝 before
 * noon, 午後/昼/夕方/夜 after). A bare 12-hour form of an afternoon or evening time is not one of them.
 *
 * A line is checked by removal, never by reading: the verbatim promise, then the allowed phrases (longest first), then its own
 * lateness (「47分過ぎ」), the due day's own 今日, weekday and date, are taken out. If any sign of a time or a date is left (a digit,
 * a kanji number beside 時/分/日/月/曜 or beside what was taken out, a half-of-day word in Japanese or English, a day other than the
 * due day, a weekday or a date, a duration or a relative time such as 〜前/〜後/〜間/〜過ぎ right after a time), the line is not
 * trusted and the caller uses the neutral factual line. Unsure is untrusted.
 */
export interface CommitmentClockFacts {
  /** The promise's own words (a verbatim quote of them is its name, not a claim of the line). */
  title: string;
  /** Owner-local 「HH:MM」 when the promise has a clock time; anything else (「今日」) means it has none. */
  when: string | null;
  overdueMinutes: number | null;
  /** The owner-local day it is due (weekday: one character, 水), and whether that day is today where the line is said. */
  dueOn?: { month: number; day: number; weekday: string; today: boolean };
}

const KANJI = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 0..59 in kanji (九, 十, 二十, 二十五). */
function kanji(value: number): string {
  if (value < 10) return KANJI[value]!;
  const tens = Math.floor(value / 10);
  return `${tens === 1 ? '' : KANJI[tens]}十${value % 10 ? KANJI[value % 10] : ''}`;
}

function clockOf(when: string | null): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(when ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** One hour (as written) and the minute in every exact form: 9時20分, 九時二十分, 9:20 (and 09:20 when two digits are asked). */
function clockForms(hour: number, minute: number, padded: boolean): string[] {
  const minuteWords = minute === 0 ? ['時', '時ちょうど'] : minute === 30 ? ['時半', '時30分'] : [`時${minute}分`];
  const kanjiMinute = minute === 0 ? ['時'] : minute === 30 ? ['時半', `時${kanji(30)}分`] : [`時${kanji(minute)}分`];
  const mm = String(minute).padStart(2, '0');
  return [
    ...minuteWords.map(word => `${hour}${word}`), ...kanjiMinute.map(word => `${kanji(hour)}${word}`),
    `${hour}:${mm}`, ...(padded ? [`${String(hour).padStart(2, '0')}:${mm}`] : []),
  ];
}

/** The half-of-day words true of an hour (24h), and the 12-hour hour they go with. */
function halves(hour: number): { words: string[]; twelve: number } {
  if (hour < 12) return { words: ['午前', ...(hour >= 5 && hour <= 10 ? ['朝'] : [])], twelve: hour };
  // Noon: 午後12時 is read both ways, so only 昼 goes with 12.
  if (hour === 12) return { words: ['昼'], twelve: 12 };
  const words = ['午後', ...(hour <= 14 ? ['昼'] : []), ...(hour >= 15 && hour <= 18 ? ['夕方'] : []), ...(hour >= 18 ? ['夜'] : [])];
  return { words, twelve: hour === 12 ? 12 : hour - 12 };
}

/** The phrases her line is told to use for the promise's time (none without a clock time). */
export function canonicalTimePhrases(facts: Pick<CommitmentClockFacts, 'when'>): string[] {
  const clock = clockOf(facts.when);
  if (!clock) return [];
  const minute = clock.minute === 0 ? '時' : `時${clock.minute}分`;
  if (clock.hour < 12) return [`${clock.hour}${minute}`];
  const { words, twelve } = halves(clock.hour);
  return [`${words.at(-1)}の${twelve}${minute}`, `${clock.hour}${minute}`];
}

/** Every phrase that states the promise's time exactly: the 24-hour forms, and the 12-hour forms with a true half-of-day word. */
export function allowedTimePhrases(facts: Pick<CommitmentClockFacts, 'when'>): string[] {
  const clock = clockOf(facts.when);
  if (!clock) return [];
  const { words, twelve } = halves(clock.hour);
  // Bare 24-hour forms: unambiguous for an afternoon hour (13..23) and for the morning (0..11, as said in the morning).
  const bare = clock.hour === 12 ? clockForms(12, clock.minute, true) : clockForms(clock.hour, clock.minute, true);
  const withHalf = words.flatMap(word => clockForms(twelve, clock.minute, false).flatMap(form => [`${word}${form}`, `${word}の${form}`]));
  return [...new Set([...withHalf, ...bare])].sort((left, right) => right.length - left.length);
}

/** The due day's own words: 今日 (only when it is today), its weekday and its date. */
function dayPhrases(due: CommitmentClockFacts['dueOn']): string[] {
  if (!due) return [];
  return [
    ...(due.today ? ['今日'] : []), `${due.weekday}曜日`, `${due.weekday}曜`,
    `${due.month}月${due.day}日`, `${kanji(due.month)}月${due.day}日`,
  ].sort((left, right) => right.length - left.length);
}

const shape = (text: string) => text.normalize('NFKC').replace(/[\s「」『』、。！？!?・,]/gu, '').toLowerCase();
const KANJI_NUMBER = '[〇零一二三四五六七八九十百]';
const MARK = '⟨t⟩';

/** Any sign of a time or a date left in a line once what may be said was taken out. */
const SIGNS: readonly RegExp[] = Object.freeze([
  /[0-9]/u,
  new RegExp(`${KANJI_NUMBER}+(?:時|分|日|月|曜|秒|週)`, 'u'),
  new RegExp(`${KANJI_NUMBER}${MARK}|${MARK}${KANJI_NUMBER}`, 'u'),
  // A word glued to the front of an allowed phrase changes it (深夜9時 is not 夜9時; 昨夜, 今朝, 翌朝 …): unsure, so not trusted.
  new RegExp(`[深今昨明翌真夜朝午昼晩宵前後毎日月曜a-z]${MARK}`, 'u'),
  /午前|午後|朝|夜|晩|深夜|真夜中|夜中|明け方|夜明け|夕方|夕暮れ|昼|正午|今夜|今朝|今晩|未明|宵/u,
  /\b(?:a\.?m|p\.?m)\b|am|pm|morning|evening|night|tonight|noon|midnight|o'?clock/u,
  /今日|きょう|明日|あした|あす|明後日|あさって|明々後日|明明後日|しあさって|翌|前日|昨日|きのう|一昨日|おととい|昨夜|昨晩|来週|先週|今週|再来週|来月|先月|今月|週末|平日/u,
  /tomorrow|yesterday|today|tonite|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday/u,
  /[月火水木金土日]曜|曜日/u,
  new RegExp(`${MARK}(?:前|後|間|過ぎ|すぎ|頃|ごろ|くらい|ぐらい|ほど|弱|強)`, 'u'),
  // A duration or a relative time (with digits or kanji numbers they are caught above; 数 is a count too). 「約束の時間」 is not one.
  /数(?:時間|分|秒|日|週)|分後|分前|時間後|時間前|日後|日前|秒/u,
]);

/** Whether a line says nothing of a time, a day or a date but what the promise's facts allow. */
export function commitmentTimesGrounded(line: string, facts: CommitmentClockFacts): boolean {
  const title = shape(facts.title);
  let rest = title ? shape(line).split(title).join(' ⟨q⟩ ') : shape(line);
  for (const phrase of allowedTimePhrases(facts)) rest = rest.split(shape(phrase)).join(MARK);
  if (facts.overdueMinutes !== null && facts.overdueMinutes > 0) {
    for (const late of [`${facts.overdueMinutes}分過ぎ`, `${facts.overdueMinutes}分すぎ`, `${facts.overdueMinutes}分遅れ`]) rest = rest.split(late).join(' ⟨l⟩ ');
  }
  for (const phrase of dayPhrases(facts.dueOn)) rest = rest.split(shape(phrase)).join(' ⟨d⟩ ');
  return !SIGNS.some(sign => sign.test(rest));
}
