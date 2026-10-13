import { ACTION_ID } from '@shannon/mind';
import { actionResource, leaseOf, type ActionThreads, type ActionLease, type ActionView } from '../contracts/actionThreadContract.js';
import type { ApiRequest, ApiResponse } from '../contracts/contracts.js';
import type { AgentTaskStore, HostAgentEvent } from '../mind/action/agentTasks/agentTasksPorts.js';

const terminal = ['completed', 'failed', 'cancelled', 'unknown'];
const id = (value: unknown): value is string => typeof value === 'string' && ACTION_ID.test(value);
export function checkedActionLease(value: unknown): ActionLease | null {
  if (!value || typeof value !== 'object') return null;
  const lease = value as ActionLease;
  return id(lease.id) && id(lease.holder) && Number.isSafeInteger(lease.generation) && lease.generation > 0 ? lease : null;
}

/** Existing task/body records remain authoritative. Only execution rights pass through the mind. */
export function externalActionWiring(actions: ActionThreads | null, tasks: AgentTaskStore, ownerScope: string, now: () => string) {
  const find = async (kind: ActionView['kind'], sourceId: string) =>
    (await actions!.list(ownerScope)).find(view => view.kind === kind && view.sourceId === sourceId);
  const acknowledge = async (view: ActionView, lease: ActionLease, state: 'completed' | 'failed' | 'cancelled', code: string) => {
    if (view.state === 'unknown') await actions!.reconcile(lease, state, code);
    else if (!await actions!.finish(lease, state, code)) await actions!.reconcile(lease, state, code);
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
        if (view && task && ['paused', 'cancelled', 'failed', 'completed'].includes(task.status)) {
          await actions.stop(ownerScope, view.id, `host-stop:${view.id}:${task.updatedAt}`);
          return { status: 200, body: { allowed: false } };
        }
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
      if (tasks.taskTrees && host?.kind === 'cloud') resources.push(actionResource(ownerScope, 'folder:vm'));
      const previous = await find('agentTask', task.id);
      const tree = task.taskTree;
      // An existing canonical admission retains its rights. Unknown legacy intent is not upgraded by the new planner.
      let view = await actions.enqueue({ scopeKey: ownerScope, kind: 'agentTask',
        origin: previous?.origin ?? (tree?.origin === 'own_time' ? 'own_time' : 'owner_request'), sourceId: task.id,
        ...(previous?.parentId ? { parentId: previous.parentId } : {}),
        ownerInformed: previous?.ownerInformed || (tree?.origin === 'own_time' ? tree.ownerInformed : true), resources });
      if (['failed', 'cancelled'].includes(view.state) && ['resume', 'steer'].includes(candidate.type)) {
        await actions.resume(ownerScope, view.id);
        view = (await actions.list(ownerScope)).find(item => item.id === view.id)!;
      }
      if (view.state === 'queued') view = await actions.claim(view.id) ?? view;
      if (!['running', 'waiting'].includes(view.state) || !view.holder) return { status: 200, body: { command: null } };
      const lease = leaseOf(view);
      if (!await actions.dispatch(lease)) return { status: 200, body: { command: null } };
      const command = tasks.claim(body.hostId, now(), 35, candidate.id);
      if (command) tasks.bindActionLease?.(command.id, lease);
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
        // Command receipt is separate from the turn's outcome. It closes the canonical
        // delivery record even when that turn is uncertain, without releasing its locks.
        const commandReceipt = event.type === 'command_completed';
        if (view.generation === lease.generation && !terminal.includes(view.state)
          || (acknowledged || commandReceipt) && view.state === 'unknown' && view.generation === lease.generation + 1
          || commandReceipt && view.generation === lease.generation) events.push(event);
      }
      return { ...request, body: { ...body, events } };
    },
    async afterHost(request: ApiRequest, response: ApiResponse): Promise<void> {
      if (!actions || response.status !== 200 || request.path !== '/v1/agent/host/events') return;
      const body = request.body as { events: HostAgentEvent[] };
      for (const event of body.events) {
        const uncertain = event.type === 'progress' && event.payload?.executionUncertain === true;
        if(!uncertain && !['paused','completed','failed'].includes(event.type))continue;
        const lease = checkedActionLease(event.payload?.actionLease);
        const task = tasks.get(ownerScope, event.taskId), view = await find('agentTask', event.taskId);
        if (!task || !view || !lease) continue;
        if (uncertain) { await actions.finish(lease, 'unknown', 'host_result_unknown'); continue; }
        if (['paused','cancelled'].includes(task.status)) await acknowledge(view, lease, 'cancelled', 'host_paused');
        else if (task.status === 'completed') await acknowledge(view, lease, 'completed', 'host_completed');
        else if (task.status === 'failed') await acknowledge(view, lease, 'failed', 'host_failed');
      }
    },
    async stopOutside(views: readonly ActionView[], requestId: string): Promise<void> {
      for (const view of views) {
        if (!['stopping', 'cancelled'].includes(view.state)) continue;
        // A Minecraft lifecycle action stops by its own lease (its renewal fails and its native command is cancelled).
        if (view.kind !== 'agentTask') continue;
        const task = tasks.get(view.scopeKey, view.sourceId);
        if (task && !['completed', 'failed', 'cancelled', 'paused'].includes(task.status)) tasks.enqueue(view.scopeKey, task.id,
          { idempotencyKey: `action:${requestId}:${task.id}`, type: 'interrupt', payload: {} }, now());
      }
    },
  };
}
