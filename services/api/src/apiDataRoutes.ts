import type { CompanionStateStore } from '@shannon/cognition';
import type { AetherProposalStore } from './integrations/aether/aetherProposal.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import type { ApiRequest, ApiResponse, StateEventRequest } from './contracts/contracts.js';
import type { InitiativeInbox } from './initiativeStore.js';
import type { KnowledgeAnswer, KnowledgeStore } from './knowledgeStore.js';
import type { MemoryDashboard, ShannonMemoryStore } from './memoryService.js';
import { dispatchPersonRequest } from './apiPersonRoutes.js';
import { dispatchAutonomyRequest } from './apiAutonomyRoutes.js';
import type { ShannonAutonomyService } from './autonomyService.js';
import type { PersonIdentityStore } from './personIdentity.js';
import type { WorldSubscriptionReader } from './integrations/world/store/worldStore.js';
import type { CognitiveIntentStatus, CognitiveIntentStore } from './cognitiveIntent.js';
import { conversationWithCaptures } from './turnCaptures.js';
import { badRequest, objectBody, validBoundedString, validEvent, validMemoryAction, validScopeKey, validThreadTitle } from './apiValidation.js';

export interface ApiDataRouteDependencies {
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  memoryStore: ShannonMemoryStore;
  knowledgeStore: KnowledgeStore | null;
  initiativeInbox: InitiativeInbox | null;
  aetherProposals: AetherProposalStore;
  personIdentities: PersonIdentityStore;
  worldSubscriptions: WorldSubscriptionReader | null;
  cognitiveIntents: CognitiveIntentStore;
  autonomy: ShannonAutonomyService;
  now: () => string;
}

export function dispatchDataRequest(request: ApiRequest, dependencies: ApiDataRouteDependencies): ApiResponse | Promise<ApiResponse> | undefined {
  const personResponse = dispatchPersonRequest(request, dependencies);
  if (personResponse) return personResponse;
  const autonomyResponse = dispatchAutonomyRequest(request, dependencies.autonomy);
  if (autonomyResponse) return autonomyResponse;

  if (request.method === 'GET' && request.path === '/v1/cognition') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: {
      intents: dependencies.cognitiveIntents.list(scopeKey),
      recentCycles: dependencies.cognitiveIntents.recentCycles(scopeKey, 20),
    } };
  }

  if (request.method === 'POST' && request.path === '/v1/cognition/intents/status') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const intentID = request.body.intentId;
    const status = request.body.status;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validBoundedString(intentID, 160)) return badRequest('intentId is invalid');
    if (!isCognitiveIntentStatus(status)) return badRequest('status is invalid');
    try {
      const intent = dependencies.cognitiveIntents.updateStatus(scopeKey, intentID, status, dependencies.now());
      return intent ? { status: 200, body: { intent } } : { status: 404, body: { error: 'INTENT_NOT_FOUND' } };
    } catch (error) {
      if (error instanceof Error && error.message === 'COGNITIVE_INTENT_ACTIVE_CONFLICT') {
        return { status: 409, body: { error: error.message } };
      }
      throw error;
    }
  }

  if (request.method === 'GET' && request.path === '/v1/conversation/captures') {
    const scopeKey = request.query?.get('scopeKey');
    const requested = request.query?.get('threadId')?.trim();
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!requested || requested.length > 160) return badRequest('threadId is invalid');
    // A small poll target: the reply is already shown, and this adds what the worker recorded since.
    const messages = conversationWithCaptures(dependencies, scopeKey, requested);
    return { status: 200, body: {
      threadId: requested,
      turns: messages.flatMap(message => message.captures?.length && message.sourceExperienceId
        ? [{ turnId: message.sourceExperienceId, messageId: message.id, captures: message.captures }] : []),
      reminders: messages.flatMap(message => message.reminder ? [{ messageId: message.id, ...message.reminder }] : []),
    } };
  }

  if (request.method === 'GET' && request.path === '/v1/threads') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: { threads: dependencies.conversationStore.listThreads(scopeKey) } };
  }

  if (request.method === 'POST' && request.path === '/v1/threads') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const title = validThreadTitle(request.body.title) ? request.body.title.trim() : undefined;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const threadId = dependencies.conversationStore.createThread(scopeKey, title);
    return { status: 200, body: { threadId } };
  }

  if (request.method === 'POST' && request.path === '/v1/threads/title') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const threadId = request.body.threadId;
    const title = request.body.title;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 160) {
      return badRequest('threadId is invalid');
    }
    if (!validThreadTitle(title)) return badRequest('title is invalid');
    if (!dependencies.conversationStore.renameThread(scopeKey, threadId.trim(), title.trim())) {
      return { status: 404, body: { error: 'THREAD_NOT_FOUND' } };
    }
    return { status: 200, body: { renamed: true } };
  }

  if (request.method === 'POST' && request.path === '/v1/threads/archive') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const threadId = request.body.threadId;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 160) {
      return badRequest('threadId is invalid');
    }
    if (!dependencies.conversationStore.archiveThread(scopeKey, threadId.trim())) {
      return { status: 404, body: { error: 'THREAD_NOT_FOUND' } };
    }
    return { status: 200, body: { archived: true } };
  }

  if (request.method === 'GET' && request.path === '/v1/memories') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: dependencies.memoryStore.dashboard(scopeKey) };
  }

  if (request.method === 'GET' && request.path === '/v1/world/subscriptions') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!dependencies.worldSubscriptions) return { status: 503, body: { error: 'WORLD_UNAVAILABLE' } };
    return { status: 200, body: { subscriptions: dependencies.worldSubscriptions.subscriptions() } };
  }

  if (request.method === 'GET' && request.path === '/v1/world/sources') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!dependencies.worldSubscriptions) return { status: 503, body: { error: 'WORLD_UNAVAILABLE' } };
    return { status: 200, body: { sources: dependencies.worldSubscriptions.sources() } };
  }

  const worldSubscriptionDecision = request.path.match(/^\/v1\/world\/subscriptions\/([^/]+)\/decision$/u);
  if (request.method === 'POST' && worldSubscriptionDecision) {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const decision = request.body.decision;
    const expectedUpdatedAt = request.body.expectedUpdatedAt;
    const subscriptionID = decodeURIComponent(worldSubscriptionDecision[1] ?? '');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validBoundedString(subscriptionID, 160)) return badRequest('subscription id is invalid');
    if (decision !== 'approve' && decision !== 'reject') return badRequest('decision is invalid');
    if (!validBoundedString(expectedUpdatedAt, 80)) return badRequest('expectedUpdatedAt is invalid');
    if (!dependencies.worldSubscriptions) return { status: 503, body: { error: 'WORLD_UNAVAILABLE' } };
    try {
      return {
        status: 200,
        body: dependencies.worldSubscriptions.decideSubscription(
          subscriptionID,
          decision,
          expectedUpdatedAt,
          dependencies.now(),
        ),
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message === 'WORLD_SUBSCRIPTION_NOT_FOUND') {
        return { status: 404, body: { error: error.message } };
      }
      if (error.message === 'WORLD_SUBSCRIPTION_STALE' || error.message === 'WORLD_SUBSCRIPTION_ALREADY_DECIDED') {
        return { status: 409, body: { error: error.message } };
      }
      if (error.message === 'WORLD_SUBSCRIPTION_LIMIT') {
        return { status: 429, body: { error: error.message } };
      }
      throw error;
    }
  }

  if (request.method === 'GET' && request.path === '/v1/initiatives') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const messages = dependencies.initiativeInbox?.unreadMessages(scopeKey) ?? [];
    return { status: 200, body: { unreadCount: messages.length, messages } };
  }

  if (request.method === 'POST' && request.path === '/v1/initiatives/read') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const rawThreadId = request.body.threadId;
    if (rawThreadId !== undefined
      && (typeof rawThreadId !== 'string' || !rawThreadId.trim() || rawThreadId.length > 160)) {
      return badRequest('threadId is invalid');
    }
    const threadId = typeof rawThreadId === 'string' ? rawThreadId.trim() : undefined;
    const markedRead = dependencies.initiativeInbox?.markRead(scopeKey, threadId, dependencies.now()) ?? 0;
    return { status: 200, body: { markedRead } };
  }

  if (request.method === 'POST' && request.path === '/v1/memories/action') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const memoryId = request.body.memoryId;
    const action = request.body.action;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (typeof memoryId !== 'string' || !memoryId.trim() || memoryId.length > 160) {
      return badRequest('memoryId is invalid');
    }
    if (!validMemoryAction(action)) return badRequest('action is invalid');
    if (action === 'correct'
      && (typeof request.body.text !== 'string' || !request.body.text.trim() || request.body.text.length > 320)) {
      return badRequest('text must be 1..320 characters');
    }
    try {
      return {
        status: 200,
        body: dependencies.memoryStore.mutate(scopeKey, {
          memoryId,
          action,
          ...(typeof request.body.text === 'string' ? { text: request.body.text } : {}),
        }),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'MEMORY_NOT_FOUND') {
        return { status: 404, body: { error: 'MEMORY_NOT_FOUND' } };
      }
      if (error instanceof Error && error.message === 'MEMORY_COMMITMENT_REQUIRED') return badRequest('This action requires a commitment');
      throw error;
    }
  }

  if (request.method === 'POST' && request.path === '/v1/knowledge/correct') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const answerId = request.body.answerId;
    const answer = request.body.answer;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (typeof answerId !== 'string' || !answerId.trim() || answerId.length > 160) {
      return badRequest('answerId is invalid');
    }
    // The pencil shares the memory-detail limit so both entrances record one identical correction.
    if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > 320) {
      return badRequest('answer must be 1..320 characters');
    }
    const known = dependencies.knowledgeStore?.knowledgeAnswers(scopeKey).find(item => item.answerId === answerId);
    if (!known || !dependencies.knowledgeStore) return { status: 404, body: { error: 'KNOWLEDGE_NOT_FOUND' } };
    return { status: 200, body: correctKnowledgeAsOwner(dependencies, dependencies.knowledgeStore, scopeKey, known, answer.trim()) };
  }

  if (request.method === 'POST' && request.path === '/v1/events') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const body = request.body as unknown as StateEventRequest;
    if (!validScopeKey(body.scopeKey)) return badRequest('scopeKey is required');
    if (!validEvent(body.event)) return badRequest('event is invalid');
    return { status: 200, body: dependencies.stateStore.apply(body.scopeKey, body.event) };
  }

  if (request.method === 'POST' && request.path === '/v1/aether/proposals') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!dependencies.aetherProposals.configured) {
      return { status: 503, body: { error: 'AETHER_LINK_UNAVAILABLE', message: 'Aether連携はまだ利用できません。' } };
    }
    if (typeof request.body.content !== 'string' || !request.body.content.trim() || request.body.content.length > 6_000) {
      return badRequest('content must be 1..6000 characters');
    }
    if (request.body.title !== undefined && (typeof request.body.title !== 'string' || request.body.title.length > 120)) {
      return badRequest('title is invalid');
    }
    if (request.body.reason !== undefined && (typeof request.body.reason !== 'string' || request.body.reason.length > 300)) {
      return badRequest('reason is invalid');
    }
    try {
      const proposal = dependencies.aetherProposals.create(scopeKey, {
        content: request.body.content,
        ...(typeof request.body.title === 'string' ? { title: request.body.title } : {}),
        ...(typeof request.body.reason === 'string' ? { reason: request.body.reason } : {}),
        ...(typeof request.body.targetNoteId === 'string' ? { targetNoteId: request.body.targetNoteId } : {}),
        ...(typeof request.body.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: request.body.expectedUpdatedAt } : {}),
      });
      return { status: 201, body: proposal };
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_AETHER_PROPOSAL') return badRequest('proposal target is invalid');
      if (error instanceof Error && error.message === 'AETHER_PROPOSAL_QUEUE_FULL') {
        return { status: 429, body: { error: 'AETHER_PROPOSAL_QUEUE_FULL', message: 'Aetherで提案を整理してから、もう一度送ってください。' } };
      }
      throw error;
    }
  }
  return undefined;
}

/** An owner correction must outlive re-extraction, so it is recorded as a memory control, not only as an answer row. */
function correctKnowledgeAsOwner(
  dependencies: ApiDataRouteDependencies, knowledge: KnowledgeStore, scopeKey: string, known: KnowledgeAnswer, text: string,
): MemoryDashboard {
  const at = dependencies.now();
  try {
    dependencies.memoryStore.mutate(scopeKey, { memoryId: known.answerId, action: 'correct', text });
  } catch (error) {
    if (!(error instanceof Error && error.message === 'MEMORY_NOT_FOUND')) throw error;
    // An answer whose fact left the bounded state still needs the same durable boundary.
    dependencies.stateStore.apply(scopeKey, { type: 'memory-control-upserted', control: {
      memoryId: known.answerId, kind: 'user-fact', status: 'active', pinned: false, updatedAt: at,
      changeReason: 'ユーザーが内容を訂正', overrideText: text, contextInvalidatedAt: at, withheldText: known.answer,
      ...(known.evidence.find(item => item.source !== 'user') ? { sourceEvidence: known.evidence.find(item => item.source !== 'user')!.quote } : {}),
    } });
  }
  if (knowledge.knowledgeAnswers(scopeKey).find(item => item.answerId === known.answerId)?.answer !== text) {
    knowledge.correctKnowledge(scopeKey, known.answerId, text, at);
  }
  return dependencies.memoryStore.dashboard(scopeKey);
}

function isCognitiveIntentStatus(value: unknown): value is CognitiveIntentStatus {
  return value === 'active' || value === 'paused' || value === 'completed' || value === 'dismissed';
}
