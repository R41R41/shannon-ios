import { randomUUID } from 'node:crypto';
import { placeReply, wantsNearbyPlaces, wantsPlaceDiscovery } from '../../integrations/places/placeDiscovery.js';
import { combinedPlaceSources, runPlaceDiscoverySkill, spokenPlaceReply } from '../../integrations/places/placeDiscoverySkill.js';
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
import { agentTaskPromptProjection } from '../../mind/action/respond/apiPromptProjection.js';
import { badRequest, objectBody, validBoundedString, validScopeKey } from '../../infra/http/apiValidation.js';
import type { AgentTaskStore } from '../../mind/action/agentTasks/agentTaskStore.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { DailyMindReader } from '../../mind/action/respond/dailyMind.js';
import { type KnowledgeStore } from '../../mind/memory/memoryPorts.js';
import { companionIdentityPrompt, identityOnly } from '../../mind/memory/identityPrompt.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway, type VoiceTurnDecision } from '../../mind/selectors/voiceDecision.js';
import { prepareTurnCognitiveContext } from '../../mind/workspace/turnCognitiveContext.js';
import { withMemorySearchLatency, type TurnMemoryRecall } from '../../mind/recall/turnMemoryRecall.js';
import { visibleConversationHistory } from '../../mind/memory/memoryVisibility.js';
import { conversationReplay } from '../../mind/recall/conversationWindow.js';
import { executeConversationCommand, spokenCommandAllowed, type ConversationCommandDependencies } from '../../mind/action/respond/conversationCommands.js';
import { extractExplicitUserIntent, type CognitiveIntentStore } from '../../mind/action/respond/cognitiveIntent.js';
import { recordCompletedCognitiveCycle } from '../../mind/action/respond/cognitiveCycle.js';
import { NO_CAPABILITY_CONTEXT, conversationCapabilityContext, withCapabilitySources, type ConversationReadCapabilities } from '../../mind/action/respond/conversationCapabilities.js';
import { asksAboutNotion } from '../../integrations/notion/notionConversation.js';
import type { PersonIdentityStore } from '../../mind/memory/memoryPorts.js';
import { transcriptNeedsInterpretation, transcriptTrust, voiceTranscriptInterpretationPrompt } from './voiceTranscriptContext.js';
import { commandOnce } from './voiceContinuation.js';
import {
  buildConversationOrchestrationPrompt,
  confirmedVoiceImplementationRequest,
  observeConversationTurn,
  recordConversationProposal,
  recordConversationReceipt,
  type ConversationOrchestrationStore,
  settleVoiceTaskDecision, voiceTurnSetsImplementation,
} from '../../mind/action/respond/conversationOrchestration.js';
import { isExplicitVoyagerUpdateRequest } from '../../integrations/voyager/organize.js';
import { validatedVoiceDeviceContext, type VoiceDeviceContext } from './voiceDeviceContext.js';
export { voiceConversationInstructions } from './voiceConversationInstructions.js';
import { spokenReplyLines, temporaryGuestVoiceInstructions, voiceConversationInstructions } from './voiceConversationInstructions.js';
import { guestSpeakerReminder, guestTurnPositionInstruction } from './voiceIntroductionInstructions.js';
import { applyGuestAddressing, boundedVoiceHistory, guestAddressDecision, guestCallHistory, GUEST_CALL_MODEL_TURNS } from './voiceGuestCall.js';
export { realtimeVoiceSessionProjection, type VoiceParticipantMode } from './voiceSessionProjection.js';
import type { VoiceParticipantMode } from './voiceSessionProjection.js';
import { ownerSaysCompanionPresent } from '../../mind/perception/voiceCompanionPresence.js';
import { emotionTiming, feelingBeforeTurn, innerNoteVoice, stillFeltLine, type InnerNotePort } from '../../mind/emotion/companionPresence.js';
import type { PeopleMemory } from '../../mind/memory/peopleMemory.js';
import { DisclosureGate, sharedDailyFocus } from '../../mind/inhibition/memoryDisclosure.js';
import { guestPeoplePrompt } from '../../mind/memory/peopleMemoryPrompts.js';
import { voiceLookTurn, type VoiceLooks } from './voiceAppLook.js';
import { perceptionOrActionRequest } from './voiceRecallScope.js';
import { notHisWordsToHer, ownerVoiceTurnFacts, settleOwnerVoiceTurn } from '../../mind/attention/voiceSilence.js';
import type { ShannonToolRunner } from '../../mind/tools/shannonToolRunner.js';
import { conversationTools, ownerAloneReads, skillProfilePrompt, toolTraceReader, turnToolResults, turnWroteHerOwnThings, weatherToolAvailable, withToolCapabilityLines, type ConversationToolServer, type SkillTurnPorts, type ToolMenuChooser } from '../../mind/tools/shannonToolSession.js';
import { startVoiceStage2, voiceFinished, voiceOfferAndTier } from './voiceStage2.js';
import { withStage5Capabilities, type ShannonStage5Capabilities } from '@shannon/cognition';
import type { FeedbackPorts } from '../../contracts/feedbackContract.js';
import { voiceCommandResponse, voiceTurnGrounding } from './voiceGrounding.js';
import { TurnDeadline, VOICE_TURN_DEADLINE } from '../../mind/action/respond/turnDeadline.js';
import { tierRequest, type TurnRouting } from '../../mind/action/respond/turnRouting.js';
import { OWNER_IN_CALL_ELSEWHERE_RESPONSE, type OwnerCalls } from '../../mind/perception/ownerCallElsewhere.js';
import { withWorkspace, type MindTurnPorts } from '../../mind/workspace/workspacePorts.js';
import { observeAsync, observeSync, observerHandoff, withObserverRun } from '../../infra/observer/observerContext.js';
import { conversationFcaProvenance, observeFcaConversation } from '../../mind/action/fca/fcaConversationPorts.js';
import type { FcaVoicePort } from '../../mind/action/fca/fcaVoicePorts.js';
import { confirmedFcaVoiceInput, stageFcaVoice, voiceFcaChooser, voiceFcaDuplicate } from './fcaVoiceContext.js';
import { perceiveVoiceTurn, visibleVoiceResponse, voiceObservationOptions, voicePlanner, voiceWorkspace } from './voiceObservation.js';
import { admittedWorkContext, admitVoiceResearch, researchAfterAck, researchSaid, voiceTurnClock, type AckStream } from './voiceResearchTurn.js';
import { finishTurnTiming, TurnTiming, turnStages, turnTimingId } from '../../infra/observer/turnTiming.js';
import { plainVoiceHint, conversationHintMenu, PLAIN_VOICE_HINT, webForWeather, followUp } from './voiceConversationHint.js';
interface LiveVoiceDependencies extends ConversationReadCapabilities, ConversationCommandDependencies {
  /** Looking through her body's camera or the app's (`voiceAppLook.ts`); absent, a voice turn never looks. */
  looks?: VoiceLooks; innerNote?: InnerNotePort; // Syzygy ADR-0012 (SHANNON_INNER_NOTE): her inner note; absent, every prompt as before.
  personIdentities?: PersonIdentityStore;
  chatModel: ShannonChatModel; auxiliaryChatModel?: ShannonChatModel;
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
  reactions?: { link(scopeKey: string, reactionId: unknown): { text: string; threadId: string | null } | null; // Her line from a touch, for the turn
    voiceTouchContext?: import('../../contracts/bodyReactionContract.js').VoiceTouchContext }; // and what a turn is told of her body.
  /** Others present as the server knows them, and what her writes must not repeat; absent, no tool is offered. */
  toolServer?: ConversationToolServer;
  ownerCalls?: Pick<OwnerCalls, 'admitTurn'>; // The owner in a call on another device (`ownerCallElsewhere.ts`); absent, nothing is refused.
  turnChooser?: ToolMenuChooser; toolHints?: true; turnRouting?: TurnRouting; skills?: Pick<SkillTurnPorts, 'index'>; feedback?: FeedbackPorts; stage5Capabilities?: ShannonStage5Capabilities;
  /** Syzygy ADR-0008 stage 3: what the turn hands the mind (`voicePerception` copies `present`); absent, nothing is perceived. */
  mind?: MindTurnPorts;
  fcaVoice?: () => FcaVoicePort | null; deviceId?: string;
}
export interface LiveVoiceStreamObserver extends Pick<AckStream, 'flushSpoken'> {
  readonly signal?: AbortSignal;
  readonly timing?: TurnTiming; // The stream's own timing line (`turnTiming.ts`); absent, the delegation writes one itself.
  onPlan(plan: Record<string, unknown>): void | Promise<void>;
  onTextDelta(delta: string): void | Promise<void>;
  /** Whether the plan's waiting phrase has been heard yet (the stream route says it only after a silence); absent, it was said with the plan. */
  waitingSaid?(): boolean;
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
  const transcript=request.body.transcript.trim();
  const chatModel = dependencies.chatModel.forTurn?.(scopeKey) ?? dependencies.chatModel;
  const timing = observer?.timing ?? new TurnTiming('voice', turnTimingId(deviceContext?.userUtterance?.id)); // A stream writes its own line.
  timing.note('trigger', deviceContext?.userUtterance?.trigger ?? ''); // What opened the microphone (`wake`): a closed code or nothing.
  const complete=()=>completeLiveVoiceDelegation(scopeKey, requestedThreadId, transcript, participantMode, deviceContext,
    reaction?.text ?? null, { ...dependencies, chatModel, deviceId: request.deviceId, looks: dependencies.looks?.of(request) }, observer, timing);
  return finishTurnTiming(withObserverRun(voiceObservationOptions(scopeKey, { transcript, participantMode, deviceContext }),
  () => dependencies.mind?.foreground ? dependencies.mind.foreground(scopeKey,complete) : complete()), observer?.timing ? null : timing);
}
async function completeLiveVoiceDelegation(
  scopeKey: string,
  requestedThreadId: string | undefined,
  transcript: string,
  participantMode: VoiceParticipantMode,
  deviceContext: VoiceDeviceContext | null,
  reactionLine: string | null,
  dependencies: LiveVoiceDependencies,
  observer: LiveVoiceStreamObserver | undefined,
  timing: TurnTiming,
): Promise<ApiResponse> {
  timing.mark('admit'); // Waiting behind the scope's earlier turn, and the respond admission.
  const bounded = turnStages('voice', timing); // Every input before the model call is bounded (`TURN_STAGE_BOUNDS`).
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
  const fca = !temporaryGuest && alone ? dependencies.fcaVoice?.() : null;
  const fcaInput = confirmedFcaVoiceInput(scopeKey, threadId, dependencies.deviceId, deviceContext?.userUtterance, transcript);
  const duplicate = voiceFcaDuplicate(fca, fcaInput); if (duplicate) return duplicate;
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
  const localRules = new LocalVoiceDecisionGateway(); // Also what decides when the router is past its bound.
  const router = address && !address.respond ? localRules : dependencies.voiceDecision;
  // Owner call: what the moment looks like, for deciding whether she should speak at all (voiceSilence.ts).
  // The turn in which he says that someone is with him is said to her; from the next one on she must be addressed.
  const turnFacts = temporaryGuest ? undefined : ownerVoiceTurnFacts({ history: routingHistory, at: occurredAt, othersPresent: !alone && !ownerSaysCompanionPresent(transcript),
    newest: dependencies.conversationStore.conversationHistory(scopeKey, threadId).at(-1), source: deviceContext?.userUtterance?.source, answersHer: reactionLine });
  const { toolAudience, choices } = startVoiceStage2(router === dependencies.voiceDecision ? voiceFcaChooser(dependencies.turnChooser, Boolean(fca && fcaInput)) : null, { autonomy: dependencies.autonomy, server: dependencies.toolServer ?? {}, scopeKey, threadId, transcript, guest: temporaryGuest, legacyGuest, alone });
  const routeInput = {
    // In a remembered 「友人も一緒」 call the same capabilities may be chosen as with the owner; what is said is checked at speak time.
    scopeKey, transcript, rawTranscript, participantMode: legacyGuest ? 'guest' as const : 'owner' as const,
    context: boundedVoiceHistory(routingHistory, 4), ...(turnFacts ? { turn: turnFacts } : {}),
    requestedLocation: deviceContext?.requestedLocation ?? false,
    ...innerNoteVoice.route(dependencies.innerNote, scopeKey, alone && !temporaryGuest, occurredAt), // ADR-0012: voice_route.v3 sees her.
    hasFreshLocation: deviceContext?.location !== null && deviceContext?.location !== undefined, ...dependencies.looks?.routing,
  };
  let decision = await timing.measure('route', () => bounded('route_timeout', router.decide(routeInput), () => localRules.decide(routeInput)));
  observer?.signal?.throwIfAborted();
  // Words trusted to act (commands, writes, goals; the client's confidence only lowers it) or to talk, look and run FCA.
  const uncertainTranscript = transcriptNeedsInterpretation(decision, deviceContext?.userUtterance),
    unclearTranscript = transcriptNeedsInterpretation(decision, deviceContext?.userUtterance, 'converse');
  const confirmedImplementationRequest = !alone || uncertainTranscript ? null
    : confirmedVoiceImplementationRequest(transcript, routingHistory,
      dependencies.conversationStore.conversationHistory(scopeKey, threadId).slice(-2), occurredAt);
  decision = settleOwnerVoiceTurn(decision, { transcript, facts: turnFacts, uncertain: uncertainTranscript });
  if (address) decision = applyGuestAddressing(decision, address);
  // Stage 3: the turn as the mind perceives it, with the audience decided above, copied (nothing without the wiring); once the
  // router has heard it, so that a transcript it scored uncertain, or words not his to her (an echo, overheard), are not taken as his
  // (stage 3 review). A transcript with no score (an old client, the router's fallback) keeps the handling it had.
  const perceivedTurn = perceiveVoiceTurn(dependencies.mind, scopeKey, { threadId, transcript, present, alone, guest: temporaryGuest,
    unverified: transcriptTrust(decision, deviceContext?.userUtterance) === 'uncertain' || notHisWordsToHer(decision), at: occurredAt });
  // One look at the room: the same conditions as a text turn, chosen by the gateway or asked for in so many words (voiceRoomLook.ts).
  // Judged at this instant, not at the turn's start: the body may have read presence while the router decided.
  const roomLook = voiceLookTurn(dependencies.looks, { scopeKey, transcript, at: dependencies.now(), threadId, turnId: deviceContext?.userUtterance?.id, guest: temporaryGuest, source: deviceContext?.userUtterance?.source,
    audience: alone && !temporaryGuest ? 'owner' : 'others', decision, uncertain: unclearTranscript });
  // A turn that will search memory with a model is at least a >3 s turn (her memory gets no waiting phrase: `voiceWaitingCue.ts`).
  const semanticMemoryTurn = !legacyGuest && decision.shouldRespond && dependencies.memoryRecall?.willSearch({
    message: transcript, memoryTurn: decision.selectedSkills.includes('conversation_memory') && !perceptionOrActionRequest(transcript) }) === true;
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
    ? commandOnce(dependencies.conversationStore, scopeKey, deviceContext.userUtterance, occurredAt, () => executeConversationCommand(scopeKey, threadId,
      deviceContext.userUtterance!, occurredAt, { ...dependencies, agentTasks: dependencies.agentTasks })) // Once for words sent again (`continues`).
    : null;
  if (command) {
    if (orchestrationState && command.receipt) orchestrationState = dependencies.conversationOrchestration.save(recordConversationReceipt(orchestrationState, command.receipt));
    return visibleVoiceResponse(() => voiceCommandResponse(dependencies, { scopeKey, threadId, transcript, deviceContext, occurredAt, present, command }));
  }
  const emotionState = temporaryGuest ? null : dependencies.stateStore.snapshot(scopeKey);
  const previousExpressiveEmotion = emotionState ? feelingBeforeTurn(emotionState, occurredAt) : undefined;
  const voiceMood = emotionState ? projectEmotionReaction(emotionState, transcript, emotionTiming()) : undefined;
  // Her feeling for this turn, from his words and, once there is one, her reply (the decision is final from here on).
  const emotionWith = (reply?: string) => resolveShannonEmotionState({ previous: previousExpressiveEmotion, provisionalPrimary: decision.affect,
    provisionalIntensity: decision.affectIntensity, transcript, ...(reply === undefined ? {} : { reply }), now: occurredAt,
    target: temporaryGuest ? '現在の話者' : 'ライ氏' });
  const provisionalExpressiveEmotion = emotionWith();
  let expressiveEmotion = provisionalExpressiveEmotion;
  // Its timing line is noted too (`silence`, `chars`).
  const planFor = innerNoteVoice.planner(voicePlanner(decision, voiceMood, { ownerAlone: alone && !temporaryGuest, transcript, timing,
    trigger: deviceContext?.userUtterance?.trigger }), dependencies.innerNote, scopeKey, occurredAt, alone && !temporaryGuest); // ADR-0012 D5.2
  let voicePlan = planFor(expressiveEmotion);
  await observer?.onPlan(voicePlan);
  const waitingSaid = String(voicePlan.waitingPhrase ?? '').trim() ? { waitingSaid: observer?.waitingSaid?.bind(observer) ?? true as const } : {};
  observer?.signal?.throwIfAborted();
  if (!decision.shouldRespond) {
    return visibleVoiceResponse(() => ({ status: 200, body: { threadId, model: dependencies.chatModel.model, reply: '', webSources: [],
      ...(!temporaryGuest && !alone ? { companionPresent: true } : {}), voicePlan } }));
  }
  const contextStartedAt = performance.now();
  const selectedSkills = webForWeather(new Set(decision.selectedSkills), weatherToolAvailable(dependencies.autonomy, scopeKey, alone && !temporaryGuest));
  const backendInstructions = voiceTurnGrounding({ temporaryGuest, alone, legacyGuest, selectedSkills, at: dependencies.now(), deviceContext });
  // Refresh after the classifier await so a concurrent forget/hide is respected.
  const captured = dependencies.stateStore.snapshot(scopeKey);
  // A goal is the owner's own; with anyone else present the words may not be his.
  const provisionalIntent = !alone || uncertainTranscript ? null : extractExplicitUserIntent(transcript, threadId, occurredAt);
  // Every mode builds its memory through the same gate; `present` decides what passes.
  // While a name is unresolved between two remembered people, nothing about anyone is recalled.
  const peopleRecall = guestPresence?.ambiguousName ? undefined : dependencies.people?.recall(scopeKey, captured, transcript, present);
  const recallStartedAt = performance.now();
  const deterministicContext = observeSync('recall', { strategy: 'deterministic', surface: 'voice' }, () => prepareTurnCognitiveContext(
    captured,
    dependencies.conversationStore,
    { scopeKey, message: transcript, occurredAt, channel: 'voice', threadId, present,
      intents: legacyGuest ? [] : dependencies.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent,
      timeZone: deviceContext?.timeZoneIdentifier, additionalCandidates: peopleRecall?.candidates ?? [],
      participants: temporaryGuest ? [] : dependencies.personIdentities?.list(scopeKey).filter(person => person.status === 'active' && transcript.includes(person.displayName)).map(person => person.displayName),
    },
  ), value => ({ characterCount: value.prompt.length }));
  const complexTurn = decision.conversationClass === 'skill_complex' || dependencies.memoryRecall?.walksTree?.(decision.conversationClass) === true; // Stage 2, step 8: a skill_* turn walks the tree.
  const recalled = !legacyGuest && dependencies.memoryRecall
    && (semanticMemoryTurn || complexTurn || decision.selectedSkills.includes('conversation_memory'))
    ? await bounded('recall_timeout', observeAsync('recall', { strategy: 'semantic', surface: 'voice', memoryTurn: semanticMemoryTurn, complexTurn },
      () => dependencies.memoryRecall!.enrich(deterministicContext, { scopeKey, message: transcript, snapshot: captured, threadId,
        memoryTurn: semanticMemoryTurn, complexTurn, voiceClass: decision.conversationClass, ...(observer?.signal ? { signal: observer.signal } : {}) }),
      value => ({ characterCount: value.prompt.length })), () => null) : null;
  const cognitiveContext = recalled ?? deterministicContext;
  timing.add('recall', performance.now() - recallStartedAt);
  // Fixed first, what changes last (`ShannonPromptLayers`): her profile follows the fixed blocks, the state opens the turn's context.
  // The slim path drops owner state, never the identity: persona, suite roles and capabilities stay.
  // The full profile block is for the owner alone; otherwise the disclosed block in the turn context stands in.
  const identity = innerNoteVoice.identity(temporaryGuest ? identityOnly(shannonIdentityPrompt('guest')) : selectedSkills.has('conversation_memory') && alone
    ? dependencies.knowledgeStore?.promptProjectionParts(scopeKey) ?? companionIdentityPrompt(captured) : identityOnly(shannonIdentityPrompt('owner', { othersPresent: !alone })), dependencies.innerNote);
  const basePrompt = temporaryGuest
    ? [identity.identity, voiceConversationInstructions(true, false, false), temporaryGuestVoiceInstructions].join('\n\n')
    : [withStage5Capabilities(dependencies.autonomy?.identityProjection(scopeKey, identity.identity) ?? identity.identity, alone ? dependencies.stage5Capabilities : undefined), voiceConversationInstructions(true)].join('\n\n');
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
    : await timing.measure('capability', () => bounded('capability_timeout', conversationCapabilityContext(scopeKey, transcript, dependencies, {
      aetherNotes: selectedSkills.has('aether_notes'),
      voyagerTasks: selectedSkills.has('voyager_tasks'),
      notion: notionTurn, upcoming: temporaryGuest ? false : alone ? true : 'guarded',
    }, Boolean(fca && fcaInput && !unclearTranscript)), () => NO_CAPABILITY_CONTEXT));
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
    taskPrompt, dependencies.reactions?.voiceTouchContext?.(scopeKey, occurredAt, reactionLine, alone && !temporaryGuest) ?? '', // Her body (2026-10-14).
    capabilityPrompt, innerNoteVoice.context(dependencies.innerNote, scopeKey, alone, temporaryGuest, occurredAt), // ADR-0012: her inner note.
    [
      '[Voice route]',
      `Conversation class: ${decision.conversationClass}. Expected latency: ${decision.latencyClass}.`,
      `Selected capabilities: ${decision.selectedSkills.join(', ') || 'none'}.`,
      `Concrete-solution probability: ${decision.solutionWantedProbability.toFixed(2)}.`,
      decision.solutionWantedProbability < 0.4
        ? innerNoteVoice.presence(dependencies.innerNote)
        : 'Lead with the useful answer or next concrete step while keeping the spoken reply natural.',
    ].join('\n'),
    innerNoteVoice.expressive(dependencies.innerNote)(provisionalExpressiveEmotion, temporaryGuest ? 'guest' : alone ? 'owner' : 'others'),
    alone && emotionState && !includeCognitiveContext ? stillFeltLine(emotionState, occurredAt) : '',
    temporaryGuest ? guestSpeakerReminder : '',
    buildConversationOrchestrationPrompt(orchestrationState, dependencies.agentTasks.list(scopeKey)),
    confirmedImplementationRequest
      ? `[Confirmed implementation clarification]\nThe owner's immediately preceding request was: ${confirmedImplementationRequest}\nYour previous reply explicitly asked whether to show an implementation proposal; the owner has now confirmed. Return a concrete taskProposal for that request. The visible proposal card is the start boundary; do not claim code work has begun.`
      : '',
    backendInstructions, roomLook.prompt,
    voiceTranscriptInterpretationPrompt(unclearTranscript, rawTranscript, uncertainTranscript),
  ].filter(Boolean).join('\n\n');
  // The owner's thread is replayed by character budget, from after its last long silence, with the replay summary for what fell out
  // of it; a 「友人も一緒」 call keeps its own in-call turns and never sees the owner's thread.
  const replay = temporaryGuest ? null
    : conversationReplay('voice', captured, dependencies.conversationStore, scopeKey, threadId, present, undefined, toolTraceReader(dependencies.toolServer, scopeKey), false, occurredAt);
  const fcaStartedAt = performance.now(); // From the FCA bridge to the finished tool offer: where 2026-10-12's turns stalled.
  const fcaTurn = fca && fcaInput && !unclearTranscript && !notHisWordsToHer(decision) ? fca.begin({ ...fcaInput, observedAt: occurredAt,
    recalledMemoryIds: conversationFcaProvenance(captured, dependencies.conversationStore, scopeKey, threadId, [...cognitiveContext.frame.recalledMemoryIDs, ...peopleRecall?.ids ?? []]),
    readSourceIds: capability.readSourceIds, ownerAlone: () => dependencies.toolServer?.audience.othersKnown(scopeKey) === false }) : null;
  try {
  const placeContext = selectedSkills.has('place_discovery') || wantsPlaceDiscovery(transcript) ? { ...(wantsNearbyPlaces(transcript) && deviceContext?.location ? { latitude: deviceContext.location.latitude, longitude: deviceContext.location.longitude } : {}), spoken: true } : undefined;
  // A research task is started only on words trusted to act (review M2); otherwise the web is searched inline as without FCA.
  const research = !uncertainTranscript && (selectedSkills.has('current_web') || Boolean(placeContext));
  const admitted = admitVoiceResearch(fcaTurn, { transcript, route: routeInput, research,
    places: placeContext, at: occurredAt, timeZone: deviceContext?.timeZoneIdentifier }), work = admitted.work, next = followUp(fcaTurn, transcript, admitted);
  const placeSkill = !work && placeContext ? await bounded('places_timeout', runPlaceDiscoverySkill(dependencies.auxiliaryChatModel ?? dependencies.chatModel, { scopeKey, message: transcript, context: placeContext }), () => null) : null;
  observer?.signal?.throwIfAborted();
  const directHint = Boolean(fcaTurn) && plainVoiceHint(decision, transcript, unclearTranscript);
  const turnPrompt = [turnContext, placeSkill?.prompt ?? '', fcaTurn?.context() ?? '', admittedWorkContext(work), next.hint, directHint ? PLAIN_VOICE_HINT : ''].filter(Boolean).join('\n\n');
  if(dependencies.mind?.sync)await dependencies.mind.sync();
  // Stage 3: the workspace's blocks (voice: at most two lines) follow the turn's context, which stays byte for byte as it was.
  const replayed = withWorkspace(replay?.request(turnPrompt) ?? { ...(turnPrompt ? { turnContext: turnPrompt } : {}), history: boundedVoiceHistory(guestHistory, GUEST_CALL_MODEL_TURNS) },
    voiceWorkspace(dependencies.mind, { scopeKey, threadId, present, perceived: perceivedTurn, snapshot: captured, snapshotNow:()=>dependencies.stateStore.snapshot(scopeKey), store: dependencies.conversationStore, at: occurredAt }));
  const offered = conversationTools(dependencies.autonomy, scopeKey, 'voice', toolAudience, dependencies.toolServer ?? {}, `${threadId}\n${transcript}`, deadline, // 「友人も一緒」: Aether reading tools; a legacy client none.
    { trust: transcriptTrust(decision, deviceContext?.userUtterance), ...(deviceContext?.userUtterance?.id ? { utteranceId: deviceContext.userUtterance.id } : {}) }, { ...ownerAloneReads(toolAudience), ...(dependencies.toolHints ? { sourceHints: true } : {}) });
  const { offer: selectedOffer, tier } = choices ? await bounded('tool_menu_timeout', voiceOfferAndTier(dependencies.turnRouting, offered, choices, { scopeKey, threadId, deadline, at: occurredAt }), () => ({ offer: offered, tier: null })) : { offer: offered, tier: null };
  const narrowedOffer = fcaTurn?.selectTools && selectedOffer.tools && !directHint && !work ? { ...selectedOffer, tools: await bounded('tool_select_timeout', fcaTurn.selectTools(selectedOffer.tools, { goal: transcript, state: cognitiveContext.prompt }), () => selectedOffer.tools!) } : selectedOffer;
  const toolOffer = { ...narrowedOffer, tools: conversationHintMenu(narrowedOffer.tools, directHint || Boolean(work)) };
  timing.add('fca', performance.now() - fcaStartedAt);
  observerHandoff('recall', 'context', { surface: 'voice', semantic: recalled !== null });
  const modelRequest = observeSync('context', { surface: 'voice' }, () => withToolCapabilityLines({ // Her Minecraft body's and Aether's lines, in her identity, exactly when their tools are offered.
    scopeKey, systemPrompt: basePrompt, ...skillProfilePrompt(identity.profile, dependencies.skills, scopeKey, toolOffer.tools, selectedSkills.has('current_web') || Boolean(placeSkill)), ...replayed,
    // What she said when she was touched is what he is answering: it directly precedes his words, in every mode, as context only.
    ...(reactionLine ? { precedingReply: reactionLine } : {}),
    message: transcript, ...toolOffer, ...tierRequest(tier, deadline.left()),
    ...voiceTurnClock(occurredAt, deviceContext?.timeZoneIdentifier),
    spokenLines: spokenReplyLines(transcript, capabilityPrompt, toolOffer.tools, decision, deviceContext?.userUtterance?.source === 'camera'),
    useWebSearch: !work && !placeSkill && selectedSkills.has('current_web'),
    conversationClass: decision.conversationClass === 'no_response' ? 'direct' as const : decision.conversationClass,
  }), value => ({ messageCharacterCount: value.message.length, historyCount: value.history?.length ?? 0,
    contextCharacterCount: value.turnContext?.length ?? 0, toolCount: value.tools?.definitions.length ?? 0 }));
  const modelStartedAt = performance.now();
  const contextMilliseconds = Math.max(0, Math.round(modelStartedAt - contextStartedAt));
  let firstModelTokenMilliseconds: number | undefined;
  let streamedReplyPrefix = '';
  observer?.signal?.addEventListener('abort', () => roomLook.cutOff(threadId, streamedReplyPrefix), { once: true });
  let streamedEmotionUpdated = false;
  const requiresStructuredTaskDecision = voiceTurnSetsImplementation(orchestrationState, transcript, occurredAt);
  const completion = await observeFcaConversation(fcaTurn, () => placeSkill || (!work && provisionalIntent) || requiresStructuredTaskDecision || confirmedImplementationRequest
    ? dependencies.chatModel.generate({ ...modelRequest, generateThreadTitle: false, spokenReply: true })
    : observer && dependencies.chatModel.generateVoiceStreaming
      ? dependencies.chatModel.generateVoiceStreaming(
        // The stream route may speak the first plan's waiting phrase after a silence: once it has, the model's tool rounds add no second one.
        { ...modelRequest, threadKey: threadId, ...waitingSaid },
        async delta => {
          firstModelTokenMilliseconds ??= Math.max(0, Math.round(performance.now() - modelStartedAt));
          timing.mark('firstToken');
          streamedReplyPrefix = `${streamedReplyPrefix}${delta}`.slice(0, 2_000);
          await observer.onTextDelta(researchSaid(delta, work));
          if (!streamedEmotionUpdated && /[。！？!?\n]/u.test(streamedReplyPrefix)) {
            streamedEmotionUpdated = true;
            expressiveEmotion = emotionWith(streamedReplyPrefix);
            voicePlan = planFor(expressiveEmotion);
            await observer.onPlan(voicePlan);
          }
        },
        observer.signal,
      )
    : dependencies.chatModel.generateVoice
      ? dependencies.chatModel.generateVoice({ ...modelRequest, threadKey: threadId })
      : dependencies.chatModel.generate({ ...modelRequest, generateThreadTitle: false, spokenReply: true }));
  observer?.signal?.throwIfAborted();
  const modelCompleteMilliseconds = Math.max(0, Math.round(performance.now() - modelStartedAt));
  firstModelTokenMilliseconds ??= modelCompleteMilliseconds;
  timing.mark('firstToken'); // Unstreamed, the whole reply is its first token.
  orchestrationState = settleVoiceTaskDecision(dependencies, orchestrationState, requiresStructuredTaskDecision, completion.taskDecision);
  const { acknowledged, heard } = await researchAfterAck(fcaTurn, next.admitted, completion, observer);
  const taskProposal = completion.taskProposal ?? (confirmedImplementationRequest ? { title: '依頼された機能の実装', goal: confirmedImplementationRequest } : undefined);
  const answered = confirmedImplementationRequest ? 'よし、ライ氏。実装提案を画面に出しました。内容を確認して開始すると、作業が始まります。' : placeSkill ? spokenPlaceReply(completion.reply) : `${researchSaid(acknowledged, work)}${heard}`;
  let feedbackRecordId: string | undefined;
  const reply = dependencies.turnRouting ? await voiceFinished(dependencies.turnRouting, { scopeKey, threadId, alone, reply: answered, feedbackReplySuffix: placeReply('', placeSkill?.places ?? []), completion, tier, tools: toolOffer.tools, deadline, at: occurredAt, onFeedbackRecord: id=>{feedbackRecordId=id;} }) : answered;
  // Opens the look only if this turn chose one, she said so herself, and its conditions still hold.
  if (!confirmedImplementationRequest) roomLook.open(threadId, reply);
  expressiveEmotion = emotionWith(reply);
  voicePlan = planFor(expressiveEmotion, turnToolResults(toolOffer.tools).some(call => !call.ok)); // A failed tool keeps her apology.
  // Her stored feeling toward the owner moves only on his own words.
  if (alone) dependencies.stateStore.apply(scopeKey, { type: 'expressive-emotion-updated', emotion: expressiveEmotion });
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
  // A turn that wrote with her own tools has done the request itself: no agent task for it (`turnWroteHerOwnThings`).
  if (alone && !uncertainTranscript && taskProposal && !isExplicitVoyagerUpdateRequest(transcript) && !turnWroteHerOwnThings(toolOffer.tools)) {
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
  innerNoteVoice.ended(dependencies.innerNote, scopeKey, alone && !temporaryGuest, occurredAt, transcript, reply, expressiveEmotion,
    deviceContext?.userUtterance?.id); // ADR-0012
  stageFcaVoice(fcaTurn);
  dependencies.mind?.turnEnded?.(); // Stage 3: what the mind noted is written after the response.
  return visibleVoiceResponse(() => ({
    status: 200,
    body: {
      threadId,
      model: completion.model,
      reply: reply.trim(),
      ...(feedbackRecordId ? { feedbackRecordId } : {}),
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
  }));
  } catch (error) { try { fcaTurn?.abort(); } catch { /* Pending source stays ineligible. */ } throw error; }
}

