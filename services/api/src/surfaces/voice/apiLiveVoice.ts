import { badRequest, objectBody, validBoundedString, validScopeKey } from '../../infra/http/apiValidation.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { markLiveTurn } from '../../mind/action/respond/apiTextTurn.js';
import { runConversationTurn } from '../../mind/action/respond/conversationTurn.js';
import { validatedVoiceDeviceContext } from './voiceDeviceContext.js';
export { voiceConversationInstructions } from './voiceConversationInstructions.js';
export { realtimeVoiceSessionProjection, type VoiceParticipantMode } from './voiceSessionProjection.js';
import { OWNER_IN_CALL_ELSEWHERE_RESPONSE } from '../../mind/perception/ownerCallElsewhere.js';
import { withObserverRun } from '../../infra/observer/observerContext.js';
import { voiceObservationOptions } from './voiceObservation.js';
import { finishTurnTiming, TurnTiming, turnTimingId } from '../../infra/observer/turnTiming.js';
import type { VoiceSeat } from './voiceSeat.js';
import type { LiveVoiceDependencies, LiveVoiceStreamObserver } from './liveVoicePorts.js';
import { VoiceConversation, voiceTurnStages, type VoiceTurnInput } from './voiceConversation.js';
export type { LiveVoiceDependencies, LiveVoiceStreamObserver } from './liveVoicePorts.js';

/**
 * The entries of a spoken turn: the apps' voice delegation (`/v1/voice/live/delegations`, the stream route's), and with one head a
 * platform's spoken turn with its seat. Both go through the one flow (`conversationTurn.ts`) as a voice turn (`voiceConversation.ts`).
 */
export function dispatchLiveVoiceRequest(
  request: ApiRequest,
  dependencies: LiveVoiceDependencies,
  observer?: LiveVoiceStreamObserver,
): ApiResponse | Promise<ApiResponse> | null {
  if (request.method !== 'POST' || ![
    '/v1/voice/gemini/cascade/delegations',
    '/v1/voice/live/delegations',
  ].includes(request.path)) return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (!validBoundedString(request.body.transcript, 8_000)) return badRequest('transcript is invalid');
  const participantMode = request.body.participantMode ?? 'owner';
  if (participantMode !== 'owner' && participantMode !== 'guest') {
    return badRequest('participantMode is invalid');
  }
  const deviceContext = validatedVoiceDeviceContext(request.body.deviceContext, dependencies.now());
  if (deviceContext === false) return badRequest('deviceContext is invalid');

  if (request.body.reactionId !== undefined && typeof request.body.reactionId !== 'string') return badRequest('reactionId is invalid');
  if (dependencies.ownerCalls?.admitTurn(scopeKey, request.deviceId, participantMode, dependencies.now()) === false) return OWNER_IN_CALL_ELSEWHERE_RESPONSE; // Her body, while he talks with her on one of his apps: refused before anything is read or written.
  // An unknown or expired reaction is not an error: the turn is then an ordinary one.
  const reaction = dependencies.reactions?.link(scopeKey, request.body.reactionId) ?? null;
  const requestedThreadId = typeof request.body.threadId === 'string' ? request.body.threadId.trim()
    : participantMode === 'owner' ? reaction?.threadId ?? undefined : undefined;
  const transcript=request.body.transcript.trim();
  const chatModel = dependencies.chatModel.forTurn?.(scopeKey) ?? dependencies.chatModel;
  const timing = observer?.timing ?? new TurnTiming('voice', turnTimingId(deviceContext?.userUtterance?.id)); // A stream writes its own line.
  timing.note('trigger', deviceContext?.userUtterance?.trigger ?? ''); // What opened the microphone (`wake`): a closed code or nothing.
  const complete=()=>markLiveTurn(dependencies.minecraftLive,()=>completeVoiceTurn({ scopeKey, requestedThreadId, transcript, participantMode,
    deviceContext, reactionLine: reaction?.text ?? null, dependencies: {...dependencies,chatModel,deviceId:request.deviceId,looks:dependencies.looks?.of(request)},
    observer, timing }));
  return finishTurnTiming(withObserverRun(voiceObservationOptions(scopeKey, { transcript, participantMode, deviceContext }),
  () => dependencies.mind?.foreground ? dependencies.mind.foreground(scopeKey,complete) : complete()), observer?.timing ? null : timing);
}

/** One head (`SHANNON_ONE_HEAD`): a platform's spoken turn, already admitted there, through this same turn with its seat (`VoiceSeat`). */
export function dispatchSeatedVoiceTurn(
  turn: { scopeKey: string; transcript: string; seat: VoiceSeat }, dependencies: LiveVoiceDependencies, observer?: LiveVoiceStreamObserver,
): Promise<ApiResponse> {
  const chatModel = dependencies.chatModel.forTurn?.(turn.scopeKey) ?? dependencies.chatModel;
  const timing = observer?.timing ?? new TurnTiming('voice', turnTimingId(undefined));
  const seated = { ...dependencies, chatModel, seat: turn.seat, looks: undefined, reactions: undefined };
  const complete = () => markLiveTurn(dependencies.minecraftLive, () => completeVoiceTurn({ scopeKey: turn.scopeKey, requestedThreadId: undefined,
    transcript: turn.transcript, participantMode: 'owner', deviceContext: null, reactionLine: null, dependencies: seated, observer, timing }));
  const audience = turn.seat.ownerAlone ? 'owner' as const : 'others' as const;
  return finishTurnTiming(withObserverRun({ scopeKey: turn.scopeKey, surface: 'voice', audience },
    () => dependencies.mind?.foreground ? dependencies.mind.foreground(turn.scopeKey, complete) : complete()), observer?.timing ? null : timing);
}

/** The one flow with a spoken turn's modality. */
function completeVoiceTurn(input: VoiceTurnInput): Promise<ApiResponse> {
  return runConversationTurn(voiceTurnStages(input.dependencies), new VoiceConversation(input));
}
