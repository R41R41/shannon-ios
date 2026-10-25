import { UNKNOWN_GUEST_PRESENCE, messageEmotionForOthers, type CompanionStateStore, type ShannonFace } from '@shannon/cognition';
import { presentCompanionState, resolveReplyEmotion } from '../../mind/emotion/companionPresence.js';
import { storedVoiceFace } from '../../mind/emotion/voiceEmotionPlan.js';
import { feelingVoice, type FeelingPort } from '../../mind/emotion/feelingPorts.js';
import { objectBody, validScopeKey, validBoundedString, badRequest } from '../../infra/http/apiValidation.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import type { TurnBackgroundService } from '../../mind/sleep/backgroundUpdates.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { dispatchVoiceCallSummary } from './apiVoiceCallSummary.js';
import { ownerSaysCompanionPresent } from '../../mind/perception/voiceCompanionPresence.js';
import { bindCompletedFeedback } from '../../mind/action/respond/turnFeedback.js';
import type { FeedbackPorts } from '../../contracts/feedbackContract.js';
import type { FcaVoicePort } from '../../mind/action/fca/fcaVoicePorts.js';

export function dispatchVoiceTurn(request: ApiRequest, dependencies: {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  background: TurnBackgroundService; now: () => string; chatModel?: ShannonChatModel;
  /** Her line from a touch (`bodyReaction.ts`): the first voice turn that answers it stores it before his words. */
  reactions?: {
    claim(scopeKey: string, reactionId: unknown):
      { text: string; threadId: string | null; audience: 'owner' | 'others'; saidAt: string; face?: ShannonFace } | null;
  };
  looks?: { turnStored(scopeKey: string, threadId: string, said: string, turnId?: string): void };
  feedback?: FeedbackPorts;
  fcaVoice?: () => FcaVoicePort | null;
  /** Syzygy ADR-0012: her inner note learns which stored turn a voice utterance became (forgetting the turn forgets its notes). */
  innerNote?: { bind(scopeKey: string, from: string, to: string): void } | null;
  /** Syzygy ADR-0013 D17 (`SHANNON_SINGLE_FACE`): the presentation id stored with her message; absent, the message as before. */
  feeling?: FeelingPort | null;
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
  if (request.body.feedbackRecordId !== undefined && !validBoundedString(request.body.feedbackRecordId,120)) return badRequest('feedbackRecordId is invalid');
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
  const voiced = decidedEmotion(request.body.emotion);
  const messageEmotion = storedVoiceFace(resolveReplyEmotion({ snapshot: captured, userMessage, reply: shannonReply, now: completedAt,
    ...(voiced ?? {}) }), voiced?.decided);
  // Someone else was listening: the turn stays in the owner's thread, marked, and teaches nothing about the owner.
  const companion = request.body.companionPresent === true || ownerSaysCompanionPresent(userMessage)
    ? { audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' as const } : {};
  const storedEmotion = feelingVoice.stored(dependencies.feeling ?? null, messageEmotion, // ADR-0013 D17
    { scopeKey, at: completedAt, ...(utteranceId ? { utteranceId } : {}) });
  // He answered her line aloud, so it becomes conversation: her line, his words, her reply. It is display history
  // (no user side, no experience). With someone else able to hear, the turn follows the companion rules and her
  // line stays out of the Talk: it was context for the reply and remains in the memory of the touch.
  if (reaction && reaction.audience === 'owner' && !('audience' in companion)) {
    // The line keeps the face she said it with, so its icon in the Talk is not the usual face (2026-10-26).
    const { valence, arousal, openness } = captured.emotion;
    dependencies.conversationStore.appendNote?.(scopeKey, threadId, reaction.text, reaction.saidAt, 'body-reaction',
      reaction.face ? { valence, arousal, openness, ...reaction.face } : undefined);
  }
  const turn = { scopeKey, threadId, capturedState: captured, userMessage, shannonReply,
    messageEmotion: storedEmotion, completedAt, timeZone, ...companion, ...(utteranceId ? { utteranceId } : {}) };
  const fca = dependencies.fcaVoice?.(), receipt = utteranceId && request.deviceId ? { scopeKey, threadId,
    deviceId: request.deviceId, utteranceId, userTranscript: userMessage, shannonReply, companionPresent: 'audience' in companion } : null;
  const delivery = receipt ? fca?.history(receipt) : null;
  const stored = delivery?.status === 'duplicate' ? dependencies.conversationStore.experiencesById?.(scopeKey, [delivery.experienceId])[0] : null;
  const experience = stored ?? dependencies.background.recordTurn(turn);
  // This is the client's canonical visible-history write, not proof that the whole generated reply was heard.
  if (receipt && delivery?.status === 'ready') fca?.recorded({ ...receipt, experienceId: experience.id });
  // Her message about a look opened in this turn was waiting for the turn to be in the Talk (bodyLook.ts). Only a turn
  // with the owner alone can have a look, so a turn someone else heard is not noted there.
  if (!('audience' in companion)) {
    try { dependencies.looks?.turnStored(scopeKey, threadId, userMessage, utteranceId); } catch { /* the turn is stored either way */ }
  }
  if (!stored) dependencies.background.schedule(turn, experience.id);
  if (utteranceId) dependencies.innerNote?.bind(scopeKey, `utterance:${utteranceId}`, `experience:${experience.id}`);
  // The face goes back as before; its `kind` is sent only to the owner alone (it is stored either way).
  const shownEmotion = 'audience' in companion ? messageEmotionForOthers(storedEmotion) : storedEmotion;
  const feedback = 'audience' in companion ? null : bindCompletedFeedback(dependencies.feedback,scopeKey,typeof request.body.feedbackRecordId==='string'?request.body.feedbackRecordId:undefined,threadId,experience.id,shannonReply);
  return { status: 201, body: { threadId, turnId: experience.id, messageEmotion: shownEmotion, state: presentCompanionState(captured, completedAt), ...(feedback?{feedback}:{}) } };
}

function decidedEmotion(value: unknown): { decided: { primary: string; intensity: number } } | null {
  if (!objectBody(value) || typeof value.primary !== 'string' || value.primary.length > 40) return null;
  const intensity = typeof value.intensity === 'number' && Number.isFinite(value.intensity) ? value.intensity : 0.5;
  return { decided: { primary: value.primary, intensity: Math.min(1, Math.max(0, intensity)) } };
}
