import type { CheckedStreamReply, StreamTurn } from '../../mind/emotion/streamFeeling.js';
import type { CommentaryEnd, CommentaryFactory, CommentaryHooks, CommentaryPort } from './streamContract.js';
import { checkedLine } from './streamGate.js';
import { cleanStreamLine } from './streamWriter.js';

/**
 * The game's commentary as the stream hosts it (`docs/stream-contract.md` §5): the engine (composed in `wiring/streamCommentaryWiring.ts`) is
 * given hooks over this stream's mouth, its allowance and its checks. A line the engine writes is made voice-ready, checked against the
 * stream's turn, and kept as a `CheckedStreamReply` until the engine puts it in the mouth; nothing else can enter the mouth from here.
 */
export interface GameTalkParts {
  factory: CommentaryFactory;
  base: Pick<CommentaryHooks, 'now' | 'log' | 'identity' | 'persona' | 'body' | 'quiet' | 'room' | 'complete'>;
  /** Her turn when no viewer is being answered (the stream's block and a check). */
  turn: () => StreamTurn | null;
  /** Puts a checked reply in the mouth as commentary; the mouth's id for it, or null when there is no room. */
  put: (reply: CheckedStreamReply) => string | null;
  dropped: () => void;
}

export class StreamGameTalk {
  private readonly checked = new Map<string, CheckedStreamReply>();
  private readonly port: CommentaryPort;

  constructor(private readonly parts: GameTalkParts) {
    this.port = parts.factory({ ...parts.base, enqueue: text => this.enqueue(text), accept: text => this.accept(text) });
  }

  start(): void { this.port.start(); }
  stop(): void { this.port.stop(); }
  ended(end: CommentaryEnd): void { this.port.ended(end); }
  stats(): Readonly<Record<string, number>> { return this.port.stats(); }

  /** A line of commentary as the mouth may take it: voice-ready (54 characters) and checked against the stream's turn; null when it is not. */
  private accept(raw: string): string | null {
    const clean = cleanStreamLine(raw, 54);
    const turn = clean ? this.parts.turn() : null;
    const verdict = clean && turn ? checkedLine(turn, clean) : null;
    if (!clean || !verdict?.ok) {
      if (clean) this.parts.dropped();
      return null;
    }
    this.checked.set(clean, verdict.reply);
    return clean;
  }

  private enqueue(text: string): string | null {
    const reply = this.checked.get(text);
    this.checked.delete(text);
    return reply ? this.parts.put(reply) : null;
  }
}
