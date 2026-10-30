import type { ReplyCheckFlag } from '@shannon/cognition';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { ShannonChatModel, ShannonChatModelRequest } from '../../infra/models/chatModelContract.js';
import { streamModelRequest, type CheckedStreamReply, type StreamFeeling, type StreamModelRequest, type StreamTurn } from '../../mind/emotion/streamFeeling.js';
import { STREAM_LIMITS, type StreamLineKind } from './streamContract.js';
import { checkedLine, dropsLine, safeLine } from './streamGate.js';
import type { ModelBudget, ModelPurpose, StreamMeasure } from './streamMeasure.js';
import { parseStreamDraft, streamWriterPrompt, type StreamDraft, type WriterInput, type WriterPurpose } from './streamWriter.js';

/**
 * The part of the stream that asks a model: one call at a time against the minute's allowance, and the line for a purpose written from a
 * stream turn. The request is built from `streamModelRequest(turn)` and from nothing of the owner's (no profile, recall, person memory, task
 * or tool); the answer (the line led by its mark, in the reply of the structured answer) is read, checked (`checkedLine`),
 * rewritten once with the note of what was off,
 * and at last dropped or
 * replaced by the ladder's safe line. Only a `CheckedStreamReply` comes out.
 */
export interface AuthorParts {
  scopeKey: string;
  now: () => number;
  model: ShannonChatModel;
  feeling: Pick<StreamFeeling, 'turn'>;
  snapshot: (scopeKey: string) => CompanionStateSnapshot;
  budget: ModelBudget;
  measure: () => StreamMeasure;
  identity: () => string;
  persona: (streamId: string) => string;
  /** Her Minecraft body's present for a shared room; null while she has no body. */
  body: () => string | null;
  /** Her last lines on this stream, and how the chat feels now. */
  recent: () => string[];
  crowd: () => string;
  context: () => string;
  log: (line: string) => void;
}

export interface AuthorSession { streamId: string; title: string; minecraft: boolean }
export interface WrittenLine { reply: CheckedStreamReply; draft: StreamDraft }

/** The model's request, built from the stream turn's own request (`streamModelRequest`): its check goes along as `feelingCheck`. */
export function writerRequest(
  request: StreamModelRequest, layers: { systemPrompt: string; turnContext: string; message: string }, scopeKey: string,
): ShannonChatModelRequest {
  return {
    scopeKey, systemPrompt: layers.systemPrompt, turnContext: layers.turnContext, history: [], message: layers.message,
    conversationReply: true, skipThinking: true, feelingCheck: request.feelingCheck,
  };
}

/** `promise`, or null once `milliseconds` have gone (the late answer is dropped). */
export function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
  promise.catch(() => undefined);
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const PRIORITY_KINDS: ReadonlySet<StreamLineKind> = new Set(['reply', 'notice', 'greeting', 'closing']);
const PURPOSE_OF: Readonly<Record<StreamLineKind, ModelPurpose>> = {
  reply: 'writer', notice: 'writer', greeting: 'greeting', closing: 'closing', topic: 'topic', commentary: 'commentary',
};
/** A greeting or a closing is not waited for long: the stream begins and ends on time, with a fixed word in its place. */
const WAIT_MILLISECONDS: Readonly<Partial<Record<StreamLineKind, number>>> = { closing: 5_000, greeting: 8_000 };

export class StreamAuthor {
  constructor(private readonly parts: AuthorParts) {}

  /** Her turn when no viewer is being answered (a greeting, a topic, a closing, commentary): the stream's block and a check, from the crowd. */
  ownTurn(streamId: string): StreamTurn | null {
    const { parts } = this;
    return parts.feeling.turn(parts.scopeKey, {
      streamId, viewer: null, words: '', at: new Date(parts.now()).toISOString(), snapshot: parts.snapshot(parts.scopeKey), path: 'text_pre_send',
    });
  }

  /** One model call. Spends the minute's allowance; nothing is called past it. A late answer is dropped. */
  async call(
    purpose: ModelPurpose, model: ShannonChatModel, request: ShannonChatModelRequest, priority: 'reply' | 'low', milliseconds: number,
  ): Promise<string | null> {
    const measure = this.parts.measure();
    if (!this.parts.budget.take(priority)) {
      measure.counts.budgetSkips += 1;
      return null;
    }
    measure.calls[purpose] += 1;
    try {
      const result = await within(model.generate(request), milliseconds);
      if (!result) {
        measure.counts.modelTimeouts += 1;
        return null;
      }
      measure.usage(result);
      return result.reply;
    } catch {
      measure.counts.modelErrors += 1;
      return null;
    }
  }

  private input(session: AuthorSession, request: StreamModelRequest, purpose: WriterPurpose, rewriteNote?: string): WriterInput {
    const { parts } = this;
    return {
      identity: parts.identity(), persona: parts.persona(session.streamId), streamBlock: request.block, title: session.title,
      body: session.minecraft ? parts.body() ?? '' : '', recent: parts.recent(), crowd: parts.crowd(), context: parts.context(), purpose,
      ...(rewriteNote ? { rewriteNote } : {}),
    };
  }

  private async ask(
    session: AuthorSession, turn: StreamTurn, purpose: WriterPurpose, allowed: readonly string[], kind: StreamLineKind,
    attempt: { name: ModelPurpose; note?: string },
  ): Promise<StreamDraft | null> {
    const request = streamModelRequest(turn);
    const layers = streamWriterPrompt(this.input(session, request, purpose, attempt.note));
    const priority = PRIORITY_KINDS.has(kind) ? 'reply' : 'low';
    const wait = WAIT_MILLISECONDS[kind] ?? STREAM_LIMITS.writerMilliseconds;
    const raw = await this.call(attempt.name, this.parts.model, writerRequest(request, layers, this.parts.scopeKey), priority, wait);
    if (raw === null) return null;
    const draft = parseStreamDraft(raw, allowed, kind);
    if (!draft) this.parts.measure().counts.brokenAnswers += 1;
    return draft;
  }

  /** The line for a purpose, or null (no answer, a broken one, one dropped for a guard line or a private matter). */
  async write(session: AuthorSession, turn: StreamTurn, purpose: WriterPurpose, allowed: readonly string[], kind: StreamLineKind)
    : Promise<WrittenLine | null> {
    const first = await this.ask(session, turn, purpose, allowed, kind, { name: PURPOSE_OF[kind] });
    if (!first) return null;
    const verdict = checkedLine(turn, first.say);
    if (verdict.ok) return { reply: verdict.reply, draft: first };
    this.parts.measure().counts.rewrites += 1;
    const second = await this.ask(session, turn, purpose, allowed, kind, { name: 'rewrite', note: verdict.note });
    const again = second ? checkedLine(turn, second.say) : null;
    if (second && again?.ok) return { reply: again.reply, draft: second };
    return this.fallback(turn, first, again && !again.ok ? again.flags : verdict.flags, kind);
  }

  private fallback(turn: StreamTurn, draft: StreamDraft, flags: readonly ReplyCheckFlag[], kind: StreamLineKind): WrittenLine | null {
    const { counts } = this.parts.measure();
    const reply = dropsLine(flags) || (kind !== 'reply' && kind !== 'notice') ? null : safeLine(turn);
    if (!reply) {
      counts.droppedLines += 1;
      this.parts.log(`Shannon stream dropped a line kind=${kind} flags=${flags.join(',')}`);
      return null;
    }
    counts.safeLines += 1;
    const step = turn.state.viewer?.ladder;
    const strong = step === 'tell_off' || step === 'scold';
    return { reply, draft: { ...draft, plan: { affect: strong ? 'annoyed' : 'neutral', affectIntensity: strong ? 0.5 : 0.4, delivery: 'conversational' } } };
  }
}
