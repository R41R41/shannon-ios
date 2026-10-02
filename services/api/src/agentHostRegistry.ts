import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentHostDescriptor,
  AgentHostHeartbeat,
  AgentModelDescriptor,
  AgentReasoningEffort,
  AgentRoutingPreference,
  AgentWorkspaceCatalog,
  AgentWorkspaceProjectState,
} from './agentTaskStore.js';

interface HostRow {
  host_id: string;
  display_name: string;
  host_kind: string;
  capabilities_json: string;
  projects_json: string;
  models_json: string;
  workspaces_json: string;
  last_seen_at: string;
  active_count: number;
}

export class AgentHostRegistry {
  constructor(private readonly database: DatabaseSync) {}

  heartbeat(heartbeat: AgentHostHeartbeat, now: string): void {
    this.database.prepare(`
      INSERT INTO agent_hosts
        (host_id, display_name, host_kind, capabilities_json, projects_json, models_json, workspaces_json, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET display_name = excluded.display_name,
        host_kind = excluded.host_kind, capabilities_json = excluded.capabilities_json,
        projects_json = excluded.projects_json, models_json = excluded.models_json,
        workspaces_json = excluded.workspaces_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      heartbeat.hostId,
      heartbeat.displayName,
      heartbeat.kind,
      JSON.stringify(heartbeat.capabilities),
      JSON.stringify(heartbeat.projects),
      JSON.stringify(heartbeat.models),
      JSON.stringify(heartbeat.workspaces ?? []),
      now,
    );
  }

  resolveHost(
    projectHint: string | undefined,
    preference: string | undefined,
    now: string,
    fallbackHost: string | null,
  ): string | null {
    const requested = normalizedPreference(preference);
    if (preference && !requested) {
      const exact = this.hostRows().find(host => host.host_id === preference);
      return exact?.host_id ?? preference;
    }
    const hosts = this.hostDescriptors(now);
    const project = projectHint?.trim().toLocaleLowerCase('en-US');
    const supportsProject = (host: AgentHostDescriptor) => !project || host.projects.includes(project);
    const eligible = hosts.filter(host => host.status !== 'offline'
      && supportsProject(host));
    const available = eligible.filter(host => host.status === 'available');
    const byKind = (kind: 'local' | 'cloud') => available.find(host => host.kind === kind)?.hostId;
    if (requested === 'cloud') {
      return byKind('cloud') ?? null;
    }
    // A task that names a project changes code. It waits in line on a Mac that is online, even a busy
    // one, because a host without the Apple toolchain cannot verify it. Work without a project does not wait.
    const local = byKind('local')
      ?? (project ? eligible.find(host => host.kind === 'local')?.hostId : undefined);
    if (requested === 'local') {
      return local ?? null;
    }
    return local ?? byKind('cloud') ?? fallbackHost;
  }

  resolveProvisioningHost(preference: string | undefined, now: string): string | null {
    return this.resolveProvisioningHosts(preference, now)[0] ?? null;
  }

  resolveProvisioningHosts(preference: string | undefined, now: string): readonly string[] {
    const requested = normalizedPreference(preference);
    const available = this.hostDescriptors(now).filter(host =>
      host.status === 'available' && host.capabilities.includes('project-provision'));
    if (requested === 'local') {
      const host = available.find(candidate => candidate.kind === 'local');
      return host ? Object.freeze([host.hostId]) : [];
    }
    if (requested === 'cloud') {
      const host = available.find(candidate => candidate.kind === 'cloud');
      return host ? Object.freeze([host.hostId]) : [];
    }
    return Object.freeze([
      ...available.filter(host => host.kind === 'local'),
      ...available.filter(host => host.kind === 'cloud'),
    ].map(host => host.hostId));
  }

  catalog(projectHint: string | undefined, now: string, fallbackHost: string | null): AgentWorkspaceCatalog {
    const rows = this.hostRows();
    const hosts = this.hostDescriptors(now, rows);
    const projectKeys = [...new Set(hosts.flatMap(host => host.projects))].sort();
    const models = mergeModels(hosts.filter(host => host.status !== 'offline').flatMap(host => host.models));
    const resolvedHostId = this.resolveHost(projectHint, 'auto', now, fallbackHost);
    const resolved = hosts.find(host => host.hostId === resolvedHostId);
    const workspaceStates = [
      ...rows.filter(row => row.host_id === resolvedHostId),
      ...rows.filter(row => row.host_id !== resolvedHostId),
    ].flatMap(row => workspaceArray(row.workspaces_json));
    const explanation = resolved
      ? resolved.kind === 'local'
        ? resolved.status === 'busy'
          ? 'このMacは別の作業中のため、前の作業が終わってから順番に実行します。'
          : 'このMacが利用できるため、ローカルで実行します。'
        : 'このMacが利用できないため、クラウドで実行します。'
      : '利用できる作業ホストを待っています。';
    return Object.freeze({
      routing: Object.freeze({ defaultPreference: 'auto', resolvedHostId, explanation }),
      hosts: Object.freeze(hosts),
      projects: Object.freeze(projectKeys.map(key => Object.freeze({
        key,
        availableHostIds: Object.freeze(hosts
          .filter(host => host.status !== 'offline' && host.projects.includes(key))
          .map(host => host.hostId)),
        ...mergedWorkspaceState(key, workspaceStates),
      }))),
      models: Object.freeze(models),
    });
  }

  private hostRows(): HostRow[] {
    return this.database.prepare(`
      SELECT h.*,
        (SELECT COUNT(*) FROM agent_tasks t
          WHERE t.assigned_host_id = h.host_id
            AND t.status IN ('queued','starting','running','waiting_approval','paused')) AS active_count
      FROM agent_hosts h
      ORDER BY CASE h.host_kind WHEN 'local' THEN 0 ELSE 1 END, h.display_name
    `).all() as unknown as HostRow[];
  }

  private hostDescriptors(now: string, rows: HostRow[] = this.hostRows()): AgentHostDescriptor[] {
    const nowMillis = Date.parse(now);
    return rows.map(row => {
      const lastSeenMillis = Date.parse(row.last_seen_at);
      const online = Number.isFinite(nowMillis) && Number.isFinite(lastSeenMillis)
        && nowMillis - lastSeenMillis <= 45_000;
      return Object.freeze({
        hostId: row.host_id,
        displayName: row.display_name,
        kind: row.host_kind === 'cloud' ? 'cloud' : 'local',
        capabilities: Object.freeze(stringArray(row.capabilities_json)),
        projects: Object.freeze(stringArray(row.projects_json).map(value => value.toLocaleLowerCase('en-US'))),
        models: Object.freeze(modelArray(row.models_json)),
        status: !online ? 'offline' : row.active_count > 0 ? 'busy' : 'available',
        lastSeenAt: row.last_seen_at,
      });
    });
  }
}

function normalizedPreference(value: string | undefined): AgentRoutingPreference | undefined {
  return value === 'auto' || value === 'local' || value === 'cloud' ? value : undefined;
}

export function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra';
}

function stringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [];
  } catch {
    return [];
  }
}

function modelArray(json: string): AgentModelDescriptor[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const model = item as Record<string, unknown>;
      if (typeof model.id !== 'string' || !model.id.trim()) return [];
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.filter(isReasoningEffort)
        : [];
      return [Object.freeze({
        id: model.id,
        displayName: typeof model.displayName === 'string' && model.displayName.trim()
          ? model.displayName : model.id,
        ...(typeof model.description === 'string' && model.description.trim()
          ? { description: model.description } : {}),
        supportedReasoningEfforts: Object.freeze(efforts),
        ...(isReasoningEffort(model.defaultReasoningEffort)
          ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      })];
    });
  } catch {
    return [];
  }
}

function mergeModels(models: readonly AgentModelDescriptor[]): AgentModelDescriptor[] {
  const merged = new Map<string, AgentModelDescriptor>();
  for (const model of models) {
    const existing = merged.get(model.id);
    if (!existing) {
      merged.set(model.id, model);
      continue;
    }
    merged.set(model.id, Object.freeze({
      ...existing,
      supportedReasoningEfforts: Object.freeze([...new Set([
        ...existing.supportedReasoningEfforts,
        ...model.supportedReasoningEfforts,
      ])]),
      ...(existing.defaultReasoningEffort || model.defaultReasoningEffort
        ? { defaultReasoningEffort: existing.defaultReasoningEffort ?? model.defaultReasoningEffort }
        : {}),
    }));
  }
  return [...merged.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function workspaceArray(json: string): AgentWorkspaceProjectState[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const state = item as Record<string, unknown>;
      if (typeof state.key !== 'string' || !state.key.trim()) return [];
      const changes = Array.isArray(state.changes) ? state.changes.flatMap(change => {
        if (!change || typeof change !== 'object' || Array.isArray(change)) return [];
        const candidate = change as Record<string, unknown>;
        if (typeof candidate.path !== 'string' || typeof candidate.status !== 'string') return [];
        return [{
          path: candidate.path,
          status: candidate.status,
          additions: finiteInteger(candidate.additions),
          deletions: finiteInteger(candidate.deletions),
        }];
      }) : [];
      return [{
        key: state.key.trim().toLocaleLowerCase('en-US'),
        isGitRepository: state.isGitRepository === true,
        ...(typeof state.currentBranch === 'string' && state.currentBranch.trim()
          ? { currentBranch: state.currentBranch.trim() } : {}),
        files: Object.freeze(Array.isArray(state.files)
          ? state.files.filter((file): file is string => typeof file === 'string').slice(0, 1_200)
          : []),
        changes: Object.freeze(changes),
      }];
    });
  } catch {
    return [];
  }
}

function mergedWorkspaceState(key: string, states: readonly AgentWorkspaceProjectState[]) {
  const state = states.find(candidate => candidate.key === key);
  return {
    isGitRepository: state?.isGitRepository ?? false,
    ...(state?.currentBranch ? { currentBranch: state.currentBranch } : {}),
    files: Object.freeze(state?.files ?? []),
    changes: Object.freeze(state?.changes ?? []),
  };
}

function finiteInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
