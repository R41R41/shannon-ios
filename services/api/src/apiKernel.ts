import {
  InMemoryCompanionStateStore,
  assembleShannonSystemPrompt,
  createShannonMessageEmotion,
  projectEmotionReaction,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import { agentTaskPromptProjection } from './apiPromptProjection.js';
export { agentTaskPromptProjection } from './apiPromptProjection.js';
import { dispatchAgentRequest } from './apiAgentRoutes.js';
import { dispatchDataRequest } from './apiDataRoutes.js';
import { dispatchOrganizeRequest } from './apiOrganizeRoutes.js';
import { dispatchVoiceTurn } from './apiVoiceTurns.js';
import {
  dispatchLiveVoiceRequest,
  realtimeVoiceSessionProjection,
  type VoiceParticipantMode,
} from './apiLiveVoice.js';
import {
  appendWebSources,
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
import { LocalStubChatModel, type ShannonChatAttachment, type ShannonChatModel } from './chatModel.js';
import { LocalVoiceDecisionGateway, type VoiceDecisionGateway } from './voiceDecision.js';
import { InMemoryConversationStore, type ConversationStore } from './conversationStore.js';
import type { ApiRequest, ApiResponse, ChatRequest, ChatResponse, StateEventRequest } from './contracts.js';
import {
  ShannonMemoryService,
  type MemoryAction,
  type ShannonMemoryStore,
} from './memoryService.js';
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
import { randomUUID } from 'node:crypto';
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';
import { conversationCapabilityPrompt } from './conversationCapabilities.js';
import { prepareConversationOrganize } from './conversationOrganize.js';
import { executeConversationCommand } from './conversationCommands.js';
import { visibleConversationHistory, mayUseThreadSummary } from './memoryVisibility.js';
import type { TestFlightDeliveryReader } from './testflightDeliveryStore.js';
import type { DailyMindReader } from './dailyMind.js';
import type { WorldSubscriptionReader } from './worldStore.js';
import { SQLitePersonIdentityStore, type PersonIdentityStore } from './personIdentity.js';
import {
  extractExplicitUserIntent,
  InMemoryCognitiveIntentStore,
  type CognitiveIntentStore,
} from './cognitiveIntent.js';
import { recordCompletedCognitiveCycle } from './cognitiveCycle.js';
import {
  DisabledVoyagerTaskDestination,
  DisabledVoyagerCatalog,
  InMemoryOrganizeStore,
  LocalOrganizeExtractor,
  OrganizeError,
  isExplicitVoyagerUpdateRequest,
  isOrganizeCommand,
  type OrganizeDecision,
  type OrganizeExtractor,
  type OrganizeStore,
  type VoyagerTaskDestination,
  type VoyagerCatalog,
  type VoyagerTaskProjection,
} from './organize.js';
import {
  InMemoryVoiceIdentityStore,
  isShannonRealtimeVoiceId,
  type ShannonVoiceIdentityMode,
  type ShannonVoiceIdentityStore,
  voiceIdentityResponse,
} from './voiceIdentity.js';
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
  }

  realtimeVoiceSession(scopeKey: string, requestedThreadId?: string, options: {
    clientDelegation?: boolean;
    participantMode?: VoiceParticipantMode;
    brightVoice?: boolean;
  } = {}): { threadId: string; instructions: string; voice: string } {
    return realtimeVoiceSessionProjection(scopeKey, requestedThreadId, options, {
      stateStore: this.stateStore,
      conversationStore: this.conversationStore,
      knowledgeStore: this.knowledgeStore,
      dailyMind: this.dailyMind,
      now: this.now,
      voice: this.voiceIdentity.read(scopeKey).effectiveVoice,
      cognitiveIntents: this.cognitiveIntents,
    });
  }

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    if (request.method === 'GET' && request.path === '/health') {
      return {
        status: 200,
        body: {
          ok: true,
          service: 'shannon-ios-api',
          mode: 'local',
          llm: { mode: this.chatModel.mode, model: this.chatModel.model },
          voiceRouting: { mode: this.voiceDecision.mode, model: this.voiceDecision.model },
          background: { mode: this.background.mode },
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/state') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.stateStore.snapshot(scopeKey) };
    }

    if (request.method === 'GET' && request.path === '/v1/voice/identity') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: voiceIdentityResponse(this.voiceIdentity.read(scopeKey)) };
    }

    if (request.method === 'POST' && request.path === '/v1/voice/identity') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const mode = request.body.mode;
      const selectedVoice = request.body.selectedVoice;
      const supportedVoice = isShannonRealtimeVoiceId(selectedVoice) ? selectedVoice : null;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (mode !== 'automatic' && mode !== 'manual') return badRequest('mode is invalid');
      if (mode === 'automatic' && selectedVoice !== undefined && selectedVoice !== null) {
        return badRequest('selectedVoice must be empty in automatic mode');
      }
      if (mode === 'manual' && !supportedVoice) {
        return badRequest('selectedVoice is invalid');
      }
      const preference = this.voiceIdentity.save(
        scopeKey,
        mode as ShannonVoiceIdentityMode,
        mode === 'manual' ? supportedVoice : null,
        this.now(),
      );
      return { status: 200, body: voiceIdentityResponse(preference) };
    }

    if (request.method === 'GET' && request.path === '/v1/conversation') {
      const scopeKey = request.query?.get('scopeKey');
      const threadId = request.query?.get('threadId')?.trim();
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const resolvedThreadId = this.conversationStore.threadId(scopeKey, threadId);
      return {
        status: 200,
        body: {
          threadId: resolvedThreadId,
          messages: this.conversationStore.conversationHistory(scopeKey, resolvedThreadId),
          state: this.stateStore.snapshot(scopeKey),
        },
      };
    }

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
        body: this.testFlightDelivery?.dashboard(30, scopeKey) ?? {
          condition: 'waiting',
          latestBuildVersion: null,
          lastCheckedAt: null,
          activeFailureCode: null,
          history: [],
          release: {
            platform: 'ios', buildVersion: null,
            gates: ['build', 'archive', 'upload', 'processing', 'assignment', 'install', 'smoke']
              .map(key => ({ key, status: 'pending', completedAt: null })),
          },
        },
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

    const dataResponse = dispatchDataRequest(request, {
      stateStore: this.stateStore,
      conversationStore: this.conversationStore,
      memoryStore: this.memoryStore,
      knowledgeStore: this.knowledgeStore,
      initiativeInbox: this.initiativeInbox,
      aetherProposals: this.aetherProposals,
      personIdentities: this.personIdentities,
      worldSubscriptions: this.worldSubscriptions,
      cognitiveIntents: this.cognitiveIntents,
      now: this.now,
    });
    if (dataResponse) return dataResponse;

    const liveVoiceResponse = dispatchLiveVoiceRequest(request, {
      chatModel: this.chatModel,
      voiceDecision: this.voiceDecision,
      stateStore: this.stateStore,
      conversationStore: this.conversationStore,
      knowledgeStore: this.knowledgeStore,
      dailyMind: this.dailyMind,
      agentTasks: this.agentTasks,
      aetherContext: this.aetherContext, voyagerCatalog: this.voyagerCatalog,
      aetherProposals: this.aetherProposals, organizeStore: this.organizeStore,
      personIdentities: this.personIdentities,
      cognitiveIntents: this.cognitiveIntents,
      now: this.now,
    });
    if (liveVoiceResponse) return await liveVoiceResponse;

    const turnResponse = dispatchVoiceTurn(request, { stateStore: this.stateStore,
      conversationStore: this.conversationStore, background: this.background, now: this.now });
    if (turnResponse) return turnResponse;

    if (request.method === 'POST' && request.path === '/v1/chat') {
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
      if (body.webSearch !== undefined && typeof body.webSearch !== 'boolean') {
        return badRequest('webSearch must be a boolean');
      }
      const message = body.message.trim();
      const threadId = this.conversationStore.threadId(body.scopeKey, body.threadId?.trim());
      const explicitCommand = executeConversationCommand(body.scopeKey, threadId,
        { id: randomUUID(), text: message }, this.now(), {
          stateStore: this.stateStore, conversationStore: this.conversationStore,
          organizeStore: this.organizeStore, aetherProposals: this.aetherProposals,
        });
      const captured = this.stateStore.snapshot(body.scopeKey);
      const occurredAt = this.now();
      const provisionalIntent = extractExplicitUserIntent(message, threadId, occurredAt);
      const cognitiveContext = prepareTurnCognitiveContext(captured, this.conversationStore, {
        scopeKey: body.scopeKey, message, occurredAt, channel: 'text',
        threadId,
        intents: this.cognitiveIntents.list(body.scopeKey, 'active'),
        provisionalIntent,
        participants: this.personIdentities.list(body.scopeKey).filter(person => person.status === 'active' && message.includes(person.displayName)).map(person => person.displayName),
      });
      const basePrompt = this.knowledgeStore?.promptProjection(body.scopeKey)
        ?? assembleShannonSystemPrompt(captured);
      const capabilityContext = explicitCommand ? '' : conversationCapabilityPrompt(body.scopeKey, message,
        { aetherContext: this.aetherContext, voyagerCatalog: this.voyagerCatalog });
      const capabilityPrompt = typeof capabilityContext === 'string' ? capabilityContext : await capabilityContext;
      const dailyMindPrompt = this.dailyMind?.promptFor(body.scopeKey, this.now()) ?? '';
      const systemPrompt = [
        basePrompt, cognitiveContext.prompt, dailyMindPrompt, capabilityPrompt,
        agentTaskPromptProjection(this.agentTasks.list(body.scopeKey), threadId),
      ].filter(Boolean).join('\n\n');
      if (explicitCommand || isOrganizeCommand(message)) {
        let { session, reply } = explicitCommand
          ? { session: explicitCommand.organizeSession, reply: explicitCommand.reply }
          : await prepareConversationOrganize(body.scopeKey, threadId, occurredAt,
            this.conversationStore, this.organizeStore, this.organizeExtractor);
        const messageEmotion = createShannonMessageEmotion(
          projectEmotionReaction(captured, message), captured.temperament,
          { userMessage: message, shannonReply: reply },
        );
        const completedTurn = {
          scopeKey: body.scopeKey, threadId, capturedState: captured, userMessage: message, shannonReply: reply,
          messageEmotion, completedAt: occurredAt,
        };
        const experience = this.background.recordTurn(completedTurn);
        recordCompletedCognitiveCycle(this.cognitiveIntents, body.scopeKey, cognitiveContext.frame, provisionalIntent, experience.id, {
          threadId, channel: 'text', action: 'command', summary: '確認済みの会話コマンドを処理した。', occurredAt,
        });
        const lastMessage = this.conversationStore.conversationHistory(body.scopeKey, threadId).at(-1);
        if (lastMessage && session) session = this.organizeStore.setCommandThrough(body.scopeKey, session.id, lastMessage.id, this.now());
        this.background.schedule(completedTurn, experience.id);
        return {
          status: 200,
          body: {
            mode: this.chatModel.mode, model: this.chatModel.model, reply, threadId,
            snapshotVersion: captured.version, messageEmotion, systemPrompt, state: captured,
            thread: this.conversationStore.listThreads(body.scopeKey).find(thread => thread.threadId === threadId),
            ...(session ? { uiBlocks: [{ type: 'organize_session' as const, session }] } : {}),
          } satisfies ChatResponse,
        };
      }
      const priorThreadSummary = mayUseThreadSummary(captured) ? this.conversationStore.threadSummary(body.scopeKey, threadId) : undefined;
      const completion = await this.chatModel.generate({
        scopeKey: body.scopeKey,
        systemPrompt,
        history: visibleConversationHistory(captured, this.conversationStore, body.scopeKey, threadId),
        ...(priorThreadSummary ? { priorThreadSummary } : {}),
        message,
        ...(attachments.length ? { attachments } : {}),
        ...(body.webSearch === true ? { useWebSearch: true } : {}),
        generateThreadTitle: this.conversationStore.needsAutomaticThreadTitle(body.scopeKey, threadId),
      });
      const reply = appendWebSources(completion.reply, completion.webSources ?? []);
      const suppressAgentTaskProposal = isExplicitVoyagerUpdateRequest(message);
      const messageEmotion = createShannonMessageEmotion(
        projectEmotionReaction(captured, message),
        captured.temperament,
        { userMessage: message, shannonReply: reply },
      );
      const response: ChatResponse = {
        mode: completion.mode,
        model: completion.model,
        reply,
        threadId,
        snapshotVersion: captured.version,
        messageEmotion,
        systemPrompt,
        state: captured,
        ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
      };
      const completedTurn = {
        scopeKey: body.scopeKey,
        threadId,
        capturedState: captured,
        userMessage: message,
        shannonReply: reply,
        ...(completion.threadTitle ? { threadTitle: completion.threadTitle } : {}),
        ...(completion.threadSummary ? { threadSummary: completion.threadSummary } : {}),
        messageEmotion: response.messageEmotion,
        ...(completion.taskDecision ? { taskDecision: completion.taskDecision } : {}),
        ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
        completedAt: occurredAt,
      };
      const experience = this.background.recordTurn(completedTurn);
      const completedIntent = recordCompletedCognitiveCycle(this.cognitiveIntents, body.scopeKey, cognitiveContext.frame, provisionalIntent, experience.id, {
        threadId, channel: 'text', action: 'respond', summary: '現在の状況・記憶・意図を使って返答した。', occurredAt,
      }, provisionalIntent ? completion.intentPlan : undefined);
      if (completion.taskProposal && !suppressAgentTaskProposal) {
        response.uiBlocks = [{
          type: 'agent_task_proposal',
          proposalId: randomUUID(),
          ...(completedIntent ? { cognitiveIntentID: completedIntent.id } : {}),
          ...completion.taskProposal,
        }];
      }
      response.thread = this.conversationStore.listThreads(body.scopeKey).find(thread => thread.threadId === threadId);
      this.background.schedule(completedTurn, experience.id);
      return { status: 200, body: response };
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }
  waitForBackground(scopeKey: string): Promise<void> {
    return this.background.waitForIdle(scopeKey);
  }

}

export function createLocalApiKernel(
  now: CompanionClock = () => new Date().toISOString(),
  options: ShannonApiKernelOptions = {},
): ShannonApiKernel {
  return new ShannonApiKernel(options.stateStore ?? new InMemoryCompanionStateStore(now), now, options);
}
