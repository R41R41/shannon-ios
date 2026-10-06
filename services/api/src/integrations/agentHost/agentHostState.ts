import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostAgentEvent } from '../../agentTaskStore.js';
import type { AgentReasoningEffort } from '../../agentTaskStore.js';

export interface PersistedAgentSession {
  taskId: string;
  startCommandId: string;
  threadId: string;
  turnId?: string;
  pendingApprovalExternalRequestID?: string;
  goal?: string;
  projectKey: string;
  cwd: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  updatedAt: string;
}

export interface PersistedAgentProject {
  key: string;
  path: string;
  repositoryURL: string;
  updatedAt: string;
}

interface AgentHostStateDocument {
  version: 1;
  sessions: Record<string, PersistedAgentSession>;
  outbox: HostAgentEvent[];
  projects: Record<string, PersistedAgentProject>;
}

const emptyState = (): AgentHostStateDocument => ({ version: 1, sessions: {}, outbox: [], projects: {} });

export class AgentHostStateStore {
  private state: AgentHostStateDocument;

  constructor(private readonly path: string) {
    this.state = this.read();
    this.persist();
  }

  session(taskId: string): PersistedAgentSession | undefined {
    const value = this.state.sessions[taskId];
    return value ? Object.freeze({ ...value }) : undefined;
  }

  resumableSessions(): readonly PersistedAgentSession[] {
    return Object.freeze(Object.values(this.state.sessions)
      .filter(session => Boolean(session.turnId || session.pendingApprovalExternalRequestID))
      .map(session => Object.freeze({ ...session })));
  }

  saveSession(session: PersistedAgentSession): void {
    this.state.sessions[session.taskId] = { ...session };
    this.persist();
  }

  updateSession(taskId: string, update: Partial<PersistedAgentSession>): PersistedAgentSession | undefined {
    const current = this.state.sessions[taskId];
    if (!current) return undefined;
    const next = { ...current, ...update, taskId: current.taskId };
    if (!next.turnId) delete next.turnId;
    if (!next.pendingApprovalExternalRequestID) delete next.pendingApprovalExternalRequestID;
    this.state.sessions[taskId] = next;
    this.persist();
    return Object.freeze({ ...next });
  }

  enqueueEvents(events: readonly HostAgentEvent[]): void {
    const known = new Set(this.state.outbox.map(event => event.eventId));
    for (const event of events) {
      if (known.has(event.eventId)) continue;
      this.state.outbox.push(structuredClone(event));
      known.add(event.eventId);
    }
    this.persist();
  }

  pendingEvents(limit = 50): readonly HostAgentEvent[] {
    return Object.freeze(this.state.outbox.slice(0, Math.max(1, limit)).map(event => structuredClone(event)));
  }

  acknowledgeEvents(eventIds: readonly string[]): void {
    const acknowledged = new Set(eventIds);
    if (!acknowledged.size) return;
    this.state.outbox = this.state.outbox.filter(event => !acknowledged.has(event.eventId));
    this.persist();
  }

  registeredProjects(): readonly PersistedAgentProject[] {
    return Object.freeze(Object.values(this.state.projects).map(project => Object.freeze({ ...project })));
  }

  saveProject(project: PersistedAgentProject): void {
    this.state.projects[project.key] = { ...project };
    this.persist();
  }

  private read(): AgentHostStateDocument {
    if (!existsSync(this.path)) return emptyState();
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
      const object = value as Partial<AgentHostStateDocument>;
      return {
        version: 1,
        sessions: object.sessions && typeof object.sessions === 'object' && !Array.isArray(object.sessions)
          ? object.sessions : {},
        outbox: Array.isArray(object.outbox) ? object.outbox : [],
        projects: object.projects && typeof object.projects === 'object' && !Array.isArray(object.projects)
          ? object.projects : {},
      };
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}
