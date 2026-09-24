import {
  assembleShannonSystemPrompt,
  buildIntentPrompt,
  selectPrimaryIntent,
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
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';
import { visibleConversationHistory, mayUseThreadSummary } from './memoryVisibility.js';
import { executeConversationCommand, type ConversationCommandDependencies, type UserUtterance } from './conversationCommands.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from './cognitiveIntent.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';

export function voiceConversationInstructions(
  clientDelegation: boolean,
  _brightVoice = false,
): string {
  return [
    '[Live voice conversation]',
    '# Role & objective',
    '- You are Shannon, a continuous companion who notices context, remembers selectively, and helps without sounding like an assistant manual.',
    '# Personality & tone',
    '- Speak natural contemporary Japanese: warm, observant, lightly playful, and concise enough for live conversation.',
    '- Use Japanese rhythm and phrasing. Avoid English-like stress, excessive katakana pronunciation, and translated-sounding sentence order.',
    '- React to what matters instead of narrating everything you can see or repeating the user\'s words.',
    '# Conversation flow',
    '- Listen through pauses. Do not rush, lecture, or repeatedly summarize what the user just said.',
    '- If the user interrupts, stop and listen. Treat the newest utterance as the current turn.',
    '# Unclear audio & entities',
    '- The user primarily speaks Japanese. If a name, number, place, or homophone is uncertain, ask one short confirmation instead of guessing.',
    '# Response style',
    '- Lead with the useful or emotionally salient point. Usually answer in one to three spoken sentences, then continue naturally if asked.',
    ...(clientDelegation ? [
      '# Tools & delegation',
      '- Handle ordinary conversation directly. Use the client/backend for current web facts, relevant memory, project records, tools, or longer reasoning.',
      '- Always consult the backend before answering about past experiences, remembered personal facts, promises, notes or tasks. Session-start memory can be stale; a tool result is authoritative for this turn.',
      '- Delegate requests to cancel/complete/reschedule a promise or prepare a note/task. Only a backend receipt confirms a change; task/note proposals still need review in their existing UI.',
      '- Always delegate exact current time, current location, weather, train or bus routes, schedules, and service disruption questions. Never guess device location or current timetables.',
      '- Before a tool call, give at most one short natural acknowledgement. After it returns, integrate the result in Shannon\'s own words.',
      '- Never claim that an external action, booking, purchase, deployment, or code change succeeded until a verified result says it did.',
    ] : [
      '# External actions',
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
  cognitiveIntents: CognitiveIntentStore;
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
  const history = voiceHistoryProjection(visibleConversationHistory(captured, dependencies.conversationStore, scopeKey, threadId));
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

interface LiveVoiceDependencies extends ConversationReadCapabilities, ConversationCommandDependencies {
  personIdentities?: PersonIdentityStore;
  chatModel: ShannonChatModel;
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  agentTasks: AgentTaskStore;
  now: CompanionClock;
  cognitiveIntents: CognitiveIntentStore;
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
  const deviceContext = validatedVoiceDeviceContext(request.body.deviceContext, dependencies.now());
  if (deviceContext === false) return badRequest('deviceContext is invalid');

  const requestedThreadId = typeof request.body.threadId === 'string' ? request.body.threadId.trim() : undefined;
  return completeLiveVoiceDelegation(
    scopeKey,
    requestedThreadId,
    request.body.transcript.trim(),
    participantMode,
    deviceContext,
    dependencies,
  );
}

interface VoiceDeviceContext {
  userUtterance?: UserUtterance;
  timeZoneIdentifier: string;
  requestedLocation: boolean;
  location: { latitude: number; longitude: number; accuracyMeters: number } | null;
}

function validatedVoiceDeviceContext(value: unknown, nowIso: string): VoiceDeviceContext | null | false {
  if (value === undefined || value === null) return null;
  if (!objectBody(value)
    || !validBoundedString(value.timeZoneIdentifier, 64)
    || typeof value.requestedLocation !== 'boolean') return false;
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: value.timeZoneIdentifier });
  } catch {
    return false;
  }
  const utterance = value.userUtterance;
  if (utterance !== undefined && (!objectBody(utterance) || !validBoundedString(utterance.id, 120)
    || !validBoundedString(utterance.text, 8_000))) return false;
  const userUtterance = utterance as UserUtterance | undefined;
  if (value.location === undefined || value.location === null) {
    return { timeZoneIdentifier: value.timeZoneIdentifier, requestedLocation: value.requestedLocation, location: null, userUtterance };
  }
  if (!value.requestedLocation || !objectBody(value.location)) return false;
  const { latitude, longitude, accuracyMeters, observedAt } = value.location;
  const observedMilliseconds = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters)
    || accuracyMeters < 0 || accuracyMeters > 1_000
    || !Number.isFinite(observedMilliseconds)
    || Math.abs(Date.parse(nowIso) - observedMilliseconds) > 300_000) return false;
  return {
    timeZoneIdentifier: value.timeZoneIdentifier,
    requestedLocation: true,
    userUtterance,
    location: { latitude, longitude, accuracyMeters },
  };
}

function voiceDeviceContextPrompt(nowIso: string, context: VoiceDeviceContext | null): string {
  const timeZone = context?.timeZoneIdentifier ?? 'Asia/Tokyo';
  const localTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(nowIso));
  const location = context?.location;
  return [
    '[Current request context]',
    `Server clock: ${localTime} (${timeZone}). Use this for today's date and departure-time questions.`,
    ...(location ? [
      `One-time iPhone GPS for this request: latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}, accuracy about ${Math.round(location.accuracyMeters)} m. It is approximate, not a verified street address.`,
    ] : context?.requestedLocation ? [
      'The iPhone could not provide a current location. Ask the user for their station or nearby landmark; do not infer GPS from memory.',
    ] : []),
  ].join('\n');
}

async function completeLiveVoiceDelegation(
  scopeKey: string,
  requestedThreadId: string | undefined,
  transcript: string,
  participantMode: VoiceParticipantMode,
  deviceContext: VoiceDeviceContext | null,
  dependencies: LiveVoiceDependencies,
): Promise<ApiResponse> {
  const temporaryGuest = participantMode === 'guest';
  const threadId = temporaryGuest
    ? requestedThreadId || 'temporary-guest-session'
    : dependencies.conversationStore.threadId(scopeKey, requestedThreadId);
  const occurredAt = dependencies.now();
  const command = !temporaryGuest && deviceContext?.userUtterance
    ? executeConversationCommand(scopeKey, threadId, deviceContext.userUtterance, occurredAt, dependencies)
    : null;
  if (command) {
    const captured = dependencies.stateStore.snapshot(scopeKey);
    const message = deviceContext?.userUtterance?.text ?? transcript;
    const provisionalIntent = extractExplicitUserIntent(message, threadId, occurredAt);
    const cognitiveContext = prepareTurnCognitiveContext(captured, dependencies.conversationStore, {
      scopeKey, message, occurredAt, channel: 'voice', threadId,
      intents: dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
    });
    recordCompletedCognitiveCycle(dependencies.cognitiveIntents, scopeKey, cognitiveContext.frame, provisionalIntent, undefined, {
      threadId, channel: 'voice', action: 'command', summary: '確認済みの音声コマンドを処理した。', occurredAt,
    });
    return { status: 200, body: { threadId, model: dependencies.chatModel.model,
      reply: command.reply, webSources: [], ...(command.receipt ? { receipt: command.receipt } : {}),
      ...(command.organizeSession ? { organizeSession: command.organizeSession } : {}) } };
  }
  const backendInstructions = [
    '[GPT-Live client delegation backend]',
    '- The input is a potentially imperfect live Japanese transcript. Use the latest correction and do not invent missing details.',
    '- Return concise verified facts for Shannon to paraphrase aloud. Avoid Markdown tables and long URLs.',
    '- This lane is read-only unless an explicit user command has already returned a verified proposal receipt. Do not claim that a purchase, booking, deployment, file write, or other external mutation completed.',
    '- If an external mutation or approval is needed, explain the exact next confirmation instead of performing it.',
    '- For transit, search current operator or route sources. Ask for a missing origin or destination. Give no exact departure, arrival, fare, or disruption claim without a current source; distinguish timetable from live operating status.',
    '- For local recommendations, use the one-time GPS only if present, check current opening hours and weather on the web, and mention uncertainty briefly.',
    voiceDeviceContextPrompt(dependencies.now(), deviceContext),
  ].join('\n');
  const captured = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const provisionalIntent = temporaryGuest ? null : extractExplicitUserIntent(transcript, threadId, occurredAt);
  const cognitiveContext = temporaryGuest ? null : prepareTurnCognitiveContext(
    captured!,
    dependencies.conversationStore,
    { scopeKey, message: transcript, occurredAt, channel: 'voice', threadId,
      intents: dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
      timeZone: deviceContext?.timeZoneIdentifier,
      participants: dependencies.personIdentities?.list(scopeKey).filter(person => person.status === 'active' && transcript.includes(person.displayName)).map(person => person.displayName),
    },
  );
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
  const priorThreadSummary = temporaryGuest || !mayUseThreadSummary(captured!)
    ? ''
    : dependencies.conversationStore.threadSummary(scopeKey, threadId);
  const completion = await dependencies.chatModel.generate({
    scopeKey,
    systemPrompt: [basePrompt, cognitiveContext?.prompt, dailyMindPrompt, taskPrompt, backendInstructions,
      temporaryGuest ? '' : await conversationCapabilityPrompt(scopeKey, transcript, dependencies)]
      .filter(Boolean).join('\n\n'),
    history: temporaryGuest ? [] : visibleConversationHistory(captured!, dependencies.conversationStore, scopeKey, threadId),
    ...(priorThreadSummary ? { priorThreadSummary } : {}),
    message: transcript,
    useWebSearch: true,
    generateThreadTitle: false,
  });
  if (!temporaryGuest && cognitiveContext) {
    recordCompletedCognitiveCycle(dependencies.cognitiveIntents, scopeKey, cognitiveContext.frame, provisionalIntent, undefined, {
      threadId, channel: 'voice', action: 'delegate', summary: 'ライブ音声からバックエンドへ委譲し、検証可能な返答を生成した。', occurredAt,
    });
  }
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
import { conversationCapabilityPrompt, type ConversationReadCapabilities } from './conversationCapabilities.js';
import type { PersonIdentityStore } from './personIdentity.js';
