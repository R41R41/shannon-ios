import { resolveReplyEmotion, type CompanionStateStore } from '@shannon/cognition';
import { presentCompanionState } from './companionPresence.js';
import { objectBody, validScopeKey, validBoundedString, badRequest } from './apiValidation.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonChatModel } from './chatModel.js';
import { dispatchVoiceCallSummary } from './apiVoiceCallSummary.js';

export function dispatchVoiceTurn(request: ApiRequest, dependencies: {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  background: TurnBackgroundService; now: () => string; chatModel?: ShannonChatModel;
}): ApiResponse | Promise<ApiResponse> | null {
  const summary = dispatchVoiceCallSummary(request, dependencies);
  if (summary) return summary;
  if (request.method !== 'POST' || ![
    '/v1/voice/gemini/cascade/turns',
    '/v1/voice/realtime/turns',
  ].includes(request.path)) return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const { scopeKey, userTranscript, shannonTranscript } = request.body;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (!validBoundedString(userTranscript, 8_000)) return badRequest('userTranscript is invalid');
  if (!validBoundedString(shannonTranscript, 8_000)) return badRequest('shannonTranscript is invalid');
  const timeZone = request.body.timeZone ?? 'Asia/Tokyo';
  try {
    if (typeof timeZone !== 'string' || timeZone.length > 64) return badRequest('timeZone is invalid');
    new Intl.DateTimeFormat('ja-JP', { timeZone });
  } catch { return badRequest('timeZone is invalid'); }
  const userMessage = userTranscript.trim();
  const shannonReply = shannonTranscript.trim();
  const threadId = dependencies.conversationStore.threadId(scopeKey,
    typeof request.body.threadId === 'string' ? request.body.threadId.trim() : undefined);
  const captured = dependencies.stateStore.snapshot(scopeKey);
  const completedAt = dependencies.now();
  // The stored face is the feeling the voice acted with: the client returns the reconciled
  // emotion of this reply. Older clients send none; the reply's own cues decide instead.
  const { messageEmotion } = resolveReplyEmotion({ snapshot: captured, userMessage, reply: shannonReply, now: completedAt,
    ...(decidedEmotion(request.body.emotion) ?? {}) });
  const turn = { scopeKey, threadId, capturedState: captured, userMessage, shannonReply,
    messageEmotion, completedAt, timeZone };
  const experience = dependencies.background.recordTurn(turn);
  dependencies.background.schedule(turn, experience.id);
  return { status: 201, body: { threadId, turnId: experience.id, messageEmotion, state: presentCompanionState(captured, completedAt) } };
}

function decidedEmotion(value: unknown): { decided: { primary: string; intensity: number } } | null {
  if (!objectBody(value) || typeof value.primary !== 'string' || value.primary.length > 40) return null;
  const intensity = typeof value.intensity === 'number' && Number.isFinite(value.intensity) ? value.intensity : 0.5;
  return { decided: { primary: value.primary, intensity: Math.min(1, Math.max(0, intensity)) } };
}
