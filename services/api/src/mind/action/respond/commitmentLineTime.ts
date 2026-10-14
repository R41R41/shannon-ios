/**
 * A promise's line never carries a time she wrote (owner rule: a fact is never wrong; reviews of b867e66c, 508b6288, ab5df22b and
 * aac5b7be found that every parser or denylist of written times leaks: 「9時半」 for 09:00, 「九時廿分」, 「次の水曜日の」, 「今、9時20分」
 * while late, 「ちょっと前」, 「around 9:20」, 「くじはん」, 「at ten」, 「Ⅹ時」, 丑三つ時, 「明​日」 …).
 *
 * Layers, each failing closed to the neutral factual line:
 * 1. **She never writes the time.** Her line has the placeholder `{時刻}` where she would say the time and `{約束}` where she would
 *    name the promise; the server puts in the canonical phrase (`canonicalTimePhrases(...)[0]`) and the promise's exact words.
 * 2. **Her raw text is checked strictly** (`commitmentRawTextClean`), the placeholders excepted, after NFKC, without zero-width and
 *    format characters and with whitespace collapsed: no number in any script, no numeral character, no kana number word with a
 *    counter, no word of a time, a day, a part of the day or a duration in kanji, kana or English. Anything found: neutral.
 * 3. **A second judge** reads the sentence with `{時刻}` put in (`commitmentLineJudge.ts`): another time, date, day or duration
 *    stated or implied, or unsure: neutral.
 */
export const TIME_PLACEHOLDER = '{時刻}';
export const PROMISE_PLACEHOLDER = '{約束}';

const KANJI = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export interface CommitmentClockFacts {
  /** Owner-local 「HH:MM」 when the promise has a clock time; anything else (「今日」) means it has none. */
  when: string | null;
}

function clockOf(when: string | null): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(when ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * The phrases for the promise's time, the first being what `{時刻}` becomes: 「9時20分」 for 09:20; 「夜の9時20分」 (or 「21時20分」) for
 * 21:20; 「昼の12時20分」 at noon. None without a clock time.
 */
export function canonicalTimePhrases(facts: CommitmentClockFacts): string[] {
  const clock = clockOf(facts.when);
  if (!clock) return [];
  const minute = clock.minute === 0 ? '時' : `時${clock.minute}分`;
  if (clock.hour < 12) return [`${clock.hour}${minute}`];
  if (clock.hour === 12) return [`昼の12${minute}`, `12${minute}`];
  const half = clock.hour >= 18 ? '夜' : clock.hour >= 15 ? '夕方' : '昼';
  return [`${half}の${clock.hour - 12}${minute}`, `${clock.hour}${minute}`];
}

/** Zero-width and format characters out, whitespace collapsed; NFKC alongside (both are checked). */
export function rawShapes(text: string): { raw: string; folded: string } {
  const raw = text.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
  return { raw, folded: raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').toLowerCase() };
}

const PLACEHOLDER = /[{｛]\s*(時刻|約束)\s*[}｝]/gu;

/** Katakana as hiragana, for the kana number words only (「クジハン」). */
const hiragana = (text: string) => text.replace(/[ァ-ヶ]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0x60));

const KANA_NUMBER = '(?:いち|に|さん|よん|し|ご|ろく|なな|しち|はち|く|きゅう|じゅう|はん)';
const COUNTER = '(?:じ|ふん|ぷん|にち|がつ|ようび|時|分|秒|日|週|月|年|曜)';
const ENGLISH = [
  'now', 'around', 'about', 'before', 'after', 'until', 'till', 'past', 'today', 'tonight', 'tonite', 'tomorrow', 'yesterday', 'morning', 'evening',
  'night', 'noon', 'midnight', 'am', 'pm', 'a\\.m', 'p\\.m', "o'?clock", 'half', 'quarter', 'hour', 'hours', 'minute', 'minutes', 'day', 'days',
  'week', 'weekend', 'month', 'year', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'zero', 'one', 'two', 'three',
  'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'later', 'soon', 'early', 'late',
];

/** What must not be in her raw text (the placeholders taken out), each read on the raw and on the NFKC text. */
const DENIED: readonly RegExp[] = Object.freeze([
  // Numbers in any script (digits, Roman numerals, circled and other numbers), and numeral characters.
  /\p{N}/u,
  /[〇零一二三四五六七八九十百千万億兆廿卅半両壱弐参拾伍]/u,
  // Kana number words with a counter, in hiragana or katakana (くじ, くじはん, ニジ, いちにち …).
  new RegExp(`${KANA_NUMBER}${COUNTER}`, 'u'),
  // Times, days, parts of the day, relative times and durations in kanji.
  /今|現在|次|前|後|先|来|去|翌|明|昨|毎|週|月末|年明|頃|以前|以降|過ぎ|朝|夜|晩|宵|昼|夕|午|暁|丑|寅|子の刻|刻|深夜|未明|早朝|日中|正午|曜|暦|元旦|休日|祝日|平日/u,
  /時刻|時半|時間後|時間前|日後|日前|分後|分前|数時間|数分|数日|半日|一日中/u,
  // The same in hiragana (whole words only where a common ending would read as one: います is not いま).
  /いま(?![すせし])|ただいま|あさ|よる|ゆうがた|ゆうべ|ひる|ごぜん|ごご|あけがた|よあけ|まよなか|よなか|こんや|けさ|しんや|こんばん/u,
  /あした|あす|あさって|きのう|おととい|のち|ごろ|くらい|ぐらい|すぎ|まえ|あとで|つぎ|らいしゅう|せんしゅう|しゅう|ようび/u,
  // Katakana and loan words.
  /アサ|ヨル|ヒル|イマ|ゴゴ|ゴゼン|ランチ|モーニング|イブニング|ナイト|ミッドナイト|ヌーン|ブランチ|ディナー|ウィーク/u,
  new RegExp(`\\b(?:${ENGLISH.join('|')})\\b`, 'u'),
  // A counter right beside a placeholder (「{時刻}時」, 「前{時刻}」), and any other brace left.
  /[{}｛｝]/u,
]);

/** Whether her raw line (with its placeholders) holds nothing of a time, a day, a date or a duration but `{時刻}`. */
export function commitmentRawTextClean(text: string, facts: CommitmentClockFacts): boolean {
  const { raw, folded } = rawShapes(text);
  // `{時刻}` only for a promise with a clock time; a counter glued to a placeholder is a time of hers.
  const usesTime = [...raw.matchAll(PLACEHOLDER)].some(match => match[1] === '時刻');
  if (usesTime && canonicalTimePhrases(facts).length === 0) return false;
  if (/[時分秒日週月年曜]\s*[{｛]\s*時刻|時刻\s*[}｝]\s*[時分秒日週月年曜]/u.test(raw.normalize('NFKC'))) return false;
  const rest = [raw.replace(PLACEHOLDER, ' '), folded.replace(PLACEHOLDER, ' ')];
  return !rest.some(text => DENIED.some(denied => denied.test(text) || denied.test(hiragana(text))));
}

/** The sentence as said: `{時刻}` becomes the canonical phrase and `{約束}` the promise's own words. */
export function filledCommitmentLine(text: string, facts: CommitmentClockFacts & { title: string }, keepPromise = false): string {
  const time = canonicalTimePhrases(facts)[0] ?? '';
  return rawShapes(text).raw.replace(PLACEHOLDER, (_match, name: string) => (name === '時刻' ? time : keepPromise ? PROMISE_PLACEHOLDER : facts.title));
}

/** Kanji digits of a number below ten (kept for the fixtures that build kanji time phrases). */
export function kanjiDigit(value: number): string {
  return KANJI[value] ?? '';
}
