import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProject } from '../src/integrations/agentHost/agentWorkspaceSnapshot.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Agent workspace snapshot', () => {
  it('reports the branch, files, and bounded Git change metadata', () => {
    const path = mkdtempSync(join(tmpdir(), 'shannon-workspace-'));
    directories.push(path);
    git(path, ['init', '-b', 'feature/workspace']);
    git(path, ['config', 'user.email', 'tests@example.com']);
    git(path, ['config', 'user.name', 'Shannon Tests']);
    writeFileSync(join(path, 'README.md'), 'first\n');
    git(path, ['add', 'README.md']);
    git(path, ['commit', '-m', 'Initial']);
    writeFileSync(join(path, 'README.md'), 'first\nsecond\n');
    writeFileSync(join(path, 'new.swift'), 'struct New {}\n');

    const state = readProject({ key: 'sample', path });

    expect(state).toMatchObject({
      key: 'sample', isGitRepository: true, currentBranch: 'feature/workspace',
    });
    expect(state.files).toEqual(['README.md', 'new.swift']);
    expect(state.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', status: 'M', additions: 1, deletions: 0 }),
      expect.objectContaining({ path: 'new.swift', status: '??', additions: 0, deletions: 0 }),
    ]));
  });
});

function git(path: string, args: readonly string[]): void {
  execFileSync('git', ['-C', path, ...args]);
}
