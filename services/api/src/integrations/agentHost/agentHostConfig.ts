import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { processEnvironment } from '../../infra/config/serverEnvironment.js';

export interface AgentHostProject {
  key: string;
  path: string;
}

export interface AgentHostConfig {
  apiBaseURL: string;
  token: string;
  hostId: string;
  displayName: string;
  stateFile: string;
  workspaceRoot: string;
  codexExecutable: string;
  codexModel?: string;
  codexEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  deliveryMode: 'local-device' | 'cloud-testflight';
  projects: Map<string, AgentHostProject>;
  defaultProjectKey: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
}

export function loadAgentHostConfig(environment: NodeJS.ProcessEnv = processEnvironment()): AgentHostConfig {
  const token = environment.SHANNON_AGENT_HOST_TOKEN?.trim() ?? '';
  if (token.length < 32) throw new Error('SHANNON_AGENT_HOST_TOKEN must contain at least 32 characters');

  const apiBaseURL = normalizeBaseURL(environment.SHANNON_API_BASE_URL ?? 'http://127.0.0.1:4317');
  const projects = parseProjects(environment.SHANNON_AGENT_PROJECTS_JSON);
  const requestedDefault = environment.SHANNON_AGENT_DEFAULT_PROJECT?.trim();
  const defaultProjectKey = requestedDefault || (projects.size === 1 ? [...projects.keys()][0]! : '');
  if (!defaultProjectKey || !projects.has(defaultProjectKey.toLocaleLowerCase('en-US'))) {
    throw new Error('SHANNON_AGENT_DEFAULT_PROJECT must name an allowlisted project');
  }

  const configuredCodex = environment.SHANNON_CODEX_COMMAND?.trim();
  const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const codexExecutable = configuredCodex || (existsSync(bundledCodex) ? bundledCodex : 'codex');
  const codexEffort = parseEffort(environment.SHANNON_CODEX_REASONING_EFFORT);
  const deliveryMode = parseDeliveryMode(environment.SHANNON_AGENT_DELIVERY_MODE);

  return Object.freeze({
    apiBaseURL,
    token,
    hostId: environment.SHANNON_AGENT_HOST_ID?.trim() || 'shannon-mac',
    displayName: environment.SHANNON_AGENT_HOST_NAME?.trim() || 'Shannon Mac',
    stateFile: environment.SHANNON_AGENT_STATE_FILE?.trim() || join(homedir(), '.shannon', 'agent-host-state.json'),
    workspaceRoot: validatedWorkspaceRoot(
      environment.SHANNON_AGENT_WORKSPACE_ROOT?.trim() || join(homedir(), '.shannon', 'workspaces'),
    ),
    codexExecutable,
    ...(environment.SHANNON_CODEX_MODEL?.trim() ? { codexModel: environment.SHANNON_CODEX_MODEL.trim() } : {}),
    ...(codexEffort ? { codexEffort } : {}),
    deliveryMode,
    projects,
    defaultProjectKey: defaultProjectKey.toLocaleLowerCase('en-US'),
    pollIntervalMs: boundedInteger(environment.SHANNON_AGENT_POLL_INTERVAL_MS, 1_500, 250, 30_000),
    heartbeatIntervalMs: boundedInteger(environment.SHANNON_AGENT_HEARTBEAT_INTERVAL_MS, 15_000, 5_000, 120_000),
  });
}

function validatedWorkspaceRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error('SHANNON_AGENT_WORKSPACE_ROOT must be an absolute path');
  return value;
}

function parseDeliveryMode(raw: string | undefined): AgentHostConfig['deliveryMode'] {
  const value = raw?.trim() || 'local-device';
  if (value === 'local-device' || value === 'cloud-testflight') return value;
  throw new Error('SHANNON_AGENT_DELIVERY_MODE must be local-device or cloud-testflight');
}

export function resolveAgentProject(config: AgentHostConfig, hint: unknown): AgentHostProject {
  const key = typeof hint === 'string' && hint.trim()
    ? hint.trim().toLocaleLowerCase('en-US')
    : config.defaultProjectKey;
  const project = config.projects.get(key);
  if (!project) throw new Error(`AGENT_PROJECT_NOT_ALLOWLISTED:${key}`);
  return project;
}

function parseProjects(raw: string | undefined): Map<string, AgentHostProject> {
  if (!raw?.trim()) throw new Error('SHANNON_AGENT_PROJECTS_JSON is required');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('SHANNON_AGENT_PROJECTS_JSON must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SHANNON_AGENT_PROJECTS_JSON must be an object of project names to paths');
  }
  const projects = new Map<string, AgentHostProject>();
  for (const [rawKey, rawPath] of Object.entries(value)) {
    const key = rawKey.trim().toLocaleLowerCase('en-US');
    if (!key || typeof rawPath !== 'string' || !isAbsolute(rawPath)) {
      throw new Error(`Invalid allowlisted project: ${rawKey}`);
    }
    const path = realpathSync(rawPath);
    if (!statSync(path).isDirectory()) throw new Error(`Allowlisted project is not a directory: ${rawKey}`);
    projects.set(key, Object.freeze({ key, path }));
  }
  if (!projects.size) throw new Error('At least one allowlisted project is required');
  return projects;
}

function normalizeBaseURL(raw: string): string {
  const url = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('SHANNON_API_BASE_URL must use HTTPS except on localhost');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function parseEffort(raw: string | undefined): AgentHostConfig['codexEffort'] | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra') return value;
  throw new Error('SHANNON_CODEX_REASONING_EFFORT must be low, medium, high, xhigh, max, or ultra');
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = raw ? Number(raw) : fallback;
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
