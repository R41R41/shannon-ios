import {
  InMemoryCompanionStateStore,
  withoutUnshownTitles,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import { agentTaskPromptProjection } from './apiPromptProjection.js';
import { presentCompanionState } from './companionPresence.js';
import { emotionTiming } from './emotionTiming.js';
export { agentTaskPromptProjection } from './apiPromptProjection.js';
import { dispatchAgentRequest } from './apiAgentRoutes.js';
import { dispatchDataRequest } from './apiDataRoutes.js';
import { dispatchOrganizeRequest } from './apiOrganizeRoutes.js';
import { dispatchVoiceTurn } from './apiVoiceTurns.js';
import { dispatchPreferenceRequest } from './apiPreferenceRoutes.js';
import { dispatchLiveVoiceRequest, realtimeVoiceSessionProjection, type LiveVoiceStreamObserver, type VoiceParticipantMode } from './apiLiveVoice.js';
import {
  badRequest,
  objectBody,
  validAgentCommandType,
  validAgentHostHint,
  validBoundedString,
  validEvent,
  validHostEvents,
  validMemoryAction,
  validPlan,
  validScopeKey,
  validThreadTitle,
  validVoyagerTaskProjection,
  validatedChatAttachments,
} from './apiValidation.js';
import { BackgroundUpdateCoordinator, type TurnBackgroundService } from './backgroundUpdates.js';
import { LocalStubChatModel, type ShannonChatModel } from './chatModel.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway } from './voiceDecision.js';
import { InMemoryConversationStore, type ConversationStore } from './conversationStore.js';
import type { ApiRequest, ApiResponse, ChatRequest, StateEventRequest } from './contracts.js';
import { ShannonMemoryService, type MemoryAction, type ShannonMemoryStore } from './memoryService.js';
import { dispatchConversationRead } from './apiConversationRead.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { InitiativeInbox } from './initiativeStore.js';
import type { AetherContextReader } from './aetherContext.js';
import { DisabledAetherProposalStore, type AetherProposalStore } from './aetherProposal.js';
import {
  InMemoryAgentTaskStore,
  type AgentCommandType,
  type AgentPlanItem,
  type AgentTask,
  type AgentTaskStore,
  type HostAgentEvent,
} from './agentTaskStore.js';
import { validatedPlaceSearchOptions } from './placeDiscovery.js';
import { chatAudienceTurn } from './chatAudience.js';
import { validChatStream } from './chatSentenceStream.js';
import { conversationToolServer, type ConversationToolServer } from './shannonToolSession.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from './turnDeadline.js';
import type { TurnMemoryRecall } from './turnMemoryRecall.js';
import { type NotionTurnReader } from './conversationCapabilities.js';
import { WAITING_TESTFLIGHT_DASHBOARD, type TestFlightDeliveryReader } from './testflightDeliveryStore.js';
import { dispatchPeopleMemoryRequest } from './apiPeopleMemoryRoutes.js';
import { PeopleMemory } from './peopleMemory.js';
import { SQLitePeopleMemoryStore, type PeopleMemoryStore } from './peopleMemoryStore.js';
import type { DailyMindReader } from './dailyMind.js';
import type { WorldSubscriptionReader } from './worldStore.js';
import { SQLitePersonIdentityStore, type PersonIdentityStore } from './personIdentity.js';
import {
  InMemoryConversationOrchestrationStore,
  type ConversationOrchestrationStore,
} from './conversationOrchestration.js';
import {
  InMemoryCognitiveIntentStore,
  type CognitiveIntentStore,
} from './cognitiveIntent.js';
import { createInMemoryAutonomyService, type ShannonAutonomyService } from './autonomyService.js';
import { dispatchBodyRequest, isBodyRoute } from './apiBodyRoutes.js';
import { CALENDAR_UPCOMING_PATH, dispatchCalendarRequest, localOwnerUpcoming, type OwnerUpcoming } from './calendarRoutes.js';
import { ShannonBody, type ShannonBodyOptions } from './shannonBody.js';
import {
  DisabledVoyagerTaskDestination,
  DisabledVoyagerCatalog,
  InMemoryOrganizeStore,
  LocalOrganizeExtractor,
  OrganizeError,
  type OrganizeDecision,
  type OrganizeExtractor,
  type OrganizeStore,
  type VoyagerTaskDestination,
  type VoyagerCatalog,
  type VoyagerTaskProjection,
} from './organize.js';
import { InMemoryVoiceIdentityStore, type ShannonVoiceIdentityStore } from './voiceIdentity.js';
import { OwnOutreach, type OwnOutreachReader } from './ownOutreach.js';
import { voiceSessionCalls } from './ownerCallElsewhere.js';
import {
  NO_LOOK, answerTextCommand, beginTextTurn, storedBySurface, textTurnIdentityAndCapability, textTurnSystemPrompt, type TextTurnInput, type TextTurnResult,
} from './apiTextTurn.js';
import { randomUUID } from 'node:crypto';
import { commitReplyEmotionLater, replyFeelingOffer, resolveTextReplyEmotion } from './companionPresence.js';
import { generateChatTurn, withSentenceStream } from './chatSentenceStream.js';
import { conversationTools, toolTraceReader } from './shannonToolSession.js';
import { withCapabilitySources } from './conversationCapabilities.js';
import { usableThreadSummary } from './memoryVisibility.js';
import { conversationReplay } from './conversationWindow.js';
import { recordConversationProposal } from './conversationOrchestration.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';
import { isExplicitVoyagerUpdateRequest } from './organize.js';
import { optionalPlaceDiscoverySkill, placeSkillReply } from './placeDiscoverySkill.js';
import type { ChatResponse } from './contracts.js';
export type { TextTurnInput, TextTurnResult, TextTurnSurface } from './apiTextTurn.js';
export interface ShannonApiKernelOptions {
  chatModel?: ShannonChatModel;
  voiceDecision?: VoiceDecisionGateway;
  stateStore?: CompanionStateStore;
  conversationStore?: ConversationStore;
  background?: TurnBackgroundService;
  memoryStore?: ShannonMemoryStore;
  knowledgeStore?: KnowledgeStore;
  initiativeInbox?: InitiativeInbox;
  aetherContext?: AetherContextReader;
  aetherProposals?: AetherProposalStore;
  agentTasks?: AgentTaskStore;
  testFlightDelivery?: TestFlightDeliveryReader;
  defaultAgentHost?: string;
  dailyMind?: DailyMindReader;
  organizeStore?: OrganizeStore;
  organizeExtractor?: OrganizeExtractor;
  voyagerDestination?: VoyagerTaskDestination;
  voyagerCatalog?: VoyagerCatalog;
  voiceIdentity?: ShannonVoiceIdentityStore;
  personIdentities?: PersonIdentityStore;
  worldSubscriptions?: WorldSubscriptionReader;
  cognitiveIntents?: CognitiveIntentStore;
  conversationOrchestration?: ConversationOrchestrationStore;
  memoryRecall?: TurnMemoryRecall;
  peopleMemory?: PeopleMemoryStore;
  autonomy?: ShannonAutonomyService;
  notion?: NotionTurnReader; body?: ShannonBodyOptions; upcoming?: OwnerUpcoming; /** What she did on her own (`ownOutreach.ts`). */ ownOutreach?: OwnOutreachReader;
  /** What her Minecraft body reported about the requests it was given (`minecraftBodyRequests.ts`), for a turn the owner alone reads. */
  minecraftRequests?: { promptBlock(scopeKey: string, at: string): string } | null;
}
export class ShannonApiKernel {
  private readonly chatModel: ShannonChatModel;
  private readonly voiceDecision: VoiceDecisionGateway;
  private readonly conversationStore: ConversationStore;
  private readonly background: TurnBackgroundService;
  private readonly memoryStore: ShannonMemoryStore;
  private readonly knowledgeStore: KnowledgeStore | null;
  private readonly initiativeInbox: InitiativeInbox | null;
  private readonly aetherContext: AetherContextReader | null;
  private readonly aetherProposals: AetherProposalStore;
  private readonly agentTasks: AgentTaskStore;
  private readonly testFlightDelivery: TestFlightDeliveryReader | null;
  private readonly defaultAgentHost: string | null;
  private readonly dailyMind: DailyMindReader | null;
  private readonly organizeStore: OrganizeStore;
  private readonly organizeExtractor: OrganizeExtractor;
  private readonly voyagerDestination: VoyagerTaskDestination;
  private readonly voyagerCatalog: VoyagerCatalog;
  private readonly voiceIdentity: ShannonVoiceIdentityStore;
  private readonly personIdentities: PersonIdentityStore;
  private readonly worldSubscriptions: WorldSubscriptionReader | null;
  private readonly cognitiveIntents: CognitiveIntentStore;
  private readonly conversationOrchestration: ConversationOrchestrationStore;
  private readonly memoryRecall: TurnMemoryRecall | null;
  private readonly people: PeopleMemory;
  private readonly autonomy: ShannonAutonomyService;
  private readonly notion: NotionTurnReader | null; private readonly body: ShannonBody; private readonly upcoming: OwnerUpcoming; private readonly ownOutreach: OwnOutreach | null;
  private readonly minecraftRequests: { promptBlock(scopeKey: string, at: string): string } | null;
  /** What the server knows when it offers her tools: others present, and what her writes must not repeat (`shannonToolSession.ts`). */
  private readonly toolServer: ConversationToolServer;
  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly now: CompanionClock,
    options: ShannonApiKernelOptions = {},
  ) {
    this.chatModel = options.chatModel ?? new LocalStubChatModel();
    this.voiceDecision = options.voiceDecision ?? new LocalVoiceDecisionGateway();
    this.conversationStore = options.conversationStore ?? new InMemoryConversationStore();
    this.background = options.background
      ?? new BackgroundUpdateCoordinator(this.stateStore, this.conversationStore);
    this.memoryStore = options.memoryStore
      ?? new ShannonMemoryService(this.stateStore, this.conversationStore, this.now);
    this.knowledgeStore = options.knowledgeStore ?? null;
    this.initiativeInbox = options.initiativeInbox ?? null;
    this.aetherContext = options.aetherContext ?? null;
    this.aetherProposals = options.aetherProposals ?? new DisabledAetherProposalStore();
    this.agentTasks = options.agentTasks ?? new InMemoryAgentTaskStore();
    this.testFlightDelivery = options.testFlightDelivery ?? null;
    this.defaultAgentHost = validAgentHostHint(options.defaultAgentHost)
      ? options.defaultAgentHost.trim()
      : null;
    this.dailyMind = options.dailyMind ?? null;
    this.organizeStore = options.organizeStore ?? new InMemoryOrganizeStore();
    this.organizeExtractor = options.organizeExtractor ?? new LocalOrganizeExtractor();
    this.voyagerDestination = options.voyagerDestination ?? new DisabledVoyagerTaskDestination();
    this.voyagerCatalog = options.voyagerCatalog ?? new DisabledVoyagerCatalog();
    this.voiceIdentity = options.voiceIdentity ?? new InMemoryVoiceIdentityStore();
    this.personIdentities = options.personIdentities ?? new SQLitePersonIdentityStore(':memory:');
    this.worldSubscriptions = options.worldSubscriptions ?? null;
    this.cognitiveIntents = options.cognitiveIntents ?? new InMemoryCognitiveIntentStore();
    this.conversationOrchestration = options.conversationOrchestration ?? new InMemoryConversationOrchestrationStore();
    this.memoryRecall = options.memoryRecall ?? null;
    this.notion = options.notion ?? null;
    this.minecraftRequests = options.minecraftRequests ?? null;
    this.people = new PeopleMemory(options.peopleMemory ?? new SQLitePeopleMemoryStore(':memory:'), this.stateStore);
    this.autonomy = options.autonomy ?? createInMemoryAutonomyService(this.now, { agentTasks: this.agentTasks, defaultThread: scope => this.conversationStore.threadId(scope) });
    this.upcoming = options.upcoming ?? localOwnerUpcoming(this.stateStore, this.now); this.ownOutreach = options.ownOutreach ? new OwnOutreach(options.ownOutreach, this.now) : null;
    this.body = new ShannonBody({ ...options.body, stateStore: this.stateStore, autonomy: this.autonomy, conversationStore: this.conversationStore, now: this.now });
    this.toolServer = conversationToolServer(this.body, this.stateStore, this.conversationStore, this.now);
    this.background = this.toolServer.turns.watching(this.background); // Each stored turn takes what her tools did with it.
  }
  get voiceSessions() { return voiceSessionCalls(this.body.ownerCalls, this.now); } // A voice session while the owner is in a call elsewhere.
  realtimeVoiceSession(scopeKey: string, requestedThreadId?: string, options: {
    clientDelegation?: boolean;
    participantMode?: VoiceParticipantMode;
    brightVoice?: boolean;
  } = {}): { threadId: string; instructions: string; voice: string } {
    if (options.participantMode === 'guest') this.toolServer.audience.noteOthers(scopeKey);
    return realtimeVoiceSessionProjection(scopeKey, requestedThreadId, options, {
      stateStore: this.stateStore,
      conversationStore: this.conversationStore,
      knowledgeStore: this.knowledgeStore,
      dailyMind: this.dailyMind, autonomy: this.autonomy,
      now: this.now,
      voice: this.voiceIdentity.read(scopeKey).effectiveVoice,
      cognitiveIntents: this.cognitiveIntents,
    });
  }

  async streamLiveVoiceDelegation(request: ApiRequest, observer: LiveVoiceStreamObserver): Promise<ApiResponse> {
    const response = dispatchLiveVoiceRequest(request, this.liveVoiceDependencies(), observer);
    return response ? await response : { status: 404, body: { error: 'NOT_FOUND' } };
  }
  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const preferenceResponse = dispatchPreferenceRequest(request, {
      chatModel: this.chatModel, voiceDecision: this.voiceDecision, background: this.background,
      voiceIdentity: this.voiceIdentity, now: this.now,
    });
    if (preferenceResponse) return preferenceResponse;
    if (isBodyRoute(request.path)) return dispatchBodyRequest(request, this.body);
    if (request.path === CALENDAR_UPCOMING_PATH) return dispatchCalendarRequest(request, this.upcoming, this.now);

    if (request.method === 'GET' && request.path === '/v1/state') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: presentCompanionState(this.stateStore.snapshot(scopeKey), this.now()) };
    }

    const conversationRead = dispatchConversationRead(request, { conversationStore: this.conversationStore, stateStore: this.stateStore, cognitiveIntents: this.cognitiveIntents, now: this.now });
    if (conversationRead) return conversationRead;

    if (request.method === 'GET' && request.path === '/v1/agent/tasks') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: { tasks: this.agentTasks.list(scopeKey) } };
    }

    if (request.method === 'GET' && request.path === '/v1/testflight/delivery') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return {
        status: 200,
        body: this.testFlightDelivery?.dashboard(30, scopeKey) ?? WAITING_TESTFLIGHT_DASHBOARD,
      };
    }

    if (request.method === 'POST' && request.path === '/v1/testflight/delivery/confirm') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!validBoundedString(request.body.buildVersion, 80)) return badRequest('buildVersion is invalid');
      if (request.body.gate !== 'install' && request.body.gate !== 'smoke') return badRequest('gate is invalid');
      if (!this.testFlightDelivery?.confirmGate) return { status: 503, body: { error: 'TESTFLIGHT_DELIVERY_UNAVAILABLE' } };
      try {
        return {
          status: 200,
          body: this.testFlightDelivery.confirmGate(scopeKey, request.body.buildVersion, request.body.gate, this.now()),
        };
      } catch (error) {
        if (error instanceof Error && (error.message === 'TESTFLIGHT_BUILD_NOT_DISTRIBUTED'
          || error.message === 'TESTFLIGHT_INSTALL_REQUIRED')) {
          return { status: 409, body: { error: error.message } };
        }
        throw error;
      }
    }

    if (request.path.startsWith('/v1/organize/') || request.path.startsWith('/v1/integrations/voyager/')) {
      const organizeResponse = await dispatchOrganizeRequest(request, {
        organizeStore: this.organizeStore,
        voyagerCatalog: this.voyagerCatalog,
        voyagerDestination: this.voyagerDestination,
        now: this.now,
      });
      if (organizeResponse) return organizeResponse;
    }

    const agentResponse = dispatchAgentRequest(request, {
      agentTasks: this.agentTasks,
      cognitiveIntents: this.cognitiveIntents,
      defaultAgentHost: this.defaultAgentHost,
      now: this.now,
    });
    if (agentResponse) return agentResponse;

    const peopleResponse = dispatchPeopleMemoryRequest(request, { people: this.people, stateStore: this.stateStore, chatModel: this.chatModel, now: this.now, impressions: this.conversationStore.impressionStore?.() });
    if (peopleResponse) return await peopleResponse;

    const dataResponse = dispatchDataRequest(request, {
      stateStore: this.stateStore,
      conversationStore: this.conversationStore,
      memoryStore: this.memoryStore,
      knowledgeStore: this.knowledgeStore,
      initiativeInbox: this.initiativeInbox,
      aetherProposals: this.aetherProposals,
      personIdentities: this.personIdentities,
      worldSubscriptions: this.worldSubscriptions,
      cognitiveIntents: this.cognitiveIntents, autonomy: this.autonomy,
      now: this.now,
    });
    if (dataResponse) return dataResponse;

    const liveVoiceResponse = dispatchLiveVoiceRequest(request, this.liveVoiceDependencies());
    if (liveVoiceResponse) return await liveVoiceResponse;

    const turnResponse = dispatchVoiceTurn(request, { stateStore: this.stateStore, chatModel: this.chatModel,
      conversationStore: this.conversationStore, background: this.background, now: this.now, reactions: this.body.reactions, looks: this.body.turnLooks });
    if (turnResponse) return await turnResponse;

    if (request.method === 'POST' && request.path === '/v1/chat') {
      const deadline = new TurnDeadline(TEXT_TURN_DEADLINE, () => Date.parse(this.now())); // From arrival: recall and context count too.
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const body = request.body as unknown as ChatRequest;
      if (!validScopeKey(body.scopeKey)) return badRequest('scopeKey is required');
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8_000) {
        return badRequest('message must be 1..8000 characters');
      }
      const attachments = validatedChatAttachments(body.attachments);
      if (attachments === null) {
        return badRequest('attachments must contain at most 4 UTF-8 text files, 24000 characters each and 48000 characters total');
      }
      if (body.webSearch !== undefined && typeof body.webSearch !== 'boolean') return badRequest('webSearch must be a boolean');
      // Who can see or hear the reply. Absent: the owner alone, as before the field existed.
      const audience = chatAudienceTurn(body.audience);
      if (!audience || !validChatStream(body.stream)) return badRequest(audience ? 'stream is invalid' : 'audience is invalid');
      if (!audience.alone) this.toolServer.audience.noteOthers(body.scopeKey);
      const message = body.message.trim();
      const placeOptions = validatedPlaceSearchOptions(message, body.placeLocation, this.now());
      if (placeOptions === false) return badRequest('placeLocation is invalid');
      const threadId = this.conversationStore.threadId(body.scopeKey, body.threadId?.trim());
      return (await this.textTurn({ scopeKey: body.scopeKey, threadId, message, audience, body, attachments, placeOptions, deadline, request })).response;
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }

  /**
   * One text turn of the conversation: recall, replay, identity, mood, tools, storing and background work. `POST /v1/chat`
   * is its first caller; another surface (her Minecraft body, a platform reply) passes its audience policy and a
   * `surface`. Its stages up to the model call are in `apiTextTurn.ts`; the awaits, the look, the call, her reply's feeling
   * and storing are here, in the order they always had.
   */
  async textTurn(input: TextTurnInput): Promise<TextTurnResult> {
    const { audience, threadId, message, attachments, placeOptions, request, surface } = input;
    const body = input.body;
    const deadline = input.deadline ?? new TurnDeadline(TEXT_TURN_DEADLINE, () => Date.parse(this.now()));
    const deps = this.textTurnDependencies();
    const begun = beginTextTurn(deps, input);
    const { occurredAt, captured, provisionalIntent, peopleRecall } = begun;
    const cognitiveContext = this.memoryRecall && !begun.explicitCommand && !begun.organizeTurn
      ? await this.memoryRecall.enrich(begun.deterministicContext, { scopeKey: body.scopeKey, message, snapshot: captured, threadId }) : begun.deterministicContext;
    const { basePrompt, capabilityContext } = textTurnIdentityAndCapability(deps, input, begun);
    const capability = capabilityContext instanceof Promise ? await capabilityContext : capabilityContext;
    // A surface has no look at the room or through the app.
    const roomLook = surface ? NO_LOOK : this.body.turnLooks.turn(body.scopeKey, message, occurredAt, audience.audience, request);
    const systemPrompt = textTurnSystemPrompt(deps, input, begun, { basePrompt, cognitiveContext, capability, roomLook });
    if (begun.explicitCommand || begun.organizeTurn) return answerTextCommand(deps, input, begun, cognitiveContext, systemPrompt);
    let { orchestrationState } = begun;
    const priorThreadSummary = usableThreadSummary(captured, this.conversationStore, body.scopeKey, threadId, audience.present);
    const placeSkill = placeOptions.placeSearch ? await optionalPlaceDiscoverySkill(this.chatModel, body.scopeKey, message, placeOptions.placeSearch) : null;
    const completion = await generateChatTurn(this.chatModel, request.chatSentences, { body, threadId, audience, capability, placeSearch: placeSkill !== null }, {
      scopeKey: body.scopeKey, // The history is a character budget; what fell out of it is covered by the replay summary.
      ...conversationReplay('text', captured, this.conversationStore, body.scopeKey, threadId, audience.present, undefined, toolTraceReader(this.toolServer, body.scopeKey))
        .request(placeSkill ? `${systemPrompt}\n\n${placeSkill.prompt}` : systemPrompt),
      ...(priorThreadSummary ? { priorThreadSummary } : {}),
      message,
      ...(attachments.length ? { attachments } : {}), ...roomLook.request, ...replyFeelingOffer(audience.alone), ...conversationTools(this.autonomy, body.scopeKey, 'text', audience.alone, this.toolServer, `${threadId}\n${message}`, deadline, undefined,
        // Game chat asks her Minecraft body through the turn's intent, not through her tools.
        surface && !surface.minecraftTools ? { withoutDomains: ['minecraft_body'] } : {}),
      ...(body.webSearch === true || placeSkill ? { useWebSearch: true } : {}),
      ...(surface?.offerMinecraftIntent ? { offerMinecraftIntent: true } : {}),
      // A surface's conversation has its own fixed title.
      generateThreadTitle: surface ? false : this.conversationStore.needsAutomaticThreadTitle(body.scopeKey, threadId),
    });
    const reply = completion.outOfTime ? completion.reply : placeSkillReply(withCapabilitySources(completion, capability), placeSkill);
    const suppressAgentTaskProposal = !audience.alone || Boolean(surface) || isExplicitVoyagerUpdateRequest(message);
    // Her feeling for this reply, from state already in hand; it is stored after the response.
    const { messageEmotion, expressiveEmotion } = resolveTextReplyEmotion({ snapshot: captured, userMessage: message, reply, now: occurredAt }, completion, audience.alone);
    const response: ChatResponse = {
      mode: completion.mode, model: completion.model, reply, threadId, audience: audience.audience,
      snapshotVersion: captured.version, messageEmotion, systemPrompt: withoutUnshownTitles(systemPrompt), // Her unshown titles stay on the server.
      state: presentCompanionState(captured, occurredAt, expressiveEmotion),
      ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
    };
    if (placeSkill?.places.length) response.uiBlocks = [{ type: 'place_search', places: placeSkill.places }];
    const completedTurn = {
      scopeKey: body.scopeKey,
      threadId,
      capturedState: captured,
      userMessage: message,
      shannonReply: reply,
      ...(surface ? { threadTitle: surface.threadTitle } : completion.threadTitle ? { threadTitle: completion.threadTitle } : {}),
      ...(completion.threadSummary ? { threadSummary: completion.threadSummary } : {}), ...audience.turnLabel,
      messageEmotion: response.messageEmotion,
      ...(completion.taskDecision ? { taskDecision: completion.taskDecision } : {}),
      ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
      completedAt: occurredAt, recalledMemoryIds: [...cognitiveContext.frame.recalledMemoryIDs, ...peopleRecall.ids], summaryContinuesChain: Boolean(priorThreadSummary && completion.threadSummary),
    };
    // Another surface decides where its turn is kept (her Minecraft body: the owner's platform thread, or person memory).
    const experience = surface ? storedBySurface(deps, surface, completedTurn) : this.background.recordTurn(completedTurn);
    if (experience) response.turnId = experience.id;
    const completedIntent = experience ? recordCompletedCognitiveCycle(this.cognitiveIntents, body.scopeKey, cognitiveContext.frame, provisionalIntent, experience.id, {
      threadId, channel: 'text', action: 'respond', summary: '現在の状況・記憶・意図を使って返答した。', occurredAt,
    }, provisionalIntent ? completion.intentPlan : undefined) : null;
    if (completion.taskProposal && !suppressAgentTaskProposal) {
      if (orchestrationState) {
        orchestrationState = this.conversationOrchestration.save(recordConversationProposal(
          orchestrationState, completion.taskProposal.goal, occurredAt, this.agentTasks.list(body.scopeKey),
        ));
      }
      response.uiBlocks = [...(response.uiBlocks ?? []), {
        type: 'agent_task_proposal',
        proposalId: orchestrationState?.resumeToken ?? randomUUID(),
        ...(completedIntent ? { cognitiveIntentID: completedIntent.id } : {}),
        ...completion.taskProposal,
      }];
    }
    response.thread = this.conversationStore.listThreads(body.scopeKey).find(thread => thread.threadId === threadId);
    Object.assign(response, roomLook.decide({ ...completion, reply }, threadId)); // One look, only if this turn offered it (conversationLooks.ts).
    if (experience) this.background.schedule(completedTurn, experience.id);
    // Her stored feeling toward the owner moves only on a turn that is his alone.
    if (audience.alone) commitReplyEmotionLater(this.stateStore, body.scopeKey, expressiveEmotion);
    return { response: withSentenceStream(completion, { status: 200, body: audience.visible(response) }), completion, ...(experience ? { experienceId: experience.id } : {}) };
  }

  private textTurnDependencies() {
    return { ...this.liveVoiceDependencies(), background: this.background, organizeExtractor: this.organizeExtractor, body: this.body, minecraftRequests: this.minecraftRequests };
  }

  private liveVoiceDependencies() {
    return {
      chatModel: this.chatModel, voiceDecision: this.voiceDecision,
      stateStore: this.stateStore, conversationStore: this.conversationStore,
      knowledgeStore: this.knowledgeStore, dailyMind: this.dailyMind, autonomy: this.autonomy, agentTasks: this.agentTasks,
      aetherContext: this.aetherContext, voyagerCatalog: this.voyagerCatalog, notion: this.notion, upcoming: this.upcoming,
      aetherProposals: this.aetherProposals, organizeStore: this.organizeStore,
      personIdentities: this.personIdentities, cognitiveIntents: this.cognitiveIntents, now: this.now,
      conversationOrchestration: this.conversationOrchestration, memoryRecall: this.memoryRecall, people: this.people, reactions: this.body.reactions, looks: this.body.turnLooks,
      toolServer: this.toolServer, ownerCalls: this.body.ownerCalls, ownOutreach: this.ownOutreach,
    };
  }
  waitForBackground(scopeKey: string): Promise<void> { return this.background.waitForIdle(scopeKey); }
}
export function createLocalApiKernel(now: CompanionClock = () => new Date().toISOString(), options: ShannonApiKernelOptions = {}): ShannonApiKernel {
  return new ShannonApiKernel(options.stateStore ?? new InMemoryCompanionStateStore(now, emotionTiming()), now, options);
}
