import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkspaceResource } from '../src/mind/action/agentTasks/store/agentWorkspaceResources.js';
import { InMemoryAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Agent workspace resource reader', () => {
  it('durably claims and returns a resource only to its assigned host and scope', () => {
    const store = new InMemoryAgentTaskStore();
    const now = new Date().toISOString();
    const created = store.createWorkspaceResource('owner', {
      idempotencyKey: 'resource-1', projectKey: 'sample', path: 'Sources.swift',
      kind: 'file', assignedHostID: 'host-1',
    }, now);
    const duplicate = store.createWorkspaceResource('owner', {
      idempotencyKey: 'resource-2', projectKey: 'sample', path: 'Sources.swift',
      kind: 'file', assignedHostID: 'host-1',
    }, now);
    expect(duplicate).toMatchObject({ created: false, request: { id: created.request.id } });
    expect(store.claimWorkspaceResource('host-2', now)).toBeNull();
    const claimed = store.claimWorkspaceResource('host-1', now);
    expect(claimed).toMatchObject({ id: created.request.id, path: 'Sources.swift' });
    store.recordWorkspaceResource('host-1', {
      requestId: created.request.id, status: 'ready', content: 'let safe = true', occurredAt: now,
    });
    expect(store.getWorkspaceResource('other-owner', created.request.id)).toBeNull();
    expect(store.getWorkspaceResource('owner', created.request.id)).toMatchObject({
      status: 'ready', content: 'let safe = true',
    });
  });

  it('returns bounded UTF-8 file content and a complete per-file diff', () => {
    const path = repository();
    writeFileSync(join(path, 'Sources.swift'), `let before = false\n${'let value = 1\n'.repeat(2_000)}`);
    const projects = new Map([['sample', { key: 'sample', path }]]);

    const file = readWorkspaceResource(projects, request('file', 'Sources.swift'));
    const diff = readWorkspaceResource(projects, request('diff', 'Sources.swift'));

    expect(file).toMatchObject({ status: 'ready', truncated: false });
    expect(file.content).toContain('let value = 1');
    expect(diff).toMatchObject({ status: 'ready', truncated: false });
    expect(diff.content?.length).toBeGreaterThan(16_000);
    expect(diff.content).toContain('+let value = 1');
  });

  it('fails closed for traversal, secrets, binary content, and paths outside the workspace', () => {
    const path = repository();
    writeFileSync(join(path, '.env'), 'TOKEN=private');
    writeFileSync(join(path, 'binary.dat'), Buffer.from([0, 1, 2]));
    symlinkSync('.env', join(path, 'innocent.txt'));
    const projects = new Map([['sample', { key: 'sample', path }]]);

    expect(readWorkspaceResource(projects, request('file', '../outside')).errorCode).toBe('INVALID_PATH');
    expect(readWorkspaceResource(projects, request('file', '.env')).errorCode).toBe('SENSITIVE_FILE');
    expect(readWorkspaceResource(projects, request('file', 'binary.dat')).errorCode).toBe('BINARY_FILE');
    expect(readWorkspaceResource(projects, request('file', 'innocent.txt')).errorCode).toBe('SYMLINK_FILE');
  });
});

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'shannon-resource-'));
  directories.push(path);
  execFileSync('git', ['-C', path, 'init', '-b', 'main']);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'tests@example.com']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Shannon Tests']);
  writeFileSync(join(path, 'Sources.swift'), 'let before = true\n');
  execFileSync('git', ['-C', path, 'add', 'Sources.swift']);
  execFileSync('git', ['-C', path, 'commit', '-m', 'Initial']);
  return path;
}

function request(kind: 'file' | 'diff', path: string) {
  return { id: 'request-1', projectKey: 'sample', path, kind, attempts: 1, leaseUntil: new Date().toISOString() };
}
