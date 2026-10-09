import { afterEach, describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { currentObserverRunId, installObserverSink, observeAsync, observeSync, observerHandoff, observerValue, withObserverRun, withObserverTask, withScopedObserverTask } from '../src/infra/observer/observerContext.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function capture() { const events: ObserverDraft[] = []; cleanups.push(installObserverSink(event => { events.push(event); })); return events; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const run = <T>(work: () => Promise<T>, scopeKey = 'owner', runId?: string) => withObserverRun({ scopeKey, surface: 'test', ...(runId ? { runId } : {}) }, work);

describe('observer context isolation and fail-open work', () => {
  it('executes disabled sync and async work exactly once and preserves identities/errors', async () => {
    const value = {}, error = new Error('original'); let calls = 0;
    expect(observeSync('tools', {}, () => { calls++; return value; })).toBe(value);
    expect(await run(() => observeAsync('llm', {}, async () => { calls++; return value; }))).toBe(value);
    expect(() => observeSync('tools', {}, () => { calls++; throw error; })).toThrow(error);
    await expect(run(() => observeAsync('llm', {}, async () => { calls++; throw error; }))).rejects.toBe(error);
    expect(calls).toBe(4); expect(currentObserverRunId()).toBeNull();
  });

  it('preserves results and errors with a failing observer and never retries', async () => {
    cleanups.push(installObserverSink(() => { throw new Error('observer unavailable'); }));
    const error = new Error('work failed'), value = {}; let count = 0;
    expect(await run(async () => observeSync('gate', {}, () => { count++; return value; }))).toBe(value);
    await expect(run(() => observeAsync('tools', {}, async () => { count++; throw error; }))).rejects.toBe(error);
    expect(count).toBe(2);
  });

  it('keeps simultaneous calls in separate run/scope trees across awaits', async () => {
    const events = capture(), aEntered = deferred(), bEntered = deferred(), aRelease = deferred(), bRelease = deferred();
    const call = (scope: string, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) => run(() => observeAsync('llm', { call: scope }, async () => {
      entered.resolve(); await release.promise; observerHandoff('llm', 'decode', { call: scope });
      return observeSync('decode', {}, () => currentObserverRunId(), value => ({ value }));
    }), scope, `run-${scope}`);
    const a = call('a', aEntered, aRelease), b = call('b', bEntered, bRelease);
    await Promise.all([aEntered.promise, bEntered.promise]); bRelease.resolve(); expect(await b).toBe('run-b'); aRelease.resolve(); expect(await a).toBe('run-a');
    for (const scope of ['a', 'b']) {
      const own = events.filter(event => event.scopeKey === scope), otherIds = new Set(events.filter(event => event.scopeKey !== scope).map(event => event.spanId));
      expect(own.every(event => event.runId === `run-${scope}`)).toBe(true);
      expect(own.every(event => !event.parentSpanId || !otherIds.has(event.parentSpanId))).toBe(true);
      expect(own.every(event => !event.sourceSpanId || !otherIds.has(event.sourceSpanId))).toBe(true);
    }
    expect(currentObserverRunId()).toBeNull();
  });

  it('links a handoff to its own concurrent source span rather than its sibling', async () => {
    const events = capture(), aEntered = deferred(), bEntered = deferred();
    await run(async () => {
      const a = observeAsync('llm', { call: 'a' }, async () => { aEntered.resolve(); await bEntered.promise; observerHandoff('llm', 'decode', { call: 'a' }); });
      await aEntered.promise;
      const b = observeAsync('llm', { call: 'b' }, async () => { bEntered.resolve(); observerHandoff('llm', 'decode', { call: 'b' }); });
      await Promise.all([a, b]);
    });
    for (const call of ['a', 'b']) {
      const start = events.find(event => event.kind === 'span.started' && event.node === 'llm' && (event.input as { call?: string })?.call === call)!;
      const handoff = events.find(event => event.kind === 'handoff' && (event.output as { call?: string })?.call === call)!;
      expect(handoff.sourceSpanId, call).toBe(start.spanId);
    }
  });

  it('keeps each branch source after its nested provider await returns', async () => {
    const events = capture(), aEntered = deferred(), bFinished = deferred();
    await run(async () => {
      const a = observeAsync('jevv', {}, async () => {
        await observeAsync('llm', { call: 'a' }, async () => { aEntered.resolve(); await bFinished.promise; });
        observerHandoff('llm', 'decode', { call: 'a' });
      });
      await aEntered.promise;
      const b = observeAsync('jevt', {}, async () => {
        await observeAsync('llm', { call: 'b' }, async () => true);
        observerHandoff('llm', 'decode', { call: 'b' }); bFinished.resolve();
      });
      await Promise.all([a, b]);
    });
    for (const call of ['a', 'b']) {
      const start = events.find(event => event.kind === 'span.started' && event.node === 'llm' && (event.input as { call?: string })?.call === call)!;
      const handoff = events.find(event => event.kind === 'handoff' && (event.output as { call?: string })?.call === call)!;
      expect(handoff.sourceSpanId, call).toBe(start.spanId);
    }
  });

  it('keeps a nested different-scope run separate from its caller', async () => {
    const events = capture();
    await run(() => run(async () => { observeSync('tools', {}, () => true); }, 'guest', 'guest-run'), 'owner', 'owner-run');
    const event = events.find(event => event.node === 'tools')!;
    expect(event).toMatchObject({ scopeKey: 'guest', runId: 'guest-run' });
  });

  it('starts an explicitly requested new run even in the same scope', async () => {
    const events = capture();
    await run(() => run(async () => { observeSync('tools', {}, () => true); }, 'owner', 'second-run'), 'owner', 'first-run');
    expect(events.find(event => event.node === 'tools')).toMatchObject({ scopeKey: 'owner', runId: 'second-run' });
    expect(events.filter(event => event.kind === 'run.started').map(event => event.runId)).toEqual(['first-run', 'second-run']);
  });

  it('records explicit dependencies only and resumes the parent after nested others privacy', async () => {
    const events = capture(); let calls = 0;
    await run(async () => {
      observeSync('native', {}, () => { calls++; });
      await withObserverRun({ scopeKey: 'owner', surface: 'nested', audience: 'others' }, async () => {
        observeSync('tools', { private: 'PRIVATE_OTHER' }, () => { calls++; }); observerHandoff('tools', 'llm', 'PRIVATE_OTHER');
        await withObserverRun({ scopeKey: 'owner', surface: 'inner', audience: 'owner' }, () => observeAsync('llm', {}, async () => { calls++; }));
      });
      observerHandoff('native', 'llm', { purpose: 'reply' });
      await observeAsync('llm', {}, async () => { calls++; });
    });
    expect(calls).toBe(4); expect(events.filter(event => event.kind === 'handoff')).toHaveLength(1);
    expect(events.filter(event => event.node === 'tools')).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_OTHER');
    const native = events.find(event => event.node === 'native')!;
    expect(events.find(event => event.kind === 'handoff')).toMatchObject({ sourceSpanId: native.spanId, fromNode: 'native', toNode: 'llm' });
  });

  it('contains throwing/cyclic projections and bounds size without changing work', async () => {
    const events = capture(); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const input = Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('projection'); } });
    expect(await run(() => observeAsync('llm', input, async () => cycle, () => { throw new Error('project failed'); }))).toBe(cycle);
    expect(events.find(event => event.kind === 'span.started' && event.node === 'llm')?.input).toBe('[projection unavailable]');
    expect(events.find(event => event.kind === 'span.completed' && event.node === 'llm')?.output).toBe('[projection unavailable]');
    expect(JSON.stringify(observerValue(cycle))).toContain('[depth limit]');
    const secret = 'sk-ant-very-private-token';
    const value = observerValue({ authorization: 'Bearer private', apiKey: 'key', systemPrompt: 'prompt', thinking: 'thought', signature: 'signed',
      text: `reply ${secret} Bearer private-bearer`, array: Array.from({ length: 100 }, (_, i) => i), long: 'x'.repeat(5000) }) as Record<string, unknown>;
    for (const key of ['authorization', 'apiKey', 'systemPrompt', 'thinking', 'signature']) expect(value[key]).toBe('[redacted]');
    expect(value.text).not.toContain(secret); expect(value.text).not.toContain('private-bearer');
    expect((value.array as unknown[]).length).toBeLessThanOrEqual(64); expect((value.long as string).length).toBeLessThanOrEqual(2000);
    await run(() => observeAsync('llm', {}, async () => Array(64).fill('x'.repeat(2000)), result => result));
    expect(events.at(-2)?.output).toBe('[size limit]');
  });
});


describe('task branch causal provenance', () => {
  it('keeps parallel bound-task source spans after nested awaits without changing the untagged caller', async () => {
    const events=capture(), aEntered=deferred(), bFinished=deferred();
    await run(async () => {
      observeSync('context', {}, () => true);
      const a=withObserverTask({taskId:'a',stepId:'a-step'}, async () => {
        await observeAsync('llm', {}, async () => {aEntered.resolve(); await bFinished.promise;});
        observerHandoff('llm','decode');
      });
      await aEntered.promise;
      const b=withObserverTask({taskId:'b',stepId:'b-step'}, async () => {
        await observeAsync('llm', {}, async () => true);
        observerHandoff('llm','decode'); bFinished.resolve();
      });
      await Promise.all([a,b]); observerHandoff('llm','decode');
    });
    for (const taskId of ['a','b']) {
      const source=events.find(event=>event.taskId===taskId&&event.node==='llm'&&event.kind==='span.started')!;
      expect(events.find(event=>event.taskId===taskId&&event.kind==='handoff')!.sourceSpanId).toBe(source.spanId);
    }
    expect(events.find(event=>!event.taskId&&event.kind==='handoff')!.sourceSpanId).toBeNull();
  });
  it('clears current prediction provenance when an older task or step is settled, preserving same-step ancestors', async () => {
    const events=capture();
    await withObserverRun({scopeKey:'owner',surface:'fixture',taskId:'current',stepId:'current-step',actionId:'current-action'}, async () => {
      observeSync('prediction', {}, () => true);
      withObserverTask({taskId:'current'},()=>observerHandoff('prediction','memory',{same:true}));
      await observeAsync('prediction', {}, async () => {
        withScopedObserverTask('owner',{taskId:'current',stepId:'old-step'},()=>observerHandoff('prediction','memory'));
        withScopedObserverTask('owner',{taskId:'old-task',stepId:'old-step'},()=>observerHandoff('prediction','memory'));
      });
    });
    const retained=events.find(event=>event.kind==='handoff'&&(event.output as {same?:boolean})?.same)!;
    expect(retained.sourceSpanId).toBeTruthy(); expect(retained.stepId).toBe('current-step');
    for (const changed of events.filter(event=>event.kind==='handoff'&&event.stepId==='old-step')) {
      expect(changed.sourceSpanId).toBeNull(); expect(changed.actionId).toBeUndefined();
      expect(changed.parentSpanId).toBe(events.find(event=>event.kind==='run.started')!.spanId);
    }
  });
});
