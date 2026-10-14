import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));
const now = () => '2026-10-09T00:00:00.000Z';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('local cancellation of existing action resource admission', () => {
  it('cancels a competing resource waiter without cancelling its outer action, then permits a later operation', async () => {
    const h = actionHarness(now); cleanups.push(h.close);
    const resource = actionResource('minebot', 'minecraft-body');
    const other = await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'other' });
    expect(await h.actions.dispatch(leaseOf(other!), [resource])).toBe(true);
    const active = await acquireAction(h.actions, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task' });
    cleanups.push(active!.stop);
    const local = new AbortController(), waiting = active!.execution.permit([resource], local.signal);
    local.abort(); expect(await waiting).toBe(false);
    expect(active!.execution.signal.aborted).toBe(false);
    expect(h.store.get(active!.view.id)?.state).toBe('running');
    await h.actions.finish(leaseOf(other!), 'completed', 'done');
    expect(await active!.execution.permit([resource])).toBe(true);
    await active!.finish('completed', 'done');
  });
  it('does not adopt a grant arriving after local cancellation or invent a second resource release authority', async () => {
    const h = actionHarness(now); cleanups.push(h.close);
    const granted = deferred<void>(), release = deferred<void>();
    const actions = { ...h.actions, async dispatch(...args: Parameters<typeof h.actions.dispatch>) {
      const result = await h.actions.dispatch(...args); granted.resolve(); await release.promise; return result;
    } };
    const active = await acquireAction(actions, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task' });
    cleanups.push(active!.stop);
    const resource = actionResource('minebot', 'minecraft-body'), local = new AbortController();
    const waiting = active!.execution.permit([resource], local.signal);
    await granted.promise; local.abort(); release.resolve();
    expect(await waiting).toBe(false);
    expect(active!.execution.signal.aborted).toBe(false);
    expect(h.store.get(active!.view.id)?.resources).toContain(resource);
    await active!.finish('cancelled', 'local_admission_cancelled');
    expect(h.store.get(active!.view.id)?.state).toBe('cancelled');
  });
  it('asks again after a transient dispatch failure (a missed IPC deadline) and keeps the action, as the heartbeat does', async () => {
    const h = actionHarness(now); cleanups.push(h.close);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failures = 2;
    const active = await acquireAction({ ...h.actions, async dispatch(...args: Parameters<typeof h.actions.dispatch>) {
      if (failures-- > 0) throw new Error('MIND_IPC_DEADLINE');
      return h.actions.dispatch(...args);
    } }, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task' });
    cleanups.push(active!.stop);
    expect(await active!.execution.permit([])).toBe(true);
    expect(active!.execution.signal.aborted).toBe(false);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual(['Shannon action permit error code=MIND_IPC_DEADLINE attempt=1',
      'Shannon action permit error code=MIND_IPC_DEADLINE attempt=2']);
    await active!.finish('completed', 'done');
    warn.mockRestore();
  });
  it('still aborts the outer action on worker dispatch failure', async () => {
    const h = actionHarness(now); cleanups.push(h.close);
    const active = await acquireAction({ ...h.actions, async dispatch() { throw new Error('worker_unavailable'); } },
      { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task' });
    cleanups.push(active!.stop);
    expect(await active!.execution.permit([], new AbortController().signal)).toBe(false);
    expect(active!.execution.signal.aborted).toBe(true);
  });
});
