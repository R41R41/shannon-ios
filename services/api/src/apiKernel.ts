import {
  InMemoryCompanionStateStore,
  assembleShannonSystemPrompt,
  createShannonMessageEmotion,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import type { ApiRequest, ApiResponse, ChatRequest, ChatResponse, StateEventRequest } from './contracts.js';

const LOCAL_REPLY = 'うん、聞いてるよ。今はまだローカル接続の確認中だけど、ここから少しずつ覚えていける。';

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

export class ShannonApiKernel {
  constructor(private readonly stateStore: CompanionStateStore) {}

  dispatch(request: ApiRequest): ApiResponse {
    if (request.method === 'GET' && request.path === '/health') {
      return { status: 200, body: { ok: true, service: 'shannon-ios-api', mode: 'local' } };
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
      const captured = this.stateStore.snapshot(body.scopeKey);
      const response: ChatResponse = {
        mode: 'local-stub',
        reply: LOCAL_REPLY,
        snapshotVersion: captured.version,
        messageEmotion: createShannonMessageEmotion(captured.emotion, captured.temperament),
        systemPrompt: assembleShannonSystemPrompt(captured),
        state: captured,
      };
      return { status: 200, body: response };
    }

    return { status: 404, body: { error: 'NOT_FOUND' } };
  }
}

export function createLocalApiKernel(now: CompanionClock = () => new Date().toISOString()): ShannonApiKernel {
  return new ShannonApiKernel(new InMemoryCompanionStateStore(now));
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', message } };
}
