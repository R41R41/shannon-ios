import { UNKNOWN_GUEST_PRESENCE, type CompanionStateStore } from '@shannon/cognition';
import { presentCompanionState, resolveReplyEmotion } from './companionPresence.js';
import { objectBody, validScopeKey, validBoundedString, badRequest } from './apiValidation.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonChatModel } from './chatModel.js';
import { dispatchVoiceCallSummary } from './apiVoiceCallSummary.js';
import { ownerSaysCompanionPresent } from './voiceCompanionPresence.js';

export function dispatchVoiceTurn(request: ApiRequest, dependencies: {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  background: TurnBackgroundService; now: () => string; chatModel?: ShannonChatModel;
  /** Her line from a touch (`bodyReaction.ts`): the first voice turn that answers it stores it before his words. */
  reactions?: { claim(scopeKey: string, reactionId: unknown): { text: string; threadId: string | null; audience: 'owner' | 'others'; saidAt: string } | null };
  looks?: { turnStored(scopeKey: string, threadId: string, said: string, turnId?: string): void };
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
  if (request.body.reactionId !== undefined && typeof request.body.reactionId !== 'string') return badRequest('reactionId is invalid');
  if (request.body.companionPresent !== undefined && typeof request.body.companionPresent !== 'boolean') return badRequest('companionPresent is invalid');
  // Optional: the `userUtterance.id` the client sent with the delegation of this turn, so the two requests are known as one turn.
  if (request.body.utteranceId !== undefined && !validBoundedString(request.body.utteranceId, 120)) return badRequest('utteranceId is invalid');
  const utteranceId = typeof request.body.utteranceId === 'string' ? request.body.utteranceId : undefined;
  const userMessage = userTranscript.trim();
  const shannonReply = shannonTranscript.trim();
  // Taken once, after the request is known to be valid: an unknown or expired reaction leaves an ordinary turn.
  const reaction = dependencies.reactions?.claim(scopeKey, request.body.reactionId) ?? null;
  const threadId = dependencies.conversationStore.threadId(scopeKey,
    typeof request.body.threadId === 'string' ? request.body.threadId.trim() : reaction?.threadId ?? undefined);
  const captured = dependencies.stateStore.snapshot(scopeKey);
  const completedAt = dependencies.now();
  // The stored face is the feeling the voice acted with: the client returns the reconciled
  // emotion of this reply. Older clients send none; the reply's own cues decide instead.
  const { messageEmotion } = resolveReplyEmotion({ snapshot: captured, userMessage, reply: shannonReply, now: completedAt,
    ...(decidedEmotion(request.body.emotion) ?? {}) });
  // Someone else was listening: the turn stays in the owner's thread, marked, and teaches nothing about the owner.
  const companion = request.body.companionPresent === true || ownerSaysCompanionPresent(userMessage)
    ? { audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' as const } : {};
  // He answered her line aloud, so it becomes conversation: her line, his words, her reply. It is display history
  // (no user side, no experience). With someone else able to hear, the turn follows the companion rules and her
  // line stays out of the Talk: it was context for the reply and remains in the memory of the touch.
  if (reaction && reaction.audience === 'owner' && !('audience' in companion)) {
    dependencies.conversationStore.appendNote?.(scopeKey, threadId, reaction.text, reaction.saidAt, 'body-reaction');
  }
  const turn = { scopeKey, threadId, capturedState: captured, userMessage, shannonReply,
    messageEmotion, completedAt, timeZone, ...companion };
  const experience = dependencies.background.recordTurn(turn);
  // Her message about a look opened in this turn was waiting for the turn to be in the Talk (bodyLook.ts). Only a turn
  // with the owner alone can have a look, so a turn someone else heard is not noted there.
  if (!('audience' in companion)) {
    try { dependencies.looks?.turnStored(scopeKey, threadId, userMessage, utteranceId); } catch { /* the turn is stored either way */ }
  }
  dependencies.background.schedule(turn, experience.id);
  return { status: 201, body: { threadId, turnId: experience.id, messageEmotion, state: presentCompanionState(captured, completedAt) } };
}

function decidedEmotion(value: unknown): { decided: { primary: string; intensity: number } } | null {
  if (!objectBody(value) || typeof value.primary !== 'string' || value.primary.length > 40) return null;
  const intensity = typeof value.intensity === 'number' && Number.isFinite(value.intensity) ? value.intensity : 0.5;
  return { decided: { primary: value.primary, intensity: Math.min(1, Math.max(0, intensity)) } };
}
