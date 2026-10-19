/**
 * How a promise is worded once it is stored (owner 2026-10-19). A promise keeps the sentence it was made in (「明日の9:20に起こして」),
 * and that sentence was read back days later as if 「明日」 were still tomorrow: 「明日の9時20分に起こす約束も覚えていますよ」 on the 14th,
 * 15th and 16th, and 「9:20 明日の9:20に起こして」 in a morning brief. Its time is stored apart (`dueAt`, `dueDate`), so what is told
 * of it is what it is about, and its day is a date. Pure.
 */
const DAY_WORD = '(?:今日|きょう|今夜|今晩|明日|あした|あす|明後日|あさって|明々後日|しあさって|\\d{1,2}月\\d{1,2}日|来週の?[月火水木金土日]曜日?|[月火水木金土日]曜日?)';
const PART = '(?:早朝|朝|昼|夕方|夜|晩|午前中|午前|午後)';
const CLOCK = '(?:午前|午後)?\\s*\\d{1,2}(?:時(?:\\d{1,2}分|半)?|[:：]\\d{2})(?:ごろ|頃)?';
const LEAD = new RegExp(`^(?:じゃあ|では|それじゃ|よし)?[、,\\s]*${DAY_WORD}?(?:の|\\s)*${PART}?(?:の|\\s)*(?:${CLOCK})?(?:までに|まで|には|に|は|の)?[、,\\s]*`, 'u');
const RELATIVE: ReadonlyArray<readonly [RegExp, number]> = [
  [/明々後日|しあさって/u, 3], [/明後日|あさって/u, 2], [/明日|あした|あす/u, 1], [/今日|きょう|今夜|今晩/u, 0],
];

/** What a promise is about, without the day and time it was said with (they are stored apart): 「明日の9:20に起こして」 → 「起こして」. */
export function promiseTopic(summary: string): string {
  const text = summary.replace(/\s+/gu, ' ').trim();
  const topic = text.replace(LEAD, '').trim();
  return topic.length >= 2 ? topic : text;
}

/** 「10月14日」 for a stored date (YYYY-MM-DD). */
export function promiseDateLabel(dueDate: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(dueDate);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : dueDate;
}

/**
 * The sentence with its relative day words as the date they meant (「明日の9:20に起こして」 said on the 13th → 「10月14日の9:20に起こして」),
 * when the date is stored; otherwise the sentence as it was.
 */
export function promiseWithDate(summary: string, dueDate: string | undefined): string {
  if (!dueDate) return summary;
  for (const [pattern] of RELATIVE) if (pattern.test(summary)) return summary.replace(pattern, promiseDateLabel(dueDate));
  return summary;
}

/** How long after its time a promise is still told as just past; after that it is no longer an open promise to speak of. */
export const PROMISE_PAST_HOURS = 6;

/**
 * Where a pending promise stands at `now`: `upcoming`, `due` (its time passed less than `PROMISE_PAST_HOURS` ago, or its date is today),
 * or `past` (longer ago, or its date is before today in `timeZone`). One without a time or date is `upcoming`.
 */
export function promiseStanding(memory: { dueAt?: string; dueDate?: string; timeZone?: string }, now: string, timeZone = 'Asia/Tokyo')
  : 'upcoming' | 'due' | 'past' {
  const time = Date.parse(now);
  const dueAt = memory.dueAt ? Date.parse(memory.dueAt) : Number.NaN;
  if (Number.isFinite(dueAt) && Number.isFinite(time)) {
    if (dueAt > time) return 'upcoming';
    return time - dueAt <= PROMISE_PAST_HOURS * 3_600_000 ? 'due' : 'past';
  }
  if (!memory.dueDate || !Number.isFinite(time)) return 'upcoming';
  const today = localDate(time, memory.timeZone ?? timeZone);
  return memory.dueDate > today ? 'upcoming' : memory.dueDate === today ? 'due' : 'past';
}

function localDate(time: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}
