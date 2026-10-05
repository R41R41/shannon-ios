/**
 * Kana rules of しりとり, as the opening message of the scenario states them:
 * small kana count as large (しゃ → や), a closing 「ー」 takes the kana before it, dakuten and
 * handakuten may be added or dropped (か = が = か), を counts as お, and a word ending in ん loses.
 */
const SMALL: Readonly<Record<string, string>> = Object.freeze({
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', っ: 'つ', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ', ゕ: 'か', ゖ: 'け',
});

export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
}

/** The kana a chain compares: large, without dakuten or handakuten. */
export function kanaBase(character: string): string {
  const large = SMALL[character] ?? character;
  const plain = large.normalize('NFD').charAt(0);
  return plain === 'を' ? 'お' : plain;
}

/** A word of kana only (hiragana, katakana, the long mark), so that its reading is certain. */
export function isKanaWord(word: string): boolean {
  return /^[ぁ-ゖァ-ヺ][ぁ-ゖァ-ヺー]*$/u.test(word);
}

/** The last kana as it is written, after a closing long mark is skipped. */
export function lastKana(word: string): string | null {
  const reading = toHiragana(word).replace(/ー+$/u, '');
  return reading ? reading.charAt(reading.length - 1) : null;
}

/** The base the next word must start with, or null when the word ends in ん or has no reading. */
export function nextBase(word: string): string | null {
  if (!isKanaWord(word)) return null;
  const last = lastKana(word);
  return !last || last === 'ん' ? null : kanaBase(last);
}

export function firstBase(word: string): string | null {
  if (!isKanaWord(word)) return null;
  return kanaBase(toHiragana(word).charAt(0));
}

/** The word a reply gives in 『』, else in 「」 (counted as a format slip), trimmed; null when there is none. */
export function spokenWord(reply: string): { word: string; bracketed: boolean } | null {
  const double = /『\s*([^』\s]{1,24})\s*』/u.exec(reply);
  if (double) return { word: double[1]!, bracketed: true };
  const single = /「\s*([^」\s]{1,24})\s*」/u.exec(reply);
  return single ? { word: single[1]!, bracketed: false } : null;
}

/** Hiragana form for comparing words and answers regardless of script. */
export function sameReading(text: string): string {
  return toHiragana(text).replace(/\s+/gu, '');
}
