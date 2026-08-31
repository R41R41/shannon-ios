import {
  InMemoryCompanionStateStore,
  assembleShannonSystemPrompt,
  createShannonMessageEmotion,
  projectEmotionReaction,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import { BackgroundUpdateCoordinator, type TurnBackgroundService } from './backgroundUpdates.js';
import { LocalStubChatModel, type ShannonChatModel } from './chatModel.js';
import { InMemoryConversationStore, type ConversationStore } from './conversationStore.js';
import type { ApiRequest, ApiResponse, ChatRequest, ChatResponse, StateEventRequest } from './contracts.js';
import {
  ShannonMemoryService,
  type MemoryAction,
  type ShannonMemoryStore,
} from './memoryService.js';

function objectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validScopeKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function validEvent(value: unknown): value is CompanionStateEvent {
  if (!objectBody(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'emotion-adjusted':
      return objectBody(value.delta)
        && optionalFiniteNumber(value.delta.valence)
        && optionalFiniteNumber(value.delta.arousal)
        && optionalFiniteNumber(value.delta.openness);
    case 'interest-observed':
      return typeof value.interest === 'string' && value.interest.trim().length > 0;
    case 'user-fact-upserted':
      return objectBody(value.fact)
        && typeof value.fact.id === 'string'
        && typeof value.fact.statement === 'string'
        && typeof value.fact.observedAt === 'string'
        && typeof value.fact.confidence === 'number'
        && Number.isFinite(value.fact.confidence);
    case 'relationship-upserted':
      return objectBody(value.relationship)
        && typeof value.relationship.id === 'string'
        && typeof value.relationship.statement === 'string'
        && typeof value.relationship.observedAt === 'string'
        && typeof value.relationship.confidence === 'number'
        && Number.isFinite(value.relationship.confidence);
    case 'memory-control-upserted':
      return objectBody(value.control)
        && typeof value.control.memoryId === 'string'
        && validMemoryKind(value.control.kind)
        && validMemoryStatus(value.control.status)
        && typeof value.control.pinned === 'boolean'
        && typeof value.control.updatedAt === 'string'
        && typeof value.control.changeReason === 'string';
    case 'memory-activated':
      return objectBody(value.memory)
        && typeof value.memory.id === 'string'
        && typeof value.memory.summary === 'string'
        && typeof value.memory.observedAt === 'string'
        && typeof value.memory.relevance === 'number'
        && Number.isFinite(value.memory.relevance);
    case 'memory-deactivated':
      return typeof value.memoryId === 'string' && value.memoryId.length > 0;
    default:
      return false;
  }
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validMemoryKind(value: unknown): boolean {
  return value === 'user-fact' || value === 'interest' || value === 'experience' || value === 'relationship';
}

function validMemoryStatus(value: unknown): boolean {
  return value === 'active' || value === 'forgotten' || value === 'rejected';
}

function validMemoryAction(value: unknown): value is MemoryAction {
  return value === 'correct' || value === 'forget' || value === 'pin'
    || value === 'unpin' || value === 'reject' || value === 'restore';
}

export interface ShannonApiKernelOptions {
  chatModel?: ShannonChatModel;
  stateStore?: CompanionStateStore;
  conversationStore?: ConversationStore;
  background?: TurnBackgroundService;
  memoryStore?: ShannonMemoryStore;
}

export class ShannonApiKernel {
  private readonly chatModel: ShannonChatModel;
  private readonly conversationStore: ConversationStore;
  private readonly background: TurnBackgroundService;
  private readonly memoryStore: ShannonMemoryStore;

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly now: CompanionClock,
    options: ShannonApiKernelOptions = {},
  ) {
    this.chatModel = options.chatModel ?? new LocalStubChatModel();
    this.conversationStore = options.conversationStore ?? new InMemoryConversationStore();
    this.background = options.background
      ?? new BackgroundUpdateCoordinator(this.stateStore, this.conversationStore);
    this.memoryStore = options.memoryStore
      ?? new ShannonMemoryService(this.stateStore, this.conversationStore, this.now);
  }

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    if (request.method === 'GET' && request.path === '/health') {
      return {
        status: 200,
        body: {
          ok: true,
          service: 'shannon-ios-api',
          mode: 'local',
          llm: { mode: this.chatModel.mode, model: this.chatModel.model },
          background: { mode: this.background.mode },
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/state') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.stateStore.snapshot(scopeKey) };
    }

    if (request.method === 'GET' && request.path === '/v1/conversation') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return {
        status: 200,
        body: {
          messages: this.conversationStore.conversationHistory(scopeKey),
          state: this.stateStore.snapshot(scopeKey),
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/memories') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.memoryStore.dashboard(scopeKey) };
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
          body: this.memoryStore.mutate(scopeKey, {
            memoryId,
            action,
            ...(typeof request.body.text === 'string' ? { text: request.body.text } : {}),
          }),
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'MEMORY_NOT_FOUND') {
          return { status: 404, body: { error: 'MEMORY_NOT_FOUND' } };
        }
        throw error;
      }
    }

    if (request.method === 'POST' && request.path === '/v1/events') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const body = request.body as unknown as StateEventRequest;
      if (!validScopeKey(body.scopeKey)) return badRequest('scopeKey is required');
      if (!validEvent(body.event)) return badRequest('event is invalid');
      return { status: 200, body: this.stateStore.apply(body.scopeKey, body.event) };
    }

    if (request.method === 'POST' && request.path === '/v1/chat') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const body = request.body as unknown as ChatRequest;
      if (!validScopeKey(body.scopeKey)) return badRequest('scopeKey is required');
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8_000) {
        return badRequest('message must be 1..8000 characters');
      }

      const message = body.message.trim();
      const captured = this.stateStore.snapshot(body.scopeKey);
      const systemPrompt = assembleShannonSystemPrompt(captured);
      const completion = await this.chatModel.generate({
        scopeKey: body.scopeKey,
        systemPrompt,
        history: this.conversationStore.history(body.scopeKey),
        message,
      });
      const messageEmotion = createShannonMessageEmotion(
        projectEmotionReaction(captured, message),
        captured.temperament,
        { userMessage: message, shannonReply: completion.reply },
      );
      const response: ChatResponse = {
        mode: completion.mode,
        model: completion.model,
        reply: completion.reply,
        snapshotVersion: captured.version,
        messageEmotion,
        systemPrompt,
        state: captured,
      };

      const completedTurn = {
        scopeKey: body.scopeKey,
        capturedState: captured,
        userMessage: message,
        shannonReply: completion.reply,
        messageEmotion: response.messageEmotion,
        completedAt: this.now(),
      };
      const experience = this.background.recordTurn(completedTurn);
      this.background.schedule(completedTurn, experience.id);
      return { status: 200, body: response };
    }

    return { status: 404, body: { error: 'NOT_FOUND' } };
  }

  waitForBackground(scopeKey: string): Promise<void> {
    return this.background.waitForIdle(scopeKey);
  }
}

export function createLocalApiKernel(
  now: CompanionClock = () => new Date().toISOString(),
  options: ShannonApiKernelOptions = {},
): ShannonApiKernel {
  return new ShannonApiKernel(options.stateStore ?? new InMemoryCompanionStateStore(now), now, options);
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', message } };
}
