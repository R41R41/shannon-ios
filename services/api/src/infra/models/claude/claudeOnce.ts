import type Anthropic from '@anthropic-ai/sdk';
import { observeAsync, observerHandoff } from '../../observer/observerContext.js';
import { recordCacheReceipt, type CacheRoute } from '../anthropic/cacheReceipts.js';

/**
 * One request of a one-shot caller (Syzygy ADR-0009 stage 1, M3): the FCA step, the Sonnet skill proposer and the background
 * bridge (`haikuResponses.ts`). The caller builds the request and reads the answer; this sends it as handed, inside the
 * observer's `llm` span when the caller has one, and leaves a cache receipt when the caller names its route. It imports
 * nothing of the conversation, so a worker that loads it loads no turn deadline, stream decoder or voice bound.
 */
type Message = Anthropic.Message;
type Body = Anthropic.MessageCreateParamsNonStreaming;

/** The observer's `llm` span of a one-shot request: its handoff from `native`, what it shows of the request and of the answer. */
export interface ClaudeSpan<T> {
  handoff?: Record<string, unknown>;
  input: unknown;
  project: (value: T) => unknown;
  model: string;
}

export interface ClaudeOnce<T> {
  /** The request as dispatched (the receipt's prefix fingerprint). */
  body: Body;
  dispatch: () => PromiseLike<T>;
  /** The provider message within what `dispatch` resolved to. */
  message: (value: T) => Message;
  /** Synchronously, inside the span, right before dispatch (FCA marks its paid outcome unknown there). */
  dispatching?: () => void;
  span?: ClaudeSpan<T>;
  receipt?: CacheRoute;
}

export async function sendClaudeOnce<T>(call: ClaudeOnce<T>): Promise<T> {
  if (call.span?.handoff) observerHandoff('native', 'llm', call.span.handoff);
  const run = async (): Promise<T> => {
    call.dispatching?.();
    return call.dispatch();
  };
  const span = call.span;
  const value = span ? await observeAsync('llm', span.input, run, span.project, { model: span.model }) : await run();
  if (call.receipt) recordCacheReceipt(call.receipt, call.body, call.message(value).usage);
  return value;
}
