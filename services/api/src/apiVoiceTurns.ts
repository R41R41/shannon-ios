import { createShannonMessageEmotion, projectEmotionReaction, type CompanionStateStore } from '@shannon/cognition';
import { objectBody, validScopeKey, validBoundedString, badRequest } from './apiValidation.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';

export function dispatchVoiceTurn(request: ApiRequest, dependencies: {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  background: TurnBackgroundService; now: () => string;
}): ApiResponse | null {
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
  const messageEmotion = createShannonMessageEmotion(projectEmotionReaction(captured, userMessage), captured.temperament, { userMessage, shannonReply });
  const turn = { scopeKey, threadId, capturedState: captured, userMessage, shannonReply,
    messageEmotion, completedAt: dependencies.now(), timeZone };
  const experience = dependencies.background.recordTurn(turn);
  dependencies.background.schedule(turn, experience.id);
  return { status: 201, body: { threadId, messageEmotion, state: captured } };
}
