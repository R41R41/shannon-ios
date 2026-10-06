import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentHostConfig } from './agentHostConfig.js';
import type { AgentHostStateStore } from './agentHostState.js';
import {
  normalizedAgentProjectKey,
  normalizedGitHubRepositoryURL,
  type AgentProjectProvisioningEvent,
  type ClaimedAgentProjectProvisioning,
} from '../../agentProjectProvisioning.js';

export class AgentProjectProvisioner {
  constructor(
    private readonly config: AgentHostConfig,
    private readonly state: AgentHostStateStore,
  ) {}

  restore(): void {
    mkdirSync(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.config.workspaceRoot);
    for (const project of this.state.registeredProjects()) {
      const key = normalizedAgentProjectKey(project.key);
      if (!key || !existsSync(project.path) || !statSync(project.path).isDirectory()) continue;
      const path = realpathSync(project.path);
      const location = relative(root, path);
      if (!location || location.startsWith('..') || location.startsWith('/')) continue;
      this.config.projects.set(key, Object.freeze({ key, path }));
    }
  }

  async provision(command: ClaimedAgentProjectProvisioning): Promise<AgentProjectProvisioningEvent> {
    const occurredAt = () => new Date().toISOString();
    const key = normalizedAgentProjectKey(command.projectKey);
    const repositoryURL = normalizedGitHubRepositoryURL(command.repositoryURL);
    if (!key || !repositoryURL) {
      return { requestId: command.id, status: 'failed', errorMessage: 'リポジトリ指定が安全条件を満たしません。', occurredAt: occurredAt() };
    }

    mkdirSync(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.config.workspaceRoot);
    const target = join(root, key);
    if (existsSync(target)) {
      return { requestId: command.id, status: 'failed', errorMessage: '同じ名前の作業領域がすでに存在します。', occurredAt: occurredAt() };
    }

    const temporary = join(root, `.${key}.clone-${command.id}`);
    try {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      await cloneRepository(repositoryURL, temporary);
      renameSync(temporary, target);
      const path = realpathSync(target);
      this.state.saveProject({ key, path, repositoryURL, updatedAt: occurredAt() });
      this.config.projects.set(key, Object.freeze({ key, path }));
      return { requestId: command.id, status: 'ready', occurredAt: occurredAt() };
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      return {
        requestId: command.id,
        status: 'failed',
        errorMessage: safeCloneError(error),
        occurredAt: occurredAt(),
      };
    }
  }
}

function cloneRepository(repositoryURL: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--filter=blob:none', '--', repositoryURL, destination], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      errorOutput = `${errorOutput}${String(chunk)}`.slice(-4_000);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Git clone timed out'));
    }, 10 * 60 * 1_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(errorOutput || `git clone failed (${code ?? 'unknown'})`));
    });
  });
}

function safeCloneError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication|credentials|repository not found/i.test(message)) {
    return 'GitHubの認証またはリポジトリへのアクセス権を確認してください。';
  }
  if (/timed out/i.test(message)) return 'GitHubからの取得が時間切れになりました。';
  return 'GitHubリポジトリを取得できませんでした。Agent Hostのログを確認してください。';
}
