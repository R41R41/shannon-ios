/**
 * Whether a transcript has her name in it, and in what place (owner 2026-10-21, 「話しかけられたか」, `addressed.ts`). Speech recognition
 * writes 「シャノン」 many ways (しゃのん, シャノ, しゃの, 社の, シャノンちゃん, シャロン...), so the text is normalised first: NFKC, lower
 * case, katakana to hiragana, and nothing but letters and digits kept. Only the first step of the judgement: a name in the text opens the
 * question "was it said to her?", it does not answer it.
 *
 * Two tiers. `strong` is her name as it is written or one letter off in a way recognisers do all the time; `weak` is a guess that is
 * often another word (社の, しゃの, シャロン). A weak match may open the question for the model; without the model it counts only as a call
 * (at the head of the utterance, followed by a pause or a mark).
 */
export interface NameMatch {
  /** The form of her name found: `strong`, or `weak` (a likely mishearing). */
  tier: 'strong' | 'weak';
  /** What is before and after the name, normalised. */
  before: string;
  after: string;
  /** The name opens the utterance (only calling words before it: ねえ, あの, ちょっと). */
  atHead: boolean;
  /** The name closes the utterance (a vocative: 〜だよね、シャノン). */
  atEnd: boolean;
  /** Nothing but the call: 「シャノン」「ねえシャノンちゃん」. */
  bare: boolean;
  /** What follows the name makes it the topic of the sentence (シャノンってさ, シャノンは...), not a call. */
  topic: boolean;
  /** A pause or a mark follows the name in the written text (シャノン、...). */
  called: boolean;
}

const STRONG = /しゃのん|shannon/u;
/** Mishearings (ー is already gone). 社の is a word of its own (会社の), so it counts only when no kanji comes just before it. */
const WEAK = /しゃの|じゃのん|じゃの|しゃろん|しぇのん|ちゃのん|しゃんの|(?<!\p{Script=Han})社の/u;
/** A name (either tier), an optional ending of address, then a pause mark. */
const CALLED = new RegExp(`(?:${STRONG.source}|${WEAK.source})(?:ちゃん|さん|くん)?\\|`, 'u');

function fold(text: string, marks: boolean): string {
  const folded = text.normalize('NFKC').toLowerCase();
  let out = '';
  for (const char of folded) {
    const code = char.codePointAt(0)!;
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else if (code === 0x30fc || code === 0x2015) continue; // ー
    else if (/[\p{L}\p{N}]/u.test(char)) out += char;
    else if (marks && /[、,，。.!！?？…]/u.test(char) && !out.endsWith('|')) out += '|';
  }
  return out;
}

/** NFKC, lower case, katakana to hiragana, long-vowel marks and everything but letters and digits removed. */
export function normalizedForName(text: string): string {
  return fold(text, false);
}

/** Calling words that may come before the name, and the endings of a call after it (all read after `normalizedForName`, which drops ー). */
const LEAD = /^(?:ねえ|ねぇ|ね|おい|あのさ|あの|ちょっと|はい|へい|ほら|えっと|えと|えー|あー|あ|あれ|もしもし|ok|おっけ|おけ|hey|よし|さて|ところで|それで|で)*$/u;
const CALL_END = /^(?:ちゃん|さん|くん|さま|様|たん|よ|や|ね|さ|っ|ってば|ったら)*$/u;
const TOPIC = /^(?:ちゃん|さん|くん)?(?:って|っていう|という|ていうか|ときたら|は|が|も|の|に|と)/u;

/** The name in the text, or null. The text is the transcript as written (a pause or a mark after the name is read for `called`). */
export function nameMatch(text: string): NameMatch | null {
  const normalized = normalizedForName(text);
  const strong = STRONG.exec(normalized);
  const weak = strong ? null : WEAK.exec(normalized);
  const found = strong ?? weak;
  if (!found) return null;
  const before = normalized.slice(0, found.index);
  const after = normalized.slice(found.index + found[0].length);
  const atHead = LEAD.test(before);
  const atEnd = CALL_END.test(after);
  const topic = TOPIC.test(after);
  const called = CALLED.test(fold(text, true));
  return { tier: strong ? 'strong' : 'weak', before, after, atHead, atEnd, bare: atHead && atEnd, topic, called };
}

/** The question stays closed for text that has no name in it at all. */
export function hasName(text: string): boolean {
  return nameMatch(text) !== null;
}
