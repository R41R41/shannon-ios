import {
  InMemoryCompanionStateStore,
  assembleShannonSystemPrompt,
  createShannonMessageEmotion,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import { BackgroundUpdateCoordinator } from './backgroundUpdates.js';
import { LocalStubChatModel, type ShannonChatModel } from './chatModel.js';
import { InMemoryConversationStore } from './conversationStore.js';
import type { ApiRequest, ApiResponse, ChatRequest, ChatResponse, StateEventRequest } from './contracts.js';

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

export interface ShannonApiKernelOptions {
  chatModel?: ShannonChatModel;
  conversationStore?: InMemoryConversationStore;
  background?: BackgroundUpdateCoordinator;
}

export class ShannonApiKernel {
  private readonly chatModel: ShannonChatModel;
  private readonly conversationStore: InMemoryConversationStore;
  private readonly background: BackgroundUpdateCoordinator;

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly now: CompanionClock,
    options: ShannonApiKernelOptions = {},
  ) {
    this.chatModel = options.chatModel ?? new LocalStubChatModel();
    this.conversationStore = options.conversationStore ?? new InMemoryConversationStore();
    this.background = options.background
      ?? new BackgroundUpdateCoordinator(this.stateStore, this.conversationStore);
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
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/state') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.stateStore.snapshot(scopeKey) };
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
      const response: ChatResponse = {
        mode: completion.mode,
        model: completion.model,
        reply: completion.reply,
        snapshotVersion: captured.version,
        messageEmotion: createShannonMessageEmotion(captured.emotion, captured.temperament),
        systemPrompt,
        state: captured,
      };

      this.background.schedule({
        scopeKey: body.scopeKey,
        capturedState: captured,
        userMessage: message,
        shannonReply: completion.reply,
        completedAt: this.now(),
      });
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
  return new ShannonApiKernel(new InMemoryCompanionStateStore(now), now, options);
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', message } };
}
