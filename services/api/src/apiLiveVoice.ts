import { randomUUID } from 'node:crypto';
import { wantsNearbyPlaces, wantsPlaceDiscovery } from './placeDiscovery.js';
import { combinedPlaceSources, runPlaceDiscoverySkill, spokenPlaceReply } from './placeDiscoverySkill.js';
import {
  OWNER_AUDIENCE,
  UNKNOWN_GUEST_PRESENCE,
  buildExpressiveEmotionPrompt,
  guardedShannonSeenPrompt,
  isOwnerOnly,
  projectEmotionReaction,
  resolveShannonEmotionState,
  shannonIdentityPrompt,
  type CompanionClock,
  type CompanionStateStore,
  type MemoryAudience,
} from '@shannon/cognition';
import { agentTaskPromptProjection } from './apiPromptProjection.js';
import { badRequest, objectBody, validBoundedString, validScopeKey } from './apiValidation.js';
import type { AgentTaskStore } from './agentTaskStore.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import type { ConversationStore } from './conversationStore.js';
import type { DailyMindReader } from './dailyMind.js';
import { companionIdentityPrompt, identityOnly, type KnowledgeStore } from './knowledgeStore.js';
import type { ShannonChatModel } from './chatModel.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway, type VoiceTurnDecision } from './voiceDecision.js';
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';
import { withMemorySearchLatency, type TurnMemoryRecall } from './turnMemoryRecall.js';
import { visibleConversationHistory } from './memoryVisibility.js';
import { conversationReplay } from './conversationWindow.js';
import { executeConversationCommand, spokenCommandAllowed, type ConversationCommandDependencies } from './conversationCommands.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from './cognitiveIntent.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';
import { NO_CAPABILITY_CONTEXT, conversationCapabilityContext, withCapabilitySources, type ConversationReadCapabilities } from './conversationCapabilities.js';
import { asksAboutNotion } from './notionConversation.js';
import type { PersonIdentityStore } from './personIdentity.js';
import { voicePlanResponse } from './voiceEmotionPlan.js';
import { transcriptNeedsInterpretation, transcriptTrust, voiceTranscriptInterpretationPrompt } from './voiceTranscriptContext.js';
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
import { applyGuestAddressing, boundedVoiceHistory, guestAddressDecision, guestCallHistory, GUEST_CALL_MODEL_TURNS } from './voiceGuestCall.js';
export { realtimeVoiceSessionProjection, type VoiceParticipantMode } from './voiceSessionProjection.js';
import type { VoiceParticipantMode } from './voiceSessionProjection.js';
import { companionPresentInstructions, ownerSaysCompanionPresent, speakTimePrivacyCheck } from './voiceCompanionPresence.js';
import { emotionTiming, feelingBeforeTurn, stillFeltLine } from './companionPresence.js';
import type { PeopleMemory } from './peopleMemory.js';
import { DisclosureGate, sharedDailyFocus } from './memoryDisclosure.js';
import { guestPeoplePrompt } from './peopleMemoryPrompts.js';
import { voiceLookTurn, type VoiceLooks } from './voiceAppLook.js';
import { notHisWordsToHer, ownerVoiceTurnFacts, settleOwnerVoiceTurn } from './voiceSilence.js';
import type { ShannonToolRunner } from './shannonToolRunner.js';
import { conversationTools, toolTraceReader, withToolCapabilityLines, type ConversationToolServer } from './shannonToolSession.js';
import { TurnDeadline, VOICE_TURN_DEADLINE } from './turnDeadline.js';
import { OWNER_IN_CALL_ELSEWHERE_RESPONSE, type OwnerCalls } from './ownerCallElsewhere.js';

interface LiveVoiceDependencies extends ConversationReadCapabilities, ConversationCommandDependencies {
  /** Looking through her body's camera or the app's (`voiceAppLook.ts`); absent, a voice turn never looks. */
  looks?: VoiceLooks;
  personIdentities?: PersonIdentityStore;
  chatModel: ShannonChatModel;
  voiceDecision: VoiceDecisionGateway;
  stateStore: CompanionStateStore;
  conversationStore: ConversationStore;
  knowledgeStore: KnowledgeStore | null;
  dailyMind: DailyMindReader | null;
  /** Her own pursuits and work, and the autonomy wording of the identity block. */
  autonomy?: { pursuitPrompt(scopeKey: string): string; identityProjection(scopeKey: string, prompt: string): string; tools?: ShannonToolRunner };
  agentTasks: AgentTaskStore;
  now: CompanionClock;
  cognitiveIntents: CognitiveIntentStore;
  conversationOrchestration: ConversationOrchestrationStore;
  memoryRecall?: TurnMemoryRecall | null;
  people?: PeopleMemory;
  /** Her line from a touch (`bodyReaction.ts`), named by the first voice turn that answers it. */
  reactions?: { link(scopeKey: string, reactionId: unknown): { text: string; threadId: string | null } | null };
  /** Others present as the server knows them, and what her writes must not repeat; absent, no tool is offered. */
  toolServer?: ConversationToolServer;
  ownerCalls?: Pick<OwnerCalls, 'admitTurn'>; // The owner in a call on another device (`ownerCallElsewhere.ts`); absent, nothing is refused.
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

  if (request.body.reactionId !== undefined && typeof request.body.reactionId !== 'string') return badRequest('reactionId is invalid');
  if (dependencies.ownerCalls?.admitTurn(scopeKey, request.deviceId, participantMode, dependencies.now()) === false) return OWNER_IN_CALL_ELSEWHERE_RESPONSE; // Her body, while he talks with her on one of his apps: refused before anything is read or written.
  // An unknown or expired reaction is not an error: the turn is then an ordinary one.
  const reaction = dependencies.reactions?.link(scopeKey, request.body.reactionId) ?? null;
  const requestedThreadId = typeof request.body.threadId === 'string' ? request.body.threadId.trim()
    : participantMode === 'owner' ? reaction?.threadId ?? undefined : undefined;
  return completeLiveVoiceDelegation(scopeKey, requestedThreadId, request.body.transcript.trim(), participantMode, deviceContext,
    reaction?.text ?? null, { ...dependencies, looks: dependencies.looks?.of(request) }, observer);
}

async function completeLiveVoiceDelegation(
  scopeKey: string,
  requestedThreadId: string | undefined,
  transcript: string,
  participantMode: VoiceParticipantMode,
  deviceContext: VoiceDeviceContext | null,
  reactionLine: string | null,
  dependencies: LiveVoiceDependencies,
  observer?: LiveVoiceStreamObserver,
): Promise<ApiResponse> {
  const turnStartedAt = performance.now();
  const deadline = new TurnDeadline(VOICE_TURN_DEADLINE, () => Date.parse(dependencies.now())); // One deadline for her tools, from arrival.
  const temporaryGuest = participantMode === 'guest';
  const threadId = temporaryGuest
    ? requestedThreadId || 'temporary-guest-session'
    : dependencies.conversationStore.threadId(scopeKey, requestedThreadId);
  const occurredAt = dependencies.now();
  const routingState = dependencies.stateStore.snapshot(scopeKey);
  // 「友人も一緒」 follows this call's own turns, which the device holds and sends each turn.
  const guestCall = temporaryGuest ? deviceContext?.guestCall ?? null : null;
  const guestHistory = guestCallHistory(guestCall);
  // Who can hear the reply decides what every later step may read. Unknown people are never assumed away.
  // In 「友人も一緒」 a person is present only once their name has been said; until then the guest is unknown.
  const guestPresence = temporaryGuest ? dependencies.people?.resolveCall(scopeKey, {
    transcript, turns: guestCall?.turns ?? [], ...(guestCall?.callId ? { callId: guestCall.callId } : {}),
    ...(requestedThreadId ? { threadId: requestedThreadId } : {}) }, occurredAt) ?? null : null;
  const present: MemoryAudience = temporaryGuest ? guestPresence?.present ?? UNKNOWN_GUEST_PRESENCE
    : deviceContext?.companionPresent === true || ownerSaysCompanionPresent(transcript) ? UNKNOWN_GUEST_PRESENCE : OWNER_AUDIENCE;
  const alone = isOwnerOnly(present);
  if (!alone) dependencies.toolServer?.audience.noteOthers(scopeKey);
  // A client that predates people memory tells the friend that no owner memory is used; keep that promise for it.
  const legacyGuest = temporaryGuest && guestPresence?.recorded !== true;
  const routingHistory = temporaryGuest ? guestHistory
    : visibleConversationHistory(routingState, dependencies.conversationStore, scopeKey, threadId, present);
  const rawTranscript = deviceContext?.userUtterance?.rawText ?? transcript;
  // At a shared table Shannon answers when addressed and otherwise stays quiet. Overheard
  // talk is settled by local rules, so it costs no router or reply model call.
  const address = temporaryGuest
    ? guestAddressDecision(transcript, guestCall, deviceContext?.userUtterance?.source) : null;
  const router = address && !address.respond ? new LocalVoiceDecisionGateway() : dependencies.voiceDecision;
  // Owner call: what the moment looks like, for deciding whether she should speak at all (voiceSilence.ts).
  // The turn in which he says that someone is with him is said to her; from the next one on she must be addressed.
  const turnFacts = temporaryGuest ? undefined : ownerVoiceTurnFacts({ history: routingHistory, at: occurredAt, othersPresent: !alone && !ownerSaysCompanionPresent(transcript),
    newest: dependencies.conversationStore.conversationHistory(scopeKey, threadId).at(-1), source: deviceContext?.userUtterance?.source, answersHer: reactionLine });
  let decision = await router.decide({
    // In a remembered 「友人も一緒」 call the same capabilities may be chosen as with the owner; what is said is checked at speak time.
    scopeKey, transcript, rawTranscript, participantMode: legacyGuest ? 'guest' : 'owner',
    context: boundedVoiceHistory(routingHistory, 4), ...(turnFacts ? { turn: turnFacts } : {}),
    requestedLocation: deviceContext?.requestedLocation ?? false,
    hasFreshLocation: deviceContext?.location !== null && deviceContext?.location !== undefined, ...dependencies.looks?.routing,
  });
  observer?.signal?.throwIfAborted();
  const uncertainTranscript = transcriptNeedsInterpretation(decision, deviceContext?.userUtterance);
  const confirmedImplementationRequest = !alone || uncertainTranscript ? null
    : confirmedVoiceImplementationRequest(transcript, routingHistory,
      dependencies.conversationStore.conversationHistory(scopeKey, threadId).slice(-2), occurredAt);
  decision = settleOwnerVoiceTurn(decision, { transcript, facts: turnFacts, uncertain: uncertainTranscript });
  if (address) decision = applyGuestAddressing(decision, address);
  // One look at the room: the same conditions as a text turn, chosen by the gateway or asked for in so many words (voiceRoomLook.ts).
  // Judged at this instant, not at the turn's start: the body may have read presence while the router decided.
  const roomLook = voiceLookTurn(dependencies.looks, { scopeKey, transcript, at: dependencies.now(), threadId, turnId: deviceContext?.userUtterance?.id, guest: temporaryGuest, source: deviceContext?.userUtterance?.source,
    audience: alone && !temporaryGuest ? 'owner' : 'others', decision, uncertain: uncertainTranscript });
  // A turn that will search memory with a model is at least a >3 s turn, so the existing waiting phrase plays first.
  const semanticMemoryTurn = !legacyGuest && decision.shouldRespond && dependencies.memoryRecall?.willSearch({
    message: transcript, memoryTurn: decision.selectedSkills.includes('conversation_memory') }) === true;
  if (semanticMemoryTurn) decision = withMemorySearchLatency(decision);
  if (decision.selectedSkills.includes('place_discovery')) decision = withMemorySearchLatency(decision);
  // Notion is the owner's private material: read only when he is alone, by a fixed rule on his words.
  const notionTurn = alone && !temporaryGuest && decision.shouldRespond && asksAboutNotion(transcript);
  if (notionTurn && dependencies.notion?.connected) decision = withMemorySearchLatency(decision);
  // A turn that was not his words to her (overheard, an echo, a fragment) writes no orchestration state and runs no command.
  let orchestrationState = !alone || uncertainTranscript || notHisWordsToHer(decision) ? null : observeConversationTurn({
    previous: dependencies.conversationOrchestration.read(scopeKey, threadId),
    scopeKey, threadId, message: transcript, occurredAt, participantMode,
    tasks: dependencies.agentTasks.list(scopeKey),
  });
  if (orchestrationState) orchestrationState = dependencies.conversationOrchestration.save(orchestrationState);
  // Commands that act (tasks, notes, remember, forget, promises) run only for the owner alone, on words that can be trusted.
  const command = alone && spokenCommandAllowed(transcriptTrust(decision, deviceContext?.userUtterance), scopeKey, threadId, deviceContext?.userUtterance, occurredAt, dependencies.conversationStore) && !notHisWordsToHer(decision) && deviceContext?.userUtterance
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
  const emotionState = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const previousExpressiveEmotion = emotionState ? feelingBeforeTurn(emotionState, occurredAt) : undefined;
  const voiceMood = emotionState ? projectEmotionReaction(emotionState, transcript, emotionTiming()) : undefined;
  const provisionalExpressiveEmotion = resolveShannonEmotionState({
    previous: previousExpressiveEmotion,
    provisionalPrimary: decision.affect,
    provisionalIntensity: decision.affectIntensity,
    transcript,
    now: occurredAt,
    target: temporaryGuest ? '現在の話者' : 'ライ氏',
  });
  let expressiveEmotion = provisionalExpressiveEmotion;
  let voicePlan = voicePlanResponse(decision, expressiveEmotion, voiceMood, { ownerAlone: alone && !temporaryGuest });
  await observer?.onPlan(voicePlan);
  observer?.signal?.throwIfAborted();
  if (!decision.shouldRespond) {
    return {
      status: 200,
      body: {
        threadId,
        model: dependencies.chatModel.model,
        reply: '',
        webSources: [], ...(!temporaryGuest && !alone ? { companionPresent: true } : {}),
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
      alone ? ownerCompanionPresenceInstructions : companionPresentInstructions,
    ] : []),
    ...(!alone && !legacyGuest ? [speakTimePrivacyCheck] : []),
    ...(selectedSkills.has('current_web') ? [
      '- For transit, search current operator or route sources. Ask for a missing origin or destination. Give no exact departure, arrival, fare, or disruption claim without a current source; distinguish timetable from live operating status.',
      '- For local recommendations, use the one-time GPS only if present, check current opening hours and weather on the web, and mention uncertainty briefly.',
    ] : []),
    ...(selectedSkills.has('device_context') || selectedSkills.has('current_web')
      ? [voiceDeviceContextPrompt(dependencies.now(), deviceContext)] : []),
  ].join('\n');
  // Refresh after the classifier await so a concurrent forget/hide is respected.
  const captured = dependencies.stateStore.snapshot(scopeKey);
  // A goal is the owner's own; with anyone else present the words may not be his.
  const provisionalIntent = !alone || uncertainTranscript ? null : extractExplicitUserIntent(transcript, threadId, occurredAt);
  // Every mode builds its memory through the same gate; `present` decides what passes.
  // While a name is unresolved between two remembered people, nothing about anyone is recalled.
  const peopleRecall = guestPresence?.ambiguousName ? undefined : dependencies.people?.recall(scopeKey, captured, transcript, present);
  const deterministicContext = prepareTurnCognitiveContext(
    captured,
    dependencies.conversationStore,
    { scopeKey, message: transcript, occurredAt, channel: 'voice', threadId, present,
      intents: legacyGuest ? [] : dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
      timeZone: deviceContext?.timeZoneIdentifier, additionalCandidates: peopleRecall?.candidates ?? [],
      participants: temporaryGuest ? [] : dependencies.personIdentities?.list(scopeKey).filter(person => person.status === 'active' && transcript.includes(person.displayName)).map(person => person.displayName),
    },
  );
  const complexTurn = decision.conversationClass === 'skill_complex';
  const recalled = !legacyGuest && dependencies.memoryRecall
    && (semanticMemoryTurn || complexTurn || decision.selectedSkills.includes('conversation_memory'))
    ? await dependencies.memoryRecall.enrich(deterministicContext, { scopeKey, message: transcript, snapshot: captured, threadId,
      memoryTurn: semanticMemoryTurn, complexTurn, ...(observer?.signal ? { signal: observer.signal } : {}) }) : null;
  const cognitiveContext = recalled ?? deterministicContext;
  // Fixed first, what changes last (`ShannonPromptLayers`): her profile follows the fixed blocks, the state opens the turn's context.
  // The slim path drops owner state, never the identity: persona, suite roles and capabilities stay.
  // The full profile block is for the owner alone; otherwise the disclosed block in the turn context stands in.
  const identity = temporaryGuest ? identityOnly(shannonIdentityPrompt('guest')) : selectedSkills.has('conversation_memory') && alone
    ? dependencies.knowledgeStore?.promptProjectionParts(scopeKey) ?? companionIdentityPrompt(captured) : identityOnly(shannonIdentityPrompt('owner'));
  const basePrompt = temporaryGuest
    ? [identity.identity, voiceConversationInstructions(true, false, false), temporaryGuestVoiceInstructions].join('\n\n')
    : [dependencies.autonomy?.identityProjection(scopeKey, identity.identity) ?? identity.identity, voiceConversationInstructions(true)].join('\n\n');
  // Today's focus is built from the owner's interests, which carry no label: it is marked when others can hear.
  const focus = legacyGuest || !selectedSkills.has('daily_mind') ? '' : dependencies.dailyMind?.promptFor(scopeKey, dependencies.now()) ?? '';
  const focusGate = new DisclosureGate(present, captured, dependencies.conversationStore, scopeKey);
  const dailyMindPrompt = sharedDailyFocus(focusGate, focus);
  // Agent work, notes and tasks keep their bounded projections; the speak-time check says how far to go aloud.
  const taskPrompt = legacyGuest || !selectedSkills.has('agent_status')
    ? ''
    : agentTaskPromptProjection(dependencies.agentTasks.list(scopeKey), threadId);
  const capability = legacyGuest
    ? NO_CAPABILITY_CONTEXT
    : await conversationCapabilityContext(scopeKey, transcript, dependencies, {
      aetherNotes: selectedSkills.has('aether_notes'),
      voyagerTasks: selectedSkills.has('voyager_tasks'),
      notion: notionTurn, upcoming: temporaryGuest ? false : alone ? true : 'guarded',
    });
  const capabilityPrompt = capability.prompt;
  observer?.signal?.throwIfAborted();
  // A client that predates people memory tells the friend that no owner memory is used; keep that promise for it.
  const includeCognitiveContext = temporaryGuest ? !legacyGuest : selectedSkills.has('conversation_memory');
  const turnContext = [
    temporaryGuest ? guestTurnPositionInstruction(guestCall?.introductionStart === true || guestHistory.length === 0) : '', identity.state,
    includeCognitiveContext ? cognitiveContext.prompt : [complexTurn ? recalled?.knowledgePrompt : '', legacyGuest ? '' : cognitiveContext.impressionPrompt].filter(Boolean).join('\n\n'),
    // Alone: 「誰と何を話した？」 with provenance. 友人も一緒: who is here and what she remembers of them.
    guestPresence ? guestPeoplePrompt({ ...guestPresence, items: peopleRecall?.items ?? [] }) : peopleRecall?.prompt,
    dailyMindPrompt,
    // What she is doing in her own time: only when the owner is alone with her. With someone listening beside the owner,
    // only what she saw of the room stays, marked for the speak-time check. A friend's own call gets nothing.
    temporaryGuest ? '' : alone ? dependencies.autonomy?.pursuitPrompt(scopeKey)
      : guardedShannonSeenPrompt(dependencies.autonomy?.pursuitPrompt(scopeKey) ?? '', focusGate.unlabelledMarker),
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
    buildExpressiveEmotionPrompt(provisionalExpressiveEmotion, temporaryGuest ? 'guest' : alone ? 'owner' : 'others'),
    alone && emotionState && !includeCognitiveContext ? stillFeltLine(emotionState, occurredAt) : '',
    temporaryGuest ? guestSpeakerReminder : '',
    buildConversationOrchestrationPrompt(orchestrationState, dependencies.agentTasks.list(scopeKey)),
    confirmedImplementationRequest
      ? `[Confirmed implementation clarification]\nThe owner's immediately preceding request was: ${confirmedImplementationRequest}\nYour previous reply explicitly asked whether to show an implementation proposal; the owner has now confirmed. Return a concrete taskProposal for that request. The visible proposal card is the start boundary; do not claim code work has begun.`
      : '',
    backendInstructions, roomLook.prompt,
    voiceTranscriptInterpretationPrompt(uncertainTranscript, rawTranscript),
  ].filter(Boolean).join('\n\n');
  // The owner's thread is replayed by character budget, with the replay summary for what fell out of it;
  // a 「友人も一緒」 call keeps its own in-call turns and never sees the owner's thread.
  const replay = temporaryGuest ? null
    : conversationReplay('voice', captured, dependencies.conversationStore, scopeKey, threadId, present, undefined, toolTraceReader(dependencies.toolServer, scopeKey));
  const placeSkill = selectedSkills.has('place_discovery') || wantsPlaceDiscovery(transcript)
    ? await runPlaceDiscoverySkill(dependencies.chatModel, { scopeKey, message: transcript, context: {
      ...(wantsNearbyPlaces(transcript) && deviceContext?.location ? {
        latitude: deviceContext.location.latitude, longitude: deviceContext.location.longitude,
      } : {}), spoken: true,
    } }) : null;
  observer?.signal?.throwIfAborted();
  const turnPrompt = [turnContext, placeSkill?.prompt ?? ''].filter(Boolean).join('\n\n');
  const replayed = replay?.request(turnPrompt) ?? { ...(turnPrompt ? { turnContext: turnPrompt } : {}), history: boundedVoiceHistory(guestHistory, GUEST_CALL_MODEL_TURNS) };
  const modelRequest = withToolCapabilityLines({ // Her Minecraft body's and Aether's lines, in her identity, exactly when their tools are offered.
    scopeKey, systemPrompt: basePrompt, ...(identity.profile ? { profilePrompt: identity.profile } : {}), ...replayed,
    // What she said when she was touched is what he is answering: it directly precedes his words, in every mode, as context only.
    ...(reactionLine ? { precedingReply: reactionLine } : {}),
    message: transcript, ...conversationTools(dependencies.autonomy, scopeKey, 'voice',
      // 「友人も一緒」: her Aether reading tools (owner decision 2026-10-06); a client that predates people memory, none.
      temporaryGuest ? !legacyGuest && 'guests' : alone || 'others', dependencies.toolServer ?? {}, `${threadId}\n${transcript}`, deadline,
      { trust: transcriptTrust(decision, deviceContext?.userUtterance), ...(deviceContext?.userUtterance?.id ? { utteranceId: deviceContext.userUtterance.id } : {}) }),
    useWebSearch: selectedSkills.has('current_web') || !!placeSkill,
    conversationClass: decision.conversationClass === 'no_response' ? 'direct' as const : decision.conversationClass,
  });
  const modelStartedAt = performance.now();
  const contextMilliseconds = Math.max(0, Math.round(modelStartedAt - contextStartedAt));
  let firstModelTokenMilliseconds: number | undefined;
  let streamedReplyPrefix = '';
  observer?.signal?.addEventListener('abort', () => roomLook.cutOff(threadId, streamedReplyPrefix), { once: true });
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
            voicePlan = voicePlanResponse(decision, expressiveEmotion, voiceMood, { ownerAlone: alone && !temporaryGuest });
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
  // Opens the look only if this turn chose one, she said so herself, and its conditions still hold.
  if (!confirmedImplementationRequest) roomLook.open(threadId, reply);
  expressiveEmotion = resolveShannonEmotionState({
    previous: previousExpressiveEmotion,
    provisionalPrimary: decision.affect,
    provisionalIntensity: decision.affectIntensity,
    transcript,
    reply,
    now: occurredAt,
    target: temporaryGuest ? '現在の話者' : 'ライ氏',
  });
  voicePlan = voicePlanResponse(decision, expressiveEmotion, voiceMood, { ownerAlone: alone && !temporaryGuest });
  // Her stored feeling toward the owner moves only on his own words.
  if (alone) {
    dependencies.stateStore.apply(scopeKey, {
      type: 'expressive-emotion-updated',
      emotion: expressiveEmotion,
    });
  }
  let completedIntent = provisionalIntent;
  if (!temporaryGuest) {
    completedIntent = recordCompletedCognitiveCycle(dependencies.cognitiveIntents, scopeKey, cognitiveContext.frame, provisionalIntent, undefined, {
      threadId, channel: 'voice', action: 'delegate', summary: 'ライブ音声からバックエンドへ委譲し、検証可能な返答を生成した。', occurredAt,
    }, provisionalIntent ? completion.intentPlan : undefined);
  }
  let uiBlocks: Array<Record<string, unknown>> | undefined;
  if (placeSkill?.places.length) {
    uiBlocks = [{ type: 'place_search', places: placeSkill.places }];
  }
  if (alone && !uncertainTranscript && taskProposal && !isExplicitVoyagerUpdateRequest(transcript)) {
    if (orchestrationState) {
      orchestrationState = dependencies.conversationOrchestration.save(recordConversationProposal(
        orchestrationState, taskProposal.goal, occurredAt, dependencies.agentTasks.list(scopeKey),
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
      webSources: combinedPlaceSources(placeSkill, withCapabilitySources(completion, capability).webSources),
      ...(uiBlocks ? { uiBlocks } : {}), ...roomLook.ask(), ...(completion.truncated ? { truncated: true } : {}),
      // Tells the iPhone to keep marking this call's owner turns as "someone else may be listening".
      ...(!temporaryGuest && !alone ? { companionPresent: true } : {}),
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
