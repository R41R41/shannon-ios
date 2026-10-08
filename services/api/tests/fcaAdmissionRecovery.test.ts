import { afterEach, describe, expect, it } from 'vitest';
import { actionResource, leaseOf, type ActionDraft } from '../src/contracts/actionThreadContract.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  let time = Date.parse('2026-10-09T00:00:00.000Z');
  const now = () => new Date(time).toISOString(), h = actionHarness(now);
  const calls: FcaModelInput[] = [], drivers: Array<ReturnType<typeof createTaskRuntimeWiring>> = [];
  const create = () => {
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now, ownerAlone: () => true,
      model: { async decide(input) {
        calls.push(input);
        return { decision: { kind: 'wait', summary: 'Handled once' }, history: [{ reply: 'handled' }] };
      }, toolResults: results => ({ results }) } });
    drivers.push(driver); return driver;
  };
  const driver = create(), root = driver.runtime.ensureRoot('owner');
  const child = driver.runtime.createChild('owner', root.id, { title: 'Work', goal: 'Preserve admission' }, 'request');
  const draft = (): ActionDraft => ({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
    sourceId: `fca:${child.id}:${driver.runtime.get('owner', child.id)!.revision}`,
    resources: [actionResource('owner', `fca:${child.id}`)] });
  const admissions = () => h.db.prepare("SELECT payload_json FROM agent_task_events WHERE task_id=? AND event_type='fca_admission_recovered'")
    .all(child.id).map(row => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
  cleanups.push(async () => { for (const active of drivers) await active.close(); h.close(); });
  return { ...h, driver, root, child, draft, calls, create, admissions,
    advance() { time += 31_000; h.store.transaction(() => h.store.sweep(now())); } };
}

describe('FCA admission recovery before a runtime step exists', () => {
  it('recovers a lost successful claim acknowledgement without losing its inbox or replaying the model', async () => {
    const f = fixture();
    f.driver.runtime.send('owner', f.root.id, f.child.id, 'Keep this input', 'message');
    const originalDraft = f.draft(), originalRevision = f.driver.runtime.get('owner', f.child.id)!.revision;
    const claim = f.actions.claim; let loseReply = true;
    f.actions.claim = async id => {
      const action = await claim(id);
      if (action && loseReply) { loseReply = false; throw new Error('claim_reply_lost'); }
      return action;
    };
    await f.driver.tick(); await f.driver.drain();
    const original = f.store.list('owner')[0]!;
    expect(original).toMatchObject({ sourceId: originalDraft.sourceId, state: 'running', sent: false });
    expect(f.driver.runtime.activeSteps('owner')).toEqual([]);
    expect(f.calls).toEqual([]);

    f.advance(); await f.driver.tick(); await f.driver.drain();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.messages.map(message => message.id)).toEqual(['message']);
    expect(f.driver.runtime.snapshot('owner', f.child.id)).toMatchObject({
      task: { phase: 'waiting' }, messages: [], history: [{ reply: 'handled' }],
    });
    expect(f.admissions()).toMatchObject([{ actionId: original.id, generation: original.generation + 1, revision: originalRevision + 1 }]);
    expect(f.store.get(original.id)).toMatchObject({ state: 'cancelled', sent: false, result: 'lease_expired' });
    expect(f.store.list('owner').find(action => action.id !== original.id)).toMatchObject({
      sourceId: `fca:${f.child.id}:${originalRevision + 1}`, state: 'completed', result: 'fca_segment_committed',
    });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls).toHaveLength(1);
    expect(f.admissions()).toHaveLength(1);
  });

  it('recovers after process replacement between claim and beginStep, only after the scheduler expires the lease', async () => {
    const f = fixture(), original = (await f.actions.claim((await f.actions.enqueue(f.draft())).id))!;
    await f.driver.close();
    const restarted = f.create();
    await restarted.tick(); await restarted.drain();
    expect(f.calls).toEqual([]);
    expect(f.admissions()).toEqual([]);
    expect(f.store.get(original.id)?.state).toBe('running');
    f.advance(); await restarted.tick(); await restarted.drain();
    expect(f.calls).toHaveLength(1);
    expect(restarted.runtime.get('owner', f.child.id)?.phase).toBe('waiting');
    expect(f.admissions()).toHaveLength(1);
  });

  it('lets competing runtime instances recover one admission and execute one model decision', async () => {
    const f = fixture();
    await f.actions.claim((await f.actions.enqueue(f.draft())).id);
    f.advance();
    const other = f.create();
    await Promise.all([f.driver.tick(), other.tick()]);
    await Promise.all([f.driver.drain(), other.drain()]);
    expect(f.admissions()).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(f.driver.runtime.get('owner', f.child.id)?.phase).toBe('waiting');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM mind_actions').get()).toEqual({ n: 2 });
  });

  it('acknowledges a durable pre-dispatch stop after its disconnected unsent action expires', async () => {
    const f = fixture(), finish = f.actions.finish, dispatch = f.actions.dispatch;
    f.actions.finish = async () => { throw new Error('worker_disconnected'); };
    f.actions.dispatch = async () => {
      await f.driver.stop(f.child.id, 'owner stopped before dispatch');
      return false;
    };
    await f.driver.tick(); await f.driver.drain();
    const [receipt] = f.driver.runtime.pendingReceipts('owner');
    expect(receipt).toMatchObject({ taskId: f.child.id, state: 'cancelled' });
    expect(f.driver.runtime.get('owner', f.child.id)?.phase).toBe('stopping');
    expect(f.calls).toEqual([]);
    f.advance();
    expect(f.store.get(receipt!.lease.id)).toMatchObject({ state: 'cancelled', sent: false,
      result: 'lease_expired', generation: receipt!.lease.generation + 1 });

    await f.driver.close();
    f.actions.finish = finish; f.actions.dispatch = dispatch;
    const restarted = f.create();
    await restarted.tick(); await restarted.drain();
    expect(restarted.runtime.pendingReceipts('owner')).toEqual([]);
    expect(restarted.runtime.activeSteps('owner')).toEqual([]);
    expect(restarted.runtime.get('owner', f.child.id)?.phase).toBe('stopped');
    expect(f.calls).toEqual([]);
    expect(restarted.runtime.resume('owner', f.child.id)?.phase).toBe('ready');
    await restarted.tick(); await restarted.drain();
    expect(f.calls).toHaveLength(1);
    expect(restarted.runtime.get('owner', f.child.id)?.phase).toBe('waiting');
  });

  it('preserves a dispatched orphan as unknown without creating a successor admission', async () => {
    const f = fixture(), original = (await f.actions.claim((await f.actions.enqueue(f.draft())).id))!;
    await f.actions.dispatch(leaseOf(original)); f.advance();
    for (let attempt = 0; attempt < 3; attempt++) { await f.driver.tick(); await f.driver.drain(); }
    expect(f.store.get(original.id)).toMatchObject({ state: 'unknown', sent: true, result: 'lease_expired' });
    expect(f.calls).toEqual([]);
    expect(f.admissions()).toEqual([]);
    expect(f.driver.runtime.get('owner', f.child.id)?.revision).toBe(f.child.revision);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM mind_actions').get()).toEqual({ n: 1 });
  });

  it.each([
    ['cancelled', 'fca_not_ready'], ['failed', 'admission_failed'], ['completed', 'manually_completed'],
    ['cancelled', 'lease_expired'],
  ] as const)('does not reinterpret %s/%s as an unsent scheduler expiry', async (state, code) => {
    const f = fixture(), original = (await f.actions.claim((await f.actions.enqueue(f.draft())).id))!;
    await f.actions.finish(leaseOf(original), state, code);
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls).toEqual([]);
    expect(f.admissions()).toEqual([]);
    expect(f.store.get(original.id)).toMatchObject({ state, result: code, generation: original.generation });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM mind_actions').get()).toEqual({ n: 1 });
  });

  it.each(['origin', 'resource'] as const)('does not recover an expired action whose %s does not match the task', async mismatch => {
    const f = fixture(), draft = f.draft();
    if (mismatch === 'origin') draft.origin = 'own_time';
    else draft.resources = [actionResource('owner', 'another-task')];
    await f.actions.claim((await f.actions.enqueue(draft)).id); f.advance();
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls).toEqual([]);
    expect(f.admissions()).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM mind_actions').get()).toEqual({ n: 1 });
  });
});
