/**
 * What the voice is given for a count written "N/M" after a word that has a maximum: 体力5/20 is read 「20のうち5」.
 *
 * The voices read a bare slash by their own guess (a date, a time, 「20分」...), and a Japanese reading of "5/20" is not settled,
 * so the line is rewritten just before it goes to a voice. The caption and the record keep the line as it was written.
 * Only a count with a word of its own is touched (a stat such as 体力・満腹度・HP, or an item with a counter such as 個);
 * a bare "5/20", a time (12:30), a date (11/24, 2026/11/24), a coordinate, a URL and a path are left alone, and so is anything unsure.
 * The tags of the sentence ([whispers] and the like) have no digit and stay where they are. Running it twice changes nothing more.
 */

const STAT_WORDS = '満腹度|満腹|空腹度|空腹|体力|HP|ＨＰ|ヒットポイント|ライフ|ハート|耐久値|耐久|スタミナ|酸素';
const NUMBER = String.raw`(\d{1,4}(?:\.\d{1,2})?)`;
const SLASH = String.raw`\s*[/／]\s*`;
const AFTER_NUMBER = String.raw`(?![\d.]|[/／:：]\s*\d|[A-Za-z])`;

// 体力5/20・体力が5/20まで・HP: 5/20 ...  (the word is kept; a comma is put before the number so that the voice pauses there)
const STAT = new RegExp(String.raw`(${STAT_WORDS})(が|は|も|を|の|って)?([\s:：=]*)${NUMBER}${SLASH}${NUMBER}${AFTER_NUMBER}`, 'giu');

// 羊毛 3/3個・骨粉12/64個: a counter right after makes it a count, never a date.
const COUNTERS = 'スタック|セット|ブロック|個|本|枚|匹|人|体|つ|粒';
const COUNTED = new RegExp(String.raw`([\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}ー]{2,}?)([\s:：=]*)${NUMBER}${SLASH}${NUMBER}(\s*)(${COUNTERS})(?![\p{Script=Han}])`, 'gu');

const FRACTION_WORDS_ARE_UNSURE = 4;

function counted(numerator: string, denominator: string): { n: number; m: number } | null {
  const n = Number(numerator);
  const m = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0 || n < 0) return null;
  return { n, m };
}

export function spokenNumbers(text: string): string {
  if (!text.includes('/') && !text.includes('／')) return text;
  return text
    .replace(STAT, (whole, word: string, particle: string | undefined, _gap: string, numerator: string, denominator: string) => {
      const pair = counted(numerator, denominator);
      if (!pair) return whole;
      const lead = `${word}${particle ?? ''}、`;
      return pair.n === pair.m ? `${lead}全部` : `${lead}${denominator}のうち${numerator}`;
    })
    .replace(COUNTED, (whole, word: string, gap: string, numerator: string, denominator: string, _space: string, counter: string) => {
      const pair = counted(numerator, denominator);
      if (!pair) return whole;
      if (pair.n === pair.m) return `${word}${gap}${denominator}${counter}とも`;
      // 1/2個, 1/3本 and the like are a part of one thing, not a count of a stock.
      if (pair.n < pair.m && pair.m <= FRACTION_WORDS_ARE_UNSURE) return whole;
      return `${word}、${denominator}${counter}のうち${numerator}${counter}`;
    });
}
