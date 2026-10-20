/**
 * Where a spoken voice reply may be cut into sentences. The live voice stream sends each
 * complete sentence as one `segment`; a reply that reached its length limit ends at the
 * last complete sentence by the same rule, so what is shown and stored is what was said.
 */
const SENTENCE_TERMINATORS = '。！？!?';
const CLOSING_MARKS = '」』）】”"';

/** Index just past the first sentence end at or after `from`, or -1 while the sentence is open. */
export function spokenSentenceEnd(text: string, from = 0): number {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') return index + 1;
    if (!SENTENCE_TERMINATORS.includes(character ?? '')) continue;
    const suffix = text[index + 1];
    return index + (suffix && CLOSING_MARKS.includes(suffix) ? 2 : 1);
  }
  return -1;
}

const WRAPPED_LINE = /^\s*[「『“"]([^「」『』“”"]+?)[」』”"]\s*([。！？!?]?)\s*$/u;

/**
 * A line wholly wrapped in quotation marks (「「ちょっと調べてみますね」」, owner test 2026-10-13: an instruction's example copied with its
 * brackets) without them, ending as a sentence; any other text unchanged.
 */
export function unquotedSpokenLine(text: string): string {
  const match = WRAPPED_LINE.exec(text);
  if (!match) return text;
  const inner = match[1]!.trim();
  return `${inner}${match[2] || (/[。！？!?…〜ー]$/u.test(inner) ? '' : '。')}`;
}

/**
 * The reply up to and including its last complete sentence, trimmed; empty when no
 * sentence was completed.
 */
export function completeSpokenSentences(text: string): string {
  const value = text.replace(/\r\n?/gu, '\n');
  let end = 0;
  for (let next = spokenSentenceEnd(value); next > 0; next = spokenSentenceEnd(value, end)) end = next;
  return value.slice(0, end).trim();
}

const CLAUSE_BREAKS = '、，';
const QUOTE_OPENERS = '「『（(“';
const QUOTE_CLOSERS = '」』）)”';

/**
 * Owner 2026-10-21 (`SHANNON_REPLY_SONNET`): a reply's first sentence is said from its first clause, once that clause is this many
 * characters long and ends at a 「、」 outside a quotation, so her first words reach the speaker before the sentence is finished (the
 * Discord voice channel cuts every clause so, `VOICE_SENTENCE_CUT`). Only the first: the rest is said sentence by sentence.
 */
export const FIRST_CLAUSE_CHARACTERS = 14;

/** Index just past the first clause break at or after `minimum` characters, outside quotation marks; -1 when there is none yet. */
export function spokenClauseEnd(text: string, minimum: number): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (QUOTE_OPENERS.includes(character)) depth += 1;
    else if (QUOTE_CLOSERS.includes(character)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && CLAUSE_BREAKS.includes(character) && index + 1 >= minimum) return index + 1;
  }
  return -1;
}

export interface SpokenSegmenterOptions {
  /** The first clause is said at once (`FIRST_CLAUSE_CHARACTERS`); absent, every segment is a whole sentence, as before. */
  firstClauseCharacters?: number;
}

export class SpokenSentenceSegmenter {
  private pending = '';
  private said = false;

  constructor(private readonly options: SpokenSegmenterOptions = {}) {}

  append(delta: string): string[] {
    this.pending += delta.replace(/\r\n?/gu, '\n');
    const segments: string[] = [];
    while (this.pending) {
      const boundary = this.boundary();
      if (boundary < 0) break;
      const segment = normalizedSegment(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary);
      if (segment) segments.push(segment);
      if (segment) this.said = true;
    }
    return segments;
  }

  /** Where the next segment ends: its sentence's end, or before anything was said, its first clause's (with the option). */
  private boundary(): number {
    const end = spokenSentenceEnd(this.pending);
    const clause = this.options.firstClauseCharacters;
    if (end >= 0 || this.said || !clause) return end;
    return spokenClauseEnd(this.pending, clause);
  }

  flush(): string[] {
    const segment = normalizedSegment(this.pending);
    this.pending = '';
    return segment ? [segment] : [];
  }

  /** Drops an unfinished sentence: a reply cut at its length limit never says half a sentence. */
  discard(): void {
    this.pending = '';
  }
}

function normalizedSegment(value: string): string {
  return value.trim().replace(/\s*\n\s*/gu, ' ');
}
