import type { MemoryAudience, CompanionStateStore } from '@shannon/cognition';
import type { ApiResponse } from '../../contracts/contracts.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { recordCompletedCognitiveCycle } from '../../mind/action/respond/cognitiveCycle.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from '../../mind/action/respond/cognitiveIntent.js';
import type { executeConversationCommand } from '../../mind/action/respond/conversationCommands.js';
import { prepareTurnCognitiveContext } from '../../mind/workspace/turnCognitiveContext.js';
import { companionPresentInstructions, speakTimePrivacyCheck } from '../../mind/perception/voiceCompanionPresence.js';
import { voiceDeviceContextPrompt, type VoiceDeviceContext } from './voiceDeviceContext.js';
import { ownerCompanionPresenceInstructions } from './voiceIntroductionInstructions.js';

/**
 * Two cohesive pieces of a voice delegation, moved out of `apiLiveVoice.ts` for its size (Syzygy ADR-0008 §10) with no change:
 * the turn's grounding block, and the answer of a spoken command the turn already ran.
 */
export function voiceTurnGrounding(turn: {
  temporaryGuest: boolean; alone: boolean; legacyGuest: boolean; selectedSkills: ReadonlySet<string>; at: string; deviceContext: VoiceDeviceContext | null;
}): string {
  return [
    '[Voice turn grounding]',
    '- The input is a potentially imperfect live Japanese transcript. Use the latest correction and do not invent missing details.',
    '- Your reply is spoken aloud as Shannon herself. State verified facts concisely in her voice; avoid Markdown tables and long URLs.',
    '- This lane is read-only unless an explicit user command has already returned a verified proposal receipt. Do not claim that a purchase, booking, deployment, file write, or other external mutation completed.',
    '- If an external mutation or approval is needed, explain the exact next confirmation instead of performing it.',
    ...(!turn.temporaryGuest ? [
      '- Shannon can propose a Codex implementation task, including adding a new capability or changing Shannon itself. A user starts the visible proposal before code work runs. Never claim this capability is unavailable.',
      '- If an ASR-uncertain request sounds like an implementation request, briefly confirm the intended feature before proposing it. Do not treat uncertain speech as execution authorization.',
      turn.alone ? ownerCompanionPresenceInstructions : companionPresentInstructions,
    ] : []),
    ...(!turn.alone && !turn.legacyGuest ? [speakTimePrivacyCheck] : []),
    ...(turn.selectedSkills.has('current_web') ? [
      '- For transit, search current operator or route sources. Ask for a missing origin or destination. Give no exact departure, arrival, fare, or disruption claim without a current source; distinguish timetable from live operating status.',
      '- For local recommendations, use the one-time GPS only if present, check current opening hours and weather on the web, and mention uncertainty briefly.',
    ] : []),
    ...(turn.selectedSkills.has('weather') && !turn.selectedSkills.has('current_web') ? [
      '- For the weather, read the forecast with weather_forecast now (no place named: his home), one call per place, and do not hand it to research. '
        + 'Say the conclusion first (傘はいる・いらない, 晴れ・雨) with one reason such as the chance of rain. '
        + 'If the place sounds garbled (「東京都 博多」), answer both places or ask which in one short question.',
    ] : []),
    ...(['device_context', 'current_web', 'weather'].some(skill => turn.selectedSkills.has(skill))
      ? [voiceDeviceContextPrompt(turn.at, turn.deviceContext)] : []),
  ].join('\n');
}

/** A spoken command that ran: its cognitive cycle recorded, and its reply as the response. */
export function voiceCommandResponse(
  dependencies: { stateStore: CompanionStateStore; conversationStore: Parameters<typeof prepareTurnCognitiveContext>[1]; cognitiveIntents: CognitiveIntentStore; chatModel: Pick<ShannonChatModel, 'model'> },
  turn: { scopeKey: string; threadId: string; transcript: string; deviceContext: VoiceDeviceContext | null; occurredAt: string; present: MemoryAudience;
    command: NonNullable<ReturnType<typeof executeConversationCommand>> },
): ApiResponse {
  const { scopeKey, threadId, occurredAt, present, command } = turn;
  const captured = dependencies.stateStore.snapshot(scopeKey);
  const message = turn.deviceContext?.userUtterance?.text ?? turn.transcript;
  const provisionalIntent = extractExplicitUserIntent(message, threadId, occurredAt);
  const cognitiveContext = prepareTurnCognitiveContext(captured, dependencies.conversationStore, {
    scopeKey, message, occurredAt, channel: 'voice', threadId, present,
    intents: dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
  });
  recordCompletedCognitiveCycle(dependencies.cognitiveIntents, scopeKey, cognitiveContext.frame, provisionalIntent, undefined, {
    threadId, channel: 'voice', action: 'command', summary: '確認済みの音声コマンドを処理した。', occurredAt,
  });
  return { status: 200, body: { threadId, model: dependencies.chatModel.model,
    reply: command.reply, webSources: [], ...(command.receipt ? { receipt: command.receipt } : {}),
    ...(command.organizeSession ? { organizeSession: command.organizeSession } : {}) } };
}
