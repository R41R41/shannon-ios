import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../infra/models/chatModel.js';
import type {
  ApiResponse, ChatRequest, ChatResponse, ChatSentenceFallback, ChatSentenceSink, ChatStreamLine, ChatTextRegister,
} from '../../contracts/contracts.js';
import { ChatSentenceSplitter, splitChatSentences } from './chatSentenceSplitter.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * `stream: "sentences"` on `POST /v1/chat` (docs/chat-stream-contract.md).
 *
 * Every opted-in turn is completed, checked and stored exactly as without the field, and
 * its lines are the finished reply cut into sentences. For a turn the owner alone reads,
 * with nothing that could still change the reply text, the sentences are in addition sent
 * while the model writes (`generateChatTurn`); the HTTP layer then checks them against the
 * finished reply and sends only what is left. Every other turn is sent after it is complete.
 */

/** `stream` as a request may carry it. */
export function validChatStream(value: unknown): value is undefined | 'sentences' {
  return value === undefined || value === 'sentences';
}

/** `SHANNON_CHAT_STREAM_EARLY=off` sends every turn's lines only after the turn is complete. A restart applies it. */
export function chatStreamEarlyEnabled(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_CHAT_STREAM_EARLY?.trim().toLowerCase() ?? '');
}

/** What the kernel knows about a generated turn before the model is called. */
export interface ChatSentenceTurn {
  body: ChatRequest;
  threadId: string;
  audience: { audience: 'owner' | 'others'; alone: boolean };
  /** The turn's Notion, Aether and Voyager reads: the prompt text and the pages that become a source list. */
  capability: { prompt: string; sources: readonly unknown[] };
  placeSearch: boolean;
  /**
   * Item 10 (`SHANNON_TEXT_REGISTER`): her form and pacing, with a bypass already known (review M3). A paced turn (a pause, the typing
   * display or a split) is sent once complete, when the reply's own bypass is known too; a bypassed or unpaced one may stream early.
   */
  textRegister?: ChatTextRegister;
}

/** Whether a turn's directive holds its reply back (a pause, the typing display or a split) and nothing bypasses it yet. */
function paced(register: ChatTextRegister | undefined): boolean {
  return Boolean(register && !register.bypass && (register.pauseMs > 0 || register.typingMs > 0 || register.split));
}

/** Why an opted-in turn is a single `done`, decided before the model is called; null when its sentences are sent. */
function plannedFallback(turn: ChatSentenceTurn): ChatSentenceFallback | null {
  return turn.body.attachments?.length ? 'attachments'
    : turn.body.webSearch === true ? 'web_search'
      : turn.placeSearch ? 'place_search'
        : turn.capability.sources.length ? 'sources'
          : null;
}

const plans = new WeakMap<ShannonChatModelResult, { fallback: ChatSentenceFallback | null }>();

/**
 * The kernel's model call. Without the opt-in it is `model.generate(request)` and nothing else.
 *
 * Sentences go out while the model writes only when all of this holds: the HTTP layer gave a
 * sink (opted in, switch on), the owner alone reads the reply, the turn is not a fallback, it
 * made no Notion, Aether or Voyager read, and the model can stream. `start` is sent with the
 * first sentence, so a turn that fails before any text is still a plain error response.
 */
export async function generateChatTurn(
  model: ShannonChatModel, sink: ChatSentenceSink | undefined, turn: ChatSentenceTurn, request: ShannonChatModelRequest,
): Promise<ShannonChatModelResult> {
  if (turn.body.stream !== 'sentences') return model.generate(request);
  const fallback = plannedFallback(turn);
  const early = sink && fallback === null && turn.audience.alone && model.generateStreaming && !paced(turn.textRegister);
  const register = turn.textRegister ? { textRegister: turn.textRegister } : {};
  let completion: ShannonChatModelResult;
  if (early) {
    const splitter = new ChatSentenceSplitter();
    let index = 0;
    completion = await model.generateStreaming!(request, text => {
      for (const sentence of splitter.append(text)) {
        if (index === 0) sink.write({ type: 'start', threadId: turn.threadId, audience: turn.audience.audience, ...register });
        sink.write({ type: 'sentence', index, text: sentence });
        index += 1;
      }
    });
  } else {
    completion = await model.generate(request);
  }
  plans.set(completion, { fallback });
  return completion;
}

/**
 * The kernel's return. Without the opt-in the response is returned as it is, the same object.
 * With it the body is still the same; only the note for the HTTP layer is added. A reply that
 * is not the text the model wrote had a list appended and is never cut.
 */
export function withSentenceStream(completion: ShannonChatModelResult, response: ApiResponse): ApiResponse {
  const plan = plans.get(completion);
  if (!plan) return response;
  const changed = (response.body as ChatResponse).reply !== completion.reply;
  return { ...response, sentenceStream: { fallback: plan.fallback ?? (changed ? 'sources' : null) } };
}

export function chatSentenceStreamRequested(path: string, body: unknown): boolean {
  return path === '/v1/chat' && !!body && typeof body === 'object' && (body as { stream?: unknown }).stream === 'sentences';
}

/**
 * The lines of one opted-in turn, in order. A turn the kernel did not mark is an explicit
 * command or an organize turn: its reply is fixed text with a card, sent as a single `done`.
 */
export function chatSentenceStreamLines(response: ApiResponse): ChatStreamLine[] {
  const body = response.body as ChatResponse;
  const fallback = response.sentenceStream ? response.sentenceStream.fallback : 'command';
  if (fallback) return [{ type: 'done', response: body, fallback }];
  return [
    { type: 'start', threadId: body.threadId, ...(body.turnId ? { turnId: body.turnId } : {}), audience: body.audience,
      ...(body.textRegister ? { textRegister: body.textRegister } : {}) },
    ...splitChatSentences(body.reply).map((text, index) => ({ type: 'sentence' as const, index, text })),
    { type: 'done', response: body },
  ];
}

/** True when a line already sent is the line the finished turn has at that place. A `start` sent early has no turn id yet. */
export function sameChatStreamLine(sent: ChatStreamLine, final: ChatStreamLine | undefined): boolean {
  if (!final || sent.type !== final.type) return false;
  if (sent.type === 'start' && final.type === 'start') return sent.threadId === final.threadId && sent.audience === final.audience;
  return sent.type === 'sentence' && final.type === 'sentence' && sent.index === final.index && sent.text === final.text;
}
