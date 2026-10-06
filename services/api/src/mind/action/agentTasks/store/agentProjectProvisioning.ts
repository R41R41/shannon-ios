import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AgentProjectProvisioningStatus = 'queued' | 'provisioning' | 'ready' | 'failed';

export interface AgentProjectProvisioningRequest {
  id: string;
  repositoryURL: string;
  projectKey: string;
  assignedHostID: string;
  status: AgentProjectProvisioningStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentProjectProvisioningInput {
  idempotencyKey: string;
  repositoryURL: string;
  projectKey: string;
  assignedHostID: string;
}

export interface ClaimedAgentProjectProvisioning {
  id: string;
  repositoryURL: string;
  projectKey: string;
  attempts: number;
  leaseUntil: string;
}

export interface AgentProjectProvisioningEvent {
  requestId: string;
  status: 'ready' | 'failed';
  errorMessage?: string;
  occurredAt: string;
}

interface ProvisioningRow {
  request_id: string;
  repository_url: string;
  project_key: string;
  assigned_host_id: string;
  status: AgentProjectProvisioningStatus;
  error_message: string | null;
  attempts: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export function migrateAgentProjectProvisioning(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_project_requests (
      request_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      project_key TEXT NOT NULL,
      assigned_host_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','provisioning','ready','failed')),
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS agent_project_requests_claim
      ON agent_project_requests (assigned_host_id, status, created_at);
    CREATE INDEX IF NOT EXISTS agent_project_requests_scope
      ON agent_project_requests (scope_key, updated_at DESC);
  `);
}

export class AgentProjectProvisioningPersistence {
  constructor(private readonly database: DatabaseSync) {}

  create(scopeKey: string, input: CreateAgentProjectProvisioningInput, now: string): {
    request: AgentProjectProvisioningRequest;
    created: boolean;
  } {
    const existing = this.database.prepare(`
      SELECT * FROM agent_project_requests WHERE scope_key = ? AND idempotency_key = ?
    `).get(scopeKey, input.idempotencyKey) as unknown as ProvisioningRow | undefined;
    if (existing) return { request: inflate(existing), created: false };

    const active = this.database.prepare(`
      SELECT * FROM agent_project_requests
      WHERE assigned_host_id = ? AND project_key = ? AND status IN ('queued','provisioning','ready')
      ORDER BY created_at DESC LIMIT 1
    `).get(input.assignedHostID, input.projectKey) as unknown as ProvisioningRow | undefined;
    if (active) return { request: inflate(active), created: false };

    const requestId = randomUUID();
    this.database.prepare(`
      INSERT INTO agent_project_requests
        (request_id, scope_key, idempotency_key, repository_url, project_key,
         assigned_host_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      requestId, scopeKey, input.idempotencyKey, input.repositoryURL,
      input.projectKey, input.assignedHostID, now, now,
    );
    return { request: this.required(requestId), created: true };
  }

  list(scopeKey: string): readonly AgentProjectProvisioningRequest[] {
    const rows = this.database.prepare(`
      SELECT * FROM agent_project_requests WHERE scope_key = ? ORDER BY updated_at DESC LIMIT 50
    `).all(scopeKey) as unknown as ProvisioningRow[];
    return Object.freeze(rows.map(inflate));
  }

  claim(hostId: string, now: string, leaseSeconds = 180): ClaimedAgentProjectProvisioning | null {
    const leaseUntil = new Date(
      Date.parse(now) + Math.max(60, Math.min(600, leaseSeconds)) * 1_000,
    ).toISOString();
    this.database.prepare(`
      UPDATE agent_project_requests
      SET status = 'queued', lease_until = NULL, updated_at = ?
      WHERE assigned_host_id = ? AND status = 'provisioning' AND lease_until <= ?
    `).run(now, hostId, now);
    const row = this.database.prepare(`
      SELECT * FROM agent_project_requests
      WHERE assigned_host_id = ? AND status = 'queued'
      ORDER BY created_at ASC LIMIT 1
    `).get(hostId) as unknown as ProvisioningRow | undefined;
    if (!row) return null;
    const changed = this.database.prepare(`
      UPDATE agent_project_requests
      SET status = 'provisioning', attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(leaseUntil, now, row.request_id);
    if (Number(changed.changes) === 0) return null;
    const claimed = this.requiredRow(row.request_id);
    return Object.freeze({
      id: claimed.request_id,
      repositoryURL: claimed.repository_url,
      projectKey: claimed.project_key,
      attempts: Number(claimed.attempts),
      leaseUntil,
    });
  }

  record(hostId: string, event: AgentProjectProvisioningEvent): AgentProjectProvisioningRequest {
    const row = this.requiredRow(event.requestId);
    if (row.assigned_host_id !== hostId) throw new Error('AGENT_HOST_PROJECT_MISMATCH');
    if (row.status === 'ready' || row.status === 'failed') return inflate(row);
    this.database.prepare(`
      UPDATE agent_project_requests
      SET status = ?, error_message = ?, lease_until = NULL, updated_at = ?
      WHERE request_id = ?
    `).run(
      event.status,
      event.status === 'failed' ? event.errorMessage ?? 'リポジトリを追加できませんでした。' : null,
      event.occurredAt,
      event.requestId,
    );
    return this.required(event.requestId);
  }

  private required(id: string): AgentProjectProvisioningRequest {
    return inflate(this.requiredRow(id));
  }

  private requiredRow(id: string): ProvisioningRow {
    const row = this.database.prepare('SELECT * FROM agent_project_requests WHERE request_id = ?')
      .get(id) as unknown as ProvisioningRow | undefined;
    if (!row) throw new Error('AGENT_PROJECT_REQUEST_NOT_FOUND');
    return row;
  }
}

function inflate(row: ProvisioningRow): AgentProjectProvisioningRequest {
  return Object.freeze({
    id: row.request_id,
    repositoryURL: row.repository_url,
    projectKey: row.project_key,
    assignedHostID: row.assigned_host_id,
    status: row.status,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function normalizedGitHubRepositoryURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en-US') !== 'github.com') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const components = url.pathname.split('/').filter(Boolean);
    if (components.length !== 2) return null;
    const owner = components[0]!;
    const repository = components[1]!.replace(/\.git$/i, '');
    const safeCoordinate = /^[A-Za-z0-9_.-]+$/;
    if (!safeCoordinate.test(owner) || !safeCoordinate.test(repository)
      || owner === '.' || owner === '..' || repository === '.' || repository === '..') return null;
    return `https://github.com/${owner}/${repository}.git`;
  } catch {
    return null;
  }
}

export function normalizedAgentProjectKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLocaleLowerCase('en-US');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(key) ? key : null;
}
