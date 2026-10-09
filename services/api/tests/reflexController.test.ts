import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReflexController, evaluateReflexEntry, runReflexSession, returnReflexControl, ReflexHandoffNotSent, type BodyActionReceipt, type BodyObservation, type BodyOperation,
  type BodyStopAcknowledgement, type BodyStopRequest, type ReflexChoice, type ReflexChoiceInput, type ReflexPorts, type ReflexSessionRequest,
} from '../src/mind/action/reflex/reflexPorts.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, observeAsync, withObserverRun, withObserverTask } from '../src/infra/observer/observerContext.js';

const at = Date.parse('2026-10-09T00:00:00.000Z');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function request(bodyId = 'minecraft', sessionId = 'session'): ReflexSessionRequest {
  return { context: { scopeKey: 'owner', taskId: 'task', taskRevision: 3, bodyId, sessionId, generation: 2, goal: '避ける', completionCondition: '安全な場所' },
    limits: { maxDurationMs: 10_000, maxDecisions: 4, maxActions: 3, maxActionMs: 1_000, maxStateAgeMs: 1_000, maxImageAgeMs: 1_000 } };
}
function fixture() {
  let clock = at, sequence = 0, current = true;
  const facts = { target: 'entity-1', weather: 'clear' }, operations: BodyOperation[] = [], order: string[] = [];
  const sessions = new Map<string, 'duplicate' | 'unknown'>(), resources = new Set<string>();
  const stamp = () => new Date(clock).toISOString();
  const observation = (bodyId = 'minecraft'): BodyObservation => ({ schemaVersion: 1, bodyId, sequence: ++sequence,
    stateAt: stamp(), receivedAt: stamp(), connected: true, state: { self: 'standing' }, facts: { ...facts } });
  const acknowledgement = (input: BodyStopRequest): BodyStopAcknowledgement => ({ bodyId: input.context.bodyId, sessionId: input.context.sessionId,
    generation: input.context.generation, requestId: input.requestId, state: 'stopped', inputsReleased: true, observedAt: stamp() });
  const outcome = (op: BodyOperation, status: BodyActionReceipt['outcome'] = 'completed'): BodyActionReceipt => ({ schemaVersion: 1,
    operationId: op.operationId, bodyId: op.context.bodyId, sessionId: op.context.sessionId, generation: op.context.generation,
    outcome: status, inputsReleased: status !== 'unknown', observedAt: stamp(), evidenceId: `${op.operationId}:evidence` });
  const ports: ReflexPorts = {
    now: () => clock, current: vi.fn(() => current), event: vi.fn(),
    handoff: {
      inspect: vi.fn(async context => sessions.get(context.sessionId) ?? 'new'),
      stopNormal: vi.fn(async input => { order.push('stopped'); return acknowledgement(input); }),
      acquire: vi.fn(async context => { order.push('acquire'); if (resources.has(context.bodyId)) return null;
        resources.add(context.bodyId); sessions.set(context.sessionId, 'unknown'); return { id: context.bodyId, generation: 7, holder: 'existing-action-holder' }; }),
      valid: vi.fn(() => true), finish: vi.fn(async (_lease, receipt) => { order.push('finish');
        sessions.set(receipt.context.sessionId, receipt.control === 'returned' ? 'duplicate' : 'unknown');
        if (receipt.control === 'returned') resources.delete(receipt.context.bodyId); }),
      returnStopped: vi.fn(async (input, receipt) => returnReflexControl(ports,
        { id: input.context.bodyId, generation: 7, holder: 'existing-action-holder' }, receipt, ports.body.releaseInputs(input,
          { id: input.context.bodyId, generation: 7, holder: 'existing-action-holder' }), input)),
    },
    body: {
      observe: vi.fn(async context => { order.push('observe'); return observation(context.bodyId); }),
      candidates: (_context, state) => [{ kind: 'action', label: '退避する', operation: 'move', arguments: { target: state.facts.target!, direction: 'back' },
        preconditions: [{ key: 'target', value: state.facts.target! }], maxDurationMs: 800, expiresAt: new Date(clock + 5_000).toISOString() }],
      validate: vi.fn(() => true),
      execute: vi.fn(async op => { order.push('execute'); operations.push(op); return outcome(op); }),
      releaseInputs: vi.fn(async input => { order.push('release'); return acknowledgement(input); }),
      termination: (_context, _observation, recent) => recent.length ? { reason: 'completed', evidenceIds: [recent[0]!.evidenceId] } : null,
    },
    selector: { choose: vi.fn(async (input: ReflexChoiceInput) => { order.push('choose'); return { sessionId: input.context.sessionId,
      generation: input.context.generation, candidateId: input.candidates.find(candidate => candidate.kind === 'action')!.id }; }) },
  };
  return { ports, facts, operations, order, sessions, resources, observation, acknowledgement, outcome,
    current(value: boolean) { current = value; }, advance(ms: number) { clock += ms; } };
}
afterEach(() => vi.useRealTimers());

describe('short body control under the existing action authority', () => {
  it.each(['observation', 'explicit', 'stale', 'cancelled', 'failed'] as const)('emits entry handoffs only for a real evaluation (%s)', async mode => {
    const f = fixture(), input = request(), abort = new AbortController(), events: ObserverDraft[] = [];
    const failure = new Error('PRIVATE_PROVIDER_ERROR'); let calls = 0;
    const selector = { async evaluate() {
      calls++;
      if (mode === 'failed') throw failure;
      if (mode === 'cancelled') abort.abort();
      return { sessionId: input.context.sessionId, generation: input.context.generation, decision: 'enter' as const, reason: 'danger' as const };
    } };
    if (mode === 'stale') f.current(false);
    const restore = installObserverSink(event => events.push(event));
    try {
      const run = withObserverRun({ scopeKey: 'owner', surface: 'fixture' }, () => withObserverTask({ taskId: input.context.taskId, stepId: 'step' }, () =>
        observeAsync('fca', {}, () => evaluateReflexEntry(input, { context: input.context, observation: f.observation(),
          trigger: mode === 'explicit' ? 'explicit' : 'observation', recent: [] }, selector, f.ports, abort.signal))));
      if (mode === 'failed') await expect(run).rejects.toBe(failure);
      else expect(await run).toBe(mode === 'observation' || mode === 'explicit');
      const skipped = mode === 'explicit' || mode === 'stale';
      expect(calls).toBe(skipped ? 0 : 1);
      const handoffs = events.filter(event => event.kind === 'handoff');
      expect(handoffs.map(event => [event.fromNode, event.toNode])).toEqual(skipped ? [] : mode === 'failed'
        ? [['fca', 'reflexJev']] : [['fca', 'reflexJev'], ['reflexJev', 'fca']]);
      expect(handoffs.every(event => event.taskId === input.context.taskId && event.stepId === 'step' && event.sourceSpanId)).toBe(true);
      if (!skipped && mode !== 'failed') expect(handoffs[1]!.output).toEqual({ phase: 'entry_result', enter: mode === 'observation' });
      expect(events.some(event => event.node === 'reflex' || event.node === 'bodyControl')).toBe(false);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_PROVIDER_ERROR');
      expect(f.ports.handoff.acquire).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('waits for actual normal-executor stop ACK before acquiring or choosing, then returns new state without resuming it', async () => {
    const f = fixture(), stopped = deferred<BodyStopAcknowledgement>();
    f.ports.handoff.stopNormal = vi.fn(input => { void input; return stopped.promise; });
    const running = runReflexSession(request(), f.ports);
    await vi.waitFor(() => expect(f.ports.handoff.stopNormal).toHaveBeenCalledOnce());
    expect(f.ports.handoff.acquire).not.toHaveBeenCalled(); expect(f.ports.selector.choose).not.toHaveBeenCalled();
    const stop = vi.mocked(f.ports.handoff.stopNormal).mock.calls[0]![0]; stopped.resolve(f.acknowledgement(stop));
    const result = await running;
    expect(result).toMatchObject({ reason: 'completed', control: 'returned', decisions: 1 });
    expect(result.actions).toHaveLength(1); expect(f.order.indexOf('acquire')).toBeLessThan(f.order.indexOf('execute'));
    expect(result.latestObservation!.sequence).toBeGreaterThan(f.operations[0]!.observationSequence);
    expect(f.ports.body.releaseInputs).toHaveBeenCalledOnce(); expect(f.resources.size).toBe(0);
    expect(vi.mocked(f.ports.event).mock.calls.map(([event]) => event.id)).toEqual(['session:2:entered', 'session:2:action:1', 'session:2:returned']);
  });
  it('holds unknown when nominal lease availability has no actual stop acknowledgement', async () => {
    const f = fixture(); f.ports.handoff.stopNormal = async input => ({ ...f.acknowledgement(input), state: 'unknown' });
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'unknown', control: 'held' });
    expect(f.ports.handoff.acquire).not.toHaveBeenCalled(); expect(f.ports.body.execute).not.toHaveBeenCalled();
  });
  it.each(['abort', 'stale', 'denied', 'failed'] as const)('releases a stopped native session after %s before acquisition, awaiting actual ACK', async mode => {
    const f = fixture(), abort = new AbortController(), released = deferred<BodyStopAcknowledgement>();
    f.ports.handoff.stopNormal = async input => {
      f.resources.add(input.context.bodyId); f.sessions.set(input.context.sessionId, 'unknown');
      if (mode === 'abort') abort.abort();
      if (mode === 'stale') f.current(false);
      return f.acknowledgement(input);
    };
    if (mode === 'denied') f.ports.handoff.acquire = vi.fn(async () => null);
    if (mode === 'failed') f.ports.handoff.acquire = vi.fn(async () => { throw new Error('lease_reply_lost'); });
    f.ports.body.releaseInputs = vi.fn(() => released.promise);
    let done = false;
    const running = runReflexSession(request(), f.ports, abort.signal).then(result => { done = true; return result; });
    await vi.waitFor(() => expect(f.ports.body.releaseInputs).toHaveBeenCalledOnce());
    expect(done).toBe(false); expect(f.ports.handoff.finish).not.toHaveBeenCalled();
    expect(f.ports.selector.choose).not.toHaveBeenCalled(); expect(f.ports.body.execute).not.toHaveBeenCalled();
    const stop = vi.mocked(f.ports.body.releaseInputs).mock.calls[0]![0];
    expect(stop).toMatchObject({ requestId: 'session:2:release', reason: mode === 'abort' ? 'cancel' : 'return' });
    released.resolve(f.acknowledgement(stop));
    expect(await running).toMatchObject({ reason: { abort: 'cancelled', stale: 'stale_generation', denied: 'handoff_denied', failed: 'unknown' }[mode],
      control: mode === 'failed' ? 'held' : 'returned', actions: [] });
    expect(f.ports.handoff.finish).toHaveBeenCalledOnce();
    expect(f.resources.has('minecraft')).toBe(mode === 'failed');
  });
  it('holds a stopped but unacquired native session if its cleanup ACK is unknown, without replay after recovery', async () => {
    const f = fixture(), abort = new AbortController();
    f.ports.handoff.stopNormal = async input => { abort.abort(); f.resources.add(input.context.bodyId); return f.acknowledgement(input); };
    f.ports.body.releaseInputs = vi.fn(async (input: BodyStopRequest): Promise<BodyStopAcknowledgement> => ({ ...f.acknowledgement(input), state: 'unknown', inputsReleased: false }));
    expect(await runReflexSession(request(), f.ports, abort.signal)).toMatchObject({ control: 'held', reason: 'unknown' });
    expect(f.resources.has('minecraft')).toBe(true); expect(f.sessions.get('session')).toBe('unknown');
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ control: 'held', reason: 'unknown' });
    expect(f.ports.body.releaseInputs).toHaveBeenCalledOnce();
    expect(f.ports.body.execute).not.toHaveBeenCalled();
  });
  it('returns safely for a proved unsent stop but retains unknown for unproved transport failure', async () => {
    const f = fixture(); f.ports.handoff.stopNormal = async () => { throw new ReflexHandoffNotSent(); };
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'handoff_denied', control: 'not_acquired' });
    expect(f.ports.handoff.acquire).not.toHaveBeenCalled();
    const g = fixture(); g.ports.handoff.stopNormal = async () => { throw new Error('transport_lost'); };
    expect(await runReflexSession(request(), g.ports)).toMatchObject({ reason: 'unknown', control: 'held' });
  });
  it.each([true, false])('rechecks relevant conditions while allowing unrelated observation updates (relevant=%s)', async relevant => {
    const f = fixture(), selected = deferred<ReflexChoice>(), ready = deferred<ReflexChoice>();
    f.ports.selector.choose = async input => { ready.resolve({ sessionId: input.context.sessionId, generation: input.context.generation,
      candidateId: input.candidates[0]!.id }); return selected.promise; };
    const input = request(); input.limits.maxDecisions = 1;
    const running = runReflexSession(input, f.ports), choice = await ready.promise;
    if (relevant) f.facts.target = 'entity-2'; else f.facts.weather = 'rain';
    selected.resolve(choice); const result = await running;
    expect(f.operations).toHaveLength(relevant ? 0 : 1); expect(result.reason).toBe(relevant ? 'decision_limit' : 'completed');
    if (!relevant) expect(f.operations[0]!.candidate.arguments.target).toBe('entity-1');
  });
  it('discards a choice when the task generation was invalidated during its model wait', async () => {
    const f = fixture(), choice = deferred<ReflexChoice>(), ready = deferred<ReflexChoice>();
    f.ports.selector.choose = async input => { ready.resolve({ sessionId: input.context.sessionId, generation: input.context.generation, candidateId: input.candidates[0]!.id }); return choice.promise; };
    const running = runReflexSession(request(), f.ports), answer = await ready.promise;
    f.current(false); choice.resolve(answer);
    expect(await running).toMatchObject({ reason: 'stale_generation', control: 'returned' }); expect(f.operations).toEqual([]);
  });
  it('requires a new observation after each action and never infers completion from target loss', async () => {
    const f = fixture(), same = f.observation(); f.ports.body.observe = async () => same; f.ports.body.termination = () => null;
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'observation_unavailable', control: 'returned' }); expect(f.operations).toHaveLength(1);
    const g = fixture(); g.ports.body.termination = () => ({ reason: 'target_lost', evidenceIds: [] });
    expect(await runReflexSession(request(), g.ports)).toMatchObject({ reason: 'target_lost', actions: [] });
  });
  it('refuses stale image/state, disconnected observations and ungrounded goal completion', async () => {
    for (const mode of ['image', 'state', 'disconnect', 'unproven'] as const) {
      const f = fixture(), input = request();
      if (mode === 'image') input.requiresImage = true;
      f.ports.body.observe = async () => ({ ...f.observation(), ...(mode === 'state' ? { stateAt: new Date(at - 2_000).toISOString() } : {}),
        connected: mode !== 'disconnect', image: { ref: 'frame', capturedAt: new Date(at - 2_000).toISOString(), expiresAt: new Date(at + 500).toISOString() } });
      if (mode === 'unproven') f.ports.body.termination = () => ({ reason: 'completed', evidenceIds: [] });
      expect(await runReflexSession(input, f.ports)).toMatchObject({ reason: mode === 'unproven' ? 'unknown' : 'observation_unavailable' });
      expect(f.operations).toEqual([]);
    }
  });
  it('releases inputs immediately on abort, awaits executor unwind, and keeps an unknown operation held', async () => {
    const f = fixture(), start = deferred<BodyOperation>(), finish = deferred<BodyActionReceipt>(), abort = new AbortController();
    f.ports.body.execute = async op => { start.resolve(op); return finish.promise; };
    let done = false; const running = runReflexSession(request(), f.ports, abort.signal).then(result => { done = true; return result; });
    const operation = await start.promise; abort.abort();
    await vi.waitFor(() => expect(f.ports.body.releaseInputs).toHaveBeenCalledOnce());
    expect(done).toBe(false); expect(f.ports.handoff.finish).not.toHaveBeenCalled();
    finish.resolve(f.outcome(operation, 'unknown'));
    expect(await running).toMatchObject({ reason: 'unknown', control: 'held' }); expect(f.resources.size).toBe(1);
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'unknown', control: 'held', decisions: 0 });
    expect(f.ports.handoff.acquire).toHaveBeenCalledOnce();
  });
  it('enforces the actuator duration bound and releases input while a reply is still pending', async () => {
    vi.useFakeTimers(); const f = fixture(), start = deferred<BodyOperation>(), finish = deferred<BodyActionReceipt>();
    f.ports.body.execute = async op => { start.resolve(op); return finish.promise; };
    const running = runReflexSession(request(), f.ports), operation = await start.promise;
    await vi.advanceTimersByTimeAsync(800); expect(f.ports.body.releaseInputs).toHaveBeenCalledOnce();
    finish.resolve(f.outcome(operation, 'cancelled'));
    expect(await running).toMatchObject({ reason: 'deadline', control: 'returned' });
  });
  it('holds control if release ACK is missing and never replays a completed session after recovery', async () => {
    const f = fixture(); f.ports.body.releaseInputs = async () => { throw new Error('DISCONNECTED'); };
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'unknown', control: 'held' });
    const g = fixture(); await runReflexSession(request(), g.ports); const count = vi.mocked(g.ports.event).mock.calls.length;
    expect(await runReflexSession(request(), g.ports)).toMatchObject({ reason: 'duplicate', decisions: 0 });
    expect(g.operations).toHaveLength(1); expect(g.ports.event).toHaveBeenCalledTimes(count);
  });
  it('rejects stale stop and execution acknowledgements instead of transferring or reusing another generation', async () => {
    const f = fixture(); f.ports.handoff.stopNormal = async input => ({ ...f.acknowledgement(input), generation: 1 });
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'unknown', control: 'held' });
    expect(f.ports.handoff.acquire).not.toHaveBeenCalled();
    const g = fixture(); g.ports.body.execute = async op => ({ ...g.outcome(op), generation: 1 });
    expect(await runReflexSession(request(), g.ports)).toMatchObject({ reason: 'unknown', control: 'held',
      actions: [{ operationId: 'session:2:operation:1', generation: 2, outcome: 'unknown' }] });
  });
  it('returns for rethinking on a closed control choice, without dispatching it as a physical operation', async () => {
    const f = fixture(); f.ports.selector.choose = async input => ({ sessionId: input.context.sessionId,
      generation: input.context.generation, candidateId: input.candidates.find(item => item.kind === 'return')!.id });
    expect(await runReflexSession(request(), f.ports)).toMatchObject({ reason: 'returned', control: 'returned', actions: [] });
    expect(f.operations).toEqual([]);
  });
  it('permits different bodies concurrently while coalescing the same body, independent of ordinary model waits', async () => {
    const f = fixture(), choices = deferred<void>(), ready = deferred<void>(); let count = 0, ordinaryFinished = false;
    const ordinary = deferred<void>(); void ordinary.promise.then(() => { ordinaryFinished = true; });
    f.ports.selector.choose = async input => { count += 1; if (count === 2) ready.resolve(); await choices.promise;
      return { sessionId: input.context.sessionId, generation: input.context.generation, candidateId: input.candidates[0]!.id }; };
    const controller = createReflexController(f.ports), a = request('minecraft', 'a'), b = request('avatar', 'b');
    const first = controller.monitor(a, { context: a.context, observation: f.observation(), trigger: 'observation', recent: [] },
      { evaluate: async input => ({ sessionId: input.context.sessionId, generation: input.context.generation, decision: 'enter', reason: 'danger' }) });
    expect(await controller.run(a)).toBeNull(); const second = controller.run(b);
    await ready.promise; expect(ordinaryFinished).toBe(false); choices.resolve();
    expect((await first)?.reason).toBe('completed'); expect((await second)?.reason).toBe('completed');
    expect(f.operations).toHaveLength(2); ordinary.resolve(); await controller.close();
  });
});
