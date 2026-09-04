import type { CompanionStateEvent, CompanionStateSnapshot, ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonChatMode } from './chatModel.js';

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
  threadId?: string;
}

export interface ChatThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ThreadListRequest {
  scopeKey: string;
}

export interface ChatResponse {
  mode: ShannonChatMode;
  model: string;
  reply: string;
  threadId: string;
  snapshotVersion: number;
  messageEmotion: ShannonMessageEmotion;
  systemPrompt: string;
  state: CompanionStateSnapshot;
  uiBlocks?: Array<{
    type: 'agent_task_proposal';
    proposalId: string;
    title: string;
    goal: string;
    hostHint?: string;
    projectHint?: string;
    risk?: string;
  }>;
}

export interface ThreadListResponse {
  threads: ChatThread[];
}

export interface ThreadCreateRequest {
  scopeKey: string;
  title?: string;
}

export interface ThreadCreateResponse {
  threadId: string;
}

export interface ThreadArchiveRequest {
  scopeKey: string;
  threadId: string;
}

export interface StateEventRequest {
  scopeKey: string;
  event: CompanionStateEvent;
}
