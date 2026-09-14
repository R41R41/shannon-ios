import type {
  AgentHostHeartbeat,
  AgentModelDescriptor,
  AgentPlanItem,
  AgentReasoningEffort,
  AgentTaskStore,
  AgentWorkspaceProjectState,
  HostAgentEvent,
} from './agentTaskStore.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validAgentCommandType, validBoundedString, validHostEvents, validPlan, validScopeKey } from './apiValidation.js';
import {
  normalizedAgentProjectKey,
  normalizedGitHubRepositoryURL,
  type AgentProjectProvisioningEvent,
} from './agentProjectProvisioning.js';

export interface ApiAgentRouteDependencies {
  agentTasks: AgentTaskStore;
  defaultAgentHost: string | null;
  now: () => string;
}

export function dispatchAgentRequest(request: ApiRequest, dependencies: ApiAgentRouteDependencies): ApiResponse | undefined {
  if (request.method === 'GET' && request.path === '/v1/agent/projects') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: { requests: dependencies.agentTasks.listProjectProvisioning(scopeKey) } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/projects') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validBoundedString(request.body.idempotencyKey, 160)) return badRequest('idempotencyKey is invalid');
    const repositoryURL = normalizedGitHubRepositoryURL(request.body.repositoryURL);
    if (!repositoryURL) return badRequest('repositoryURL must be an HTTPS GitHub repository URL');
    const projectKey = normalizedAgentProjectKey(request.body.projectKey);
    if (!projectKey) return badRequest('projectKey is invalid');
    const hostPreference = typeof request.body.hostPreference === 'string'
      ? request.body.hostPreference.trim() : 'auto';
    if (!['auto', 'local', 'cloud'].includes(hostPreference)) return badRequest('hostPreference is invalid');
    const hostIds = dependencies.agentTasks.resolveProvisioningHosts(hostPreference, dependencies.now());
    if (!hostIds.length) return { status: 409, body: { error: 'AGENT_HOST_UNAVAILABLE' } };
    const catalog = dependencies.agentTasks.workspaceCatalog(
      projectKey, dependencies.now(), dependencies.defaultAgentHost,
    );
    const existingHostIDs = new Set(catalog.projects
      .find(project => project.key === projectKey)?.availableHostIds ?? []);
    const missingHostIDs = hostIds.filter(hostId => !existingHostIDs.has(hostId));
    if (!missingHostIDs.length) return { status: 409, body: { error: 'AGENT_PROJECT_ALREADY_EXISTS' } };
    const idempotencyKey = request.body.idempotencyKey as string;
    const results = missingHostIDs.map(hostId => dependencies.agentTasks.createProjectProvisioning(scopeKey, {
      idempotencyKey: `${idempotencyKey}:${hostId}`,
      repositoryURL,
      projectKey,
      assignedHostID: hostId,
    }, dependencies.now()));
    return {
      status: results.some(result => result.created) ? 202 : 200,
      body: { request: results[0]!.request, requests: results.map(result => result.request) },
    };
  }

  if (request.method === 'GET' && request.path === '/v1/agent/workspace') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const projectHint = request.query?.get('project')?.trim() || undefined;
    return {
      status: 200,
      body: dependencies.agentTasks.workspaceCatalog(projectHint, dependencies.now(), dependencies.defaultAgentHost),
    };
  }

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
    if (request.body.projectHint !== undefined && !validBoundedString(request.body.projectHint, 160)) {
      return badRequest('projectHint is invalid');
    }
    if (request.body.model !== undefined && !validBoundedString(request.body.model, 160)) {
      return badRequest('model is invalid');
    }
    if (request.body.reasoningEffort !== undefined && !isReasoningEffort(request.body.reasoningEffort)) {
      return badRequest('reasoningEffort is invalid');
    }
    try {
      const hostPreference = typeof request.body.hostHint === 'string' && request.body.hostHint.trim()
        ? request.body.hostHint.trim() : 'auto';
      const projectHint = typeof request.body.projectHint === 'string' ? request.body.projectHint.trim() : undefined;
      const hostHint = dependencies.agentTasks.resolveHost(
        projectHint,
        hostPreference,
        dependencies.now(),
        dependencies.defaultAgentHost,
      );
      if (!hostHint && (hostPreference === 'local' || hostPreference === 'cloud')) {
        return { status: 409, body: { error: 'AGENT_HOST_UNAVAILABLE' } };
      }
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
        ...(projectHint ? { projectHint } : {}),
        ...(typeof request.body.model === 'string' ? { model: request.body.model } : {}),
        ...(isReasoningEffort(request.body.reasoningEffort)
          ? { reasoningEffort: request.body.reasoningEffort } : {}),
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

  const agentMetadataMatch = request.path.match(/^\/v1\/agent\/tasks\/([^/]+)\/metadata$/);
  if (request.method === 'POST' && agentMetadataMatch) {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const isPinned = request.body.isPinned;
    const isArchived = request.body.isArchived;
    if (isPinned === undefined && isArchived === undefined) return badRequest('metadata is required');
    if (isPinned !== undefined && typeof isPinned !== 'boolean') return badRequest('isPinned is invalid');
    if (isArchived !== undefined && typeof isArchived !== 'boolean') return badRequest('isArchived is invalid');
    try {
      const task = dependencies.agentTasks.updateMetadata(
        scopeKey,
        decodeURIComponent(agentMetadataMatch[1] ?? ''),
        {
          ...(typeof isPinned === 'boolean' ? { isPinned } : {}),
          ...(typeof isArchived === 'boolean' ? { isArchived } : {}),
        },
        dependencies.now(),
      );
      return { status: 200, body: { task } };
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_TASK_NOT_FOUND') {
        return { status: 404, body: { error: error.message } };
      }
      if (error instanceof Error && error.message === 'AGENT_TASK_ARCHIVE_ACTIVE') {
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
    const projects = Array.isArray(request.body.projects)
      ? request.body.projects.filter((value): value is string => validBoundedString(value, 160)).slice(0, 50)
      : [];
    const models = validModels(request.body.models);
    const workspaces = validWorkspaces(request.body.workspaces);
    const heartbeat: AgentHostHeartbeat = {
      hostId: request.body.hostId,
      displayName,
      kind: request.body.kind === 'cloud' ? 'cloud' : 'local',
      capabilities,
      projects,
      models,
      workspaces,
    };
    dependencies.agentTasks.heartbeat(heartbeat, dependencies.now());
    return { status: 200, body: { ok: true, serverTime: dependencies.now() } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/host/commands/claim') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
    const command = dependencies.agentTasks.claim(request.body.hostId, dependencies.now());
    return { status: 200, body: { command } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/host/projects/claim') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
    const provisioning = dependencies.agentTasks.claimProjectProvisioning(request.body.hostId, dependencies.now());
    return { status: 200, body: { provisioning } };
  }

  if (request.method === 'POST' && request.path === '/v1/agent/host/projects/events') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    if (!validBoundedString(request.body.hostId, 160)) return badRequest('hostId is invalid');
    if (!objectBody(request.body.event)) return badRequest('event is invalid');
    const event = request.body.event;
    if (!validBoundedString(event.requestId, 160)
      || (event.status !== 'ready' && event.status !== 'failed')
      || !validBoundedString(event.occurredAt, 80)
      || (event.errorMessage !== undefined && !validBoundedString(event.errorMessage, 500))) {
      return badRequest('event is invalid');
    }
    try {
      const accepted = dependencies.agentTasks.recordProjectProvisioning(
        request.body.hostId,
        event as unknown as AgentProjectProvisioningEvent,
      );
      return { status: 200, body: { request: accepted } };
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_PROJECT_REQUEST_NOT_FOUND') {
        return { status: 404, body: { error: error.message } };
      }
      if (error instanceof Error && error.message === 'AGENT_HOST_PROJECT_MISMATCH') {
        return { status: 409, body: { error: error.message } };
      }
      throw error;
    }
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

function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra';
}

function validModels(value: unknown): AgentModelDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap(item => {
    if (!objectBody(item) || !validBoundedString(item.id, 160)) return [];
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter(isReasoningEffort)
      : [];
    return [{
      id: item.id,
      displayName: validBoundedString(item.displayName, 160) ? item.displayName : item.id,
      ...(validBoundedString(item.description, 500) ? { description: item.description } : {}),
      supportedReasoningEfforts: efforts,
      ...(isReasoningEffort(item.defaultReasoningEffort)
        ? { defaultReasoningEffort: item.defaultReasoningEffort } : {}),
    }];
  });
}

function validWorkspaces(value: unknown): AgentWorkspaceProjectState[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap(item => {
    if (!objectBody(item) || !validBoundedString(item.key, 160)) return [];
    const files = Array.isArray(item.files)
      ? item.files.filter((file): file is string => validBoundedString(file, 1_024)).slice(0, 1_200)
      : [];
    const changes = Array.isArray(item.changes) ? item.changes.slice(0, 500).flatMap(change => {
      if (!objectBody(change)
        || !validBoundedString(change.path, 1_024)
        || !validBoundedString(change.status, 24)) return [];
      return [{
        path: change.path,
        status: change.status,
        additions: boundedCount(change.additions),
        deletions: boundedCount(change.deletions),
      }];
    }) : [];
    return [{
      key: item.key.toLocaleLowerCase('en-US'),
      isGitRepository: item.isGitRepository === true,
      ...(validBoundedString(item.currentBranch, 300) ? { currentBranch: item.currentBranch } : {}),
      files,
      changes,
    }];
  });
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(10_000_000, Math.trunc(value))) : 0;
}
