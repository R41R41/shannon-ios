import { spawnSync } from 'node:child_process';
import type { AgentHostProject } from './agentHostConfig.js';
import type { AgentWorkspaceChangeDescriptor, AgentWorkspaceProjectState } from '../../mind/action/agentTasks/agentTasksPorts.js';

export class AgentWorkspaceSnapshotReader {
  private cachedAt = 0;
  private cached: readonly AgentWorkspaceProjectState[] = [];

  read(projects: ReadonlyMap<string, AgentHostProject>, now = Date.now()): readonly AgentWorkspaceProjectState[] {
    if (now - this.cachedAt < 30_000 && this.cached.length) return this.cached;
    this.cached = Object.freeze([...projects.values()].map(readProject));
    this.cachedAt = now;
    return this.cached;
  }
}

export function readProject(project: AgentHostProject): AgentWorkspaceProjectState {
  const isGitRepository = git(project.path, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isGitRepository) {
    return Object.freeze({ key: project.key, isGitRepository: false, files: [], changes: [] });
  }
  const branch = git(project.path, ['branch', '--show-current'])
    || git(project.path, ['rev-parse', '--short', 'HEAD']);
  const files = git(project.path, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n').map(line => line.trim()).filter(Boolean).sort().slice(0, 1_200);
  const numstat = parseNumstat(git(project.path, ['diff', '--numstat', 'HEAD', '--']));
  const changes = git(project.path, ['status', '--porcelain=v1'])
    .split('\n').flatMap(line => parseStatusLine(line, numstat));
  return Object.freeze({
    key: project.key,
    isGitRepository: true,
    ...(branch ? { currentBranch: branch } : {}),
    files: Object.freeze(files),
    changes: Object.freeze(changes),
  });
}

function git(path: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', path, ...args], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trimEnd() : '';
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split('\n')) {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t').trim();
    if (!path) continue;
    result.set(path, {
      additions: finiteCount(rawAdditions),
      deletions: finiteCount(rawDeletions),
    });
  }
  return result;
}

function parseStatusLine(
  line: string,
  numstat: ReadonlyMap<string, { additions: number; deletions: number }>,
): AgentWorkspaceChangeDescriptor[] {
  if (line.length < 4) return [];
  const status = line.slice(0, 2).trim() || 'modified';
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1)?.trim() ?? rawPath : rawPath;
  const counts = numstat.get(path) ?? { additions: 0, deletions: 0 };
  return [Object.freeze({ path, status, ...counts })];
}

function finiteCount(value: string | undefined): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}
