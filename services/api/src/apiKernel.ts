import {
  InMemoryCompanionStateStore,
  assembleShannonSystemPrompt,
  createShannonMessageEmotion,
  projectEmotionReaction,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateStore,
} from '@shannon/cognition';
import { BackgroundUpdateCoordinator, type TurnBackgroundService } from './backgroundUpdates.js';
import {
  LocalStubChatModel,
  type ShannonChatAttachment,
  type ShannonChatModel,
  type ShannonWebSource,
} from './chatModel.js';
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
import type { TestFlightDeliveryReader } from './testflightDeliveryStore.js';
import type { DailyMindReader } from './dailyMind.js';
import {
  DisabledVoyagerTaskDestination,
  DisabledVoyagerCatalog,
  InMemoryOrganizeStore,
  LocalOrganizeExtractor,
  OrganizeError,
  isOrganizeCommand,
  messagesAfterCursor,
  type OrganizeDecision,
  type OrganizeExtractor,
  type OrganizeStore,
  type VoyagerTaskDestination,
  type VoyagerCatalog,
  type VoyagerTaskProjection,
} from './organize.js';

function objectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validScopeKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

function validEvent(value: unknown): value is CompanionStateEvent {
  if (!objectBody(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'emotion-adjusted':
      return objectBody(value.delta)
        && optionalFiniteNumber(value.delta.valence)
        && optionalFiniteNumber(value.delta.arousal)
        && optionalFiniteNumber(value.delta.openness);
    case 'interest-observed':
      return typeof value.interest === 'string' && value.interest.trim().length > 0;
    case 'user-fact-upserted':
      return objectBody(value.fact)
        && typeof value.fact.id === 'string'
        && typeof value.fact.statement === 'string'
        && typeof value.fact.observedAt === 'string'
        && typeof value.fact.confidence === 'number'
        && Number.isFinite(value.fact.confidence);
    case 'relationship-upserted':
      return objectBody(value.relationship)
        && typeof value.relationship.id === 'string'
        && typeof value.relationship.statement === 'string'
        && typeof value.relationship.observedAt === 'string'
        && typeof value.relationship.confidence === 'number'
        && Number.isFinite(value.relationship.confidence);
    case 'memory-control-upserted':
      return objectBody(value.control)
        && typeof value.control.memoryId === 'string'
        && validMemoryKind(value.control.kind)
        && validMemoryStatus(value.control.status)
        && typeof value.control.pinned === 'boolean'
        && typeof value.control.updatedAt === 'string'
        && typeof value.control.changeReason === 'string';
    case 'memory-activated':
      return validActiveMemory(value.memory);
    case 'active-memories-replaced':
      return Array.isArray(value.memories) && value.memories.every(validActiveMemory);
    case 'memory-deactivated':
      return typeof value.memoryId === 'string' && value.memoryId.length > 0;
    default:
      return false;
  }
}

function validActiveMemory(value: unknown): boolean {
  return objectBody(value)
    && typeof value.id === 'string'
    && typeof value.summary === 'string'
    && typeof value.observedAt === 'string'
    && typeof value.relevance === 'number'
    && Number.isFinite(value.relevance);
}

function validThreadTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
}

function validAgentHostHint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/u.test(value.trim());
}

function validVoyagerTaskProjection(value: unknown): value is VoyagerTaskProjection {
  return objectBody(value)
    && validBoundedString(value.id, 160)
    && validBoundedString(value.title, 500)
    && typeof value.details === 'string'
    && value.details.length <= 1_000
    && validBoundedString(value.status, 80)
    && Array.isArray(value.projectIds)
    && value.projectIds.length <= 12
    && value.projectIds.every(id => validBoundedString(id, 160))
    && Number.isInteger(value.revision)
    && Number(value.revision) >= 1
    && validBoundedString(value.updatedAt, 80);
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validMemoryKind(value: unknown): boolean {
  return value === 'user-fact' || value === 'interest' || value === 'experience' || value === 'relationship';
}

function validMemoryStatus(value: unknown): boolean {
  return value === 'active' || value === 'forgotten' || value === 'rejected';
}

function validMemoryAction(value: unknown): value is MemoryAction {
  return value === 'correct' || value === 'forget' || value === 'pin'
    || value === 'unpin' || value === 'reject' || value === 'restore';
}

export interface ShannonApiKernelOptions {
  chatModel?: ShannonChatModel;
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
}

export class ShannonApiKernel {
  private readonly chatModel: ShannonChatModel;
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

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly now: CompanionClock,
    options: ShannonApiKernelOptions = {},
  ) {
    this.chatModel = options.chatModel ?? new LocalStubChatModel();
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
  }

  realtimeVoiceSession(scopeKey: string, requestedThreadId?: string): {
    threadId: string;
    instructions: string;
  } {
    const threadId = this.conversationStore.threadId(scopeKey, requestedThreadId?.trim());
    const captured = this.stateStore.snapshot(scopeKey);
    const basePrompt = this.knowledgeStore?.promptProjection(scopeKey)
      ?? assembleShannonSystemPrompt(captured);
    const dailyMindPrompt = this.dailyMind?.promptFor(scopeKey, this.now()) ?? '';
    const history = voiceHistoryProjection(this.conversationStore.history(scopeKey, threadId));
    const voiceInstructions = [
      '[Live voice conversation]',
      '- Speak naturally in Japanese as Shannon. Keep most turns concise enough for a live conversation.',
      '- Listen through pauses. Do not rush, lecture, or repeatedly summarize what the user just said.',
      '- If the user interrupts, stop and listen. Treat the newest utterance as the current turn.',
      '- Never claim that an external action or code change was completed during this voice session.',
      '- When an external task is requested, acknowledge it briefly and ask the user to continue in Talk for visible execution and approval.',
    ].join('\n');
    return {
      threadId,
      instructions: [basePrompt, dailyMindPrompt, history, voiceInstructions].filter(Boolean).join('\n\n'),
    };
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
          background: { mode: this.background.mode },
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/state') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.stateStore.snapshot(scopeKey) };
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
        body: this.testFlightDelivery?.dashboard() ?? {
          condition: 'waiting',
          latestBuildVersion: null,
          lastCheckedAt: null,
          activeFailureCode: null,
          history: [],
        },
      };
    }

    if (request.method === 'GET' && request.path === '/v1/organize/sessions') {
      const scopeKey = request.query?.get('scopeKey');
      const threadId = request.query?.get('threadId')?.trim();
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!threadId) return badRequest('threadId is required');
      return { status: 200, body: { sessions: this.organizeStore.list(scopeKey, threadId) } };
    }

    if (request.method === 'GET' && request.path === '/v1/integrations/voyager/tasks') {
      const scopeKey = request.query?.get('scopeKey');
      const query = request.query?.get('query')?.trim() ?? '';
      const limit = Number(request.query?.get('limit') ?? '8');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!validBoundedString(query, 160)) return badRequest('query is required');
      if (!Number.isInteger(limit) || limit < 1 || limit > 8) return badRequest('limit is invalid');
      try {
        const items = await this.voyagerCatalog.searchTasks(query, limit);
        return { status: 200, body: { items } };
      } catch (error) { return organizeErrorResponse(error); }
    }

    if (request.method === 'GET' && request.path === '/v1/integrations/voyager/projects') {
      const scopeKey = request.query?.get('scopeKey');
      const limit = Number(request.query?.get('limit') ?? '20');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) return badRequest('limit is invalid');
      try {
        const items = await this.voyagerCatalog.listProjects(limit);
        return { status: 200, body: { items } };
      } catch (error) { return organizeErrorResponse(error); }
    }

    const organizeSessionMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)$/);
    if (request.method === 'GET' && organizeSessionMatch) {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const session = this.organizeStore.get(scopeKey, decodeURIComponent(organizeSessionMatch[1] ?? ''));
      return session ? { status: 200, body: { session } } : { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
    }

    const organizeDecisionMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)\/items\/([^/]+)\/decision$/);
    if (request.method === 'POST' && organizeDecisionMatch) {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!Number.isInteger(request.body.expectedRevision) || Number(request.body.expectedRevision) < 1) return badRequest('expectedRevision is invalid');
      if (!['accepted', 'rejected', 'deferred'].includes(String(request.body.decision))) return badRequest('decision is invalid');
      if (request.body.title !== undefined && !validBoundedString(request.body.title, 500)) return badRequest('title is invalid');
      if (request.body.details !== undefined && (typeof request.body.details !== 'string' || request.body.details.length > 1_000)) return badRequest('details is invalid');
      if (request.body.operation !== undefined && !['create', 'update'].includes(String(request.body.operation))) return badRequest('operation is invalid');
      if (request.body.projectIds !== undefined && (!Array.isArray(request.body.projectIds) || request.body.projectIds.length > 12 || !request.body.projectIds.every(value => validBoundedString(value, 160)))) return badRequest('projectIds is invalid');
      if (request.body.target !== undefined && !validVoyagerTaskProjection(request.body.target)) return badRequest('target is invalid');
      if (request.body.operation === 'update' && request.body.target === undefined) return badRequest('target is required');
      try {
        const session = this.organizeStore.decide(
          scopeKey,
          decodeURIComponent(organizeDecisionMatch[1] ?? ''),
          decodeURIComponent(organizeDecisionMatch[2] ?? ''),
          Number(request.body.expectedRevision),
          request.body.decision as OrganizeDecision,
          {
            ...(typeof request.body.title === 'string' ? { title: request.body.title } : {}),
            ...(typeof request.body.details === 'string' ? { details: request.body.details } : {}),
            ...(request.body.operation === 'create' || request.body.operation === 'update' ? { operation: request.body.operation } : {}),
            ...(validVoyagerTaskProjection(request.body.target) ? { target: request.body.target } : {}),
            ...(Array.isArray(request.body.projectIds) ? { projectIds: request.body.projectIds as string[] } : {}),
          },
          this.now(),
        );
        return { status: 200, body: { session } };
      } catch (error) { return organizeErrorResponse(error); }
    }

    const organizeApplyMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)\/apply$/);
    if (request.method === 'POST' && organizeApplyMatch) {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!Number.isInteger(request.body.expectedRevision) || Number(request.body.expectedRevision) < 1) return badRequest('expectedRevision is invalid');
      const sessionId = decodeURIComponent(organizeApplyMatch[1] ?? '');
      let session = this.organizeStore.get(scopeKey, sessionId);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.revision !== Number(request.body.expectedRevision)) return { status: 409, body: { error: 'REVISION_CONFLICT' } };
      if (session.state === 'applied') {
        const applied = session.items.flatMap(item => item.destinationStatus === 'applied' && item.result ? [item.result] : []);
        return { status: 200, body: { session, appliedCount: applied.length, tasks: applied } };
      }
      if (session.items.some(item => item.decision === 'proposed')) {
        return { status: 409, body: { error: 'REVIEW_INCOMPLETE' } };
      }
      for (const item of session.items.filter(value => value.decision === 'accepted' && value.destinationStatus !== 'applied')) {
        try {
          const result = await this.voyagerDestination.apply(session, item);
          session = this.organizeStore.recordAttempt(scopeKey, sessionId, item.id, result, undefined, this.now());
        } catch (error) {
          const code = error instanceof OrganizeError ? error.code : 'DESTINATION_UNAVAILABLE';
          session = this.organizeStore.recordAttempt(scopeKey, sessionId, item.id, undefined, code, this.now());
        }
      }
      session = this.organizeStore.finishApply(scopeKey, sessionId, this.now());
      const applied = session.items.flatMap(item => item.destinationStatus === 'applied' && item.result ? [item.result] : []);
      return {
        status: 200,
        body: { session, appliedCount: applied.length, tasks: applied },
      };
    }

    const agentTaskMatch = request.path.match(/^\/v1\/agent\/tasks\/([^/]+)$/);
    if (request.method === 'GET' && agentTaskMatch) {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const task = this.agentTasks.get(scopeKey, decodeURIComponent(agentTaskMatch[1] ?? ''));
      if (!task) return { status: 404, body: { error: 'AGENT_TASK_NOT_FOUND' } };
      const afterSequence = Number(request.query?.get('afterSequence') ?? '-1');
      if (Number.isInteger(afterSequence) && afterSequence >= task.latestSequence) {
        return { status: 304, body: null };
      }
      return { status: 200, body: { task } };
    }

    if (request.method === 'POST' && request.path === '/v1/agent/tasks') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!validBoundedString(request.body.idempotencyKey, 160)) return badRequest('idempotencyKey is invalid');
      if (request.body.taskId !== undefined && !validBoundedString(request.body.taskId, 160)) return badRequest('taskId is invalid');
      if (!validBoundedString(request.body.conversationThreadID, 160)) return badRequest('conversationThreadID is invalid');
      if (!validBoundedString(request.body.title, 160)) return badRequest('title is invalid');
      if (!validBoundedString(request.body.goal, 2_000)) return badRequest('goal is invalid');
      if (!validBoundedString(request.body.summary, 2_000)) return badRequest('summary is invalid');
      if (request.body.sourceMessageID !== undefined && !validBoundedString(request.body.sourceMessageID, 160)) {
        return badRequest('sourceMessageID is invalid');
      }
      if (request.body.plan !== undefined && !validPlan(request.body.plan)) return badRequest('plan is invalid');
      try {
        const hostHint = typeof request.body.hostHint === 'string' && request.body.hostHint.trim()
          ? request.body.hostHint.trim()
          : this.defaultAgentHost;
        const result = this.agentTasks.create(scopeKey, {
          ...(typeof request.body.taskId === 'string' ? { taskId: request.body.taskId } : {}),
          idempotencyKey: request.body.idempotencyKey,
          conversationThreadID: request.body.conversationThreadID,
          ...(typeof request.body.sourceMessageID === 'string' ? { sourceMessageID: request.body.sourceMessageID } : {}),
          title: request.body.title,
          goal: request.body.goal,
          summary: request.body.summary,
          ...(Array.isArray(request.body.plan) ? { plan: request.body.plan as AgentPlanItem[] } : {}),
          ...(hostHint ? { hostHint } : {}),
          ...(typeof request.body.projectHint === 'string' ? { projectHint: request.body.projectHint } : {}),
        }, this.now());
        return { status: result.created ? 201 : 200, body: result };
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_TASK_ID_CONFLICT') {
          return { status: 409, body: { error: error.message } };
        }
        throw error;
      }
    }

    const agentCommandMatch = request.path.match(/^\/v1\/agent\/tasks\/([^/]+)\/commands$/);
    if (request.method === 'POST' && agentCommandMatch) {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!validBoundedString(request.body.idempotencyKey, 160)) return badRequest('idempotencyKey is invalid');
      if (!validAgentCommandType(request.body.type)) return badRequest('type is invalid');
      if (request.body.payload !== undefined && !objectBody(request.body.payload)) return badRequest('payload is invalid');
      try {
        const result = this.agentTasks.enqueue(
          scopeKey,
          decodeURIComponent(agentCommandMatch[1] ?? ''),
          {
            idempotencyKey: request.body.idempotencyKey,
            type: request.body.type,
            ...(objectBody(request.body.payload) ? { payload: request.body.payload } : {}),
          },
          this.now(),
        );
        return { status: result.created ? 202 : 200, body: result };
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_TASK_NOT_FOUND') {
          return { status: 404, body: { error: error.message } };
        }
        if (error instanceof Error && (error.message.startsWith('AGENT_COMMAND_INVALID')
          || error.message === 'AGENT_COMMAND_STALE_APPROVAL')) {
          return { status: 409, body: { error: error.message } };
        }
        throw error;
      }
    }

    if (request.method === 'POST' && request.path === '/v1/agent/host/heartbeat') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
      const displayName = validBoundedString(request.body.displayName, 120) ? request.body.displayName : 'Shannon Agent Host';
      const capabilities = Array.isArray(request.body.capabilities)
        ? request.body.capabilities.filter((value): value is string => validBoundedString(value, 80)).slice(0, 30)
        : [];
      this.agentTasks.heartbeat(request.body.hostId, displayName, capabilities, this.now());
      return { status: 200, body: { ok: true, serverTime: this.now() } };
    }

    if (request.method === 'POST' && request.path === '/v1/agent/host/commands/claim') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
      const command = this.agentTasks.claim(request.body.hostId, this.now());
      return { status: 200, body: { command } };
    }

    if (request.method === 'POST' && request.path === '/v1/agent/host/events') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
      if (!validHostEvents(request.body.events)) return badRequest('events are invalid');
      try {
        const tasks = this.agentTasks.recordHostEvents(
          request.body.hostId,
          request.body.events as HostAgentEvent[],
          this.now(),
        );
        return { status: 200, body: { accepted: request.body.events.length, tasks } };
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_APPROVAL_INVALID') return badRequest(error.message);
        if (error instanceof Error && error.message === 'AGENT_HOST_TASK_MISMATCH') {
          return { status: 409, body: { error: error.message } };
        }
        throw error;
      }
    }

    if (request.method === 'GET' && request.path === '/v1/threads') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: { threads: this.conversationStore.listThreads(scopeKey) } };
    }

    if (request.method === 'POST' && request.path === '/v1/threads') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const title = validThreadTitle(request.body.title) ? request.body.title.trim() : undefined;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const threadId = this.conversationStore.createThread(scopeKey, title);
      return { status: 200, body: { threadId } };
    }

    if (request.method === 'POST' && request.path === '/v1/threads/title') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const threadId = request.body.threadId;
      const title = request.body.title;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 160) {
        return badRequest('threadId is invalid');
      }
      if (!validThreadTitle(title)) return badRequest('title is invalid');
      if (!this.conversationStore.renameThread(scopeKey, threadId.trim(), title.trim())) {
        return { status: 404, body: { error: 'THREAD_NOT_FOUND' } };
      }
      return { status: 200, body: { renamed: true } };
    }

    if (request.method === 'POST' && request.path === '/v1/threads/archive') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const threadId = request.body.threadId;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 160) {
        return badRequest('threadId is invalid');
      }
      if (!this.conversationStore.archiveThread(scopeKey, threadId.trim())) {
        return { status: 404, body: { error: 'THREAD_NOT_FOUND' } };
      }
      return { status: 200, body: { archived: true } };
    }

    if (request.method === 'GET' && request.path === '/v1/memories') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      return { status: 200, body: this.memoryStore.dashboard(scopeKey) };
    }

    if (request.method === 'GET' && request.path === '/v1/initiatives') {
      const scopeKey = request.query?.get('scopeKey');
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const messages = this.initiativeInbox?.unreadMessages(scopeKey) ?? [];
      return { status: 200, body: { unreadCount: messages.length, messages } };
    }

    if (request.method === 'POST' && request.path === '/v1/initiatives/read') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      const markedRead = this.initiativeInbox?.markAllRead(scopeKey, this.now()) ?? 0;
      return { status: 200, body: { markedRead } };
    }

    if (request.method === 'POST' && request.path === '/v1/memories/action') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const memoryId = request.body.memoryId;
      const action = request.body.action;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (typeof memoryId !== 'string' || !memoryId.trim() || memoryId.length > 160) {
        return badRequest('memoryId is invalid');
      }
      if (!validMemoryAction(action)) return badRequest('action is invalid');
      if (action === 'correct'
        && (typeof request.body.text !== 'string' || !request.body.text.trim() || request.body.text.length > 320)) {
        return badRequest('text must be 1..320 characters');
      }
      try {
        return {
          status: 200,
          body: this.memoryStore.mutate(scopeKey, {
            memoryId,
            action,
            ...(typeof request.body.text === 'string' ? { text: request.body.text } : {}),
          }),
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'MEMORY_NOT_FOUND') {
          return { status: 404, body: { error: 'MEMORY_NOT_FOUND' } };
        }
        throw error;
      }
    }

    if (request.method === 'POST' && request.path === '/v1/knowledge/correct') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      const answerId = request.body.answerId;
      const answer = request.body.answer;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (typeof answerId !== 'string' || !answerId.trim() || answerId.length > 160) {
        return badRequest('answerId is invalid');
      }
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 500) {
        return badRequest('answer must be 1..500 characters');
      }
      if (!this.knowledgeStore?.knowledgeAnswers(scopeKey).some(item => item.answerId === answerId)) {
        return { status: 404, body: { error: 'KNOWLEDGE_NOT_FOUND' } };
      }
      this.knowledgeStore.correctKnowledge(scopeKey, answerId, answer.trim(), this.now());
      return { status: 200, body: this.memoryStore.dashboard(scopeKey) };
    }

    if (request.method === 'POST' && request.path === '/v1/events') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const body = request.body as unknown as StateEventRequest;
      if (!validScopeKey(body.scopeKey)) return badRequest('scopeKey is required');
      if (!validEvent(body.event)) return badRequest('event is invalid');
      return { status: 200, body: this.stateStore.apply(body.scopeKey, body.event) };
    }

    if (request.method === 'POST' && request.path === '/v1/aether/proposals') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!this.aetherProposals.configured) {
        return { status: 503, body: { error: 'AETHER_LINK_UNAVAILABLE', message: 'Aether連携はまだ利用できません。' } };
      }
      if (typeof request.body.content !== 'string' || !request.body.content.trim() || request.body.content.length > 6_000) {
        return badRequest('content must be 1..6000 characters');
      }
      if (request.body.title !== undefined && (typeof request.body.title !== 'string' || request.body.title.length > 120)) {
        return badRequest('title is invalid');
      }
      if (request.body.reason !== undefined && (typeof request.body.reason !== 'string' || request.body.reason.length > 300)) {
        return badRequest('reason is invalid');
      }
      try {
        const proposal = this.aetherProposals.create(scopeKey, {
          content: request.body.content,
          ...(typeof request.body.title === 'string' ? { title: request.body.title } : {}),
          ...(typeof request.body.reason === 'string' ? { reason: request.body.reason } : {}),
          ...(typeof request.body.targetNoteId === 'string' ? { targetNoteId: request.body.targetNoteId } : {}),
          ...(typeof request.body.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: request.body.expectedUpdatedAt } : {}),
        });
        return { status: 201, body: proposal };
      } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_AETHER_PROPOSAL') return badRequest('proposal target is invalid');
        if (error instanceof Error && error.message === 'AETHER_PROPOSAL_QUEUE_FULL') {
          return { status: 429, body: { error: 'AETHER_PROPOSAL_QUEUE_FULL', message: 'Aetherで提案を整理してから、もう一度送ってください。' } };
        }
        throw error;
      }
    }

    if (request.method === 'POST' && request.path === '/v1/voice/realtime/turns') {
      if (!objectBody(request.body)) return badRequest('JSON object body is required');
      const scopeKey = request.body.scopeKey;
      if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
      if (!validBoundedString(request.body.userTranscript, 8_000)) {
        return badRequest('userTranscript is invalid');
      }
      if (!validBoundedString(request.body.shannonTranscript, 8_000)) {
        return badRequest('shannonTranscript is invalid');
      }
      const userMessage = request.body.userTranscript.trim();
      const shannonReply = request.body.shannonTranscript.trim();
      const threadId = this.conversationStore.threadId(
        scopeKey,
        typeof request.body.threadId === 'string' ? request.body.threadId.trim() : undefined,
      );
      const captured = this.stateStore.snapshot(scopeKey);
      const messageEmotion = createShannonMessageEmotion(
        projectEmotionReaction(captured, userMessage),
        captured.temperament,
        { userMessage, shannonReply },
      );
      const completedTurn = {
        scopeKey,
        threadId,
        capturedState: captured,
        userMessage,
        shannonReply,
        messageEmotion,
        completedAt: this.now(),
      };
      const experience = this.background.recordTurn(completedTurn);
      this.background.schedule(completedTurn, experience.id);
      return {
        status: 201,
        body: {
          threadId,
          messageEmotion,
          state: captured,
        },
      };
    }

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
      const captured = this.stateStore.snapshot(body.scopeKey);
      const basePrompt = this.knowledgeStore?.promptProjection(body.scopeKey)
        ?? assembleShannonSystemPrompt(captured);
      const aetherPrompt = this.aetherContext?.promptFor(body.scopeKey, message) ?? '';
      const dailyMindPrompt = this.dailyMind?.promptFor(body.scopeKey, this.now()) ?? '';
      const taskPrompt = agentTaskPromptProjection(
        this.agentTasks.list(body.scopeKey),
        threadId,
      );
      const systemPrompt = [basePrompt, dailyMindPrompt, aetherPrompt, taskPrompt].filter(Boolean).join('\n\n');
      if (isOrganizeCommand(message)) {
        const completeHistory = this.conversationStore.conversationHistory(body.scopeKey, threadId);
        const source = messagesAfterCursor(completeHistory, this.organizeStore.cursor(body.scopeKey, threadId)).slice(-100);
        const drafts = await this.organizeExtractor.extract(body.scopeKey, source.map(item => ({ role: item.role, content: item.content })));
        let session = this.organizeStore.create({
          scopeKey: body.scopeKey,
          threadId,
          sourceMessageIds: source.map(item => item.id),
          drafts,
        }, this.now());
        const reply = drafts.length
          ? `Voyagerへ送るTask案を${drafts.length}件まとめたよ。内容を確認して、採用する案を選んでください。`
          : '今回の範囲には、Voyagerへ送るTask案は見つかりませんでした。';
        const messageEmotion = createShannonMessageEmotion(
          projectEmotionReaction(captured, message), captured.temperament,
          { userMessage: message, shannonReply: reply },
        );
        const completedTurn = {
          scopeKey: body.scopeKey, threadId, capturedState: captured, userMessage: message, shannonReply: reply,
          messageEmotion, completedAt: this.now(),
        };
        const experience = this.background.recordTurn(completedTurn);
        const lastMessage = this.conversationStore.conversationHistory(body.scopeKey, threadId).at(-1);
        if (lastMessage) session = this.organizeStore.setCommandThrough(body.scopeKey, session.id, lastMessage.id, this.now());
        this.background.schedule(completedTurn, experience.id);
        return {
          status: 200,
          body: {
            mode: this.chatModel.mode, model: this.chatModel.model, reply, threadId,
            snapshotVersion: captured.version, messageEmotion, systemPrompt, state: captured,
            thread: this.conversationStore.listThreads(body.scopeKey).find(thread => thread.threadId === threadId),
            uiBlocks: [{ type: 'organize_session', session }],
          } satisfies ChatResponse,
        };
      }
      const completion = await this.chatModel.generate({
        scopeKey: body.scopeKey,
        systemPrompt,
        history: this.conversationStore.history(body.scopeKey, threadId),
        message,
        ...(attachments.length ? { attachments } : {}),
        ...(body.webSearch === true ? { useWebSearch: true } : {}),
        generateThreadTitle: this.conversationStore.needsAutomaticThreadTitle(body.scopeKey, threadId),
      });
      const reply = appendWebSources(completion.reply, completion.webSources ?? []);
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
        ...(completion.taskProposal ? {
          uiBlocks: [{
            type: 'agent_task_proposal' as const,
            proposalId: randomUUID(),
            ...completion.taskProposal,
          }],
        } : {}),
      };

      const completedTurn = {
        scopeKey: body.scopeKey,
        threadId,
        capturedState: captured,
        userMessage: message,
        shannonReply: reply,
        ...(completion.threadTitle ? { threadTitle: completion.threadTitle } : {}),
        messageEmotion: response.messageEmotion,
        ...(completion.taskDecision ? { taskDecision: completion.taskDecision } : {}),
        ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
        completedAt: this.now(),
      };
      const experience = this.background.recordTurn(completedTurn);
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

function organizeErrorResponse(error: unknown): ApiResponse {
  if (error instanceof OrganizeError) return { status: error.status, body: { error: error.code, retryable: error.retryable } };
  throw error;
}

function voiceHistoryProjection(history: readonly { role: 'user' | 'assistant'; content: string }[]): string {
  const rows = history.slice(-12).map(item => {
    const speaker = item.role === 'user' ? 'User' : 'Shannon';
    const content = item.content.trim().replace(/\s+/gu, ' ').slice(0, 600);
    return `${speaker}: ${content}`;
  }).filter(row => !row.endsWith(': '));
  if (!rows.length) return '';
  const projection = `[Recent conversation]\n${rows.join('\n')}`;
  return projection.length <= 6_000 ? projection : `${projection.slice(-5_999)}…`;
}

export function agentTaskPromptProjection(tasks: readonly AgentTask[], currentThreadID?: string): string {
  const relevant = tasks
    .filter(task => task.status !== 'proposed')
    .sort((left, right) => {
      const leftActive = ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(left.status) ? 1 : 0;
      const rightActive = ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(right.status) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      const leftHere = left.conversationThreadID === currentThreadID ? 1 : 0;
      const rightHere = right.conversationThreadID === currentThreadID ? 1 : 0;
      if (leftHere !== rightHere) return rightHere - leftHere;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 5);
  if (relevant.length === 0) return '';
  const lines = relevant.map(task => {
    const approval = task.status === 'waiting_approval' && task.pendingApproval
      ? ` / 必要な確認: ${task.pendingApproval.title}（理由: ${task.pendingApproval.reason}${task.pendingApproval.resource ? ` / 対象: ${task.pendingApproval.resource}` : ''}）`
      : '';
    const action = task.currentAction ? ` / 現在: ${task.currentAction}` : '';
    return `- ${task.title} [${task.status}] ${task.summary}${action}${approval}`.slice(0, 700);
  });
  return [
    '[Codex作業の現在状態 — Azure DB上の事実・会話履歴より優先]',
    ...lines,
    'これは全トークにまたがる作業一覧である。別トークから尋ねられても、該当する作業名と最新状態をここから答える。',
    'waiting_approvalは実行中ではなく、記載された確認をユーザーが操作するまで停止中である。過去の会話にある古い進捗説明を繰り返さない。',
    'ユーザーが進捗・完了・作業途中かを尋ねたら、この状態を根拠に答える。completedを作業中、cancelledを再開中、runningを未開始とは言わない。',
  ].join('\n');
}

export function createLocalApiKernel(
  now: CompanionClock = () => new Date().toISOString(),
  options: ShannonApiKernelOptions = {},
): ShannonApiKernel {
  return new ShannonApiKernel(options.stateStore ?? new InMemoryCompanionStateStore(now), now, options);
}

function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: 'BAD_REQUEST', message } };
}

function appendWebSources(reply: string, sources: readonly ShannonWebSource[]): string {
  if (!sources.length) return reply;
  const links = sources.map(source => `- [${source.title}](${source.url})`);
  return `${reply.trim()}\n\n### 参照した情報源\n${links.join('\n')}`;
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

const allowedChatAttachmentMimeTypes = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
  'text/x-swift', 'text/javascript', 'text/typescript', 'text/jsx',
  'text/x-python', 'text/x-ruby', 'text/x-shellscript',
  'application/json', 'application/xml', 'application/yaml', 'application/sql',
]);

function validatedChatAttachments(value: unknown): ShannonChatAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) return null;
  let total = 0;
  const names = new Set<string>();
  const result: ShannonChatAttachment[] = [];
  for (const item of value) {
    if (!objectBody(item)
      || !validBoundedString(item.name, 180)
      || names.has(item.name)
      || typeof item.mimeType !== 'string'
      || !allowedChatAttachmentMimeTypes.has(item.mimeType)
      || typeof item.text !== 'string'
      || !item.text.trim()
      || item.text.length > 24_000
      || item.text.includes('\0')) return null;
    total += item.text.length;
    if (total > 48_000) return null;
    names.add(item.name);
    result.push({ name: item.name, mimeType: item.mimeType, text: item.text });
  }
  return result;
}

function validPlan(value: unknown): value is AgentPlanItem[] {
  return Array.isArray(value) && value.length <= 50 && value.every(item => objectBody(item)
    && validBoundedString(item.id, 160)
    && validBoundedString(item.title, 500)
    && ['pending', 'running', 'completed'].includes(String(item.status)));
}

function validAgentCommandType(value: unknown): value is AgentCommandType {
  return ['steer', 'interrupt', 'resume', 'resolve_approval'].includes(String(value));
}

function validHostEvents(value: unknown): value is HostAgentEvent[] {
  const types = ['started', 'progress', 'approval_requested', 'paused', 'completed', 'failed', 'command_completed'];
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(event => objectBody(event)
    && validBoundedString(event.eventId, 160)
    && validBoundedString(event.taskId, 160)
    && types.includes(String(event.type))
    && validBoundedString(event.title, 500)
    && validBoundedString(event.occurredAt, 80)
    && (event.detail === undefined || (typeof event.detail === 'string' && event.detail.length <= 4_000))
    && (event.payload === undefined || objectBody(event.payload)));
}
