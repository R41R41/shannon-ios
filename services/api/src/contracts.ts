import type { CompanionStateEvent, CompanionStateSnapshot, ShannonMessageEmotion } from '@shannon/cognition';

export interface ApiRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ChatRequest {
  scopeKey: string;
  message: string;
}

export interface ChatResponse {
  mode: 'local-stub';
  reply: string;
  snapshotVersion: number;
  messageEmotion: ShannonMessageEmotion;
  systemPrompt: string;
  state: CompanionStateSnapshot;
}

export interface StateEventRequest {
  scopeKey: string;
  event: CompanionStateEvent;
}
