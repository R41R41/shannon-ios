import { randomUUID } from 'node:crypto';
import type { HostAgentEvent } from '../../agentTaskStore.js';

export class CodexTaskEventPublisher {
  constructor(
    private readonly destination: (events: readonly HostAgentEvent[]) => Promise<void>,
    private readonly now: () => string,
    private readonly diagnostic: (error: unknown) => void,
  ) {}

  async emit(taskId: string, type: HostAgentEvent['type'], title: string, detail?: string, payload?: Record<string, unknown>, tone?: HostAgentEvent['tone']): Promise<void> {
    await this.publish([this.event(taskId, type, title, detail, payload, undefined, tone)]);
  }

  event(taskId: string, type: HostAgentEvent['type'], title: string, detail?: string, payload?: Record<string, unknown>, eventId: string = randomUUID(), tone?: HostAgentEvent['tone']): HostAgentEvent {
    return {
      eventId, taskId, type, title,
      ...(detail ? { detail } : {}),
      ...(payload ? { payload } : {}),
      ...(tone ? { tone } : {}),
      occurredAt: this.now(),
    };
  }

  async publish(events: readonly HostAgentEvent[]): Promise<void> {
    try { await this.destination(events); } catch (error) { this.diagnostic(error); }
  }
}
