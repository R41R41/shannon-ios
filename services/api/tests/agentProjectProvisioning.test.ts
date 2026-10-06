import { describe, expect, it } from 'vitest';
import { InMemoryAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import {
  normalizedAgentProjectKey,
  normalizedGitHubRepositoryURL,
} from '../src/mind/action/agentTasks/store/agentProjectProvisioning.js';

describe('Agent project provisioning', () => {
  it('normalizes GitHub repositories and rejects paths or embedded credentials', () => {
    expect(normalizedGitHubRepositoryURL('https://github.com/OpenAI/codex'))
      .toBe('https://github.com/OpenAI/codex.git');
    expect(normalizedGitHubRepositoryURL('https://github.com/OpenAI/codex.git'))
      .toBe('https://github.com/OpenAI/codex.git');
    expect(normalizedGitHubRepositoryURL('file:///tmp/project')).toBeNull();
    expect(normalizedGitHubRepositoryURL('https://token@github.com/OpenAI/codex')).toBeNull();
    expect(normalizedGitHubRepositoryURL('https://example.com/OpenAI/codex')).toBeNull();
    expect(normalizedGitHubRepositoryURL('https://github.com/OpenAI/codex%2Fother')).toBeNull();
    expect(normalizedAgentProjectKey(' New-App ')).toBe('new-app');
    expect(normalizedAgentProjectKey('../escape')).toBeNull();
  });

  it('leases a durable request only to its selected host and records completion', () => {
    const store = new InMemoryAgentTaskStore();
    const now = '2026-09-13T01:00:00.000Z';
    store.heartbeat({
      hostId: 'local-mac', displayName: 'Local Mac', kind: 'local',
      capabilities: ['project-provision'], projects: ['shannon-ios'], models: [],
    }, now);
    store.heartbeat({
      hostId: 'cloud', displayName: 'Cloud', kind: 'cloud',
      capabilities: ['project-provision'], projects: ['shannon-ios'], models: [],
    }, now);

    expect(store.resolveProvisioningHost('auto', now)).toBe('local-mac');
    expect(store.resolveProvisioningHost('cloud', now)).toBe('cloud');
    expect(store.resolveProvisioningHosts('auto', now)).toEqual(['local-mac', 'cloud']);
    expect(store.resolveProvisioningHosts('local', now)).toEqual(['local-mac']);
    const created = store.createProjectProvisioning('owner', {
      idempotencyKey: 'add-new-app',
      repositoryURL: 'https://github.com/example/new-app.git',
      projectKey: 'new-app',
      assignedHostID: 'local-mac',
    }, now);
    expect(created.created).toBe(true);
    expect(store.claimProjectProvisioning('cloud', now)).toBeNull();
    const claim = store.claimProjectProvisioning('local-mac', now);
    expect(claim).toMatchObject({ projectKey: 'new-app', attempts: 1 });

    const completed = store.recordProjectProvisioning('local-mac', {
      requestId: claim!.id,
      status: 'ready',
      occurredAt: '2026-09-13T01:00:05.000Z',
    });
    expect(completed.status).toBe('ready');
    expect(store.listProjectProvisioning('owner')).toEqual([completed]);
  });

  it('exposes the authenticated user and host provisioning protocol', async () => {
    const store = new InMemoryAgentTaskStore();
    const now = '2026-09-13T01:00:00.000Z';
    store.heartbeat({
      hostId: 'local-mac', displayName: 'Local Mac', kind: 'local',
      capabilities: ['project-provision'], projects: ['shannon-ios'], models: [],
    }, now);
    store.heartbeat({
      hostId: 'cloud', displayName: 'Cloud', kind: 'cloud',
      capabilities: ['project-provision'], projects: ['shannon-ios'], models: [],
    }, now);
    const api = createLocalApiKernel(() => now, { agentTasks: store });

    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/projects', body: {
      scopeKey: 'owner', idempotencyKey: 'request-1',
      repositoryURL: 'https://github.com/example/new-app', projectKey: 'new-app',
      hostPreference: 'auto',
    } });
    expect(created).toMatchObject({ status: 202, body: {
      request: { projectKey: 'new-app', assignedHostID: 'local-mac', status: 'queued' },
      requests: [
        { projectKey: 'new-app', assignedHostID: 'local-mac', status: 'queued' },
        { projectKey: 'new-app', assignedHostID: 'cloud', status: 'queued' },
      ],
    } });

    const claimed = await api.dispatch({
      method: 'POST', path: '/v1/agent/host/projects/claim', body: { hostId: 'local-mac' },
    });
    const requestId = (claimed.body as { provisioning: { id: string } }).provisioning.id;
    expect(claimed).toMatchObject({ status: 200, body: { provisioning: { projectKey: 'new-app' } } });

    expect(await api.dispatch({
      method: 'POST', path: '/v1/agent/host/projects/events', body: {
        hostId: 'local-mac', event: { requestId, status: 'ready', occurredAt: now },
      },
    })).toMatchObject({ status: 200, body: { request: { status: 'ready' } } });
    expect(await api.dispatch({
      method: 'POST', path: '/v1/agent/host/projects/claim', body: { hostId: 'cloud' },
    })).toMatchObject({ status: 200, body: { provisioning: { projectKey: 'new-app' } } });
    expect(await api.dispatch({
      method: 'GET', path: '/v1/agent/projects', query: new URLSearchParams({ scopeKey: 'owner' }),
    })).toMatchObject({ status: 200, body: { requests: [
      { projectKey: 'new-app', assignedHostID: 'local-mac', status: 'ready' },
      { projectKey: 'new-app', assignedHostID: 'cloud', status: 'provisioning' },
    ] } });
  });
});
