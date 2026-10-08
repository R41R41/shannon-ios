import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionThreadRoute } from '../src/infra/http/actionThreadRoutes.js';
import { actionHarness } from './support/actionThreadHarness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(before?: (target: string | null) => Promise<void>) {
  const now = () => new Date().toISOString(), harness = actionHarness(now); cleanups.push(harness.close);
  const order: string[] = [];
  const beforeStop = vi.fn(async (target: string | null) => { order.push(`before:${target}`); await before?.(target); });
  const outside = vi.fn(async () => { order.push('outside'); });
  const originalStop = harness.actions.stop;
  const stop = vi.spyOn(harness.actions, 'stop').mockImplementation(async (...args) => { order.push('actions.stop'); return originalStop(...args); });
  const route = createActionThreadRoute(harness.actions, 'owner', outside, now, () => false, beforeStop);
  const server = createServer((request, response) => {
    const scope = request.headers['x-test-scope'];
    void route(request, response, typeof scope === 'string' ? { scopeKey: scope, deviceId: 'phone' } : null,
      new URL(request.url ?? '/', 'http://localhost').pathname);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/action-threads`;
  const call = (path: string, body?: unknown, scope: string | null = 'owner') => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(scope === null ? {} : { 'x-test-scope': scope }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...harness, call, beforeStop, stop, outside, order };
}

describe('global action controls stop durable FCA tasks before execution segments', () => {
  it('invokes the task lifecycle stop for stop-all even when no action is currently queued or running', async () => {
    const h = await fixture();
    const response = await h.call('/stop-all', { requestId: 'empty-stop-all' });
    expect(response.status).toBe(200);
    expect(h.beforeStop).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.stop).toHaveBeenCalledExactlyOnceWith('owner', null, 'empty-stop-all');
    expect(h.order).toEqual(['before:null', 'actions.stop', 'outside']);
    expect(await response.json()).toMatchObject({ count: 0, threads: [] });
  });

  it('awaits the lifecycle boundary before stopping the selected existing action', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const h = await fixture(async () => { entered(); await held; });
    const action = await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'fca:task:1' });
    const pending = h.call(`/${action.id}/stop`, { requestId: 'ordered-stop' });
    await waiting;
    expect(h.stop).not.toHaveBeenCalled(); expect(h.store.get(action.id)?.state).toBe('queued');
    release(); expect((await pending).status).toBe(200);
    expect(h.beforeStop).toHaveBeenCalledExactlyOnceWith(action.id);
    expect(h.order).toEqual([`before:${action.id}`, 'actions.stop', 'outside']);
    expect(h.store.get(action.id)?.state).toBe('cancelled');
  });

  it.each([
    { path: '/stop-all', body: { requestId: '' }, scope: 'owner', status: 400 },
    { path: '/stop-all', body: { requestId: 'bad-input', extra: 'field' }, scope: 'owner', status: 400 },
    { path: '/stop-all', body: [], scope: 'owner', status: 400 },
    { path: '/unknown-control', body: { requestId: 'unknown-control' }, scope: 'owner', status: 404 },
    { path: '/missing/stop', body: { requestId: 'missing-target' }, scope: 'owner', status: 404 },
    { path: '/stop-all', body: { requestId: 'guest' }, scope: 'guest', status: 403 },
    { path: '/stop-all', body: { requestId: 'unpaired' }, scope: null, status: 403 },
  ])('never invokes the callback for invalid or unauthorized $path ($status)', async ({ path, body, scope, status }) => {
    const h = await fixture();
    expect((await h.call(path, body, scope)).status).toBe(status);
    expect(h.beforeStop).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled(); expect(h.outside).not.toHaveBeenCalled();
  });

  it('does not invoke task stopping for reads, resumes or a foreground target', async () => {
    const h = await fixture();
    const own = await h.actions.enqueue({ scopeKey: 'owner', kind: 'ownTime', origin: 'own_time', sourceId: 'cycle' });
    await h.actions.stop('owner', own.id, 'prepare-resume'); h.stop.mockClear(); h.order.length = 0;
    expect((await h.call('')).status).toBe(200);
    expect((await h.call(`/${own.id}/resume`, { requestId: 'resume' })).status).toBe(200);
    const foreground = await h.actions.enqueue({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'talk' });
    expect((await h.call(`/${foreground.id}/stop`, { requestId: 'wrong-target' })).status).toBe(404);
    expect(h.beforeStop).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled(); expect(h.outside).not.toHaveBeenCalled();
  });

  it('reports recovery without claiming the execution stop succeeded when the durable task stop fails', async () => {
    const h = await fixture(async () => { throw new Error('lifecycle unavailable'); });
    const response = await h.call('/stop-all', { requestId: 'failed-lifecycle' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'ACTION_STATE_UNAVAILABLE', availability: 'recovering' });
    expect(h.stop).not.toHaveBeenCalled(); expect(h.outside).not.toHaveBeenCalled();
  });
});
