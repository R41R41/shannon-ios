import { ACTION_ID } from '@shannon/mind';
import { actionResource, leaseOf, type ActionThreads, type ActionLease, type ActionView } from '../contracts/actionThreadContract.js';
import type { ApiRequest, ApiResponse } from '../contracts/contracts.js';
import type { AgentTaskStore, HostAgentEvent } from '../mind/action/agentTasks/agentTasksPorts.js';
import type { MinecraftBodyRequests } from '../surfaces/minecraft/minecraftBodyRequests.js';

const terminal = ['completed', 'failed', 'cancelled', 'unknown'];
const id = (value: unknown): value is string => typeof value === 'string' && ACTION_ID.test(value);
export function checkedActionLease(value: unknown): ActionLease | null {
  if (!value || typeof value !== 'object') return null;
  const lease = value as ActionLease;
  return id(lease.id) && id(lease.holder) && Number.isSafeInteger(lease.generation) && lease.generation > 0 ? lease : null;
}

/** Existing task/body records remain authoritative. Only execution rights pass through the mind. */
export function externalActionWiring(actions: ActionThreads | null, tasks: AgentTaskStore,
  minecraft: MinecraftBodyRequests | null, ownerScope: string, now: () => string) {
  const find = async (kind: ActionView['kind'], sourceId: string) =>
    (await actions!.list(ownerScope)).find(view => view.kind === kind && view.sourceId === sourceId);
  const acknowledge = async (view: ActionView, lease: ActionLease, state: 'completed' | 'failed' | 'cancelled', code: string) => {
    if (view.state === 'unknown') await actions!.reconcile(lease, state, code);
    else await actions!.finish(lease, state, code);
  };
  return {
    async beforeHost(request: ApiRequest): Promise<ApiResponse | undefined> {
      if (!actions) return request.path === '/v1/agent/host/actions/permit' ? {status:200,body:{allowed:true}} : undefined;
      if (request.method !== 'POST') return undefined;
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || !id(body.hostId)) return undefined; // Existing validator answers malformed requests.
      if (request.path === '/v1/agent/host/actions/permit') {
        const task = id(body.taskId) ? tasks.get(ownerScope, body.taskId) : null;
        const lease = checkedActionLease(body.lease);
        const view = task && task.assignedHostID === body.hostId ? await find('agentTask', task.id) : null;
        const matches = !!view && !!lease && view.id === lease.id && view.generation === lease.generation && view.holder === lease.holder;
        const allowed = matches && !!await actions.renew(lease!) && await actions.dispatch(lease!);
        return { status: 200, body: { allowed } };
      }
      if (request.path !== '/v1/agent/host/commands/claim') return undefined;
      if (body.actionThreads !== 1) return { status: 503, body: { error: 'ACTION_HOST_UPDATE_REQUIRED' } };
      const candidate = tasks.peekCommand?.(body.hostId, now());
      if (!candidate) return { status: 200, body: { command: null } };
      if (candidate.type === 'interrupt') return undefined; // A stop always reaches the existing host.
      const task = tasks.get(candidate.scopeKey, candidate.taskId);
      if (!task || candidate.scopeKey !== ownerScope) return { status: 403, body: { error: 'ACTION_OWNER_ONLY' } };
      const host = tasks.workspaceCatalog(undefined, now(), null).hosts.find(item => item.hostId === body.hostId);
      const resources = [actionResource(body.hostId, 'agent-host')];
      // The current local Agent Host is the Mac. Its task may reach her Mac folder too;
      // share the same coarse lock as folder tools instead of letting two APIs write it.
      if (host?.kind === 'local') resources.push(actionResource(ownerScope, 'folder:mac'));
      let view = await actions.enqueue({ scopeKey: ownerScope, kind: 'agentTask', origin: 'owner_request',
        sourceId: task.id, ownerInformed: true, resources });
      if (['failed', 'cancelled'].includes(view.state) && candidate.type === 'resume') {
        await actions.resume(ownerScope, view.id);
        view = (await actions.list(ownerScope)).find(item => item.id === view.id)!;
      }
      if (view.state === 'queued') view = await actions.claim(view.id) ?? view;
      if (!['running', 'waiting'].includes(view.state) || !view.holder) return { status: 200, body: { command: null } };
      const lease = leaseOf(view);
      if (!await actions.dispatch(lease)) return { status: 200, body: { command: null } };
      const command = tasks.claim(body.hostId, now(), 35, candidate.id);
      return { status: 200, body: { command: command ? { ...command, actionLease: lease } : null } };
    },
    async filterHostEvents(request: ApiRequest): Promise<ApiRequest> {
      if (!actions || request.path !== '/v1/agent/host/events') return request;
      const body = request.body as { hostId?: unknown; events?: unknown };
      if (!body || !id(body.hostId) || !Array.isArray(body.events)) return request;
      const events: HostAgentEvent[] = [];
      for (const event of body.events as HostAgentEvent[]) {
        const task = event && id(event.taskId) ? tasks.get(ownerScope, event.taskId) : null;
        const view = task && task.assignedHostID === body.hostId ? await find('agentTask', task.id) : null;
        const lease = checkedActionLease(event?.payload?.actionLease);
        if (!view) { events.push(event); continue; } // Legacy completed-task events retain their validator.
        if (!lease || lease.id !== view.id || lease.holder !== view.lastHolder) continue;
        const acknowledged = ['paused', 'completed', 'failed'].includes(event.type);
        if (view.generation === lease.generation && !terminal.includes(view.state)
          || acknowledged && view.state === 'unknown' && view.generation === lease.generation + 1) events.push(event);
      }
      return { ...request, body: { ...body, events } };
    },
    async afterHost(request: ApiRequest, response: ApiResponse): Promise<void> {
      if (!actions || response.status !== 200 || request.path !== '/v1/agent/host/events') return;
      const body = request.body as { events: HostAgentEvent[] };
      for (const event of body.events) {
        if(!['paused','completed','failed'].includes(event.type))continue;
        const lease = checkedActionLease(event.payload?.actionLease);
        const task = tasks.get(ownerScope, event.taskId), view = await find('agentTask', event.taskId);
        if (!task || !view || !lease) continue;
        if (['paused','cancelled'].includes(task.status)) await acknowledge(view, lease, 'cancelled', 'host_paused');
        else if (task.status === 'completed') await acknowledge(view, lease, 'completed', 'host_completed');
        else if (task.status === 'failed') await acknowledge(view, lease, 'failed', 'host_failed');
      }
    },
    async stopOutside(views: readonly ActionView[], requestId: string): Promise<void> {
      for (const view of views) {
        if (!['stopping', 'cancelled'].includes(view.state)) continue;
        if (view.kind === 'agentTask') {
          const task = tasks.get(view.scopeKey, view.sourceId);
          if (task && !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)) tasks.enqueue(view.scopeKey, task.id,
            { idempotencyKey: `action:${requestId}:${task.id}`, type: 'interrupt', payload: {} }, now());
        } else if (view.kind === 'minecraft') minecraft?.cancel(view.scopeKey, view.sourceId);
      }
    },
  };
}
