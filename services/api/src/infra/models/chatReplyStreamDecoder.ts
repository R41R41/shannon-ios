/**
 * Reads the `reply` string out of the structured chat turn while the provider is still
 * writing it. The provider sends the turn as JSON text in arbitrary pieces:
 * `{"reply":"…","threadSummary":…}`.
 *
 * `push` returns the reply text that is now certain. Everything it has returned, joined, is
 * a prefix of `reply.trim()` of the finished object — the value `parseStructuredTurn`
 * produces — so:
 * - leading whitespace is never returned;
 * - whitespace is held until a visible character follows it, and dropped if none does;
 * - an escape or a surrogate pair cut by a piece boundary is held until it is whole;
 * - nothing is returned from any other field, and nothing at all when `reply` is not the
 *   first key or is not a string. The caller then has only the completed turn.
 */
export class ChatReplyStreamDecoder {
  private stage: 'object' | 'key-quote' | 'key' | 'colon' | 'value-quote' | 'value' | 'closed' = 'object';
  private key = '';
  /** A backslash was read; for `\u` the hex digits collected so far. */
  private escape: string | null = null;
  private highSurrogate = '';
  private started = false;
  private heldWhitespace = '';

  /** True once `reply` cannot be read early: another key came first, or the text is not the expected JSON. */
  get abandoned(): boolean { return this.stage === 'closed' && !this.finished; }
  private finished = false;

  push(piece: string): string {
    let out = '';
    for (const unit of piece.split('')) {
      if (this.stage === 'closed') break;
      if (this.stage === 'value') { out += this.valueUnit(unit); continue; }
      if (this.stage === 'key') {
        if (unit === '"') this.stage = this.key === 'reply' ? 'colon' : 'closed';
        else if (unit === '\\' || this.key.length > 5) this.stage = 'closed';
        else this.key += unit;
        continue;
      }
      if (unit === ' ' || unit === '\n' || unit === '\r' || unit === '\t') continue;
      const expected = this.stage === 'object' ? '{' : this.stage === 'colon' ? ':' : '"';
      if (unit !== expected) { this.stage = 'closed'; break; }
      this.stage = this.stage === 'object' ? 'key-quote' : this.stage === 'key-quote' ? 'key'
        : this.stage === 'colon' ? 'value-quote' : 'value';
    }
    return out;
  }

  private valueUnit(unit: string): string {
    if (this.escape === null) {
      if (unit === '\\') { this.escape = ''; return ''; }
      if (unit === '"') {
        // The end of the reply. A held high surrogate is real text; held whitespace is trimmed away.
        this.stage = 'closed';
        this.finished = true;
        const last = this.highSurrogate;
        this.highSurrogate = '';
        return last ? this.visible(last) : '';
      }
      return this.decoded(unit);
    }
    if (this.escape === '') {
      if (unit === 'u') { this.escape = 'u'; return ''; }
      const simple = SIMPLE_ESCAPES[unit];
      this.escape = null;
      if (simple === undefined) { this.stage = 'closed'; return ''; }
      return this.decoded(simple);
    }
    if (!/[0-9a-fA-F]/u.test(unit)) { this.stage = 'closed'; return ''; }
    this.escape += unit;
    if (this.escape.length < 5) return '';
    const decoded = String.fromCharCode(Number.parseInt(this.escape.slice(1), 16));
    this.escape = null;
    return this.decoded(decoded);
  }

  /** One decoded UTF-16 unit. A high surrogate waits for its low half. */
  private decoded(unit: string): string {
    const code = unit.charCodeAt(0);
    if (this.highSurrogate) {
      const high = this.highSurrogate;
      this.highSurrogate = '';
      if (code >= 0xDC00 && code <= 0xDFFF) return this.visible(high + unit);
      return this.visible(high) + this.decoded(unit);
    }
    if (code >= 0xD800 && code <= 0xDBFF) { this.highSurrogate = unit; return ''; }
    return this.visible(unit);
  }

  /** Applies the trim of the finished reply to text that is still arriving. */
  private visible(text: string): string {
    if (/^\s$/u.test(text)) {
      if (this.started) this.heldWhitespace += text;
      return '';
    }
    const out = this.heldWhitespace + text;
    this.started = true;
    this.heldWhitespace = '';
    return out;
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};
