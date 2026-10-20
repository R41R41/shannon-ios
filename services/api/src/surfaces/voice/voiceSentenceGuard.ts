import { checkReply, type ReplyCheckContext } from '@shannon/cognition';
import { unsendableLine } from '../../infra/models/feelingStrongChatModel.js';
import { spokenSentenceEnd } from './spokenSentences.js';

/**
 * Her guard lines on a spoken reply (one head, `SHANNON_ONE_HEAD`; owner 2026-10-20: the same lines on every entry). A text draft is
 * checked whole before it is sent (`FeelingReplyChatModel`); a spoken reply goes out while it is written, so each sentence is checked
 * before it is said: one that tells a private matter in front of others, reads a marker out or crosses a guard line (a threat, a hint of
 * hurting herself or vanishing, an order on his life, sexual words, her feeling used as a lever) is replaced by the same safe line a text
 * draft would be, and nothing after it is said. Only a turn whose check reads those lines has a guard (`feelingVoice.guard`): any other
 * streams exactly as before. A spoken sentence ends where the apps' voice cuts one (`spokenSentenceEnd`), so the apps hear no delay.
 */
export class VoiceSentenceGuard {
  private held = '';
  private said = '';
  private stopped = false;
  private streamed = false;

  constructor(private readonly unsafe: (sentence: string) => string | null) {}

  static of(context: ReplyCheckContext | null): VoiceSentenceGuard | null {
    return context ? new VoiceSentenceGuard(sentence => unsendableLine(checkReply(sentence, context))) : null;
  }

  /** Whether a sentence was replaced (and the rest of the reply dropped). */
  get swallowed(): boolean { return this.stopped; }

  /** What may be said now of what the model wrote: the whole sentences that passed, or the safe line; nothing once one did not pass. */
  pass(delta: string): string {
    this.streamed = true;
    if (this.stopped) return '';
    this.held += delta;
    let out = '';
    for (let end = spokenSentenceEnd(this.held); end > 0 && !this.stopped; end = spokenSentenceEnd(this.held)) {
      out += this.release(this.held.slice(0, end));
      this.held = this.held.slice(end);
    }
    return out;
  }

  /** The unfinished last sentence, at the end of the reply. */
  end(): string {
    const rest = this.held;
    this.held = '';
    return this.stopped || !rest.trim() ? '' : this.release(rest);
  }

  /** The reply as she said it: what the model wrote when every sentence passed. An unstreamed reply is checked whole here. */
  reply(written: string): string {
    if (!this.streamed) {
      this.pass(written);
      this.end();
    }
    return this.stopped ? this.said : written;
  }

  private release(sentence: string): string {
    const safe = this.unsafe(sentence);
    if (safe === null) {
      this.said += sentence;
      return sentence;
    }
    this.stopped = true;
    this.said += safe;
    return safe;
  }
}
