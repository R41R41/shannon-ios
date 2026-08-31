import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';

describe('Shannon local API kernel', () => {
  it('reports local health', () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect(api.dispatch({ method: 'GET', path: '/health' })).toEqual({
      status: 200,
      body: { ok: true, service: 'shannon-ios-api', mode: 'local' },
    });
  });

  it('captures one immutable state version for a chat turn', () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    const first = api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'こんにちは' } });
    api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'interest-observed', interest: '脳科学' },
    } });
    const second = api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '続き' } });
    expect(first).toMatchObject({ status: 200, body: { mode: 'local-stub', snapshotVersion: 0 } });
    expect(second).toMatchObject({ status: 200, body: { mode: 'local-stub', snapshotVersion: 1 } });
    expect(JSON.stringify(first.body)).not.toContain('脳科学');
    expect(JSON.stringify(second.body)).toContain('脳科学');
  });

  it('keeps scope state isolated', () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'emotion-adjusted', delta: { valence: 0.5 } },
    } });
    const a = api.dispatch({ method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }) });
    const b = api.dispatch({ method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-b' }) });
    expect(a).toMatchObject({ status: 200, body: { version: 1, emotion: { valence: 0.5 } } });
    expect(b).toMatchObject({ status: 200, body: { version: 0, emotion: { valence: 0 } } });
  });

  it('rejects missing scope, malformed events, and long messages', () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect(api.dispatch({ method: 'GET', path: '/v1/state' }).status).toBe(400);
    expect(api.dispatch({ method: 'POST', path: '/v1/events', body: { scopeKey: 'a', event: { type: 'prediction' } } }).status).toBe(400);
    expect(api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'a', message: 'x'.repeat(8_001) } }).status).toBe(400);
  });
});

