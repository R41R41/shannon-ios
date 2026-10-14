import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import type { FcaModel, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskSleepTicket } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { integratedFcaHarness, round } from './support/fcaIntegratedHarness.js';

/**
 * Stabilization 2026-10-12: an FCA task left in `fca_unknown` must not hold the runtime forever, and stop-all must not
 * disable conversation or sleep. Real SQLite action authority and task runtime; time is a variable, never a timer.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const MINUTE = 60_000;
function blocked(signal: AbortSignal): Promise<FcaModelOutput> {
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('model_abort')), { once: true }));
}
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Promise.resolve(); }
  expect(condition(), label).toBe(true);
}
function fixture(decide: (input: FcaModelInput, signal: AbortSignal) => Promise<FcaModelOutput> | FcaModelOutput) {
  let time = Date.parse('2026-10-09T00:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const calls: FcaModelInput[] = [];
  const model: FcaModel = { async decide(input, signal) { calls.push(input); return decide(input, signal); }, toolResults: results => ({ results }) };
  const tickets = new Map<string, TaskSleepTicket>([['night', { jobId: 'night', dayKey: '2026-10-08', startAt: '2026-10-07T15:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z' }]]);
  const drivers: Array<ReturnType<typeof createTaskRuntimeWiring>> = [];
  const create = () => {
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
      sleepTicket: (scope, id) => scope === 'owner' ? tickets.get(id) ?? null : null, maintenanceAllowed: () => true });
    drivers.push(driver); return driver;
  };
  const driver = create(), root = driver.runtime.ensureRoot('owner');
  cleanups.push(async () => { for (const current of drivers) await current.close(); h.close(); });
  return { ...h, driver, root, calls, restart: create, now,
    advance(milliseconds: number) { time += milliseconds; h.store.transaction(() => h.store.sweep(now())); },
    child(title: string, parentId = root.id) {
      return driver.runtime.createChild('owner', parentId, { title, goal: `${title} goal` }, `request-${title}`);
    },
    respondLease(source: string) {
      return leaseOf(h.store.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: source }, 'test-runner', now())!);
    },
  };
}
/** Makes `title` unknown the way production did: a dispatched model call whose lease expired while the API restarted. */
async function strandUnknown(f: ReturnType<typeof fixture>, title: string, settled: () => boolean = () => true) {
  await f.driver.tick();
  await until(() => f.calls.some(call => call.task.title === title) && settled(), `${title} dispatched`);
  f.advance(MINUTE);
  await f.driver.close();
  const restored = f.restart();
  await restored.tick(); await restored.drain();
  return restored;
}

describe('FCA tasks leave fca_unknown without replaying anything', () => {
  it('fails a generic task unknown past the deadline, tells its parent, and lets the parent stop finish', async () => {
    const f = fixture((input, signal) => input.task.title === 'child' ? blocked(signal) : round({ kind: 'wait', summary: 'waiting' }));
    const parent = f.child('parent');
    const child = f.child('child', parent.id);
    const driver = await strandUnknown(f, 'child', () => f.driver.runtime.get('owner', parent.id)?.phase === 'waiting'
      && f.driver.runtime.pendingReceipts('owner').length === 0);
    expect(driver.runtime.get('owner', child.id)?.phase).toBe('unknown');
    await driver.stop(parent.id, 'owner_stop');
    expect(driver.runtime.get('owner', parent.id)?.phase).toBe('stopping'); // held by the unknown child

    // A work task's step is model-only: it leaves at the shorter exit (2026-10-13), not after ten minutes.
    f.advance(2 * MINUTE); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', child.id)?.phase).toBe('unknown');

    f.advance(2 * MINUTE); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', child.id)).toMatchObject({ phase: 'failed', status: 'failed' });
    expect(driver.runtime.get('owner', parent.id)?.phase).toBe('stopped');
    expect(driver.runtime.snapshot('owner', parent.id)?.messages.map(message => message.id)).toContain(`result:retired:${child.id}`);
    expect(f.calls.filter(call => call.task.title === 'child')).toHaveLength(1);
    expect(driver.runtime.resume('owner', child.id)).toBeNull();
  });

  it('keeps the internal root running after its unknown step expires, and runs the message it never answered once more', async () => {
    let first = true, rootId = '';
    const f = fixture((input, signal) => {
      if (input.task.id === rootId && first) { first = false; return blocked(signal); }
      return round({ kind: 'wait', summary: 'waiting' });
    });
    rootId = f.root.id;
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'wake the root', 'root-wake-1');
    const driver = await strandUnknown(f, f.root.title);
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
    expect(() => f.child('blocked-by-root')).toThrow('FCA_PARENT_INACTIVE');
    // A message that arrives while the root is unknown does not wake it (its lost step still holds it).
    driver.runtime.send('owner', f.root.id, f.root.id, 'while unknown', 'root-wake-2');
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
    f.advance(11 * MINUTE); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(f.child('after-root')).toMatchObject({ phase: 'ready' });
    // Fix 2026-10-14 (production ab990c87, a lost wakeup): the step never got past its decision request, so the message it saw is
    // delivered exactly once more, with the one that arrived meanwhile, and both are consumed.
    const rootCalls = f.calls.filter(call => call.task.id === rootId);
    expect(rootCalls.map(call => call.messages.map(message => message.id))).toEqual([['root-wake-1'], ['root-wake-1', 'root-wake-2']]);
    expect(driver.runtime.pendingMessageIds?.('owner', rootId)).toEqual([]);
    await driver.tick(); await driver.drain();
    expect(f.calls.filter(call => call.task.id === rootId)).toHaveLength(2);
  });

  it('revives an unknown conversation in place on the owner\'s next turn, fencing the lost step', async () => {
    const f = fixture(() => round({ kind: 'wait', summary: 'waiting' }));
    const lost = f.respondLease('turn-1');
    const step = f.driver.runtime.beginConversation('owner', 'thread-1', lost)!;
    expect(step).not.toBeNull();
    f.store.finish(lost, 'unknown', 'response_interrupted', f.now());
    await f.driver.tick();
    expect(f.driver.runtime.get('owner', step.taskId)?.phase).toBe('unknown');

    const next = f.driver.runtime.beginConversation('owner', 'thread-1', f.respondLease('turn-2'));
    expect(next).toMatchObject({ taskId: step.taskId });
    expect(f.driver.runtime.get('owner', step.taskId)?.phase).toBe('executing');
    expect(f.driver.runtime.completeConversation(step, { experienceId: 'experience-lost', threadId: 'thread-1',
      observedAt: f.now(), recalledMemoryIds: [] })).toBe(false);
  });
});

describe('stop-all stops the work in flight without disabling the runtime', () => {
  it('lets the owner\'s next turn revive the root and that thread\'s conversation', async () => {
    const f = fixture(() => round({ kind: 'wait', summary: 'waiting' }));
    const first = f.respondLease('turn-1');
    const step = f.driver.runtime.beginConversation('owner', 'thread-1', first)!;
    f.driver.runtime.failConversation(step);
    f.store.finish(first, 'completed', 'responded', f.now());
    await f.driver.stop(f.root.id, 'owner_stop_all');
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('stopped');
    expect(f.driver.runtime.get('owner', step.taskId)?.phase).toBe('stopped');
    expect(() => f.child('after-stop')).toThrow('FCA_PARENT_INACTIVE');

    const next = f.driver.runtime.beginConversation('owner', 'thread-1', f.respondLease('turn-2'));
    expect(next).toMatchObject({ taskId: step.taskId });
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(f.child('after-turn')).toMatchObject({ phase: 'ready' });
  });

  it('wakes a revived root for a message that arrived while it was stopped (2026-10-14)', async () => {
    const f = fixture(() => round({ kind: 'wait', summary: 'waiting' }));
    await f.driver.stop(f.root.id, 'owner_stop_all');
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'while stopped', 'stopped-1');
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('stopped');
    f.driver.runtime.beginConversation('owner', 'thread-1', f.respondLease('turn-1'));
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('ready');
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls.map(call => call.messages.map(message => message.id))).toEqual([['stopped-1']]);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
  });

  it('lets a due nightly sleep revive the stopped root', async () => {
    const f = fixture(() => round({ kind: 'wait', summary: 'waiting' }));
    await f.driver.stop(f.root.id, 'owner_stop_all');
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('stopped');
    expect(f.driver.runtime.admitSleep('owner', 'night')).toMatchObject({ kind: 'sleep', phase: 'ready' });
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
  });
});

/**
 * Production ab990c87 (2026-10-14): the root's step failed with a 400 and went unknown; at its exit the root was set to wait for
 * its next message while the result of a failed child (received just before the step) was still pending, and nothing woke it.
 */
describe('the internal root never waits on a message already delivered', () => {
  const rootCalls = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.task.id === f.root.id);
  /** Strands the root's current blocked step as unknown with a restart, as production did, and returns the new driver. */
  async function strandRunning(f: ReturnType<typeof fixture>, driver: ReturnType<typeof fixture>['driver']) {
    f.advance(MINUTE); await driver.close();
    const restored = f.restart(); await restored.tick(); await restored.drain();
    return restored;
  }

  it('runs once more, at the unknown exit, the child result its refused decision request saw (the production shape)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let first = true;
    // As ab990c87 did: the decision request threw at once (a 400 the root could not close as known), so the step went unknown
    // with its decision recorded as unknown (`fca.decide`), never answered.
    const f = fixture(() => {
      if (first) { first = false; throw new Error('FCA_MODEL_HTTP_400'); }
      return round({ kind: 'wait', summary: 'waiting' });
    });
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'failed-child: failed', 'result:child-a');
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
    const decision = f.db.prepare(`SELECT json_extract(payload_json,'$.status') AS status FROM agent_task_events WHERE task_id=?
      AND event_type='fca_progress_observed' ORDER BY sequence`).all(f.root.id).map(row => row.status);
    expect(decision).toEqual(['running', 'unknown']);
    f.advance(11 * MINUTE); await f.driver.tick(); await f.driver.drain();
    expect(rootCalls(f).map(call => call.messages.map(message => message.id))).toEqual([['result:child-a'], ['result:child-a']]);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(f.driver.runtime.pendingMessageIds?.('owner', f.root.id)).toEqual([]);
  });

  it('stays waiting, with no model call, when the retired root has no pending message', async () => {
    let first = true;
    const f = fixture((input, signal) => {
      if (first) { first = false; return blocked(signal); }
      return round({ kind: 'wait', summary: 'waiting' });
    });
    await f.driver.stop(f.root.id, 'owner_stop'); f.driver.runtime.resume('owner', f.root.id); // ready with an empty inbox
    const driver = await strandUnknown(f, f.root.title);
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
    f.advance(11 * MINUTE); await driver.tick(); await driver.drain(); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(rootCalls(f)).toHaveLength(1);
  });

  it('delivers a message once more only once: a second lost step consumes it, and the root does not spin', async () => {
    const f = fixture((_input, signal) => blocked(signal));
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'child result', 'result:child-a');
    let driver = await strandUnknown(f, f.root.title);
    f.advance(11 * MINUTE); await driver.tick();
    await until(() => rootCalls(f).length === 2, 'delivered once more');
    driver = await strandRunning(f, driver);
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('unknown');
    f.advance(11 * MINUTE);
    for (let i = 0; i < 5; i++) { await driver.tick(); await driver.drain(); }
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(rootCalls(f)).toHaveLength(2);
    expect(driver.runtime.pendingMessageIds?.('owner', f.root.id)).toEqual([]);
    const settled = f.db.prepare("SELECT payload_json FROM agent_task_events WHERE task_id=? AND event_type='fca_inbox_redelivered' ORDER BY sequence").all(f.root.id)
      .map(row => JSON.parse(String(row.payload_json)) as { messageIds: string[]; droppedMessageIds: string[] });
    expect(settled.map(({ messageIds, droppedMessageIds }) => ({ messageIds, droppedMessageIds }))).toEqual([
      { messageIds: ['result:child-a'], droppedMessageIds: [] }, { messageIds: [], droppedMessageIds: ['result:child-a'] }]);
  });

  it('does not run again a message the lost step may have acted on', async () => {
    let first = true;
    const f = fixture((input, signal) => {
      if (input.task.id === f.root.id && first) { first = false; return blocked(signal); }
      return round({ kind: 'wait', summary: 'waiting' });
    });
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'make a child', 'root-make');
    await f.driver.tick();
    await until(() => rootCalls(f).length === 1, 'root dispatched');
    f.child('made-during-the-step'); // A child appeared while the step was in flight: it may have been the step's.
    const driver = await strandRunning(f, f.driver);
    f.advance(11 * MINUTE); await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    expect(rootCalls(f)).toHaveLength(1);
    expect(driver.runtime.pendingMessageIds?.('owner', f.root.id)).toEqual([]);
  });

  it('closes a provider-refused root step as known, delivers its message once more, then consumes it without spinning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fixture(() => { currentActionExecution()!.modelOutcome = 'acknowledged'; throw new Error('FCA_MODEL_HTTP_400'); });
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'child result', 'result:child-a');
    for (let i = 0; i < 6; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(rootCalls(f).map(call => call.messages.map(message => message.id))).toEqual([['result:child-a'], ['result:child-a']]);
    expect(f.driver.runtime.get('owner', f.root.id)).toMatchObject({ phase: 'waiting', status: 'running' });
    expect(f.driver.runtime.pendingMessageIds?.('owner', f.root.id)).toEqual([]);
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'));
    expect(lines).toEqual(Array(2).fill(`Shannon FCA step failed task=${f.root.id} code=FCA_MODEL_HTTP_400`));
    // The next message still runs the root: it was never held unknown.
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'next', 'next-1');
    await f.driver.tick(); await f.driver.drain();
    expect(rootCalls(f)).toHaveLength(3);
  });

  it('runs the message after one refusal once the request is accepted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let refused = false;
    const f = fixture(() => {
      if (!refused) { refused = true; currentActionExecution()!.modelOutcome = 'acknowledged'; throw new Error('FCA_MODEL_HTTP_400'); }
      return round({ kind: 'wait', summary: 'waiting' });
    });
    f.driver.runtime.send('owner', f.root.id, f.root.id, 'child result', 'result:child-a');
    for (let i = 0; i < 4; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(rootCalls(f)).toHaveLength(2);
    expect(f.driver.runtime.snapshot('owner', f.root.id)?.messages).toEqual([]);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
  });

  it('wakes, on the next tick, a root left waiting on a pending message by an earlier release (the production state)', async () => {
    const f = fixture(() => round({ kind: 'wait', summary: 'waiting' }));
    const child = f.child('failed-child');
    // As ab990c87 left it: the message is in the inbox, the root waits for a message, and nothing woke it.
    f.db.prepare('INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at) VALUES(?,?,?,?,?,?)')
      .run('owner', 'result:legacy', child.id, f.root.id, 'failed-child: failed', f.now());
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    await f.driver.tick(); await f.driver.drain();
    expect(rootCalls(f).map(call => call.messages.map(message => message.id))).toEqual([['result:legacy']]);
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    await f.driver.tick(); await f.driver.drain();
    expect(rootCalls(f)).toHaveLength(1);
  });
});

describe('an unknown nightly sleep', () => {
  it('is closed as failed after the deadline, never re-run, and the next pending night is admitted', async () => {
    const analyzed: string[][] = [];
    const f = integratedFcaHarness({ decide: () => round({ kind: 'wait', summary: 'waiting' }), sleep: { analyzer: { mode: 'local-rules',
      async analyze(messages) {
        analyzed.push(messages.map(item => item.content));
        if (analyzed.length === 1) throw new Error('paid_result_unknown');
        return [];
      } } } });
    cleanups.push(() => f.close());
    const status = (jobId: string) => f.actions.db.prepare('SELECT status,last_error,lease_until FROM background_jobs WHERE job_id=?').get(jobId);
    f.store.appendTurn('owner', 'night', 'stuck night', 'ok', '2026-10-06T12:00:00.000Z');
    expect(f.store.enqueueSleepConsolidations('2026-10-06', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z', f.now())).toBe(1);
    const stuck = f.sleep!.jobs.admit(f.driver.runtime)!;
    const stuckJob = f.driver.runtime.sleepTicketForTask('owner', stuck.id)!.jobId;
    await f.tick();
    expect(f.driver.runtime.get('owner', stuck.id)?.phase).toBe('unknown');

    f.store.appendTurn('owner', 'night', 'next night', 'ok', '2026-10-07T12:00:00.000Z');
    expect(f.store.enqueueSleepConsolidations('2026-10-07', '2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z', f.now())).toBe(1);
    f.advance(9 * MINUTE); await f.tick();
    expect(status(stuckJob)).toMatchObject({ status: 'leased', last_error: 'fca_result_unknown' });
    // Still held inside the deadline, by its task's binding: the job row's mark is not renewed (ADR-0009 S7).
    expect(Date.parse(String(status(stuckJob)?.lease_until))).toBeLessThan(Date.parse(f.now()));
    expect(f.sleep!.jobs.admit(f.driver.runtime)).toBeNull();
    expect(analyzed).toEqual([['stuck night']]);

    f.advance(2 * MINUTE); await f.tick(); await f.tick();
    expect(status(stuckJob)).toMatchObject({ status: 'failed', last_error: 'fca_unknown_retired' });
    expect(f.driver.runtime.get('owner', stuck.id)?.phase).toBe('failed');
    // The next night ran; the stuck night's paid analysis was never repeated.
    expect(analyzed).toEqual([['stuck night'], ['next night']]);
    expect(f.store.claimNextBackgroundJob('legacy', f.now(), new Date(Date.parse(f.now()) + MINUTE).toISOString())).toBeNull();
  });
});
