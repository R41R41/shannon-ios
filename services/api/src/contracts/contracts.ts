import type { CompanionStateEvent, CompanionStateSnapshot, ShannonMessageEmotion, TextPacingBypass, TextRegisterDirective } from '@shannon/cognition';
import type { ShannonChatAttachment, ShannonChatMode, ShannonGeneratedArtifact } from '../infra/models/chatModel.js';
import type { OrganizeSession } from '../integrations/voyager/organize.js';
import type { ShannonPlace } from '../integrations/places/placeDiscovery.js';
import type { FeedbackState } from './feedbackContract.js';

export interface ApiRequest {
  /** `PUT` exists only for `/v1/body/capabilities` and `/v1/calendar/upcoming`; `DELETE` only for the latter. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** The paired device that sent the request; absent for a fixed-token or service caller. */
  deviceId?: string;
  /** Given by the HTTP layer to an opted-in `/v1/chat` turn that may send sentences while the model writes. */
  chatSentences?: ChatSentenceSink;
  /** Aborted when the caller went away; given by the HTTP layer to a long-poll (`/v1/autonomy/host-steps/claim`). */
  signal?: AbortSignal;
}

/** One NDJSON line of `stream: "sentences"` (docs/chat-stream-contract.md). */
export type ChatStreamLine =
  | { type: 'start'; threadId: string; turnId?: string; audience: 'owner' | 'others'; textRegister?: ChatTextRegister }
  | { type: 'sentence'; index: number; text: string }
  | { type: 'done'; response: unknown; fallback?: ChatSentenceFallback }
  | { type: 'error'; status: number; error: string };

/** Takes lines in order and never throws or waits: the turn does not depend on its reader. */
export interface ChatSentenceSink {
  write(line: ChatStreamLine): void;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Present only on a `/v1/chat` turn sent with `stream: "sentences"`. For the HTTP layer; never serialized. */
  sentenceStream?: { fallback: ChatSentenceFallback | null };
}

/** Why an opted-in turn is answered with a single `done` line (docs/chat-stream-contract.md). */
export type ChatSentenceFallback = 'command' | 'attachments' | 'web_search' | 'place_search' | 'sources';

export interface ChatRequest {
  scopeKey: string;
  message: string;
  threadId?: string;
  attachments?: ShannonChatAttachment[];
  webSearch?: boolean;
  placeLocation?: { latitude: number; longitude: number; accuracyMeters: number; observedAt: string };
  /** Who can see or hear the reply. Absent: the owner alone. `others`: someone else may, as in a call with someone listening. */
  audience?: 'owner' | 'others';
  /** Absent: one JSON document, as before the field existed. `sentences`: NDJSON lines (docs/chat-stream-contract.md). */
  stream?: 'sentences';
  /**
   * The client reads the reply aloud (the Windows body while 「話しかける」 is on). `true` lets a turn that is neither hard nor
   * research answer without thinking first (`textTurnThinking`); absent or `false`: as before the field existed.
   */
  readAloud?: boolean;
  /** What the app says about its camera in this turn (`appLookContract.ts`): `{ state, cameras, platform }`. Absent: the turn has no app camera. */
  appLook?: unknown;
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

/**
 * Her text register and pacing for one reply (Syzygy ADR-0013 item 10, `SHANNON_TEXT_REGISTER`; docs/feeling-events-contract.md). Absent:
 * render as before. A device waits `pauseMs` from his message before showing her typing, shows it at least `typingMs`, and with `split`
 * sends the first sentence and then the rest (`parts`, when there are two) after `gapMs` of typing; `bypass`: all at once, no pacing.
 */
export interface ChatTextRegister extends TextRegisterDirective {
  bypass?: TextPacingBypass;
  parts?: readonly [string, string];
}

export interface ChatResponse {
  thread?: ChatThread;
  mode: ShannonChatMode;
  model: string;
  reply: string;
  threadId: string;
  /** The audience the server applied to this turn. */
  audience: 'owner' | 'others';
  /** The completed turn; clients use it to attach captures that the worker records after the reply. */
  turnId?: string;
  feedback?: FeedbackState;
  snapshotVersion: number;
  messageEmotion: ShannonMessageEmotion;
  /** Item 10 (`SHANNON_TEXT_REGISTER`): the form and pacing of this reply; old clients ignore it. */
  textRegister?: ChatTextRegister;
  systemPrompt: string;
  state: CompanionStateSnapshot;
  artifacts?: ShannonGeneratedArtifact[];
  /** Her reaction on the owner's message this turn answered (rich chat §4, `docs/rich-chat-contract.md`); old clients ignore it. */
  shannonReaction?: { messageId: string; emoji: string };
  /** She looks through the app's camera now: the app captures one frame and answers `POST /v1/app/looks/{id}` before `expiresAt`. */
  appLook?: { id: string; camera: 'back' | 'front'; expiresAt: string; lifetimeSeconds: number };
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
  } | {
    type: 'place_search';
    places: ShannonPlace[];
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
