import { GUARD_FLAGS, guardFlags, type LadderStep, type ReplyCheckFlag } from '@shannon/cognition';
import type { JevChooser } from '../../infra/models/jev/jevChoice.js';
import { JEV_QUESTION_SETS } from '../../infra/models/jev/jevChoice.js';
import {
  fallbackJudgement, neverByWords, streamDeclines, streamGateQuestions, streamJudgementOf, type RouteJudgement,
} from '../../mind/selectors/conversationRoute.js';
import { checkStreamReply, type CheckedStreamReply, type StreamTurn } from '../../mind/emotion/streamFeeling.js';

/**
 * The two gates of the stream (`docs/stream-contract.md` §4).
 *
 * - **Before writing**: a chosen comment is read for what it asks of her reply in public (`stream_gate.v1`, Jev), `neverByWords` first. A
 *   comment that asks for a private or forbidden reply is declined: she is told to refuse lightly and change the subject. Without Jev (no key,
 *   a timeout, an answer that cannot be used) the words' own judgement stands in. There is no other model for such a comment, ever.
 * - **After writing**: the draft goes through the turn's check (`checkStreamReply`) and the guard lines (`guardFlags`, read here whatever the
 *   region, because a stream is the place they matter most). A flagged draft is rewritten once; if it is flagged again a draft that crossed a
 *   guard line or told a private matter is dropped, and any other falls back to a short line of the ladder's step. Only a `CheckedStreamReply`
 *   becomes a line.
 */
export interface GateDecision {
  declined: boolean;
  judgement: RouteJudgement;
  /** What decided: the words alone, Jev, or the fallback (Jev missing, late or unusable). */
  via: 'words' | 'jev' | 'fallback';
}

/** Words that a comment carries by the closed tags of the feeling (lewd, prying into the owner's life, a threat): declined when Jev did not read it. */
const DECLINED_TAGS: ReadonlySet<string> = new Set(['lewd', 'pry_owner', 'threat', 'menace']);

export class StreamGate {
  private jevCalls = 0;
  private jevFallbacks = 0;

  constructor(private readonly options: { jev: Pick<JevChooser, 'decide'> | null; scopeKey: string }) {}

  get stats(): { jevCalls: number; jevFallbacks: number } { return { jevCalls: this.jevCalls, jevFallbacks: this.jevFallbacks }; }

  /** The gate before writing for one comment. `recent`: the chat just before it (for Jev to read it in). Never throws. */
  async before(text: string, tags: readonly string[], recent: readonly string[]): Promise<GateDecision> {
    if (neverByWords(text)) {
      const judgement = fallbackJudgement(text);
      return { declined: true, judgement, via: 'words' };
    }
    const jev = this.options.jev;
    let judgement: RouteJudgement | null = null;
    if (jev) {
      this.jevCalls += 1;
      try {
        const decided = await jev.decide<RouteJudgement>({
          scopeKey: this.options.scopeKey, surface: 'voice', decision: 'stream_gate', sets: [JEV_QUESTION_SETS.streamGate],
          state: { utterance: text, recent: recent.slice(-3) }, questions: streamGateQuestions(), parse: streamJudgementOf,
          fallback: () => fallbackJudgement(text),
          traceAnswers: value => ({ category: value.category, tier: value.tier }),
        });
        if (decided.source === 'jev') judgement = decided.value;
        else this.jevFallbacks += 1;
      } catch { this.jevFallbacks += 1; }
    }
    if (judgement) return { declined: streamDeclines(judgement), judgement, via: 'jev' };
    const fallback = fallbackJudgement(text);
    return { declined: streamDeclines(fallback) || tags.some(tag => DECLINED_TAGS.has(tag)), judgement: fallback, via: 'fallback' };
  }
}

/** The flags that no rewrite is waited for twice: a guard line crossed, or the owner's private matter told or a marker read out. */
export const DROPPING_FLAGS: readonly ReplyCheckFlag[] = Object.freeze([...GUARD_FLAGS, 'private_leak', 'marker_spoken']);
export const dropsLine = (flags: readonly ReplyCheckFlag[]): boolean => flags.some(flag => DROPPING_FLAGS.includes(flag));

export type CheckedVerdict = { ok: true; reply: CheckedStreamReply } | { ok: false; flags: ReplyCheckFlag[]; note: string };

/** The check after writing: the turn's check, with the guard lines read as well. */
export function checkedLine(turn: StreamTurn, draft: string): CheckedVerdict {
  const guards = guardFlags(draft);
  const verdict = checkStreamReply(turn, draft);
  if (!guards.length) return verdict;
  const flags = [...new Set<ReplyCheckFlag>([...guards, ...(verdict.ok ? [] : verdict.flags)])];
  return { ok: false, flags, note: verdict.ok ? noteFor(guards) : `${verdict.note}\n${noteFor(guards)}` };
}
const noteFor = (flags: readonly ReplyCheckFlag[]): string =>
  `[書き直し]（さっきの下書きは、公の場で言ってはいけない線を越えていた: ${flags.join('、')}。この番の気持ちのまま、一から書き直す）`;

/** A short line of the ladder's step, for a draft that was flagged twice for something that is not a guard line. */
export const SAFE_STREAM_LINES: Readonly<Record<LadderStep, string>> = Object.freeze({
  let_go: 'あはは、そっか。',
  tease_back: 'はいはい、そう来ると思った。',
  scold: 'こら、それは言いすぎだよ。',
  end_topic: 'その話は、ここまでにしよう。',
  tell_off: 'それ以上は、やめてほしい。続けるなら、モデレーターに見てもらうよ。',
});

/** The safe line as a checked reply, or null if even it does not pass (then nothing is said). */
export function safeLine(turn: StreamTurn): CheckedStreamReply | null {
  const step = turn.state.viewer?.ladder ?? 'let_go';
  const verdict = checkedLine(turn, SAFE_STREAM_LINES[step]);
  return verdict.ok ? verdict.reply : null;
}
