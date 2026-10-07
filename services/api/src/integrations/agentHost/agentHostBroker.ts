import type { AgentHostHeartbeat, ClaimedAgentCommand, HostAgentEvent } from '../../mind/action/agentTasks/agentTasksPorts.js';
import type { AgentHostStateStore } from './agentHostState.js';
import type {
  AgentProjectProvisioningEvent,
  ClaimedAgentProjectProvisioning,
} from '../../mind/action/agentTasks/agentTasksPorts.js';
import type {
  AgentWorkspaceResourceEvent,
  ClaimedAgentWorkspaceResource,
} from '../../mind/action/agentTasks/agentTasksPorts.js';

export class AgentHostBrokerClient {
  constructor(
    private readonly baseURL: string,
    private readonly token: string,
    private readonly hostId: string,
    private readonly state: AgentHostStateStore,
  ) {}

  async heartbeat(registration: Omit<AgentHostHeartbeat, 'hostId'>): Promise<void> {
    await this.post('/v1/agent/host/heartbeat', { hostId: this.hostId, ...registration });
  }

  async claim(): Promise<ClaimedAgentCommand | null> {
    const response = await this.post<{ command: ClaimedAgentCommand | null }>(
      '/v1/agent/host/commands/claim', { hostId: this.hostId, actionThreads: 1 },
    );
    return response.command;
  }

  async permit(taskId: string): Promise<boolean> {
    const lease = this.state.session(taskId)?.actionLease;
    const reply = await this.post<{ allowed: boolean }>('/v1/agent/host/actions/permit', {
      hostId: this.hostId, taskId, lease: lease ?? null,
    });
    return reply.allowed;
  }

  async claimProject(): Promise<ClaimedAgentProjectProvisioning | null> {
    const response = await this.post<{ provisioning: ClaimedAgentProjectProvisioning | null }>(
      '/v1/agent/host/projects/claim', { hostId: this.hostId },
    );
    return response.provisioning;
  }

  async publishProject(event: AgentProjectProvisioningEvent): Promise<void> {
    await this.post('/v1/agent/host/projects/events', { hostId: this.hostId, event });
  }

  async claimWorkspaceResource(): Promise<ClaimedAgentWorkspaceResource | null> {
    const response = await this.post<{ request: ClaimedAgentWorkspaceResource | null }>(
      '/v1/agent/host/workspace/resources/claim', { hostId: this.hostId },
    );
    return response.request;
  }

  async publishWorkspaceResource(event: AgentWorkspaceResourceEvent): Promise<void> {
    await this.post('/v1/agent/host/workspace/resources/events', { hostId: this.hostId, event });
  }

  async publish(events: readonly HostAgentEvent[]): Promise<void> {
    this.state.enqueueEvents(events.map(event => {
      const lease=this.state.session(event.taskId)?.actionLease;
      return lease && !event.payload?.actionLease ? {...event,payload:{...event.payload,actionLease:lease}} : event;
    }));
    await this.flush();
  }

  async flush(): Promise<void> {
    while (true) {
      const batch = this.state.pendingEvents(50);
      if (!batch.length) return;
      await this.post('/v1/agent/host/events', { hostId: this.hostId, events: batch });
      this.state.acknowledgeEvents(batch.map(event => event.eventId));
    }
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Agent broker request failed: ${response.status} ${path}`);
    return await response.json() as T;
  }
}
