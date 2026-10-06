import {
  OWNER_AUDIENCE,
  assembleShannonSystemPrompt,
  buildIntentPrompt,
  selectPrimaryIntent,
  shannonIdentityPrompt,
  withoutUnshownTitles,
  type CompanionClock,
  type CompanionStateStore,
} from '@shannon/cognition';
import { voiceHistoryProjection } from '../../mind/action/respond/apiPromptProjection.js';
import type { CognitiveIntentStore } from '../../mind/action/respond/cognitiveIntent.js';
import type { ConversationStore } from '../../mind/memory/store/conversationStore.js';
import type { DailyMindReader } from '../../mind/action/respond/dailyMind.js';
import type { KnowledgeStore } from '../../mind/memory/store/knowledgeStore.js';
import { visibleConversationHistory } from '../../mind/memory/memoryVisibility.js';
import { temporaryGuestVoiceInstructions, voiceConversationInstructions } from './voiceConversationInstructions.js';

export type VoiceParticipantMode = 'owner' | 'guest';

export interface VoiceSessionDependencies {
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  /** Her own pursuits and work, and the autonomy wording of the identity block. Owner sessions only. */
  autonomy?: { pursuitPrompt(scopeKey: string): string; identityProjection(scopeKey: string, prompt: string): string };
  now: CompanionClock;
  voice: string;
  cognitiveIntents: CognitiveIntentStore;
}

/**
 * Instructions for a session that is created before anyone has spoken. An owner session is
 * the owner alone; a guest session carries no owner state at all.
 */
export function realtimeVoiceSessionProjection(
  scopeKey: string,
  requestedThreadId: string | undefined,
  options: {
    clientDelegation?: boolean;
    participantMode?: VoiceParticipantMode;
    brightVoice?: boolean;
  },
  dependencies: VoiceSessionDependencies,
): { threadId: string; instructions: string; voice: string } {
  if (options.participantMode === 'guest') {
    return {
      threadId: requestedThreadId?.trim() || 'temporary-guest-session',
      instructions: [
        shannonIdentityPrompt('guest'),
        voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true, false),
        temporaryGuestVoiceInstructions,
      ].join('\n\n'),
      voice: dependencies.voice,
    };
  }
  const threadId = dependencies.conversationStore.threadId(scopeKey, requestedThreadId?.trim());
  const captured = dependencies.stateStore.snapshot(scopeKey);
  const identity = dependencies.knowledgeStore?.promptProjection(scopeKey)
    ?? assembleShannonSystemPrompt(captured);
  const basePrompt = dependencies.autonomy?.identityProjection(scopeKey, identity) ?? identity;
  const dailyMindPrompt = [dependencies.dailyMind?.promptFor(scopeKey, dependencies.now()) ?? '', withoutUnshownTitles(dependencies.autonomy?.pursuitPrompt(scopeKey) ?? '')]
    .filter(Boolean).join('\n\n');
  const history = voiceHistoryProjection(visibleConversationHistory(captured, dependencies.conversationStore, scopeKey, threadId, OWNER_AUDIENCE));
  const occurredAt = dependencies.now();
  const primaryIntent = selectPrimaryIntent('', threadId, dependencies.cognitiveIntents.list(scopeKey, 'active'), occurredAt);
  const intentionPrompt = primaryIntent ? buildIntentPrompt(Object.freeze({
    situation: Object.freeze({ occurredAt, channel: 'voice' as const }),
    primaryIntent,
    supportingIntentIDs: Object.freeze([]),
    recalledMemoryIDs: Object.freeze([]),
    responseMode: 'answer' as const,
  })) : '';
  return {
    threadId,
    instructions: [
      basePrompt,
      intentionPrompt,
      dailyMindPrompt,
      history,
      voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true),
    ].filter(Boolean).join('\n\n'),
    voice: dependencies.voice,
  };
}
