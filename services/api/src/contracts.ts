import type { CompanionStateEvent, CompanionStateSnapshot, ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonChatAttachment, ShannonChatMode, ShannonGeneratedArtifact } from './chatModel.js';
import type { OrganizeSession } from './organize.js';

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
  attachments?: ShannonChatAttachment[];
  webSearch?: boolean;
}

export interface ChatThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: string;
  sections?: readonly string[];
}

export interface ThreadListRequest {
  scopeKey: string;
}

export interface ChatResponse {
  thread?: ChatThread;
  mode: ShannonChatMode;
  model: string;
  reply: string;
  threadId: string;
  snapshotVersion: number;
  messageEmotion: ShannonMessageEmotion;
  systemPrompt: string;
  state: CompanionStateSnapshot;
  artifacts?: ShannonGeneratedArtifact[];
  uiBlocks?: Array<{
    type: 'agent_task_proposal';
    proposalId: string;
    cognitiveIntentID?: string;
    title: string;
    goal: string;
    hostHint?: string;
    projectHint?: string;
    risk?: string;
  } | {
    type: 'organize_session';
    session: OrganizeSession;
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
