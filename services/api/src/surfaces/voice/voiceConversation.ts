import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, isOwnerOnly, projectEmotionReaction, resolveShannonEmotionState, type CompanionStateSnapshot,
  type MemoryAudience, type ShannonExpressiveEmotion } from '@shannon/cognition';
import type { ApiResponse } from '../../contracts/contracts.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway, type VoiceTurnDecision } from '../../mind/selectors/voiceDecision.js';
import { withMemorySearchLatency } from '../../mind/recall/turnMemoryRecall.js';
import { visibleConversationHistory } from '../../mind/memory/memoryVisibility.js';
import { executeConversationCommand, spokenCommandAllowed } from '../../mind/action/respond/conversationCommands.js';
import { extractExplicitUserIntent } from '../../mind/action/respond/cognitiveIntent.js';
import { NO_CAPABILITY_CONTEXT } from '../../mind/action/respond/conversationCapabilities.js';
import {
  confirmedVoiceImplementationRequest, observeConversationTurn, recordConversationReceipt,
} from '../../mind/action/respond/conversationOrchestration.js';
import { namedParticipants } from '../../mind/action/respond/apiTextTurn.js';
import {
  closedTurn, type ConversationModality, type StartedTurnMemory, type TurnCapabilityAsk, type TurnIdentityAsk, type TurnMemoryAsk, type TurnParts,
  type TurnStageDependencies,
} from '../../mind/action/respond/conversationTurn.js';
import { TurnDeadline, VOICE_TURN_DEADLINE } from '../../mind/action/respond/turnDeadline.js';
import { asksAboutNotion } from '../../integrations/notion/notionConversation.js';
import { ownerSaysCompanionPresent } from '../../mind/perception/voiceCompanionPresence.js';
import { emotionTiming, feelingBeforeTurn, innerNoteVoice } from '../../mind/emotion/companionPresence.js';
import { feelingVoice } from '../../mind/emotion/feelingPorts.js';
import { notHisWordsToHer, ownerVoiceTurnFacts, settleOwnerVoiceTurn } from '../../mind/attention/voiceSilence.js';
import { companionIdentityPrompt, identityOnly } from '../../mind/memory/identityPrompt.js';
import { shannonIdentityPrompt } from '@shannon/cognition';
import { weatherToolAvailable } from '../../mind/tools/shannonToolSession.js';
import { turnStages, type TurnTiming } from '../../infra/observer/turnTiming.js';
import { transcriptNeedsInterpretation, transcriptTrust } from './voiceTranscriptContext.js';
import { commandOnce } from './voiceContinuation.js';
import type { VoiceDeviceContext } from './voiceDeviceContext.js';
import { applyGuestAddressing, boundedVoiceHistory, guestAddressDecision, guestCallHistory } from './voiceGuestCall.js';
import type { VoiceParticipantMode } from './voiceSessionProjection.js';
import { voiceLookTurn, type VoiceLookTurn } from './voiceAppLook.js';
import { perceptionOrActionRequest } from './voiceRecallScope.js';
import { startVoiceStage2 } from './voiceStage2.js';
import { voiceCommandResponse, voiceTurnGrounding } from './voiceGrounding.js';
import { confirmedFcaVoiceInput, voiceFcaChooser, voiceFcaDuplicate } from './fcaVoiceContext.js';
import { perceiveVoiceTurn, visibleVoiceResponse, voicePlanner } from './voiceObservation.js';
import { webForWeather } from './voiceConversationHint.js';
import { seatMemory, seatPeople, seatToolAudience, type VoiceSeat } from './voiceSeat.js';
import type { LiveVoiceDependencies, LiveVoiceStreamObserver } from './liveVoicePorts.js';
import { composeVoiceTurn, type VoiceComposed } from './voiceConversationPrompt.js';
import { speakVoiceTurn, answerVoiceTurn, type VoiceSpoken } from './voiceConversationSpeak.js';
import type { PeopleMemory } from '../../mind/memory/peopleMemory.js';

/**
 * A spoken turn as a modality of the one flow (`conversationTurn.ts`): the apps' voice (iPhone, Mac, Windows) and, with one head, a
 * Discord voice channel with its seat (`VoiceSeat`). What is its own: who is in the call (the owner, someone beside him, a 「友人も一緒」
 * call, a platform's room), the router (whether she answers, what is recalled, her face's plan, a waiting phrase), a spoken command on
 * words trusted to act, the look, the voice's blocks, her plain spoken stream (or the structured reply where a turn needs a field), and
 * the answer the stream route speaks. Moved out of `apiLiveVoice.ts` with nothing changed in what it does.
 */
export interface VoiceTurnInput {
  scopeKey: string;
  requestedThreadId: string | undefined;
  transcript: string;
  participantMode: VoiceParticipantMode;
  deviceContext: VoiceDeviceContext | null;
  reactionLine: string | null;
  dependencies: LiveVoiceDependencies;
  observer: LiveVoiceStreamObserver | undefined;
  timing: TurnTiming;
}

/** The one flow's shared stages, from what a voice turn is handed. */
export function voiceTurnStages(dependencies: LiveVoiceDependencies): TurnStageDependencies {
  return { stateStore: dependencies.stateStore, conversationStore: dependencies.conversationStore, memoryRecall: dependencies.memoryRecall ?? null,
    innerNote: dependencies.innerNote ?? null, autonomy: dependencies.autonomy ?? null,
    ...(dependencies.stage5Capabilities ? { stage5Capabilities: dependencies.stage5Capabilities } : {}) };
}

type GuestPresence = ReturnType<PeopleMemory['resolveCall']> | null;
type Recall = ReturnType<PeopleMemory['recall']>;

/** Who is there, as the voice turn reads it (the apps' device or a platform's seat), and what the router decided. */
export class VoiceConversation implements ConversationModality<ApiResponse> {
  readonly bounded: ReturnType<typeof turnStages>;
  readonly turnStartedAt = performance.now();
  readonly deadline: TurnDeadline;
  readonly temporaryGuest: boolean;
  readonly seat: VoiceSeat | null;
  /** Someone else's turn on a platform (a guest's identity). */
  readonly otherSpeaker: boolean;
  readonly memoryText: ReturnType<typeof seatMemory>;
  threadId = '';
  occurredAt = '';
  routingState!: CompanionStateSnapshot;
  guestCall: VoiceDeviceContext['guestCall'] | null = null;
  guestHistory: ReturnType<typeof guestCallHistory> = [];
  guestPresence: GuestPresence = null;
  present: MemoryAudience = OWNER_AUDIENCE;
  alone = true;
  legacyGuest = false;
  feelingTurn: ReturnType<typeof feelingVoice.start> = null;
  fca: ReturnType<NonNullable<LiveVoiceDependencies['fcaVoice']>> | null = null;
  fcaInput: ReturnType<typeof confirmedFcaVoiceInput> = null;
  routingHistory: ReturnType<typeof guestCallHistory> | ReturnType<typeof visibleConversationHistory> = [];
  rawTranscript = '';
  address: ReturnType<typeof guestAddressDecision> | null = null;
  facts: ReturnType<VoiceConversation['turnFacts']>;
  toolAudience!: ReturnType<typeof startVoiceStage2>['toolAudience'];
  choices: ReturnType<typeof startVoiceStage2>['choices'] = null;
  routeInput!: Parameters<VoiceDecisionGateway['decide']>[0];
  decision!: VoiceTurnDecision;
  uncertainTranscript = false;
  unclearTranscript = false;
  confirmedImplementationRequest: string | null = null;
  perceivedTurn: ReturnType<typeof perceiveVoiceTurn> = null;
  roomLook!: VoiceLookTurn;
  semanticMemoryTurn = false;
  notionTurn = false;
  orchestrationState: ReturnType<typeof observeConversationTurn> | null = null;
  emotionState: CompanionStateSnapshot | null = null;
  previousExpressiveEmotion: ReturnType<typeof feelingBeforeTurn> | undefined;
  provisionalExpressiveEmotion!: ShannonExpressiveEmotion;
  expressiveEmotion!: ShannonExpressiveEmotion;
  planFor!: (emotion: ShannonExpressiveEmotion, failed?: boolean) => Record<string, unknown>;
  voicePlan: Record<string, unknown> = {};
  waitingSaid: { waitingSaid?: true | (() => boolean) } = {};
  contextStartedAt = 0;
  selectedSkills: Set<string> = new Set();
  backendInstructions = '';
  provisionalIntent: ReturnType<typeof extractExplicitUserIntent> = null;
  complexTurn = false;
  memory!: StartedTurnMemory;
  composed!: VoiceComposed;
  spoken!: VoiceSpoken;

  constructor(readonly input: VoiceTurnInput) {
    input.timing.mark('admit'); // Waiting behind the scope's earlier turn, and the respond admission.
    this.bounded = turnStages('voice', input.timing); // Every input before the model call is bounded (`TURN_STAGE_BOUNDS`).
    this.deadline = new TurnDeadline(VOICE_TURN_DEADLINE, () => Date.parse(input.dependencies.now())); // One deadline for her tools, from arrival.
    this.temporaryGuest = input.participantMode === 'guest';
    // One head: a platform's seat (`VoiceSeat`) in place of the device's.
    this.seat = input.dependencies.seat ?? null;
    this.otherSpeaker = this.seat !== null && !this.seat.ownerSpeaking;
    this.memoryText = seatMemory(this.seat);
  }

  get dependencies(): LiveVoiceDependencies { return this.input.dependencies; }
  get scopeKey(): string { return this.input.scopeKey; }
  get transcript(): string { return this.input.transcript; }
  get utterance() { return this.input.deviceContext?.userUtterance; }
  /** A guest's identity: the 「友人も一緒」 call, or someone else's turn on a platform. */
  get guestVoice(): boolean { return this.temporaryGuest || this.otherSpeaker; }
  get openOnly(): boolean { return this.seat !== null && !this.seat.ownerPresent; }

  async open() {
    const duplicate = this.seatTurn();
    if (duplicate) return closedTurn(duplicate);
    this.prepareRoute();
    await this.route();
    this.settleDecision();
    const command = this.orchestrate();
    if (command) return closedTurn(command);
    await this.planFeeling();
    if (!this.decision.shouldRespond) return closedTurn(this.silent());
    return null;
  }

  /** Who can hear the reply decides what every later step may read. Unknown people are never assumed away. */
  private seatTurn(): ApiResponse | null {
    const { dependencies: deps, scopeKey, transcript, seat } = this;
    const { requestedThreadId } = this.input;
    this.threadId = seat ? seat.threadId : this.temporaryGuest
      ? requestedThreadId || 'temporary-guest-session' : deps.conversationStore.threadId(scopeKey, requestedThreadId);
    this.occurredAt = deps.now();
    this.routingState = deps.stateStore.snapshot(scopeKey);
    this.seatPresence();
    // ADR-0013: a call with anyone else is the call's scene, never the owner's; a platform's channel is keyed as its typed turns.
    this.feelingTurn = feelingVoice.start(deps.feeling, { scopeKey, alone: this.alone, guest: this.temporaryGuest, threadId: this.threadId, transcript,
      at: this.occurredAt, snapshot: this.routingState, ...(seat ? { platform: seat.speaker ? { speaker: seat.speaker } : {} } : {}) });
    this.fca = !this.temporaryGuest && this.alone && !seat ? deps.fcaVoice?.() ?? null : null;
    this.fcaInput = confirmedFcaVoiceInput(scopeKey, this.threadId, deps.deviceId, this.utterance, transcript);
    return voiceFcaDuplicate(this.fca, this.fcaInput);
  }

  /** In 「友人も一緒」 a person is present only once their name has been said; until then the guest is unknown. */
  private seatPresence(): void {
    const { dependencies: deps, scopeKey, transcript, seat } = this;
    const { requestedThreadId, deviceContext } = this.input;
    this.guestCall = this.temporaryGuest ? deviceContext?.guestCall ?? null : null;
    this.guestHistory = guestCallHistory(this.guestCall);
    const call = this.guestCall;
    this.guestPresence = this.temporaryGuest ? deps.people?.resolveCall(scopeKey, { transcript, turns: call?.turns ?? [],
      ...(call?.callId ? { callId: call.callId } : {}), ...(requestedThreadId ? { threadId: requestedThreadId } : {}) }, this.occurredAt) ?? null : null;
    const companion = deviceContext?.companionPresent === true || ownerSaysCompanionPresent(transcript);
    this.present = seat ? seat.present : this.temporaryGuest ? this.guestPresence?.present ?? UNKNOWN_GUEST_PRESENCE
      : companion ? UNKNOWN_GUEST_PRESENCE : OWNER_AUDIENCE;
    this.alone = seat ? seat.ownerAlone : isOwnerOnly(this.present);
  }

  /** At a shared table she answers when addressed; overheard talk is settled by local rules (no router or reply model call). */
  private prepareRoute(): void {
    const { dependencies: deps, scopeKey, transcript, threadId } = this;
    // A platform's room is not the owner's: nobody is noted beside him in his apps.
    if (!this.alone && !this.seat) deps.toolServer?.audience.noteOthers(scopeKey);
    // A client that predates people memory tells the friend that no owner memory is used; keep that promise for it.
    this.legacyGuest = this.temporaryGuest && this.guestPresence?.recorded !== true;
    this.routingHistory = this.temporaryGuest ? this.guestHistory
      : visibleConversationHistory(this.routingState, deps.conversationStore, scopeKey, threadId, this.present);
    this.rawTranscript = this.utterance?.rawText ?? transcript;
    this.address = this.temporaryGuest ? guestAddressDecision(transcript, this.guestCall, this.utterance?.source) : null;
    const routed = !this.address || this.address.respond;
    const chooser = routed ? voiceFcaChooser(deps.turnChooser, Boolean(this.fca && this.fcaInput)) : null;
    const stage2 = startVoiceStage2(chooser, { autonomy: deps.autonomy, server: deps.toolServer ?? {}, scopeKey, threadId, transcript,
      guest: this.temporaryGuest, legacyGuest: this.legacyGuest, alone: this.alone, ...(this.seat ? { audience: seatToolAudience(this.seat) } : {}) });
    this.toolAudience = stage2.toolAudience;
    this.choices = stage2.choices;
    this.facts = this.turnFacts();
    this.routeInput = this.routeInputOf(this.facts);
  }

  /**
   * Owner call: what the moment looks like, for deciding whether she should speak at all (voiceSilence.ts). The turn in which he says that
   * someone is with him is said to her; from the next one on she must be addressed. A platform's channel decided it before the turn.
   */
  private turnFacts() {
    if (this.temporaryGuest || this.seat) return undefined;
    const { dependencies: deps, scopeKey, threadId, transcript } = this;
    return ownerVoiceTurnFacts({ history: this.routingHistory, at: this.occurredAt, othersPresent: !this.alone && !ownerSaysCompanionPresent(transcript),
      newest: deps.conversationStore.conversationHistory(scopeKey, threadId).at(-1), source: this.utterance?.source, answersHer: this.input.reactionLine });
  }

  private routeInputOf(turnFacts: ReturnType<VoiceConversation['turnFacts']>): Parameters<VoiceDecisionGateway['decide']>[0] {
    const { dependencies: deps, scopeKey, transcript } = this;
    const location = this.input.deviceContext?.location;
    const ownerAlone = this.alone && !this.temporaryGuest;
    return {
      // In a remembered 「友人も一緒」 call the same capabilities may be chosen as with the owner; what is said is checked at speak time.
      scopeKey, transcript, rawTranscript: this.rawTranscript, participantMode: this.legacyGuest ? 'guest' as const : 'owner' as const,
      context: boundedVoiceHistory(this.routingHistory, 4), ...(turnFacts ? { turn: turnFacts } : {}),
      requestedLocation: this.input.deviceContext?.requestedLocation ?? false,
      ...innerNoteVoice.route(deps.innerNote, scopeKey, ownerAlone, this.occurredAt), // ADR-0012: voice_route.v3 sees her.
      ...feelingVoice.route(this.feelingTurn, transcript, this.routingState), // ADR-0013: voice_route.v6 also asks her stance (no extra round trip).
      hasFreshLocation: location !== null && location !== undefined, ...deps.looks?.routing,
    };
  }

  private async route(): Promise<void> {
    const localRules = new LocalVoiceDecisionGateway(); // Also what decides when the router is past its bound.
    const router = this.address && !this.address.respond ? localRules : this.dependencies.voiceDecision;
    const input = this.routeInput;
    this.decision = await this.input.timing.measure('route', () => this.bounded('route_timeout', router.decide(input), () => localRules.decide(input)));
    this.input.observer?.signal?.throwIfAborted();
  }

  /** Words trusted to act (commands, writes, goals; the client's confidence only lowers it) or to talk, look and run FCA. */
  private settleDecision(): void {
    const { dependencies: deps, scopeKey, threadId, transcript } = this;
    this.uncertainTranscript = transcriptNeedsInterpretation(this.decision, this.utterance);
    this.unclearTranscript = transcriptNeedsInterpretation(this.decision, this.utterance, 'converse');
    const proposes = this.alone && !this.seat && !this.uncertainTranscript; // A platform shows no proposal card.
    this.confirmedImplementationRequest = proposes ? confirmedVoiceImplementationRequest(transcript, this.routingHistory,
      deps.conversationStore.conversationHistory(scopeKey, threadId).slice(-2), this.occurredAt) : null;
    let decision = settleOwnerVoiceTurn(this.decision, { transcript, facts: this.facts, uncertain: this.uncertainTranscript });
    if (this.address) decision = applyGuestAddressing(decision, this.address);
    this.decision = decision;
    // Stage 3: the turn as the mind perceives it, once the router has heard it: a transcript it scored uncertain, or words not his to her
    // (an echo, overheard), are not taken as his. A transcript with no score keeps the handling it had.
    const unverified = transcriptTrust(decision, this.utterance) === 'uncertain' || notHisWordsToHer(decision);
    this.perceivedTurn = perceiveVoiceTurn(deps.mind, scopeKey, { threadId, transcript, present: this.present, alone: this.alone,
      guest: this.guestVoice, unverified, at: this.occurredAt });
    this.lookAndGate();
  }

  /** One look at the room, judged at this instant (a platform has no camera), and the waits a model recall or Notion read adds. */
  private lookAndGate(): void {
    const { dependencies: deps, scopeKey, transcript, threadId } = this;
    this.roomLook = voiceLookTurn(deps.looks, { scopeKey, transcript, at: deps.now(), threadId, turnId: this.utterance?.id,
      guest: this.temporaryGuest || this.seat !== null, source: this.utterance?.source, audience: this.alone && !this.temporaryGuest ? 'owner' : 'others',
      decision: this.decision, uncertain: this.unclearTranscript });
    // A turn that will search memory with a model is at least a >3 s turn (her memory gets no waiting phrase: `voiceWaitingCue.ts`).
    const memoryTurn = this.decision.selectedSkills.includes('conversation_memory') && !perceptionOrActionRequest(transcript);
    this.semanticMemoryTurn = !this.legacyGuest && this.decision.shouldRespond && deps.memoryRecall?.willSearch({ message: transcript, memoryTurn }) === true;
    if (this.semanticMemoryTurn) this.decision = withMemorySearchLatency(this.decision);
    if (this.decision.selectedSkills.includes('place_discovery')) this.decision = withMemorySearchLatency(this.decision);
    // Notion is the owner's private material: read only when he is alone, by a fixed rule on his words.
    this.notionTurn = this.alone && !this.temporaryGuest && this.decision.shouldRespond && asksAboutNotion(transcript);
    if (this.notionTurn && deps.notion?.connected) this.decision = withMemorySearchLatency(this.decision);
  }

  /** Not his words to her, or a platform's turn: no orchestration state and no command. A command runs once, for the owner alone. */
  private orchestrate(): ApiResponse | null {
    const { dependencies: deps, scopeKey, threadId, transcript } = this;
    const quiet = !this.alone || this.seat !== null || this.uncertainTranscript || notHisWordsToHer(this.decision);
    this.orchestrationState = quiet ? null : observeConversationTurn({ previous: deps.conversationOrchestration.read(scopeKey, threadId), scopeKey, threadId,
      message: transcript, occurredAt: this.occurredAt, participantMode: this.input.participantMode, tasks: deps.agentTasks.list(scopeKey) });
    if (this.orchestrationState) this.orchestrationState = deps.conversationOrchestration.save(this.orchestrationState);
    const command = this.command();
    if (!command) return null;
    if (this.orchestrationState && command.receipt) {
      this.orchestrationState = deps.conversationOrchestration.save(recordConversationReceipt(this.orchestrationState, command.receipt));
    }
    const { deviceContext } = this.input;
    return visibleVoiceResponse(() => voiceCommandResponse(deps, { scopeKey, threadId, transcript, deviceContext, occurredAt: this.occurredAt,
      present: this.present, command }));
  }

  /** Commands that act (tasks, notes, remember, forget, promises), on words that can be trusted; once for words sent again (`continues`). */
  private command() {
    const { dependencies: deps, scopeKey, threadId } = this;
    const utterance = this.utterance;
    if (!this.alone || !utterance || notHisWordsToHer(this.decision)) return null;
    if (!spokenCommandAllowed(transcriptTrust(this.decision, utterance), scopeKey, threadId, utterance, this.occurredAt, deps.conversationStore)) return null;
    return commandOnce(deps.conversationStore, scopeKey, utterance, this.occurredAt, () => executeConversationCommand(scopeKey, threadId, utterance,
      this.occurredAt, { ...deps, agentTasks: deps.agentTasks }));
  }

  /** Her feeling for this turn, from his words and, once there is one, her reply. */
  emotionWith(reply?: string): ShannonExpressiveEmotion {
    return resolveShannonEmotionState({ previous: this.previousExpressiveEmotion, provisionalPrimary: this.decision.affect,
      provisionalIntensity: this.decision.affectIntensity, transcript: this.transcript, ...(reply === undefined ? {} : { reply }), now: this.occurredAt,
      target: this.guestVoice ? '現在の話者' : 'ライ氏' });
  }

  /** Her face's plan (its timing line notes `silence`, `chars`), sent before anything else. */
  private async planFeeling(): Promise<void> {
    const { dependencies: deps, scopeKey } = this;
    const observer = this.input.observer;
    this.emotionState = this.guestVoice ? null : deps.stateStore.snapshot(scopeKey);
    this.previousExpressiveEmotion = this.emotionState ? feelingBeforeTurn(this.emotionState, this.occurredAt) : undefined;
    const voiceMood = this.emotionState ? projectEmotionReaction(this.emotionState, this.transcript, emotionTiming()) : undefined;
    this.provisionalExpressiveEmotion = this.emotionWith();
    this.expressiveEmotion = this.provisionalExpressiveEmotion;
    const ownerAlone = this.alone && !this.temporaryGuest;
    this.planFor = innerNoteVoice.planner(voicePlanner(this.decision, voiceMood, { ownerAlone, transcript: this.transcript, timing: this.input.timing,
      trigger: this.utterance?.trigger }), deps.innerNote, scopeKey, this.occurredAt, ownerAlone); // ADR-0012 D5.2
    this.voicePlan = this.planFor(this.expressiveEmotion);
    await observer?.onPlan(this.voicePlan);
    const phrase = String(this.voicePlan.waitingPhrase ?? '').trim();
    this.waitingSaid = phrase ? { waitingSaid: observer?.waitingSaid?.bind(observer) ?? true as const } : {};
    observer?.signal?.throwIfAborted();
  }

  private silent(): ApiResponse {
    const companion = !this.temporaryGuest && !this.alone && !this.seat;
    return visibleVoiceResponse(() => ({ status: 200, body: { threadId: this.threadId, model: this.dependencies.chatModel.model, reply: '', webSources: [],
      ...(companion ? { companionPresent: true } : {}), voicePlan: this.voicePlan } }));
  }

  // ── The one flow's shared stages, as a voice turn asks for them ─────────────

  memoryAsk(): TurnMemoryAsk {
    const { dependencies: deps, scopeKey, transcript, threadId } = this;
    this.contextStartedAt = performance.now();
    const weather = weatherToolAvailable(deps.autonomy, scopeKey, this.alone && !this.temporaryGuest);
    this.selectedSkills = webForWeather(new Set(this.decision.selectedSkills), weather);
    // A platform's turn is grounded without the apps' lines (proposals in the app, a companion beside him): its seat's prompt says where she is.
    this.backendInstructions = voiceTurnGrounding({ temporaryGuest: this.temporaryGuest || this.seat !== null, alone: this.alone, legacyGuest: this.legacyGuest,
      selectedSkills: this.selectedSkills, at: deps.now(), deviceContext: this.input.deviceContext });
    // A goal is the owner's own; with anyone else present the words may not be his.
    this.provisionalIntent = !this.alone || this.uncertainTranscript ? null : extractExplicitUserIntent(transcript, threadId, this.occurredAt);
    // Stage 2, step 8: a skill_* turn walks the tree.
    this.complexTurn = this.decision.conversationClass === 'skill_complex' || deps.memoryRecall?.walksTree?.(this.decision.conversationClass) === true;
    return {
      scopeKey, threadId, message: transcript, occurredAt: this.occurredAt, channel: 'voice', present: this.present, surface: 'voice',
      intents: this.legacyGuest ? [] : deps.cognitiveIntents.list(scopeKey, 'active'), provisionalIntent: this.provisionalIntent,
      timeZone: this.input.deviceContext?.timeZoneIdentifier, ...(this.openOnly ? { openOnly: true } : {}),
      participants: this.temporaryGuest ? [] : namedParticipants(deps.personIdentities, scopeKey, transcript),
      people: captured => this.people(captured), semantic: this.semanticAsk(), timing: this.input.timing,
    };
  }

  /** Every mode builds its memory through the same gate; while a name is unresolved between two remembered people, nothing is recalled. */
  private people(captured: CompanionStateSnapshot): Recall | undefined {
    if (this.guestPresence?.ambiguousName) return undefined;
    return seatPeople(this.seat, this.dependencies.people?.recall(this.scopeKey, captured, this.transcript, this.present), captured, this.present);
  }

  /** The model-assisted recall only for a turn that needs it (her memory, a skill turn), bounded; none for a legacy client's friend. */
  private semanticAsk(): TurnMemoryAsk['semantic'] {
    const wanted = this.semanticMemoryTurn || this.complexTurn || this.decision.selectedSkills.includes('conversation_memory');
    if (this.legacyGuest || !wanted) return null;
    const signal = this.input.observer?.signal;
    const { semanticMemoryTurn: memoryTurn, complexTurn } = this;
    return { options: { memoryTurn, complexTurn, voiceClass: this.decision.conversationClass, ...(signal ? { signal } : {}) },
      span: { memoryTurn, complexTurn }, bounded: work => this.bounded('recall_timeout', work, () => null) };
  }

  begin(memory: StartedTurnMemory): void { this.memory = memory; }

  /**
   * Fixed first, what changes last: her profile follows the fixed blocks, the state opens the turn's context. The slim path drops owner
   * state, never the identity; the full profile is for the owner alone; a guest (a friend's call, someone else on a platform) has a guest's.
   */
  identityAsk(memory: StartedTurnMemory): TurnIdentityAsk {
    const { dependencies: deps, scopeKey } = this;
    const full = this.selectedSkills.has('conversation_memory') && this.alone;
    const parts = () => (this.guestVoice ? identityOnly(shannonIdentityPrompt('guest'))
      : full ? deps.knowledgeStore?.promptProjectionParts(scopeKey) ?? companionIdentityPrompt(memory.captured)
        : identityOnly(shannonIdentityPrompt('owner', { othersPresent: !this.alone })));
    return { scopeKey, parts, projected: !this.temporaryGuest, alone: this.alone };
  }

  /** What she may read: nothing for a legacy client's friend, nor on a platform unless the owner alone hears her (as its typed turn). */
  capabilityAsk(): TurnCapabilityAsk | null {
    const ownerWork = !this.seat || this.alone;
    if (this.legacyGuest || !ownerWork) return null;
    const { dependencies: deps, scopeKey, transcript } = this;
    const skills = this.selectedSkills;
    const upcoming = this.temporaryGuest ? false : this.alone ? true : 'guarded' as const;
    return { scopeKey, message: transcript, readers: deps, collectReadSources: Boolean(this.fca && this.fcaInput && !this.unclearTranscript),
      selection: { aetherNotes: skills.has('aether_notes'), voyagerTasks: skills.has('voyager_tasks'), notion: this.notionTurn, upcoming },
      bounded: work => this.input.timing.measure('capability', () => this.bounded('capability_timeout', work, () => NO_CAPABILITY_CONTEXT)) };
  }

  compose(parts: TurnParts): null {
    this.input.observer?.signal?.throwIfAborted();
    this.composed = composeVoiceTurn(this, parts);
    return null;
  }

  async speak(): Promise<void> { this.spoken = await speakVoiceTurn(this); }

  close(): Promise<ApiResponse> { return answerVoiceTurn(this); }

  abandon(): void { this.composed?.fcaTurn?.abort(); }
}

