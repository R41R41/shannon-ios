import { randomUUID } from 'node:crypto';
import { wantsNearbyPlaces, wantsPlaceDiscovery } from './placeDiscovery.js';
import { combinedPlaceSources, runPlaceDiscoverySkill, spokenPlaceReply } from './placeDiscoverySkill.js';
import {
  assembleShannonSystemPrompt,
  buildExpressiveEmotionPrompt,
  buildIntentPrompt,
  resolveShannonEmotionState,
  selectPrimaryIntent,
  shannonIdentityPrompt,
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
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway, type VoiceTurnDecision } from './voiceDecision.js';
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';
import { withMemorySearchLatency, type TurnMemoryRecall } from './turnMemoryRecall.js';
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

export { voiceConversationInstructions } from './voiceConversationInstructions.js';
import { temporaryGuestVoiceInstructions, voiceConversationInstructions } from './voiceConversationInstructions.js';
import { guestSpeakerReminder, guestTurnPositionInstruction, ownerCompanionPresenceInstructions } from './voiceIntroductionInstructions.js';
import { applyGuestAddressing, guestAddressDecision, guestCallHistory, GUEST_CALL_MODEL_TURNS } from './voiceGuestCall.js';
export type VoiceParticipantMode = 'owner' | 'guest';
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
        shannonIdentityPrompt('guest'),
        voiceConversationInstructions(options.clientDelegation === true, options.brightVoice === true, false),
        temporaryGuestVoiceInstructions,
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
  memoryRecall?: TurnMemoryRecall | null;
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
  // 「友人も一緒」 remembers only this call's own turns, which the device holds and sends each turn.
  const guestCall = temporaryGuest ? deviceContext?.guestCall ?? null : null;
  const guestHistory = guestCallHistory(guestCall);
  const routingHistory = temporaryGuest ? guestHistory
    : visibleConversationHistory(routingState!, dependencies.conversationStore, scopeKey, threadId);
  const rawTranscript = deviceContext?.userUtterance?.rawText ?? transcript;
  // At a shared table Shannon answers when addressed and otherwise stays quiet. Overheard
  // talk is settled by local rules, so it costs no router or reply model call.
  const address = temporaryGuest
    ? guestAddressDecision(transcript, guestCall, deviceContext?.userUtterance?.source) : null;
  const router = address && !address.respond ? new LocalVoiceDecisionGateway() : dependencies.voiceDecision;
  let decision = await router.decide({
    scopeKey, transcript, rawTranscript, participantMode,
    context: boundedVoiceHistory(routingHistory, 4),
    requestedLocation: deviceContext?.requestedLocation ?? false,
    hasFreshLocation: deviceContext?.location !== null && deviceContext?.location !== undefined,
  });
  observer?.signal?.throwIfAborted();
  const uncertainTranscript = transcriptNeedsInterpretation(decision, deviceContext?.userUtterance);
  const confirmedImplementationRequest = temporaryGuest || uncertainTranscript ? null
    : confirmedVoiceImplementationRequest(transcript, routingHistory,
      dependencies.conversationStore.conversationHistory(scopeKey, threadId).slice(-2), occurredAt);
  if (uncertainTranscript && !decision.shouldRespond) {
    decision = { ...decision, shouldRespond: true, conversationClass: 'direct' };
  }
  if (address) decision = applyGuestAddressing(decision, address);
  // A turn that will search memory with a model is at least a >3 s turn, so the existing waiting phrase plays first.
  const semanticMemoryTurn = !temporaryGuest && decision.shouldRespond && dependencies.memoryRecall?.willSearch({
    message: transcript, memoryTurn: decision.selectedSkills.includes('conversation_memory') }) === true;
  if (semanticMemoryTurn) decision = withMemorySearchLatency(decision);
  if (decision.selectedSkills.includes('place_discovery')) decision = withMemorySearchLatency(decision);
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
  observer?.signal?.throwIfAborted();
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
    '[Voice turn grounding]',
    '- The input is a potentially imperfect live Japanese transcript. Use the latest correction and do not invent missing details.',
    '- Your reply is spoken aloud as Shannon herself. State verified facts concisely in her voice; avoid Markdown tables and long URLs.',
    '- This lane is read-only unless an explicit user command has already returned a verified proposal receipt. Do not claim that a purchase, booking, deployment, file write, or other external mutation completed.',
    '- If an external mutation or approval is needed, explain the exact next confirmation instead of performing it.',
    ...(!temporaryGuest ? [
      '- Shannon can propose a Codex implementation task, including adding a new capability or changing Shannon itself. A user starts the visible proposal before code work runs. Never claim this capability is unavailable.',
      '- If an ASR-uncertain request sounds like an implementation request, briefly confirm the intended feature before proposing it. Do not treat uncertain speech as execution authorization.',
      ownerCompanionPresenceInstructions,
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
  const deterministicContext = temporaryGuest ? null : prepareTurnCognitiveContext(
    captured!,
    dependencies.conversationStore,
    { scopeKey, message: transcript, occurredAt, channel: 'voice', threadId,
      intents: dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
      timeZone: deviceContext?.timeZoneIdentifier,
      participants: dependencies.personIdentities?.list(scopeKey).filter(person => person.status === 'active' && transcript.includes(person.displayName)).map(person => person.displayName),
    },
  );
  const complexTurn = decision.conversationClass === 'skill_complex';
  const recalled = deterministicContext && dependencies.memoryRecall
    && (semanticMemoryTurn || complexTurn || decision.selectedSkills.includes('conversation_memory'))
    ? await dependencies.memoryRecall.enrich(deterministicContext, { scopeKey, message: transcript, snapshot: captured!, threadId,
      memoryTurn: semanticMemoryTurn, complexTurn, ...(observer?.signal ? { signal: observer.signal } : {}) }) : null;
  const cognitiveContext = recalled ?? deterministicContext;
  const basePrompt = temporaryGuest
    ? [shannonIdentityPrompt('guest'), voiceConversationInstructions(true, false, false), temporaryGuestVoiceInstructions,
      guestTurnPositionInstruction(guestCall?.introductionStart === true || guestHistory.length === 0)].join('\n\n')
    : [
      // The slim path drops owner state, never the identity: persona, suite roles and capabilities stay.
      selectedSkills.has('conversation_memory')
        ? dependencies.knowledgeStore?.promptProjection(scopeKey) ?? assembleShannonSystemPrompt(captured!)
        : shannonIdentityPrompt('owner'),
      voiceConversationInstructions(true),
    ].join('\n\n');
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
  observer?.signal?.throwIfAborted();
  const includeCognitiveContext = !temporaryGuest && selectedSkills.has('conversation_memory');
  const systemPrompt = [
    basePrompt,
    includeCognitiveContext ? cognitiveContext?.prompt : complexTurn ? recalled?.knowledgePrompt : '',
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
    buildExpressiveEmotionPrompt(provisionalExpressiveEmotion, temporaryGuest ? 'guest' : 'owner'),
    temporaryGuest ? guestSpeakerReminder : '',
    buildConversationOrchestrationPrompt(orchestrationState, dependencies.agentTasks.list(scopeKey)),
    confirmedImplementationRequest
      ? `[Confirmed implementation clarification]\nThe owner's immediately preceding request was: ${confirmedImplementationRequest}\nYour previous reply explicitly asked whether to show an implementation proposal; the owner has now confirmed. Return a concrete taskProposal for that request. The visible proposal card is the start boundary; do not claim code work has begun.`
      : '',
    backendInstructions,
    voiceTranscriptInterpretationPrompt(uncertainTranscript, rawTranscript),
  ].filter(Boolean).join('\n\n');
  const fullHistory = temporaryGuest ? guestHistory
    : visibleConversationHistory(captured!, dependencies.conversationStore, scopeKey, threadId);
  const historyLimit = temporaryGuest ? GUEST_CALL_MODEL_TURNS
    : selectedSkills.has('conversation_memory') || decision.conversationClass === 'skill_complex' ? 8 : 4;
  const placeSkill = selectedSkills.has('place_discovery') || wantsPlaceDiscovery(transcript)
    ? await runPlaceDiscoverySkill(dependencies.chatModel, { scopeKey, message: transcript, context: {
      ...(wantsNearbyPlaces(transcript) && deviceContext?.location ? {
        latitude: deviceContext.location.latitude, longitude: deviceContext.location.longitude,
      } : {}), spoken: true,
    } }) : null;
  observer?.signal?.throwIfAborted();
  const modelRequest = {
    scopeKey,
    systemPrompt: placeSkill ? `${systemPrompt}\n\n${placeSkill.prompt}` : systemPrompt,
    history: boundedVoiceHistory(fullHistory, historyLimit),
    message: transcript,
    useWebSearch: selectedSkills.has('current_web') || !!placeSkill,
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
  const completion = placeSkill || provisionalIntent || requiresStructuredTaskDecision || confirmedImplementationRequest
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
  observer?.signal?.throwIfAborted();
  const modelCompleteMilliseconds = Math.max(0, Math.round(performance.now() - modelStartedAt));
  firstModelTokenMilliseconds ??= modelCompleteMilliseconds;
  const taskProposal = completion.taskProposal ?? (confirmedImplementationRequest ? {
    title: '依頼された機能の実装', goal: confirmedImplementationRequest,
  } : undefined);
  const reply = confirmedImplementationRequest
    ? 'よし、ライ氏。実装提案を画面に出しました。内容を確認して開始すると、作業が始まります。'
    : placeSkill ? spokenPlaceReply(completion.reply) : completion.reply;
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
  if (placeSkill?.places.length) {
    uiBlocks = [{ type: 'place_search', places: placeSkill.places }];
  }
  if (!temporaryGuest && !uncertainTranscript && taskProposal && !isExplicitVoyagerUpdateRequest(transcript)) {
    if (orchestrationState) {
      orchestrationState = dependencies.conversationOrchestration.save(recordConversationProposal(
        orchestrationState, taskProposal.goal, occurredAt,
      ));
    }
    uiBlocks = [...(uiBlocks ?? []), {
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
      webSources: combinedPlaceSources(placeSkill, completion.webSources),
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
