import { badRequest, validScopeKey } from '../../infra/http/apiValidation.js';
import { presentCompanionState } from '../../mind/emotion/companionPresence.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { conversationWithCaptures, attachConversationFeedback, type ConversationCaptureDependencies } from '../../mind/memory/memoryPorts.js';
import type { FeedbackPorts } from '../../contracts/feedbackContract.js';
import { withoutReportCards, type ConversationExtrasPorts } from '../../contracts/conversationExtrasContract.js';
export { reactionTurnLine } from '../../contracts/conversationExtrasContract.js';

type ConversationReadDependencies = ConversationCaptureDependencies & { now: () => string;feedback?:Pick<FeedbackPorts,'project'>;ownerAlone?:(scopeKey:string)=>boolean;
  /** Rich chat: reactions and report cards (`conversationExtrasContract.ts`). Absent or null: no report card reaches the app. */
  extras?: ConversationExtrasPorts | null };

/** `GET /v1/conversation`: one Talk with what each turn took in, and her current state. Moved out of the kernel unchanged. */
export function dispatchConversationRead(request: ApiRequest, dependencies: ConversationReadDependencies): ApiResponse | undefined {
  if (request.method !== 'GET' || request.path !== '/v1/conversation') return undefined;
  const scopeKey = request.query?.get('scopeKey');
  const threadId = request.query?.get('threadId')?.trim();
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  const resolvedThreadId = dependencies.conversationStore.threadId(scopeKey, threadId);
  return {
    status: 200,
    body: {
      threadId: resolvedThreadId,
      messages: withConversationExtras(attachConversationFeedback(conversationWithCaptures(dependencies, scopeKey, resolvedThreadId),
        dependencies.feedback, scopeKey, resolvedThreadId, dependencies.ownerAlone), dependencies, scopeKey, resolvedThreadId),
      state: presentCompanionState(dependencies.stateStore.snapshot(scopeKey), dependencies.now()),
    },
  };
}

function withConversationExtras(messages: Parameters<typeof withoutReportCards>[0], dependencies: ConversationReadDependencies, scopeKey: string,
  threadId: string) {
  if (!dependencies.extras) return withoutReportCards(messages);
  try {
    const alone = dependencies.ownerAlone?.(scopeKey) === true;
    return dependencies.extras.project(scopeKey, threadId, messages, alone);
  } catch { return withoutReportCards(messages); }
}
