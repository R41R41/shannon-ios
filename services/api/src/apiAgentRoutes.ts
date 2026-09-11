import type { AgentPlanItem, AgentTaskStore, HostAgentEvent } from './agentTaskStore.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validAgentCommandType, validBoundedString, validHostEvents, validPlan, validScopeKey } from './apiValidation.js';

export interface ApiAgentRouteDependencies {
  agentTasks: AgentTaskStore;
  defaultAgentHost: string | null;
  now: () => string;
}

export function dispatchAgentRequest(request: ApiRequest, dependencies: ApiAgentRouteDependencies): ApiResponse | undefined {
  const agentTaskMatch = request.path.match(/^\/v1\/agent\/tasks\/([^/]+)$/);
  if (request.method === 'GET' && agentTaskMatch) {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const task = dependencies.agentTasks.get(scopeKey, decodeURIComponent(agentTaskMatch[1] ?? ''));
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
        : dependencies.defaultAgentHost;
      const result = dependencies.agentTasks.create(scopeKey, {
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
      }, dependencies.now());
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
      const result = dependencies.agentTasks.enqueue(
        scopeKey,
        decodeURIComponent(agentCommandMatch[1] ?? ''),
        {
          idempotencyKey: request.body.idempotencyKey,
          type: request.body.type,
          ...(objectBody(request.body.payload) ? { payload: request.body.payload } : {}),
        },
        dependencies.now(),
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
    dependencies.agentTasks.heartbeat(request.body.hostId, displayName, capabilities, dependencies.now());
    return { status: 200, body: { ok: true, serverTime: dependencies.now() } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/host/commands/claim') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
    const command = dependencies.agentTasks.claim(request.body.hostId, dependencies.now());
    return { status: 200, body: { command } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/host/events') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
    if (!validHostEvents(request.body.events)) return badRequest('events are invalid');
    try {
      const tasks = dependencies.agentTasks.recordHostEvents(
        request.body.hostId,
        request.body.events as HostAgentEvent[],
        dependencies.now(),
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
  return undefined;
}
