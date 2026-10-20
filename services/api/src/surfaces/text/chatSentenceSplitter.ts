/**
 * Splits a text reply into sentences for `stream: "sentences"` (docs/chat-stream-contract.md).
 *
 * Lossless: the sentences joined with nothing between them are the input, character for
 * character. Whitespace after a sentence, including newlines, stays at the end of that
 * sentence, so a sentence is never whitespace-only unless the whole text is.
 *
 * Deterministic: the result does not depend on how the text was cut into `append` calls. A
 * boundary is reported only once the characters that decide it have arrived; `flush` settles
 * the rest. The voice route's `SpokenSentenceSegmenter` is not reused because it rewrites
 * whitespace and splits inside quotations, which a reply that must equal `reply` cannot allow.
 */

/** A sentence is cut at this many UTF-16 units when no boundary came earlier; trailing whitespace may follow. */
export const CHAT_SENTENCE_MAXIMUM_LENGTH = 200;

const TERMINATORS = '。！？!?';
const OPENERS = '「『（(【[〈《“';
const CLOSERS = '」』）)】]〉》”';
/** Taken into the sentence when they directly follow its terminator. */
const AFTER_TERMINATOR = `${TERMINATORS}${CLOSERS}"'`;
const SOFT_BREAKS = '、，,;；:：';
/** Where a voice reply may be cut inside a sentence (`ChatSentenceSplitterOptions.clauseCharacters`). */
const CLAUSE_BREAKS = '、，';
const INLINE_CODE_MAXIMUM_LENGTH = 80;
const URL_PREFIXES = ['https://', 'http://'] as const;
/** Printable ASCII except space, `"`, `<` and `>`; a backtick also ends a URL. */
const URL_CHARACTER = /[!#-;=?-~]/u;

interface ScanState {
  /** Open 「」『』（）-style pairs. Reset by a blank line so an unmatched opener cannot swallow the reply. */
  depth: number;
  /** Inside a ``` code fence. */
  fenced: boolean;
}

interface Cut { end: number; state: ScanState }

export interface ChatSentenceSplitterOptions {
  /**
   * A voice channel's reply is cut at a 「、」 once the sentence so far is this many UTF-16 units long, so the first words reach the
   * speaker before the sentence is finished (dc-voice). Absent: a sentence ends only at a terminator, as for a reader.
   */
  clauseCharacters?: number;
}

export class ChatSentenceSplitter {
  private pending = '';
  private state: ScanState = { depth: 0, fenced: false };

  constructor(private readonly options: ChatSentenceSplitterOptions = {}) {}

  append(delta: string): string[] {
    this.pending += delta;
    return this.drain(false);
  }

  flush(): string[] {
    const sentences = this.drain(true);
    this.pending = '';
    this.state = { depth: 0, fenced: false };
    return sentences;
  }

  private drain(final: boolean): string[] {
    const sentences: string[] = [];
    while (this.pending) {
      const cut = nextCut(this.pending, this.state, final, this.options.clauseCharacters ?? 0);
      if (!cut) break;
      sentences.push(this.pending.slice(0, cut.end));
      this.pending = this.pending.slice(cut.end);
      this.state = cut.state;
    }
    return sentences;
  }
}

/** The sentences of a complete text. `splitChatSentences(text).join('') === text`. */
export function splitChatSentences(text: string, options?: ChatSentenceSplitterOptions): string[] {
  const splitter = new ChatSentenceSplitter(options);
  return [...splitter.append(text), ...splitter.flush()];
}

function nextCut(text: string, start: ScanState, final: boolean, clause = 0): Cut | null {
  const length = text.length;
  const limit = CHAT_SENTENCE_MAXIMUM_LENGTH;
  let depth = start.depth;
  let fenced = start.fenced;
  let index = whitespaceEnd(text, 0);
  if (index === length) return final ? { end: length, state: start } : null;
  // The last place before the limit where a forced cut reads least badly, and the state before the last step.
  let soft: Cut | null = null;
  let before: ScanState = { depth, fenced };
  for (;;) {
    if (index >= limit && length > limit) {
      const state = index === limit ? { depth, fenced } : before;
      return forcedCut(text, soft && soft.end >= limit / 2 ? soft : { end: wholeCharacterCut(text, limit), state }, final);
    }
    if (index >= length) return final ? { end: length, state: { depth: 0, fenced: false } } : null;
    before = { depth, fenced };
    const character = text[index]!;

    if (character === '`') {
      let end = index + 1;
      while (end < length && text[end] === '`') end += 1;
      if (end === length && !final) return null;
      if (index > 0) soft = { end: index, state: before };
      if (end - index >= 3) {
        fenced = !fenced;
      } else if (!fenced) {
        // Inline code: skip to the closing backtick when one follows soon on the same line.
        const window = text.slice(end, end + INLINE_CODE_MAXIMUM_LENGTH);
        const close = window.search(/[`\n]/u);
        if (close < 0 && window.length < INLINE_CODE_MAXIMUM_LENGTH && !final) return null;
        if (close >= 0 && window[close] === '`') end += close + 1;
      }
      index = end;
      continue;
    }
    if (fenced) {
      if (character === '\n') soft = { end: index + 1, state: before };
      index += 1;
      continue;
    }
    if (character === '\n') {
      const end = whitespaceEnd(text, index + 1);
      if (end === length && !final) return null;
      const blankLine = text.slice(index + 1, end).includes('\n');
      if (depth > 0 && !blankLine) {
        soft = { end, state: before };
        index = end;
        continue;
      }
      return { end, state: { depth: 0, fenced: false } };
    }
    if (OPENERS.includes(character)) { depth += 1; index += 1; continue; }
    if (CLOSERS.includes(character)) { depth = Math.max(0, depth - 1); index += 1; continue; }
    if (depth > 0) {
      if (softBreak(character)) soft = { end: index + 1, state: before };
      index += 1;
      continue;
    }
    if (character === 'h') {
      const rest = text.slice(index, index + 8);
      const prefix = URL_PREFIXES.find(candidate => rest.startsWith(candidate));
      if (prefix) {
        let end = index + prefix.length;
        while (end < length && text[end] !== '`' && URL_CHARACTER.test(text[end]!)) end += 1;
        if (end === length && !final && length <= limit) return null;
        if (index > 0) soft = { end: index, state: before };
        index = end;
        continue;
      }
      if (!final && index + rest.length === length && URL_PREFIXES.some(candidate => candidate.startsWith(rest))) return null;
    }
    if (TERMINATORS.includes(character)) {
      if (character === '!' || character === '?') {
        const next = text[index + 1];
        if (next === undefined && !final) return null;
        // `a?b=c`, `foo!bar`: inside a token, not the end of a sentence.
        if (next !== undefined && /[A-Za-z0-9=&/_-]/u.test(next)) { index += 1; continue; }
      }
      let end = index + 1;
      while (end < length && AFTER_TERMINATOR.includes(text[end]!)) end += 1;
      end = whitespaceEnd(text, end);
      if (end === length && !final) return null;
      return { end, state: { depth: 0, fenced: false } };
    }
    if (clause > 0 && CLAUSE_BREAKS.includes(character) && index + 1 >= clause) {
      const end = whitespaceEnd(text, index + 1);
      if (end === length && !final) return null;
      return { end, state: { depth, fenced } };
    }
    if (softBreak(character)) soft = { end: index + 1, state: before };
    index += 1;
  }
}

/** A forced cut also takes the whitespace after it, so the next sentence does not start with any. */
function forcedCut(text: string, cut: Cut, final: boolean): Cut | null {
  const end = whitespaceEnd(text, cut.end);
  if (end === text.length && !final) return null;
  return { end, state: cut.state };
}

function whitespaceEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && /\s/u.test(text[end]!)) end += 1;
  return end;
}

function softBreak(character: string): boolean {
  return SOFT_BREAKS.includes(character) || /\s/u.test(character);
}

/** Moves a cut back so it does not fall inside a surrogate pair, a joined emoji, or before a combining mark. */
function wholeCharacterCut(text: string, at: number): number {
  let cut = at;
  for (let steps = 0; steps < 16 && cut > 1; steps += 1) {
    const next = text.charCodeAt(cut);
    const previous = text.charCodeAt(cut - 1);
    const lowSurrogate = next >= 0xDC00 && next <= 0xDFFF;
    const joined = next === 0x200D || previous === 0x200D || (next >= 0xFE00 && next <= 0xFE0F);
    const skinTone = next === 0xD83C && text.charCodeAt(cut + 1) >= 0xDFFB && text.charCodeAt(cut + 1) <= 0xDFFF;
    if (!lowSurrogate && !joined && !skinTone && !/\p{M}/u.test(text[cut]!)) break;
    cut -= 1;
  }
  return cut;
}
