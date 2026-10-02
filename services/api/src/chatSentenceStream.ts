import type { ApiResponse, ChatRequest, ChatResponse, ChatSentenceFallback } from './contracts.js';
import { splitChatSentences } from './chatSentenceSplitter.js';

/**
 * `stream: "sentences"` on `POST /v1/chat` (docs/chat-stream-contract.md), stage 1.
 *
 * The turn is completed, checked and stored exactly as without the field. Only then is the
 * reply the client is allowed to receive cut into sentences, so no line can carry text that
 * the single JSON response would not have carried. Nothing here reads the model, the prompt
 * or memory.
 */

export type ChatStreamLine =
  | { type: 'start'; threadId: string; turnId?: string; audience: 'owner' | 'others' }
  | { type: 'sentence'; index: number; text: string }
  | { type: 'done'; response: unknown; fallback?: ChatSentenceFallback }
  | { type: 'error'; status: number; error: string };

/** What the kernel knows about a generated turn that its response body does not say. */
export interface ChatSentenceTurn {
  /** The reply as the model wrote it, before a source or map list was appended. */
  modelReply: string;
  placeSearch: boolean;
}

/**
 * The kernel's hook. Without the opt-in the response is returned as it is, the same object.
 * With it the response body is still the same; only the note for the HTTP layer is added.
 */
export function withSentenceStream(request: ChatRequest, response: ApiResponse, turn: ChatSentenceTurn): ApiResponse {
  if (request.stream !== 'sentences') return response;
  const reply = (response.body as ChatResponse).reply;
  const fallback: ChatSentenceFallback | null = request.attachments?.length ? 'attachments'
    : request.webSearch === true ? 'web_search'
      : turn.placeSearch ? 'place_search'
        : reply !== turn.modelReply ? 'sources'
          : null;
  return { ...response, sentenceStream: { fallback } };
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
    { type: 'start', threadId: body.threadId, ...(body.turnId ? { turnId: body.turnId } : {}), audience: body.audience },
    ...splitChatSentences(body.reply).map((text, index) => ({ type: 'sentence' as const, index, text })),
    { type: 'done', response: body },
  ];
}
