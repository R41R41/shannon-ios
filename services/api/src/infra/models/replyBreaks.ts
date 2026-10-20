/**
 * A line break the reply model wrote as the two characters 「\」「n」 (its structured reply escaped it twice; owner 2026-10-20: 「\n」 shown
 * as it is in three replies that day, six on 10-15). Outside code (an even number of backticks before it) and not followed by a Latin
 * letter (「C:\new」 stays), it is a line break. `replyBreaks` reads a whole reply; `ReplyBreakFilter` the same, a character at a time,
 * for the reply while it streams (`chatReplyStreamDecoder.ts`): what it has returned is always a prefix of `replyBreaks` of the whole.
 */
const LATIN = /[A-Za-z]/u;

export function replyBreaks(text: string): string {
  if (!text.includes('\\n')) return text;
  let ticks = 0;
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text[index]!;
    if (unit === '\\' && text[index + 1] === 'n' && ticks % 2 === 0 && !LATIN.test(text[index + 2] ?? '')) {
      out += '\n';
      index += 1;
      continue;
    }
    if (unit === '`') ticks += 1;
    out += unit;
  }
  return out;
}

export class ReplyBreakFilter {
  private ticks = 0;
  private pending: '' | '\\' | '\\n' = '';

  /** The text now certain after one more code unit. */
  push(unit: string): string {
    if (this.pending === '\\') {
      this.pending = '';
      if (unit === 'n') {
        this.pending = '\\n';
        return '';
      }
      return `\\${this.push(unit)}`;
    }
    if (this.pending === '\\n') {
      this.pending = '';
      return `${LATIN.test(unit) ? '\\n' : '\n'}${this.push(unit)}`;
    }
    if (unit === '\\' && this.ticks % 2 === 0) {
      this.pending = '\\';
      return '';
    }
    if (unit === '`') this.ticks += 1;
    return unit;
  }

  /** What is held at the end of the reply. */
  end(): string {
    const held = this.pending === '\\n' ? '\n' : this.pending;
    this.pending = '';
    return held;
  }
}
