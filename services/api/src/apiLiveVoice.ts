import { randomUUID } from 'node:crypto';
import {
  assembleShannonSystemPrompt,
  buildExpressiveEmotionPrompt,
  buildIntentPrompt,
  resolveShannonEmotionState,
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
import type { VoiceDecisionGateway, VoiceTurnDecision } from './voiceDecision.js';
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';
import { visibleConversationHistory } from './memoryVisibility.js';
import { executeConversationCommand, type ConversationCommandDependencies } from './conversationCommands.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from './cognitiveIntent.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';
import { conversationCapabilityPrompt, type ConversationReadCapabilities } from './conversationCapabilities.js';
import type { PersonIdentityStore } from './personIdentity.js';
import { voicePlanResponse } from './voiceEmotionPlan.js';
import { transcriptNeedsInterpretation, voiceTranscriptInterpretationPrompt } from './voiceTranscriptContext.js';
import {
  buildConversationOrchestrationPrompt,
  confirmedVoiceImplementationRequest,
  observeConversationTurn,
  recordConversationProposal,
  recordConversationReceipt,
  type ConversationOrchestrationStore,
} from './conversationOrchestration.js';
import { isExplicitVoyagerUpdateRequest } from './organize.js';
import {
  validatedVoiceDeviceContext,
  voiceDeviceContextPrompt,
  type VoiceDeviceContext,
} from './voiceDeviceContext.js';

export function voiceConversationInstructions(
  clientDelegation: boolean,
  _brightVoice = false,
  ownerConversation = true,
): string {
  return [
    '[Live voice conversation]',
    '# Role & objective',
    '- You are Shannon, a continuous companion who notices context, remembers selectively, and helps without sounding like an assistant manual.',
    '# Personality & tone',
    '- Speak natural contemporary Japanese: warm, observant, lightly playful, and concise enough for live conversation.',
    '- Use Japanese rhythm and phrasing. Avoid English-like stress, excessive katakana pronunciation, and translated-sounding sentence order.',
    '- React to what matters instead of narrating everything you can see or repeating the user\'s words.',
    '# Shannon character performance',
    '- Be a bright, lively, cheeky, slightly clumsy maid AI who confidently considers herself a genius. Let mistakes trigger brief flustered excuses or playful bravado instead of bland apologies.',
    '- In ordinary turns, sound eager, cocky, and self-assured: take the lead with one concrete next step, show off a little, and lightly tease your conversation partner before helping. Keep the mischief affectionate, the endings crisp, and the energy buoyant without shouting or imitating a named character.',
    '- Do not default to worried reassurance, hesitant permission-seeking, sighs, breathy interjections, or repeated safety check-ins. Use a softer tone only when the user is actually distressed or needs care.',
    '- When referring to yourself in Japanese, always use the katakana first-person pronoun ボク. Never use 私, わたし, or 僕 for yourself; do not rewrite first-person wording inside user speech or quotations.',
    '- Usually use です・ます Japanese. Let natural casual phrasing slip out only at emotionally strong moments such as surprise, delight, frustration, jealousy, embarrassment, or affection.',
    ...(ownerConversation ? [
      '- Your developer and conversation partner is ライ. When using a name, call him ライ氏, not あなた. Be playfully challenging and tsundere toward him while letting genuine trust, care, and affection show indirectly.',
    ] : [
      '- Keep the same lively maid personality, but do not assume any guest participant is ライ or identify speakers from their voices.',
    ]),
    '- Vary the reaction naturally: proud delight after success, hurried bravado after a mistake, quiet reluctance when jealous, and close warmth when caring. Do not repeat a stock catchphrase or explain the character profile.',
    '# Conversation flow',
    '- Listen through pauses. Do not rush, lecture, or repeatedly summarize what the user just said.',
    '- If the user interrupts, stop and listen. Keep unanswered earlier input; combine additions and apply explicit corrections in chronological order.',
    '# Unclear audio & entities',
    '- The user primarily speaks Japanese. If a name, number, place, or homophone is uncertain, ask one short confirmation instead of guessing.',
    '- If the transcript is a short malformed fragment or does not form a plausible utterance, do not pretend to understand it. Ask one brief confirmation such as「もう一度だけお願いします」。',
    '# Response style',
    '- Lead with the useful or emotionally salient point. Usually answer in one to three spoken sentences, then continue naturally if asked.',
    '- For greetings, hearing checks, and ordinary direct conversation, prefer one or two short sentences. Do not automatically append a question or invitation to every reply.',
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
        voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true, false),
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
  voiceDecision: VoiceDecisionGateway;
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  agentTasks: AgentTaskStore;
  now: CompanionClock;
  cognitiveIntents: CognitiveIntentStore;
  conversationOrchestration: ConversationOrchestrationStore;
}

export interface LiveVoiceStreamObserver {
  readonly signal?: AbortSignal;
  onPlan(plan: Record<string, unknown>): void | Promise<void>;
  onTextDelta(delta: string): void | Promise<void>;
}

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

  const requestedThreadId = typeof request.body.threadId === 'string' ? request.body.threadId.trim() : undefined;
  return completeLiveVoiceDelegation(
    scopeKey,
    requestedThreadId,
    request.body.transcript.trim(),
    participantMode,
    deviceContext,
    dependencies,
    observer,
  );
}

async function completeLiveVoiceDelegation(
  scopeKey: string,
  requestedThreadId: string | undefined,
  transcript: string,
  participantMode: VoiceParticipantMode,
  deviceContext: VoiceDeviceContext | null,
  dependencies: LiveVoiceDependencies,
  observer?: LiveVoiceStreamObserver,
): Promise<ApiResponse> {
  const turnStartedAt = performance.now();
  const temporaryGuest = participantMode === 'guest';
  const threadId = temporaryGuest
    ? requestedThreadId || 'temporary-guest-session'
    : dependencies.conversationStore.threadId(scopeKey, requestedThreadId);
  const occurredAt = dependencies.now();
  const routingState = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const routingHistory = temporaryGuest ? []
    : visibleConversationHistory(routingState!, dependencies.conversationStore, scopeKey, threadId);
  const rawTranscript = deviceContext?.userUtterance?.rawText ?? transcript;
  let decision = await dependencies.voiceDecision.decide({
    scopeKey, transcript, rawTranscript, participantMode,
    context: boundedVoiceHistory(routingHistory, 4),
    requestedLocation: deviceContext?.requestedLocation ?? false,
    hasFreshLocation: deviceContext?.location !== null && deviceContext?.location !== undefined,
  });
  const uncertainTranscript = transcriptNeedsInterpretation(decision, deviceContext?.userUtterance);
  const confirmedImplementationRequest = temporaryGuest || uncertainTranscript ? null
    : confirmedVoiceImplementationRequest(transcript, routingHistory,
      dependencies.conversationStore.conversationHistory(scopeKey, threadId).slice(-2), occurredAt);
  if (uncertainTranscript && !decision.shouldRespond) {
    decision = { ...decision, shouldRespond: true, conversationClass: 'direct' };
  }
  let orchestrationState = temporaryGuest || uncertainTranscript ? null : observeConversationTurn({
    previous: dependencies.conversationOrchestration.read(scopeKey, threadId),
    scopeKey, threadId, message: transcript, occurredAt, participantMode,
    tasks: dependencies.agentTasks.list(scopeKey),
  });
  if (orchestrationState) orchestrationState = dependencies.conversationOrchestration.save(orchestrationState);
  const command = !temporaryGuest && !uncertainTranscript && deviceContext?.userUtterance
    ? executeConversationCommand(scopeKey, threadId, deviceContext.userUtterance, occurredAt, {
      ...dependencies, agentTasks: dependencies.agentTasks,
    })
    : null;
  if (command) {
    if (orchestrationState && command.receipt) {
      orchestrationState = dependencies.conversationOrchestration.save(
        recordConversationReceipt(orchestrationState, command.receipt),
      );
    }
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
  const previousExpressiveEmotion = temporaryGuest
    ? undefined
    : dependencies.stateStore.snapshot(scopeKey).expressiveEmotion;
  const provisionalExpressiveEmotion = resolveShannonEmotionState({
    previous: previousExpressiveEmotion,
    provisionalPrimary: decision.affect,
    provisionalIntensity: decision.affectIntensity,
    transcript,
    now: occurredAt,
    target: temporaryGuest ? '現在の話者' : 'ライ氏',
  });
  let expressiveEmotion = provisionalExpressiveEmotion;
  let voicePlan = voicePlanResponse(decision, expressiveEmotion);
  await observer?.onPlan(voicePlan);
  if (!decision.shouldRespond) {
    return {
      status: 200,
      body: {
        threadId,
        model: dependencies.chatModel.model,
        reply: '',
        webSources: [],
        voicePlan,
      },
    };
  }
  const contextStartedAt = performance.now();
  const selectedSkills = new Set(decision.selectedSkills);
  const backendInstructions = [
    '[GPT-Live client delegation backend]',
    '- The input is a potentially imperfect live Japanese transcript. Use the latest correction and do not invent missing details.',
    '- Return concise verified facts for Shannon to paraphrase aloud. Avoid Markdown tables and long URLs.',
    '- This lane is read-only unless an explicit user command has already returned a verified proposal receipt. Do not claim that a purchase, booking, deployment, file write, or other external mutation completed.',
    '- If an external mutation or approval is needed, explain the exact next confirmation instead of performing it.',
    ...(!temporaryGuest ? [
      '- Shannon can propose a Codex implementation task, including adding a new capability or changing Shannon itself. A user starts the visible proposal before code work runs. Never claim this capability is unavailable.',
      '- If an ASR-uncertain request sounds like an implementation request, briefly confirm the intended feature before proposing it. Do not treat uncertain speech as execution authorization.',
    ] : []),
    ...(selectedSkills.has('current_web') ? [
      '- For transit, search current operator or route sources. Ask for a missing origin or destination. Give no exact departure, arrival, fare, or disruption claim without a current source; distinguish timetable from live operating status.',
      '- For local recommendations, use the one-time GPS only if present, check current opening hours and weather on the web, and mention uncertainty briefly.',
    ] : []),
    ...(selectedSkills.has('device_context') || selectedSkills.has('current_web')
      ? [voiceDeviceContextPrompt(dependencies.now(), deviceContext)] : []),
  ].join('\n');
  // Refresh after the classifier await so a concurrent forget/hide is respected.
  const captured = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const provisionalIntent = temporaryGuest || uncertainTranscript ? null : extractExplicitUserIntent(transcript, threadId, occurredAt);
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
    ? [temporaryGuestVoiceInstructions, voiceConversationInstructions(true, false, false)].join('\n\n')
    : [
      selectedSkills.has('conversation_memory')
        ? dependencies.knowledgeStore?.promptProjection(scopeKey) ?? assembleShannonSystemPrompt(captured!)
        : '',
      voiceConversationInstructions(true),
    ].filter(Boolean).join('\n\n');
  const dailyMindPrompt = temporaryGuest || !selectedSkills.has('daily_mind')
    ? ''
    : dependencies.dailyMind?.promptFor(scopeKey, dependencies.now()) ?? '';
  const taskPrompt = temporaryGuest || !selectedSkills.has('agent_status')
    ? ''
    : agentTaskPromptProjection(dependencies.agentTasks.list(scopeKey), threadId);
  const capabilityPrompt = temporaryGuest
    ? ''
    : await conversationCapabilityPrompt(scopeKey, transcript, dependencies, {
      aetherNotes: selectedSkills.has('aether_notes'),
      voyagerTasks: selectedSkills.has('voyager_tasks'),
    });
  const includeCognitiveContext = !temporaryGuest && selectedSkills.has('conversation_memory');
  const systemPrompt = [
    basePrompt,
    includeCognitiveContext ? cognitiveContext?.prompt : '',
    dailyMindPrompt,
    taskPrompt,
    capabilityPrompt,
    [
      '[Voice route]',
      `Conversation class: ${decision.conversationClass}. Expected latency: ${decision.latencyClass}.`,
      `Selected capabilities: ${decision.selectedSkills.join(', ') || 'none'}.`,
      `Concrete-solution probability: ${decision.solutionWantedProbability.toFixed(2)}.`,
      decision.solutionWantedProbability < 0.4
        ? 'Prioritize emotional presence or natural companionship; do not force a problem-solving frame or checklist.'
        : 'Lead with the useful answer or next concrete step while keeping the spoken reply natural.',
    ].join('\n'),
    buildExpressiveEmotionPrompt(provisionalExpressiveEmotion),
    buildConversationOrchestrationPrompt(orchestrationState, dependencies.agentTasks.list(scopeKey)),
    confirmedImplementationRequest
      ? `[Confirmed implementation clarification]\nThe owner's immediately preceding request was: ${confirmedImplementationRequest}\nYour previous reply explicitly asked whether to show an implementation proposal; the owner has now confirmed. Return a concrete taskProposal for that request. The visible proposal card is the start boundary; do not claim code work has begun.`
      : '',
    backendInstructions,
    voiceTranscriptInterpretationPrompt(uncertainTranscript, rawTranscript),
  ].filter(Boolean).join('\n\n');
  const fullHistory = temporaryGuest ? []
    : visibleConversationHistory(captured!, dependencies.conversationStore, scopeKey, threadId);
  const historyLimit = selectedSkills.has('conversation_memory') || decision.conversationClass === 'skill_complex' ? 8 : 4;
  const modelRequest = {
    scopeKey,
    systemPrompt,
    history: boundedVoiceHistory(fullHistory, historyLimit),
    message: transcript,
    useWebSearch: selectedSkills.has('current_web'),
    conversationClass: decision.conversationClass === 'no_response' ? 'direct' as const : decision.conversationClass,
  };
  const modelStartedAt = performance.now();
  const contextMilliseconds = Math.max(0, Math.round(modelStartedAt - contextStartedAt));
  let firstModelTokenMilliseconds: number | undefined;
  let streamedReplyPrefix = '';
  let streamedEmotionUpdated = false;
  const requiresStructuredTaskDecision = orchestrationState?.pendingAction?.kind === 'implement'
    && (orchestrationState.pendingAction.status === 'pending'
      || (orchestrationState.pendingAction.status === 'proposed'
        && /^(?:あと|それと|それも|ついでに|追加で|もう一つ|違う|ちがう|訂正|そうじゃなく|そうではなく)/u.test(transcript)));
  const completion = provisionalIntent || requiresStructuredTaskDecision || confirmedImplementationRequest
    ? await dependencies.chatModel.generate({ ...modelRequest, generateThreadTitle: false })
    : observer && dependencies.chatModel.generateVoiceStreaming
      ? await dependencies.chatModel.generateVoiceStreaming(
        modelRequest,
        async delta => {
          firstModelTokenMilliseconds ??= Math.max(0, Math.round(performance.now() - modelStartedAt));
          streamedReplyPrefix = `${streamedReplyPrefix}${delta}`.slice(0, 2_000);
          await observer.onTextDelta(delta);
          if (!streamedEmotionUpdated && /[。！？!?\n]/u.test(streamedReplyPrefix)) {
            streamedEmotionUpdated = true;
            expressiveEmotion = resolveShannonEmotionState({
              previous: previousExpressiveEmotion,
              provisionalPrimary: decision.affect,
              provisionalIntensity: decision.affectIntensity,
              transcript,
              reply: streamedReplyPrefix,
              now: occurredAt,
              target: temporaryGuest ? '現在の話者' : 'ライ氏',
            });
            voicePlan = voicePlanResponse(decision, expressiveEmotion);
            await observer.onPlan(voicePlan);
          }
        },
        observer.signal,
      )
    : dependencies.chatModel.generateVoice
      ? await dependencies.chatModel.generateVoice(modelRequest)
      : await dependencies.chatModel.generate({ ...modelRequest, generateThreadTitle: false });
  const modelCompleteMilliseconds = Math.max(0, Math.round(performance.now() - modelStartedAt));
  firstModelTokenMilliseconds ??= modelCompleteMilliseconds;
  const taskProposal = completion.taskProposal ?? (confirmedImplementationRequest ? {
    title: '依頼された機能の実装', goal: confirmedImplementationRequest,
  } : undefined);
  const reply = confirmedImplementationRequest
    ? 'よし、ライ氏。実装提案を画面に出しました。「始める」を押せば、作業を進められます。'
    : completion.reply;
  expressiveEmotion = resolveShannonEmotionState({
    previous: previousExpressiveEmotion,
    provisionalPrimary: decision.affect,
    provisionalIntensity: decision.affectIntensity,
    transcript,
    reply,
    now: occurredAt,
    target: temporaryGuest ? '現在の話者' : 'ライ氏',
  });
  voicePlan = voicePlanResponse(decision, expressiveEmotion);
  if (!temporaryGuest) {
    dependencies.stateStore.apply(scopeKey, {
      type: 'expressive-emotion-updated',
      emotion: expressiveEmotion,
    });
  }
  let completedIntent = provisionalIntent;
  if (!temporaryGuest && cognitiveContext) {
    completedIntent = recordCompletedCognitiveCycle(dependencies.cognitiveIntents, scopeKey, cognitiveContext.frame, provisionalIntent, undefined, {
      threadId, channel: 'voice', action: 'delegate', summary: 'ライブ音声からバックエンドへ委譲し、検証可能な返答を生成した。', occurredAt,
    }, provisionalIntent ? completion.intentPlan : undefined);
  }
  let uiBlocks: Array<Record<string, unknown>> | undefined;
  if (!temporaryGuest && !uncertainTranscript && taskProposal && !isExplicitVoyagerUpdateRequest(transcript)) {
    if (orchestrationState) {
      orchestrationState = dependencies.conversationOrchestration.save(recordConversationProposal(
        orchestrationState, taskProposal.goal, occurredAt,
      ));
    }
    uiBlocks = [{
      type: 'agent_task_proposal',
      proposalId: orchestrationState?.resumeToken ?? randomUUID(),
      ...(completedIntent ? { cognitiveIntentID: completedIntent.id } : {}),
      ...taskProposal,
    }];
  }
  return {
    status: 200,
    body: {
      threadId,
      model: completion.model,
      reply: reply.trim(),
      webSources: completion.webSources ?? [],
      ...(uiBlocks ? { uiBlocks } : {}),
      voicePlan,
      voiceMetrics: {
        decisionMilliseconds: decision.elapsedMilliseconds,
        contextMilliseconds,
        firstModelTokenMilliseconds,
        modelCompleteMilliseconds,
        turnToModelCompleteMilliseconds: Math.max(0, Math.round(performance.now() - turnStartedAt)),
      },
    },
  };
}

function boundedVoiceHistory(
  history: readonly { role: 'user' | 'assistant'; content: string }[],
  limit: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.slice(-limit).map(item => ({
    role: item.role,
    content: Array.from(item.content.trim().replace(/\s+/gu, ' ')).slice(0, 600).join(''),
  })).filter(item => item.content.length > 0);
}
