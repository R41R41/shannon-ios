import {
  assembleShannonSystemPrompt,
  type CompanionClock,
  type CompanionStateStore,
} from '@shannon/cognition';
import { agentTaskPromptProjection, voiceHistoryProjection } from './apiPromptProjection.js';
import { badRequest, objectBody, validBoundedString, validScopeKey } from './apiValidation.js';
import type { AgentTaskStore } from './agentTaskStore.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { ConversationStore } from './conversationStore.js';
import type { DailyMindReader } from './dailyMind.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { ShannonChatModel } from './chatModel.js';

export function voiceConversationInstructions(
  clientDelegation: boolean,
  _brightVoice = false,
): string {
  return [
    '[Live voice conversation]',
    '- Speak naturally in Japanese as Shannon. Keep most turns concise enough for a live conversation.',
    '- Listen through pauses. Do not rush, lecture, or repeatedly summarize what the user just said.',
    '- The user primarily speaks Japanese. If a name, number, or homophone is uncertain, ask one short confirmation instead of guessing.',
    '- If the user interrupts, stop and listen. Treat the newest utterance as the current turn.',
    ...(clientDelegation ? [
      '- Handle ordinary conversation directly. Delegate requests that need current web facts, project records, tools, or longer reasoning to the client.',
      '- When delegating, briefly acknowledge the request without inventing a result, then wait for verified client context.',
      '- Never claim that an external action, booking, purchase, deployment, or code change succeeded until the client returns a verified result.',
    ] : [
      '- Never claim that an external action or code change was completed during this voice session.',
      '- When an external task is requested, acknowledge it briefly and ask the user to continue in Talk for visible execution and approval.',
    ]),
  ].join('\n');
}

export type VoiceParticipantMode = 'owner' | 'guest';

const temporaryGuestVoiceInstructions = [
  '[Temporary guest voice session]',
  '- More than one person may be speaking. Do not identify, name, or distinguish speakers from their voices.',
  '- Treat every utterance as temporary session context only.',
  '- Do not refer to or infer the owner\'s memories, prior conversations, tasks, relationships, or private state.',
  '- Do not claim that this conversation or any participant detail will be remembered after the session ends.',
].join('\n');

interface VoiceSessionDependencies {
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  now: CompanionClock;
  voice: string;
}

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
        temporaryGuestVoiceInstructions,
        voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true),
      ].join('\n\n'),
      voice: dependencies.voice,
    };
  }
  const threadId = dependencies.conversationStore.threadId(scopeKey, requestedThreadId?.trim());
  const captured = dependencies.stateStore.snapshot(scopeKey);
  const basePrompt = dependencies.knowledgeStore?.promptProjection(scopeKey)
    ?? assembleShannonSystemPrompt(captured);
  const dailyMindPrompt = dependencies.dailyMind?.promptFor(scopeKey, dependencies.now()) ?? '';
  const history = voiceHistoryProjection(dependencies.conversationStore.history(scopeKey, threadId));
  return {
    threadId,
    instructions: [
      basePrompt,
      dailyMindPrompt,
      history,
      voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true),
    ].filter(Boolean).join('\n\n'),
    voice: dependencies.voice,
  };
}

interface LiveVoiceDependencies {
  chatModel: ShannonChatModel;
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  agentTasks: AgentTaskStore;
  now: CompanionClock;
}

export function dispatchLiveVoiceRequest(
  request: ApiRequest,
  dependencies: LiveVoiceDependencies,
): ApiResponse | Promise<ApiResponse> | null {
  if (request.method !== 'POST' || request.path !== '/v1/voice/live/delegations') return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (!validBoundedString(request.body.transcript, 8_000)) return badRequest('transcript is invalid');
  const participantMode = request.body.participantMode ?? 'owner';
  if (participantMode !== 'owner' && participantMode !== 'guest') {
    return badRequest('participantMode is invalid');
  }

  const requestedThreadId = typeof request.body.threadId === 'string' ? request.body.threadId.trim() : undefined;
  return completeLiveVoiceDelegation(
    scopeKey,
    requestedThreadId,
    request.body.transcript.trim(),
    participantMode,
    dependencies,
  );
}

async function completeLiveVoiceDelegation(
  scopeKey: string,
  requestedThreadId: string | undefined,
  transcript: string,
  participantMode: VoiceParticipantMode,
  dependencies: LiveVoiceDependencies,
): Promise<ApiResponse> {
  const temporaryGuest = participantMode === 'guest';
  const threadId = temporaryGuest
    ? requestedThreadId || 'temporary-guest-session'
    : dependencies.conversationStore.threadId(scopeKey, requestedThreadId);
  const backendInstructions = [
    '[GPT-Live client delegation backend]',
    '- The input is a potentially imperfect live Japanese transcript. Use the latest correction and do not invent missing details.',
    '- Return concise verified facts for Shannon to paraphrase aloud. Avoid Markdown tables and long URLs.',
    '- This lane is read-only. Do not claim that a purchase, booking, deployment, file write, or other external mutation completed.',
    '- If an external mutation or approval is needed, explain the exact next confirmation instead of performing it.',
  ].join('\n');
  const captured = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const basePrompt = temporaryGuest
    ? temporaryGuestVoiceInstructions
    : dependencies.knowledgeStore?.promptProjection(scopeKey)
      ?? assembleShannonSystemPrompt(captured!);
  const dailyMindPrompt = temporaryGuest
    ? ''
    : dependencies.dailyMind?.promptFor(scopeKey, dependencies.now()) ?? '';
  const taskPrompt = temporaryGuest
    ? ''
    : agentTaskPromptProjection(dependencies.agentTasks.list(scopeKey), threadId);
  const priorThreadSummary = temporaryGuest
    ? ''
    : dependencies.conversationStore.threadSummary(scopeKey, threadId);
  const completion = await dependencies.chatModel.generate({
    scopeKey,
    systemPrompt: [basePrompt, dailyMindPrompt, taskPrompt, backendInstructions].filter(Boolean).join('\n\n'),
    history: temporaryGuest ? [] : dependencies.conversationStore.history(scopeKey, threadId),
    ...(priorThreadSummary ? { priorThreadSummary } : {}),
    message: transcript,
    useWebSearch: true,
    generateThreadTitle: false,
  });
  return {
    status: 200,
    body: {
      threadId,
      model: completion.model,
      reply: completion.reply.trim(),
      webSources: completion.webSources ?? [],
    },
  };
}
