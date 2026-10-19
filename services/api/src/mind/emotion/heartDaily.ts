import { WARM_STANCES, apologyIn, isFeelingStance, repeatedIn, watchPhrases, type FeelingStance } from '@shannon/cognition';

/**
 * The day's numbers of her heart (owner 2026-10-19, item 17 of the review of a week of talk: nothing was measured, so nothing could
 * be compared before and after a change). Pure: closed counts from the day's rows, read-only, never a word kept or printed beyond the
 * stock phrases she repeated (her own words, which the owner reads in his Talk anyway).
 *
 * - repetition: her replies that said again an opening, an ending or a phrase she had already said three times that day;
 * - lingering: her replies that still said she was cross (むっと・むくれ・怒って・すね), and in how many days in a row;
 * - stances: the feeling turn's stances of her replies, and the share of warm ones (受け入れる・心配する・甘える・照れる);
 * - her own messages: how many she started (reach-outs), and how many in the night;
 * - promises: those due that day, told at their time, closed, and still open after their time;
 * - the watch of Syzygy daily-use evals §11: her 「ごめん」 within two turns of his, and her refusals of a touch.
 */
export interface HeartDayRows {
  /** Her day (3:00 to 3:00 in his zone), `YYYY-MM-DD`. */
  day: string;
  /** His words and her replies of the day in his Talk, oldest first (operator notices are not hers). */
  talk: readonly { role: 'user' | 'assistant'; text: string; at: string }[];
  /** The feeling turn's stance of each of her replies (text and voice), oldest first. */
  stances: readonly string[];
  /** The instants of the messages she started herself, and his zone's hour of each. */
  reachOuts: readonly { at: string; hour: number }[];
  /** Promises of the day by where they stand. */
  promises: { due: number; told: number; closed: number; openAfterTime: number };
  /** How she took the touches of the day (`welcome`, `fine`, `unsure`, `dislike`, `refuse`). */
  touchStances: readonly string[];
}

export interface HeartDayNumbers {
  day: string;
  replies: number;
  /** Her replies that repeated a phrase already said three times that day, and the phrases most repeated. */
  repeating: number;
  repeatedPhrases: readonly { phrase: string; count: number }[];
  /** Her replies that still said she was cross. */
  crossMentions: number;
  stances: Readonly<Record<string, number>>;
  /** Warm stances among all stances, 0..1 (null without a stance). */
  warmShare: number | null;
  reachOuts: number;
  /** Of them, between 23:00 and 7:00. */
  reachOutsAtNight: number;
  promises: HeartDayRows['promises'];
  /** Of his apologies, how many she answered with an apology of her own within two of her replies (§11: ideally low). */
  apologyEchoes: { his: number; echoed: number };
  touchStances: Readonly<Record<string, number>>;
}

const CROSS = /むっと|むくれ|怒って(?:ます|る|い)|すねて|拗ねて|機嫌(?:が)?(?:悪|直らな)/u;
const SORRY = /ごめん|すみません|申し訳/u;
const NIGHT_FROM = 23, NIGHT_UNTIL = 7;

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function heartDayNumbers(rows: HeartDayRows): HeartDayNumbers {
  const replies = rows.talk.filter(line => line.role === 'assistant');
  const repeated = new Map<string, number>();
  let repeating = 0;
  replies.forEach((reply, index) => {
    const found = repeatedIn(reply.text, watchPhrases(replies.slice(0, index).map(item => item.text)));
    if (!found.length) return;
    repeating += 1;
    for (const phrase of found) repeated.set(phrase, (repeated.get(phrase) ?? 0) + 1);
  });
  const stances = rows.stances.filter(isFeelingStance);
  const warm = stances.filter(stance => WARM_STANCES.includes(stance as FeelingStance)).length;
  let his = 0, echoed = 0;
  rows.talk.forEach((line, index) => {
    if (line.role !== 'user' || !apologyIn(line.text)) return;
    his += 1;
    if (rows.talk.slice(index + 1).filter(next => next.role === 'assistant').slice(0, 2).some(next => SORRY.test(next.text))) echoed += 1;
  });
  return {
    day: rows.day, replies: replies.length, repeating,
    repeatedPhrases: [...repeated].map(([phrase, count]) => ({ phrase, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    crossMentions: replies.filter(reply => CROSS.test(reply.text)).length,
    stances: tally(stances), warmShare: stances.length ? Math.round((warm / stances.length) * 100) / 100 : null,
    reachOuts: rows.reachOuts.length, reachOutsAtNight: rows.reachOuts.filter(item => item.hour >= NIGHT_FROM || item.hour < NIGHT_UNTIL).length,
    promises: rows.promises, apologyEchoes: { his, echoed }, touchStances: tally(rows.touchStances),
  };
}

/** The days in a row, up to the last one, on which she still said she was cross (2026-10-14 to 10-19: six). */
export function crossStreak(days: readonly Pick<HeartDayNumbers, 'crossMentions'>[]): number {
  let streak = 0;
  for (let index = days.length - 1; index >= 0 && days[index]!.crossMentions > 0; index -= 1) streak += 1;
  return streak;
}

/** The numbers as a short Markdown table, a day a row. */
export function heartDaysMarkdown(days: readonly HeartDayNumbers[]): string {
  const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
  const lines = days.map(day => `| ${day.day} | ${day.replies} | ${day.repeating} | ${day.crossMentions} | ${percent(day.warmShare)} | `
    + `${day.reachOuts}（夜${day.reachOutsAtNight}） | ${day.promises.due}/${day.promises.told}/${day.promises.closed}/${day.promises.openAfterTime} | `
    + `${day.apologyEchoes.echoed}/${day.apologyEchoes.his} |`);
  return ['| 日 | 返事 | 繰り返し | むっと | 温かい構え | 自分から | 約束 期限/知らせ/閉/残 | 謝り返し |', '|---|---|---|---|---|---|---|---|', ...lines,
    '', `むっとが続いた日数（最後の日まで）: ${crossStreak(days)}`].join('\n');
}
