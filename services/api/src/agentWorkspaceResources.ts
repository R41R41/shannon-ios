import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentHostProject } from './agentHostConfig.js';

export type AgentWorkspaceResourceKind = 'file' | 'diff';
export type AgentWorkspaceResourceStatus = 'queued' | 'reading' | 'ready' | 'failed';

export interface AgentWorkspaceResourceRequest {
  id: string;
  projectKey: string;
  path: string;
  kind: AgentWorkspaceResourceKind;
  assignedHostID: string;
  status: AgentWorkspaceResourceStatus;
  content?: string;
  truncated: boolean;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentWorkspaceResourceInput {
  idempotencyKey: string;
  projectKey: string;
  path: string;
  kind: AgentWorkspaceResourceKind;
  assignedHostID: string;
}

export interface ClaimedAgentWorkspaceResource {
  id: string;
  projectKey: string;
  path: string;
  kind: AgentWorkspaceResourceKind;
  attempts: number;
  leaseUntil: string;
}

export interface AgentWorkspaceResourceEvent {
  requestId: string;
  status: 'ready' | 'failed';
  content?: string;
  truncated?: boolean;
  errorCode?: string;
  errorMessage?: string;
  occurredAt: string;
}

interface ResourceRow {
  request_id: string;
  project_key: string;
  path: string;
  resource_kind: AgentWorkspaceResourceKind;
  assigned_host_id: string;
  status: AgentWorkspaceResourceStatus;
  content: string | null;
  truncated: number;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export function migrateAgentWorkspaceResources(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_workspace_resource_requests (
      request_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      path TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('file','diff')),
      assigned_host_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','reading','ready','failed')),
      content TEXT,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS agent_workspace_resources_claim
      ON agent_workspace_resource_requests (assigned_host_id, status, created_at);
  `);
}

export class AgentWorkspaceResourcePersistence {
  constructor(private readonly database: DatabaseSync) {}

  create(scopeKey: string, input: CreateAgentWorkspaceResourceInput, now: string): {
    request: AgentWorkspaceResourceRequest;
    created: boolean;
  } {
    const existing = this.database.prepare(`
      SELECT * FROM agent_workspace_resource_requests WHERE scope_key = ? AND idempotency_key = ?
    `).get(scopeKey, input.idempotencyKey) as unknown as ResourceRow | undefined;
    if (existing) return { request: inflate(existing), created: false };
    const active = this.database.prepare(`
      SELECT * FROM agent_workspace_resource_requests
      WHERE scope_key = ? AND project_key = ? AND path = ? AND resource_kind = ?
        AND assigned_host_id = ? AND status IN ('queued', 'reading')
      ORDER BY created_at DESC LIMIT 1
    `).get(scopeKey, input.projectKey, input.path, input.kind,
      input.assignedHostID) as unknown as ResourceRow | undefined;
    if (active) return { request: inflate(active), created: false };
    this.database.prepare(`
      DELETE FROM agent_workspace_resource_requests WHERE request_id IN (
        SELECT request_id FROM agent_workspace_resource_requests
        WHERE scope_key = ? AND status IN ('ready', 'failed')
        ORDER BY updated_at DESC LIMIT -1 OFFSET 200
      )
    `).run(scopeKey);
    const requestId = randomUUID();
    this.database.prepare(`
      INSERT INTO agent_workspace_resource_requests
        (request_id, scope_key, idempotency_key, project_key, path, resource_kind,
         assigned_host_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(requestId, scopeKey, input.idempotencyKey, input.projectKey, input.path,
      input.kind, input.assignedHostID, now, now);
    return { request: this.required(requestId, scopeKey), created: true };
  }

  get(scopeKey: string, requestId: string): AgentWorkspaceResourceRequest | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_workspace_resource_requests WHERE scope_key = ? AND request_id = ?
    `).get(scopeKey, requestId) as unknown as ResourceRow | undefined;
    return row ? inflate(row) : null;
  }

  claim(hostId: string, now: string, leaseSeconds = 60): ClaimedAgentWorkspaceResource | null {
    const leaseUntil = new Date(Date.parse(now) + Math.max(30, Math.min(180, leaseSeconds)) * 1_000).toISOString();
    this.database.prepare(`
      UPDATE agent_workspace_resource_requests SET status = 'queued', lease_until = NULL, updated_at = ?
      WHERE assigned_host_id = ? AND status = 'reading' AND lease_until <= ?
    `).run(now, hostId, now);
    const row = this.database.prepare(`
      SELECT * FROM agent_workspace_resource_requests
      WHERE assigned_host_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1
    `).get(hostId) as unknown as ResourceRow | undefined;
    if (!row) return null;
    const changed = this.database.prepare(`
      UPDATE agent_workspace_resource_requests
      SET status = 'reading', attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(leaseUntil, now, row.request_id);
    if (Number(changed.changes) === 0) return null;
    return Object.freeze({
      id: row.request_id,
      projectKey: row.project_key,
      path: row.path,
      kind: row.resource_kind,
      attempts: Number(row.attempts) + 1,
      leaseUntil,
    });
  }

  record(hostId: string, event: AgentWorkspaceResourceEvent): AgentWorkspaceResourceRequest {
    const row = this.requiredRow(event.requestId);
    if (row.assigned_host_id !== hostId) throw new Error('AGENT_HOST_RESOURCE_MISMATCH');
    if (row.status === 'ready' || row.status === 'failed') return inflate(row);
    this.database.prepare(`
      UPDATE agent_workspace_resource_requests
      SET status = ?, content = ?, truncated = ?, error_code = ?, error_message = ?,
          lease_until = NULL, updated_at = ? WHERE request_id = ?
    `).run(event.status, event.status === 'ready' ? event.content ?? '' : null,
      event.truncated === true ? 1 : 0, event.errorCode ?? null, event.errorMessage ?? null,
      event.occurredAt, event.requestId);
    return inflate(this.requiredRow(event.requestId));
  }

  private required(requestId: string, scopeKey: string): AgentWorkspaceResourceRequest {
    const request = this.get(scopeKey, requestId);
    if (!request) throw new Error('AGENT_WORKSPACE_RESOURCE_NOT_FOUND');
    return request;
  }

  private requiredRow(requestId: string): ResourceRow {
    const row = this.database.prepare('SELECT * FROM agent_workspace_resource_requests WHERE request_id = ?')
      .get(requestId) as unknown as ResourceRow | undefined;
    if (!row) throw new Error('AGENT_WORKSPACE_RESOURCE_NOT_FOUND');
    return row;
  }
}

export function readWorkspaceResource(
  projects: ReadonlyMap<string, AgentHostProject>,
  request: ClaimedAgentWorkspaceResource,
  occurredAt = new Date().toISOString(),
): AgentWorkspaceResourceEvent {
  try {
    const project = projects.get(request.projectKey);
    if (!project) throw resourceError('PROJECT_NOT_AVAILABLE', 'このプロジェクトはAgent Hostで利用できません。');
    const safePath = normalizedResourcePath(request.path);
    if (!safePath) throw resourceError('INVALID_PATH', '安全でないファイルパスは開けません。');
    if (isSensitivePath(safePath)) throw resourceError('SENSITIVE_FILE', '機密情報を含む可能性があるファイルは表示しません。');
    const result = request.kind === 'diff'
      ? readDiff(project.path, safePath)
      : readTextFile(project.path, safePath, 256 * 1024);
    return { requestId: request.id, status: 'ready', ...result, occurredAt };
  } catch (error) {
    const failure = error instanceof WorkspaceResourceError
      ? error : resourceError('READ_FAILED', 'ファイルを読み取れませんでした。');
    return {
      requestId: request.id,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      occurredAt,
    };
  }
}

export function normalizedResourcePath(value: string): string | null {
  const path = value.trim().replaceAll('\\', '/');
  if (!path || path.length > 1_024 || isAbsolute(path) || path.includes('\0')) return null;
  const components = path.split('/');
  if (components.some(component => !component || component === '.' || component === '..')) return null;
  return components.join('/');
}

function readTextFile(rootPath: string, path: string, limit: number): { content: string; truncated: boolean } {
  const root = realpathSync(rootPath);
  const candidate = resolve(root, path);
  if (!existsSync(candidate)) throw resourceError('FILE_NOT_FOUND', 'ファイルが見つかりません。');
  if (lstatSync(candidate).isSymbolicLink()) {
    throw resourceError('SYMLINK_FILE', 'シンボリックリンクはプレビューできません。');
  }
  const resolved = realpathSync(candidate);
  if (!isWithin(root, resolved)) throw resourceError('OUTSIDE_WORKSPACE', '作業領域外のファイルは開けません。');
  const stat = lstatSync(resolved);
  if (!stat.isFile()) throw resourceError('NOT_A_FILE', '通常ファイルだけを表示できます。');
  const descriptor = openSync(resolved, 'r');
  const bytes = Buffer.alloc(Math.min(stat.size, limit + 4));
  try {
    readSync(descriptor, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (bytes.includes(0)) throw resourceError('BINARY_FILE', 'バイナリファイルはプレビューできません。');
  const visible = bytes.subarray(0, Math.min(bytes.length, limit));
  const content = decodeUTF8Prefix(visible);
  if (content === null) {
    throw resourceError('BINARY_FILE', 'UTF-8テキスト以外はプレビューできません。');
  }
  return { content, truncated: stat.size > limit };
}

function decodeUTF8Prefix(bytes: Uint8Array): string | null {
  for (let removed = 0; removed <= Math.min(3, bytes.length); removed += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - removed));
    } catch {
      // A bounded read can end halfway through one UTF-8 scalar; trim only that incomplete suffix.
    }
  }
  return null;
}

function readDiff(rootPath: string, path: string): { content: string; truncated: boolean } {
  const maxBytes = 512 * 1024;
  const result = spawnSync('git', ['-C', rootPath, 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', path], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: maxBytes + 64 * 1024,
  });
  if (result.error && !String(result.error.message).includes('ENOBUFS')) {
    throw resourceError('DIFF_FAILED', '差分を取得できませんでした。');
  }
  let content = result.stdout ?? '';
  if (!content && existsSync(resolve(rootPath, path))) {
    const status = spawnSync('git', ['-C', rootPath, 'status', '--porcelain=v1', '--', path], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    }).stdout;
    if (status?.startsWith('??')) {
      const file = readTextFile(rootPath, path, maxBytes);
      content = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${file.content.split('\n').map(line => `+${line}`).join('\n')}`;
    }
  }
  const truncated = Buffer.byteLength(content, 'utf8') > maxBytes || Boolean(result.error);
  if (truncated) content = Buffer.from(content).subarray(0, maxBytes).toString('utf8');
  return { content, truncated };
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLocaleLowerCase('en-US');
  const name = basename(lower);
  return lower.startsWith('.git/') || lower.includes('/.git/')
    || lower.startsWith('.ssh/') || lower.includes('/.ssh/')
    || lower.startsWith('.aws/') || lower.includes('/.aws/')
    || name === '.npmrc' || name === '.pypirc' || name === 'credentials'
    || name === 'id_rsa' || name === 'id_ed25519' || name.startsWith('.env')
    || /\.(?:pem|p12|pfx|key)$/u.test(name);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

class WorkspaceResourceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function resourceError(code: string, message: string): WorkspaceResourceError {
  return new WorkspaceResourceError(code, message);
}

function inflate(row: ResourceRow): AgentWorkspaceResourceRequest {
  return Object.freeze({
    id: row.request_id,
    projectKey: row.project_key,
    path: row.path,
    kind: row.resource_kind,
    assignedHostID: row.assigned_host_id,
    status: row.status,
    ...(row.content !== null ? { content: row.content } : {}),
    truncated: row.truncated === 1,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
