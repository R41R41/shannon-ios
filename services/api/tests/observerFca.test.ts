import { describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, observeAsync, observeSync, observerSpan, withObserverRun, withObserverRunSync, withObserverTask } from '../src/infra/observer/observerContext.js';
import { observerCatalog } from '../src/infra/observer/observerCatalog.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { createFcaConversationBridge, observeFcaConversation } from '../src/mind/action/fca/fcaConversationPorts.js';
import { actionHarness } from './support/actionThreadHarness.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('common FCA observation', () => {
  it('keeps detached promise identity, settlement timing and original errors while measuring its real lifetime', async () => {
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'fixture' }, async () => {
        const ready = deferred<number>(), span = observerSpan('recall', { phase: 'task_semantic' });
        expect(span.run(() => ready.promise)).toBe(ready.promise);
        let observed = 0;
        const original = span.run(() => ready.promise).then(value => { span.complete({ count: value }); observed = value; });
        ready.resolve(7); await Promise.resolve();
        expect(observed).toBe(7); await original;
        span.failed(new Error('must not replace completed outcome'));
      });
      expect(events.filter(event => event.node === 'recall' && event.kind === 'span.completed')).toHaveLength(1);
      expect(events.filter(event => event.node === 'recall' && event.kind === 'span.failed')).toHaveLength(0);
    } finally { restore(); }
  });

  it('isolates parallel task/step linkage and clears it across explicit scope changes', async () => {
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    try {
      await withObserverRun({ scopeKey: 'owner', surface: 'fixture' }, async () => {
        await Promise.all(['one', 'two'].map(taskId => withObserverTask({ taskId, parentTaskId: 'root', stepId: `step-${taskId}`, actionId: `action-${taskId}` }, () =>
          observeAsync('fca', {}, async () => { await Promise.resolve(); observeSync('context', {}, () => taskId); }))));
        observeSync('context', {}, () => undefined);
        await withObserverTask({ taskId: 'private-task' }, () => withObserverRun({ scopeKey: 'foreign', surface: 'fixture' }, async () => observeSync('context', {}, () => undefined)));
      });
      for (const taskId of ['one', 'two']) {
        const parent = events.find(event => event.node === 'fca' && event.kind === 'span.started' && event.taskId === taskId)!;
        const child = events.find(event => event.node === 'context' && event.kind === 'span.started' && event.taskId === taskId)!;
        expect(child).toMatchObject({ parentSpanId: parent.spanId, parentTaskId: 'root', stepId: `step-${taskId}`, actionId: `action-${taskId}` });
      }
      expect(events.filter(event => event.scopeKey === 'foreign').every(event => event.taskId === undefined)).toBe(true);
      expect(events.filter(event => event.node === 'context' && event.kind === 'span.started' && !event.taskId)).toHaveLength(2);
      withObserverRunSync({ scopeKey: 'owner', surface: 'held', audience: 'others' }, () => withObserverTask({ taskId: 'hidden' }, () => observeSync('fca', {}, () => 1)));
      expect(events.some(event => event.taskId === 'hidden')).toBe(false);
    } finally { restore(); }
  });

  it.each(['working', 'throwing'] as const)('keeps canonical task outcomes with a %s sink and records no private contents', async mode => {
    const harness = actionHarness(() => '2026-10-09T00:00:00.000Z');
    const events: ObserverDraft[] = [], requests: unknown[] = [];
    const restore = installObserverSink(event => { if (mode === 'throwing') throw new Error('observer unavailable'); events.push(event); });
    const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, scopeKey: 'owner', ownerAlone: () => true,
      now: () => '2026-10-09T00:00:00.000Z', model: {
        async decide(input) { requests.push(input); return { decision: { kind: 'wait', summary: 'PRIVATE_SUMMARY' }, history: [{ signed: 'PRIVATE_NATIVE_HISTORY' }] }; },
        toolResults(results) { return { results }; },
      } });
    try {
      const root = driver.runtime.ensureRoot('owner');
      const child = driver.runtime.createChild('owner', root.id, { title: 'PRIVATE_TITLE', goal: 'PRIVATE_GOAL' }, 'once');
      if (mode === 'working') expect(events.some(event => event.node === 'taskHub' && event.kind === 'span.completed' && event.taskId === child.id && (event.output as { phase?: string })?.phase === 'ready')).toBe(true);
      driver.runtime.send('owner', root.id, child.id, 'PRIVATE_INBOX', 'message');
      await driver.tick(); await driver.drain();
      expect(requests).toHaveLength(1);
      expect(driver.runtime.get('owner', child.id)?.phase).toBe('waiting');
      expect(driver.runtime.snapshot('owner', child.id)?.history).toEqual([{ signed: 'PRIVATE_NATIVE_HISTORY' }]);
      expect(driver.runtime.pendingReceipts('owner')).toEqual([]);
      expect(harness.store.list('owner').filter(action => action.kind === 'agentTask')).toMatchObject([{ state: 'completed', result: 'fca_segment_committed' }]);
      if (mode === 'working') {
        const span = events.find(event => event.node === 'fca' && event.kind === 'span.started')!;
        expect(span).toMatchObject({ taskId: child.id, parentTaskId: root.id });
        expect(span.stepId).toBeTruthy(); expect(span.actionId).toBeTruthy();
        for (const node of ['queue', 'context', 'gate', 'store', 'wait']) expect(events.some(event => event.node === node && event.kind === 'span.completed')).toBe(true);
        const wait = events.find(event => event.node === 'wait' && event.kind === 'span.completed')!;
        expect(wait).toMatchObject({ taskId: child.id, stepId: span.stepId, output: { phase: 'waiting' } });
        expect(events.filter(event => event.elapsedMs !== undefined).every(event => event.elapsedMs! >= 0)).toBe(true);
        expect(JSON.stringify(events)).not.toContain('PRIVATE_');
        driver.runtime.stop('owner', child.id, 'PRIVATE_STOP_REASON');
        expect(events.some(event => event.node === 'taskHub' && event.kind === 'span.completed' && event.taskId === child.id && (event.output as { phase?: string })?.phase === 'stopped')).toBe(true);
        expect(JSON.stringify(events)).not.toContain('PRIVATE_STOP_REASON');
      }
    } finally { await driver.close(); restore(); harness.close(); }
  });

  it('binds foreground native spans to the existing respond lease without background admission or a replacement promise', async () => {
    const harness = actionHarness(() => '2026-10-09T00:00:00.000Z');
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, scopeKey: 'owner', ownerAlone: () => true,
      now: () => '2026-10-09T00:00:00.000Z', model: { async decide() { throw new Error('no background call'); }, toolResults() { return null; } } });
    try {
      const bridge = createFcaConversationBridge({ runtime: driver.runtime, ownerScope: 'owner', visible: Object.assign(() => true, { sources: () => true }) });
      const action = await harness.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'foreground' });
      const lease = leaseOf(action!), signal = new AbortController().signal;
      await withObserverRun({ scopeKey: 'owner', surface: 'text' }, () => inActionExecution({ lease, signal,
        permit: resources => harness.actions.dispatch(lease, resources), checkpoint: code => harness.actions.checkpoint(lease, code) }, async () => {
        const turn = bridge.begin({ scopeKey: 'owner', threadId: 'talk', observedAt: '2026-10-09T00:00:00.000Z', recalledMemoryIds: [], ownerAlone: () => true });
        const reply = deferred<string>();
        const original = observeFcaConversation(turn, () => { observeSync('native', { phase: 'fixture' }, () => undefined); return reply.promise; });
        expect(original).toBe(reply.promise);
        reply.resolve('PRIVATE_REPLY'); expect(await original).toBe('PRIVATE_REPLY'); turn!.abort();
      }));
      const native = events.find(event => event.node === 'native')!;
      const fca = events.find(event => event.node === 'fca' && event.kind === 'span.started')!;
      expect(fca.input).toEqual({ phase: 'foreground_generation', admission: 'existing_respond' });
      expect(native).toMatchObject({ taskId: fca.taskId, stepId: fca.stepId, actionId: lease.id, parentSpanId: fca.spanId });
      expect(harness.store.list('owner').filter(item => item.kind === 'agentTask')).toHaveLength(0);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_REPLY');
    } finally { await driver.close(); restore(); harness.close(); }
  });

  it('labels state checkpoints and unmeasured external/acoustic boundaries explicitly', () => {
    const catalog = observerCatalog();
    expect(catalog.nodes.find(node => node.id === 'wait')?.timing).toBe('state');
    expect(catalog.nodes.find(node => node.id === 'minecraft')?.timing).toBe('external');
    expect(catalog.coverage.find(node => node.node === 'play')?.reason).toContain('acoustic speech onset is not measured');
  });
});
