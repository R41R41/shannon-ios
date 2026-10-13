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

export class SpokenSentenceSegmenter {
  private pending = '';

  append(delta: string): string[] {
    this.pending += delta.replace(/\r\n?/gu, '\n');
    const segments: string[] = [];
    while (this.pending) {
      const boundary = spokenSentenceEnd(this.pending);
      if (boundary < 0) break;
      const segment = normalizedSegment(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary);
      if (segment) segments.push(segment);
    }
    return segments;
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
