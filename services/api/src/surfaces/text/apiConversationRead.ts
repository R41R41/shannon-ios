import { badRequest, validScopeKey } from '../../infra/http/apiValidation.js';
import { presentCompanionState } from '../../mind/emotion/companionPresence.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { conversationWithCaptures, type ConversationCaptureDependencies } from '../../mind/memory/store/turnCaptures.js';

/** `GET /v1/conversation`: one Talk with what each turn took in, and her current state. Moved out of the kernel unchanged. */
export function dispatchConversationRead(request: ApiRequest, dependencies: ConversationCaptureDependencies & { now: () => string }): ApiResponse | undefined {
  if (request.method !== 'GET' || request.path !== '/v1/conversation') return undefined;
  const scopeKey = request.query?.get('scopeKey');
  const threadId = request.query?.get('threadId')?.trim();
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  const resolvedThreadId = dependencies.conversationStore.threadId(scopeKey, threadId);
  return {
    status: 200,
    body: {
      threadId: resolvedThreadId,
      messages: conversationWithCaptures(dependencies, scopeKey, resolvedThreadId),
      state: presentCompanionState(dependencies.stateStore.snapshot(scopeKey), dependencies.now()),
    },
  };
}
