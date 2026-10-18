import { afterEach, describe, expect, it } from 'vitest';
import type { FcaDecision, FcaModel, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { installObserverSink } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { minecraftSkillResult } from '../src/surfaces/minecraft/minecraftOutcome.js';

type Driver = ReturnType<typeof createTaskRuntimeWiring>;
type Decide = (input: FcaModelInput, signal: AbortSignal) => Promise<FcaModelOutput> | FcaModelOutput;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function output(decision: FcaDecision, text = 'native-private-history'): FcaModelOutput {
  return { decision, history: [{ role: 'assistant', native: text }] };
}
function blocked(signal: AbortSignal) {
  const pending = deferred<FcaModelOutput>();
  signal.addEventListener('abort', () => pending.reject(new Error('model_abort')), { once: true });
  return pending;
}
/** All fixture work uses local SQLite and promises; no timer or provider response determines the assertions. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Promise.resolve(); }
  expect(condition(), label).toBe(true);
}
function fixture(decide: Decide) {
  let time = '2026-10-09T00:00:00.000Z', ownerAlone = true;
  const harness = actionHarness(() => time);
  const calls: FcaModelInput[] = [], events: ObserverDraft[] = [];
  const restoreObserver = installObserverSink(event => events.push(event));
  const model: FcaModel = {
    async decide(input, signal) { calls.push(input); return decide(input, signal); },
    toolResults(results) { return { role: 'tool_results', results }; },
  };
  const drivers: Driver[] = [];
  const create = () => {
    const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, model,
      scopeKey: 'owner', ownerAlone: () => ownerAlone, now: () => time });
    drivers.push(driver); return driver;
  };
  const driver = create(), root = driver.runtime.ensureRoot('owner');
  const child = (title: string, parentId = root.id) => driver.runtime.createChild('owner', parentId,
    { title, goal: `${title} private goal`, completionCriteria: 'receipt verified' }, `request-${title}`);
  cleanups.push(async () => { for (const current of drivers) await current.close(); restoreObserver(); harness.close(); });
  return { ...harness, driver, root, child, calls, events, restart: create,
    advance() { time = '2026-10-09T00:01:00.000Z'; harness.store.transaction(() => harness.store.sweep(time)); },
    setOwnerAlone(value: boolean) { ownerAlone = value; } };
}

describe('common FCA runner with the real action authority', () => {
  it('observes native hyphenated body tools without preventing the existing call or commit', async () => {
    let executed = 0;
    const f = fixture(() => output({ kind: 'tools', calls: [{ id: 'mine', name: 'mc.mine-block', input: {} }] }));
    const task = f.child('hyphenated-body');
    // This fixture uses the real runner/action authority; supply the registered native adapter definition.
    const driver = createTaskRuntimeWiring({ db: f.db, actions: f.actions, scopeKey: 'owner', now: () => '2026-10-09T00:00:00.000Z', ownerAlone: () => true,
      model: { async decide() { return output({ kind: 'tools', calls: [{ id: 'mine', name: 'mc.mine-block', input: {} }] }); }, toolResults: results => ({ results }) },
      stepPorts: () => ({ tools: { definitions: [{ name: 'mc.mine-block', description: 'Mine one observed block', input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] }],
        async execute() { executed++; return { ok: true, text: 'Actual block receipt', retryable: false }; } } }) });
    cleanups.push(() => driver.close());
    await driver.tick(); await driver.drain();
    expect(executed).toBe(1);
    expect(driver.runtime.progress?.('owner', task.id)).toMatchObject({ currentStep: 'mc.mine-block', status: 'received' });
    expect(driver.runtime.snapshot('owner', task.id)?.history).toHaveLength(2);
  });
  it('keeps canonical model/tool decisions running when optional progress persistence is unavailable', async () => {
    const f = fixture(() => output({ kind: 'wait', summary: 'Observed result' }));
    const task = f.child('projection-unavailable');
    f.driver.runtime.recordProgress = () => { throw new Error('FCA_PROGRESS_UNAVAILABLE'); };
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)).toMatchObject({ phase: 'waiting', summary: 'Observed result' });
    expect(f.driver.runtime.snapshot('owner', task.id)?.history).toHaveLength(1);
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });
  it('retains repeated tool failure stops across newly leased segments', async () => {
    let count = 0;
    const f = fixture(() => output({ kind: 'tools', calls: [{ id: `call-${++count}`, name: 'unavailable.tool', input: {} }] }));
    const task = f.child('repeated');
    for (let round = 0; round < 6; round++) { await f.driver.tick(); await f.driver.drain(); }
    expect(count).toBe(5);
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(f.driver.runtime.snapshot('owner', task.id)?.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.store.list('owner').filter(action => ['running', 'waiting', 'stopping', 'unknown'].includes(action.state))).toEqual([]);
  });
  /** One round per entry: the tool the model calls and how the body answers (a reflex cut it off, an ordinary failure, or it worked). */
  type Round = [tool: 'mine' | 'move', answer: 'reflex' | 'plain' | 'ok'];
  const bodyRounds = async (rounds: readonly Round[]) => {
    let count = 0;
    const f = fixture(() => output({ kind: 'wait', summary: 'unused' }));
    const task = f.child(`rounds-${rounds.length}`);
    const definition = (name: string) => ({ name, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] }) as const;
    const names = { mine: 'mc.mine-block', move: 'mc.move-to' } as const;
    const driver = createTaskRuntimeWiring({ db: f.db, actions: f.actions, scopeKey: 'owner', now: () => '2026-10-09T00:00:00.000Z', ownerAlone: () => true,
      model: { async decide() { return output({ kind: 'tools', calls: [{ id: `call-${++count}`, name: names[rounds[Math.min(count, rounds.length) - 1]![0]], input: {} }] }); }, toolResults: results => ({ results }) },
      stepPorts: () => ({ tools: { definitions: [definition(names.mine), definition(names.move)],
        async execute() {
          const answer = rounds[count - 1]![1];
          if (answer === 'ok') return { ok: true, text: 'done', retryable: false };
          return minecraftSkillResult({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: '2026-10-09T00:00:00.000Z', result: 'interrupted',
            failureType: answer === 'reflex' ? 'interrupted_by_reflex' : 'interrupted', recoverable: true } as never);
        } } }) });
    cleanups.push(() => driver.close());
    for (let round = 0; round < rounds.length; round++) { await driver.tick(); await driver.drain(); }
    return { count, phase: driver.runtime.get('owner', task.id)?.phase, checkpoint: driver.runtime.snapshot('owner', task.id)?.checkpoint };
  };
  const repeat = (round: Round, times: number): Round[] => Array.from({ length: times }, () => round);
  it('does not count a command the body\'s own reflex cut off (interrupted_by_reflex) among the failures that stop a task, unless it keeps happening (P8)', async () => {
    // The same text and the same retry hint; an ordinary interruption is a failed step.
    const plain = await bodyRounds(repeat(['mine', 'plain'], 7));
    expect(plain.phase).toBe('stopped'); expect(plain.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
    // One or two cuts of one tool are nobody's fault.
    const few = await bodyRounds(repeat(['mine', 'reflex'], 2));
    expect(few.count).toBe(2); expect(few.phase).not.toBe('stopped');
    expect(few.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 2, reflexCutTool: 'mc.mine-block', reflexCutToolRun: 2 });
  });
  it('treats the same tool cut off by a reflex 3 times in a row as an ordinary failure, so that it stops the task (M2)', async () => {
    const third = await bodyRounds(repeat(['mine', 'reflex'], 3));
    expect(third.checkpoint).toMatchObject({ consecutiveToolFailures: 1 });
    const six = await bodyRounds(repeat(['mine', 'reflex'], 6));
    expect(six.phase).not.toBe('stopped'); expect(six.checkpoint).toMatchObject({ consecutiveToolFailures: 4 });
    const seven = await bodyRounds(repeat(['mine', 'reflex'], 7));
    expect(seven.count).toBe(7); expect(seven.phase).toBe('stopped'); expect(seven.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
  });
  it('treats 6 cuts in a row of mixed tools as an ordinary failure, but not fewer (M2)', async () => {
    const alternating = (times: number): Round[] => Array.from({ length: times }, (_, index): Round => [index % 2 ? 'move' : 'mine', 'reflex']);
    const five = await bodyRounds(alternating(5));
    expect(five.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 5, reflexCutToolRun: 1 });
    const six = await bodyRounds(alternating(6));
    expect(six.phase).not.toBe('stopped'); expect(six.checkpoint).toMatchObject({ consecutiveToolFailures: 1 });
    const ten = await bodyRounds(alternating(10));
    expect(ten.count).toBe(10); expect(ten.phase).toBe('stopped'); expect(ten.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
  });
  it('ends a run of cuts with a successful step, an ordinary failure or another tool (M2)', async () => {
    const cut = (tool: 'mine' | 'move', times: number) => repeat([tool, 'reflex'], times);
    // A success between: 2 + 2 cuts of one tool are two short runs.
    const success = await bodyRounds([...cut('mine', 2), ['mine', 'ok'], ...cut('mine', 2)]);
    expect(success.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 2, reflexCutToolRun: 2 });
    // An ordinary failure between: it counts once, and the cuts begin again.
    const failure = await bodyRounds([...cut('mine', 2), ['mine', 'plain'], ...cut('mine', 2)]);
    expect(failure.checkpoint).toMatchObject({ consecutiveToolFailures: 1, consecutiveReflexCuts: 2, reflexCutToolRun: 2 });
    // Another tool between: the same-tool run restarts (2, 1, 2), while the cuts in all go on to 5.
    const other = await bodyRounds([...cut('mine', 2), ...cut('move', 1), ...cut('mine', 2)]);
    expect(other.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 5, reflexCutToolRun: 2 });
    // A run that ended with a success is gone from the checkpoint, and cannot be added to later.
    const cleared = await bodyRounds([...cut('mine', 2), ['mine', 'ok']]);
    expect(cleared.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 0, reflexCutToolRun: 0 });
  });
  /**
   * Steps of several calls each, the way a model really calls them: `observe` is a read (`minecraft.observe`), `mine` and `move` are writes.
   * 'wait' is a step that only waits (a message wakes the task for the next one). `restartAfter` closes the driver and builds a new one on
   * the same database after that many steps: the run must come from the checkpoint alone.
   */
  type Call = [tool: 'mine' | 'move' | 'observe', answer: 'reflex' | 'plain' | 'ok'];
  type Step = readonly Call[] | 'wait';
  const stepRounds = async (steps: readonly Step[], options: { restartAfter?: number; before?: Record<string, unknown> } = {}) => {
    let count = 0;
    const f = fixture(() => output({ kind: 'wait', summary: 'unused' }));
    const task = f.child(`steps-${steps.length}`);
    const stops: string[] = [];
    const definition = (name: string, effect: 'read' | 'write') => ({ name, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] }) as const;
    const names = { mine: 'mc.mine-block', move: 'mc.move-to', observe: 'minecraft.observe' } as const;
    const make = () => {
      const driver = createTaskRuntimeWiring({ db: f.db, actions: f.actions, scopeKey: 'owner', now: () => '2026-10-09T00:00:00.000Z', ownerAlone: () => true,
        model: { async decide() {
          count++;
          const step = steps[Math.min(count, steps.length) - 1]!;
          return step === 'wait' ? output({ kind: 'wait', summary: 'waiting' })
            : output({ kind: 'tools', calls: step.map(([tool], index) => ({ id: `call-${count}-${index}`, name: names[tool], input: {} })) });
        }, toolResults: results => ({ results }) },
        stepPorts: () => ({ tools: { definitions: [definition(names.mine, 'write'), definition(names.move, 'write'), definition(names.observe, 'read')],
          async execute(call) {
            const index = Number(call.operationId.split(':').pop()?.split('-').pop());
            const answer = (steps[count - 1] as readonly Call[])[index]![1];
            if (answer === 'ok') return { ok: true, text: 'done', retryable: false };
            return minecraftSkillResult({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: '2026-10-09T00:00:00.000Z', result: 'interrupted',
              failureType: answer === 'reflex' ? 'interrupted_by_reflex' : 'interrupted', recoverable: true } as never);
          } } }) });
      const stop = driver.runtime.stop.bind(driver.runtime);
      driver.runtime.stop = (scopeKey, taskId, reason) => { stops.push(reason); return stop(scopeKey, taskId, reason); };
      return driver;
    };
    let driver = make();
    cleanups.push(() => driver.close());
    if (options.before) expect(f.db.prepare('UPDATE fca_task_checkpoints SET checkpoint_json=? WHERE task_id=?').run(JSON.stringify(options.before), task.id).changes).toBe(1);
    for (let round = 0; round < steps.length; round++) {
      if (options.restartAfter === round) { await driver.close(); driver = make(); }
      if (round > 0 && steps[round - 1] === 'wait') driver.runtime.send('owner', f.root.id, task.id, 'go on', `wake-${round}`);
      await driver.tick(); await driver.drain();
    }
    return { count, stops, phase: driver.runtime.get('owner', task.id)?.phase, checkpoint: driver.runtime.snapshot('owner', task.id)?.checkpoint };
  };
  const cutStep = (tool: 'mine' | 'move' = 'mine'): Step => [[tool, 'reflex']];
  const withRead = (tool: 'mine' | 'move' = 'mine'): Step => [['observe', 'ok'], [tool, 'reflex']];
  it('counts a cut call whatever read succeeded beside it: [observe, mine] with mine cut every time still stops the task as a reflex stop (M2)', async () => {
    const six = await stepRounds(Array.from({ length: 6 }, () => withRead()));
    expect(six.phase).not.toBe('stopped'); expect(six.checkpoint).toMatchObject({ consecutiveToolFailures: 4, consecutiveReflexCuts: 6, reflexCutToolRun: 6 });
    const seven = await stepRounds(Array.from({ length: 7 }, () => withRead()));
    expect(seven.count).toBe(7); expect(seven.phase).toBe('stopped'); expect(seven.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
    // The task stopped for the cuts, and says so; a tool that really failed keeps its own reason.
    expect(seven.stops).toEqual(['repeated_reflex_interruption']);
    const plain = await stepRounds(Array.from({ length: 5 }, (): Step => [['mine', 'plain']]));
    expect(plain.phase).toBe('stopped'); expect(plain.stops).toEqual(['repeated_tool_failure']);
  });
  it('stops as an ordinary tool failure, not a reflex stop, when an ordinary failure is what reaches the limit after a run of cuts (P8 third review)', async () => {
    const ordinary = await stepRounds([...Array.from({ length: 6 }, () => cutStep()), [['mine', 'plain']]]);
    expect(ordinary.phase).toBe('stopped'); expect(ordinary.stops).toEqual(['repeated_tool_failure']);
    expect(ordinary.checkpoint).toMatchObject({ consecutiveToolFailures: 5 });
    // The same run pushed over by one more cut is the cuts' stop.
    const cuts = await stepRounds(Array.from({ length: 7 }, () => cutStep()));
    expect(cuts.phase).toBe('stopped'); expect(cuts.stops).toEqual(['repeated_reflex_interruption']);
  });
  it('does not let a read that worked between two cuts end the run: cut, observe, cut, observe ... (M2)', async () => {
    const alternating = Array.from({ length: 7 }, (_, index): Step => index % 2 ? [['observe', 'ok']] : cutStep());
    const four = await stepRounds(alternating.slice(0, 7));
    // Four cuts of mine-block with three observes between: the run is 4 long, not 1.
    expect(four.checkpoint).toMatchObject({ consecutiveReflexCuts: 4, reflexCutTool: 'mc.mine-block', reflexCutToolRun: 4, consecutiveToolFailures: 2 });
    const many = await stepRounds(Array.from({ length: 15 }, (_, index): Step => index % 2 ? [['observe', 'ok']] : cutStep()));
    expect(many.phase).toBe('stopped'); expect(many.stops).toEqual(['repeated_reflex_interruption']);
    expect(many.count).toBeLessThanOrEqual(15);
  });
  it('a read that FAILED, or a write that worked, is an outcome of its own and ends the run (M2)', async () => {
    const failedRead = await stepRounds([...Array.from({ length: 2 }, () => cutStep()), [['observe', 'plain']], ...Array.from({ length: 2 }, () => cutStep())]);
    expect(failedRead.checkpoint).toMatchObject({ consecutiveToolFailures: 1, consecutiveReflexCuts: 2, reflexCutToolRun: 2 });
    const write = await stepRounds([...Array.from({ length: 2 }, () => cutStep()), [['move', 'ok']], ...Array.from({ length: 2 }, () => cutStep())]);
    expect(write.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 2, reflexCutToolRun: 2 });
    const mixed = await stepRounds([...Array.from({ length: 2 }, () => cutStep()), [['mine', 'reflex'], ['move', 'ok']], cutStep()]);
    expect(mixed.checkpoint).toMatchObject({ consecutiveToolFailures: 0, consecutiveReflexCuts: 1, reflexCutToolRun: 1 });
  });
  it('a step that only reads does not clear the failures a run of cuts has counted, and one with no run still clears them as before (M2)', async () => {
    const run = await stepRounds([...Array.from({ length: 4 }, () => cutStep()), [['observe', 'ok']]]);
    expect(run.checkpoint).toMatchObject({ consecutiveToolFailures: 2, consecutiveReflexCuts: 4, reflexCutToolRun: 4 });
    const none = await stepRounds([[['mine', 'plain']], [['observe', 'ok']]]);
    expect(none.checkpoint).toMatchObject({ consecutiveToolFailures: 0 });
  });
  it('a wait between cuts leaves the run as it was (M2)', async () => {
    const waited = await stepRounds([cutStep(), cutStep(), 'wait', cutStep(), cutStep(), 'wait', cutStep()]);
    expect(waited.checkpoint).toMatchObject({ consecutiveReflexCuts: 5, reflexCutToolRun: 5, consecutiveToolFailures: 3 });
    const stopped = await stepRounds([...Array.from({ length: 3 }, () => cutStep()), 'wait', ...Array.from({ length: 4 }, () => cutStep())]);
    expect(stopped.phase).toBe('stopped'); expect(stopped.stops).toEqual(['repeated_reflex_interruption']);
  });
  it('carries the run across a restart, and starts from none when the checkpoint is from before the keys existed (M2)', async () => {
    // Four cuts, a restart in the middle: three more after it are the 5th, 6th and 7th of one run.
    const restarted = await stepRounds(Array.from({ length: 7 }, () => cutStep()), { restartAfter: 4 });
    expect(restarted.phase).toBe('stopped'); expect(restarted.stops).toEqual(['repeated_reflex_interruption']);
    // A checkpoint that has never heard of the keys (an older task) is no run at all.
    const old = await stepRounds(Array.from({ length: 2 }, () => cutStep()), { before: { consecutiveToolFailures: 1 } });
    expect(old.checkpoint).toMatchObject({ consecutiveToolFailures: 1, consecutiveReflexCuts: 2, reflexCutToolRun: 2 });
    // Damaged keys are no run either.
    const damaged = await stepRounds([cutStep()], { before: { consecutiveReflexCuts: 'many', reflexCutTool: 7, reflexCutToolRun: -4 } });
    expect(damaged.checkpoint).toMatchObject({ consecutiveReflexCuts: 1, reflexCutToolRun: 1 });
  });
  it('a stale body step puts the run back as it was, whatever it held (M2)', async () => {
    let count = 0;
    const f = fixture(() => output({ kind: 'wait', summary: 'unused' }));
    const task = f.child('stale-run');
    const definition = { name: 'mc.mine-block', description: 'x', input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] } as const;
    let revision = 0, stale = false;
    const driver = createTaskRuntimeWiring({ db: f.db, actions: f.actions, scopeKey: 'owner', now: () => '2026-10-09T00:00:00.000Z', ownerAlone: () => true,
      model: { async decide() { count++; return output({ kind: 'tools', calls: [{ id: `call-${count}`, name: 'mc.mine-block', input: {} }] }); }, toolResults: results => ({ results }) },
      stepPorts: () => ({ tools: { definitions: [definition], async execute() {
        if (stale) revision++; // The body changed under this step: its outcome says nothing.
        return minecraftSkillResult({ id: 'x', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: '2026-10-09T00:00:00.000Z', result: 'interrupted',
          failureType: 'interrupted_by_reflex', recoverable: true } as never);
      } },
      body: { revision: () => revision, guard: async (expected: number) => expected === revision, start() {}, async close() {}, noteCall() {}, noteResult() {}, toolSignal: (_name: string, signal: AbortSignal) => signal, context: () => ({}), settling: () => false } as never }) });
    cleanups.push(() => driver.close());
    for (let round = 0; round < 4; round++) { if (round === 3) stale = true; await driver.tick(); await driver.drain(); }
    // Three honest cuts, then a stale one: the run is the third's, not the fourth's.
    expect(driver.runtime.snapshot('owner', task.id)?.checkpoint).toMatchObject({ consecutiveReflexCuts: 3, reflexCutToolRun: 3, consecutiveToolFailures: 1 });
    expect(driver.runtime.get('owner', task.id)?.phase).not.toBe('stopped');
  });
  it('runs two independent tasks concurrently, bounds the third, and preserves the foreground slot', async () => {
    const pending = new Map<string, ReturnType<typeof blocked>>();
    const f = fixture((input, signal) => { const call = blocked(signal); pending.set(input.task.id, call); return call.promise; });
    const tasks = ['one', 'two', 'three'].map(title => f.child(title));
    await f.driver.tick();
    await until(() => pending.size === 2, 'two decisions must be in flight before either responds');
    const started = new Set(pending.keys());
    expect(f.store.list('owner').filter(action => action.state === 'running')).toHaveLength(2);
    expect(tasks.filter(task => f.driver.runtime.get('owner', task.id)?.phase === 'ready')).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    const foreground = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'foreground' });
    expect(foreground?.state).toBe('running');
    for (const [id, call] of pending) call.resolve(output({ kind: 'wait', summary: id }, `history:${id}`));
    await f.driver.drain();
    expect([...started].every(id => f.driver.runtime.get('owner', id)?.phase === 'waiting')).toBe(true);
    expect(f.store.list('owner').filter(action => action.kind === 'agentTask' && action.state === 'running')).toEqual([]);
    await f.driver.tick();
    await until(() => pending.size === 3, 'third decision follows released slots');
    const third = tasks.find(task => !started.has(task.id))!;
    expect(f.calls.at(-1)?.task.id).toBe(third.id);
    pending.get(third.id)!.resolve(output({ kind: 'wait', summary: 'idle' }, `history:${third.id}`));
    await f.driver.drain();
    for (const task of tasks) expect(f.driver.runtime.snapshot('owner', task.id)?.history).toEqual([{ role: 'assistant', native: `history:${task.id}` }]);
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
  });

  it('creates a real child through the common tools, releases a waiting parent, and wakes it on the child receipt', async () => {
    let childCall: ReturnType<typeof blocked> | undefined;
    const turns = new Map<string, number>();
    const f = fixture((input, signal) => {
      const round = turns.get(input.task.id) ?? 0; turns.set(input.task.id, round + 1);
      if (input.task.title === 'child') { childCall = blocked(signal); return childCall.promise; }
      if (round === 0) return output({ kind: 'tools', calls: [{ id: 'delegate', name: 'task.create', input: {
        title: 'child', goal: 'Find a fact', completionCriteria: 'A verified fact', context: 'private child context',
      } }] });
      if (round === 1) return output({ kind: 'wait', summary: 'Awaiting child' });
      return output({ kind: 'complete', summary: 'Parent assembled the answer' });
    });
    const parent = f.child('parent');
    await f.driver.tick(); await f.driver.drain();
    const childId = f.driver.runtime.get('owner', parent.id)!.childIds[0]!;
    expect(f.driver.runtime.get('owner', childId)).toMatchObject({ parentId: parent.id, title: 'child', phase: 'ready' });
    expect(f.driver.runtime.snapshot('owner', childId)?.messages).toMatchObject([{ sourceTaskId: parent.id, text: 'private child context' }]);
    await f.driver.tick();
    await until(() => !!childCall && f.driver.runtime.get('owner', parent.id)?.phase === 'waiting'
      && f.store.list('owner').filter(action => action.kind === 'agentTask' && action.state === 'running').length === 1,
    'waiting parent must release its action while the child is still deciding');
    childCall!.resolve(output({ kind: 'complete', summary: 'Fact verified' }));
    await f.driver.drain();
    expect(f.driver.runtime.get('owner', childId)?.phase).toBe('completed');
    expect(f.driver.runtime.get('owner', parent.id)?.phase).toBe('ready');
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', parent.id)?.phase).toBe('completed');
    expect(f.calls.filter(call => call.task.id === parent.id).at(-1)?.messages).toMatchObject([{ sourceTaskId: childId, text: 'Fact verified' }]);
    expect(f.calls.filter(call => call.task.id === parent.id).at(-1)?.children).toMatchObject([{ id: childId, phase: 'completed', summary: 'Fact verified' }]);
    const parentHistory = f.driver.runtime.snapshot('owner', parent.id)!.history;
    expect(parentHistory).toHaveLength(4);
    expect(parentHistory[1]).toMatchObject({ role: 'tool_results', results: [{ id: 'delegate', ok: true }] });

    const context = f.events.filter(event => event.node === 'context' && event.kind === 'span.started');
    expect(context).toHaveLength(4);
    const startedSteps = f.db.prepare("SELECT payload_json FROM agent_task_events WHERE event_type='fca_step_started'").all()
      .map(row => JSON.parse(String(row.payload_json)) as { taskId: string; parentId: string; stepId: string; revision: number });
    for (const event of context) {
      const provenance = event.input as { taskId: string; parentId: string; stepId: string; revision: number };
      expect(startedSteps).toContainEqual(expect.objectContaining(provenance));
      expect(f.events.some(other => other.runId === event.runId && other.node === 'store' && other.kind === 'span.completed')).toBe(true);
      expect(f.events.some(other => other.runId === event.runId && other.kind === 'run.started')).toBe(true);
    }
    expect(f.events.some(event => event.node === 'tools' && event.kind === 'span.started'
      && (event.input as { operationId?: string })?.operationId?.endsWith(':delegate'))).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain('native-private-history');
    expect(JSON.stringify(f.events)).not.toContain('private child context');
    expect(JSON.stringify(f.events)).not.toContain('private goal');
  });

  it('preserves messages delivered during a decision and delivers them exactly once to the next step', async () => {
    let first: ReturnType<typeof blocked> | undefined;
    const f = fixture((input, signal) => {
      if (f.calls.length === 1) { first = blocked(signal); return first.promise; }
      return output({ kind: 'wait', summary: 'Second input handled' });
    });
    const task = f.child('mail');
    f.driver.runtime.send('owner', f.root.id, task.id, 'first', 'm1');
    await f.driver.tick(); await until(() => !!first, 'first model call');
    expect(f.calls[0]?.messages.map(message => message.id)).toEqual(['m1']);
    f.driver.runtime.send('owner', f.root.id, task.id, 'while deciding', 'm2');
    f.driver.runtime.send('owner', f.root.id, task.id, 'while deciding', 'm2');
    first!.resolve(output({ kind: 'complete', summary: 'First input handled' }));
    await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('ready');
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.messages.map(message => message.id)).toEqual(['m2']);
    expect(f.calls[1]?.history).toHaveLength(1);
    expect(f.driver.runtime.snapshot('owner', task.id)?.messages).toEqual([]);
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('waiting');
  });

  it('keeps descendants stopping until their aborted model calls actually unwind', async () => {
    const release = deferred<void>(), aborted = new Set<string>();
    const f = fixture(async (input, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted.add(input.task.id); resolve(); }, { once: true }));
      await release.promise;
      throw new Error('model_stopped_after_unwind');
    });
    cleanups.push(async () => release.resolve());
    const parent = f.child('parent'), child = f.child('descendant', parent.id);
    await f.driver.tick(); await until(() => f.calls.length === 2, 'parent and descendant are deciding');
    await f.driver.stop(f.root.id, 'owner requested stop');
    expect(aborted).toEqual(new Set([parent.id, child.id]));
    expect([f.root.id, parent.id, child.id].map(id => f.driver.runtime.get('owner', id)?.phase)).toEqual(['stopping', 'stopping', 'stopping']);
    expect(f.store.list('owner').filter(action => action.kind === 'agentTask').map(action => action.state)).toEqual(['stopping', 'stopping']);
    release.resolve(); await f.driver.drain();
    expect([f.root.id, parent.id, child.id].map(id => f.driver.runtime.get('owner', id)?.phase)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(f.store.list('owner').filter(action => action.kind === 'agentTask').map(action => action.state)).toEqual(['cancelled', 'cancelled']);
    expect(f.driver.runtime.snapshot('owner', child.id)?.history).toEqual([]);
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it('leaves an expired sent action unknown across restart and never calls the model again for it', async () => {
    const f = fixture((_input, signal) => blocked(signal).promise);
    const task = f.child('unknown');
    await f.driver.tick(); await until(() => f.calls.length === 1, 'model dispatch');
    const original = f.store.list('owner').find(action => action.kind === 'agentTask')!;
    expect(original.sent).toBe(true);
    f.advance(); await f.driver.close();
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('unknown');
    expect(f.store.get(original.id)).toMatchObject({ state: 'unknown', sent: true, generation: original.generation + 1 });
    restored.runtime.send('owner', f.root.id, task.id, 'later input', 'unknown-message');
    await restored.tick(); await restored.drain();
    expect(f.calls).toHaveLength(1);
    expect(restored.runtime.resume('owner', task.id)).toBeNull();
    expect(restored.runtime.snapshot('owner', task.id)?.history).toEqual([]);
    expect(restored.runtime.snapshot('owner', task.id)?.messages).toMatchObject([{ id: 'unknown-message' }]);
  });

  it('recovers a definitive cancellation when only the stop acknowledgement response was lost', async () => {
    const f = fixture((_input, signal) => blocked(signal).promise);
    const task = f.child('stop-receipt'), originalFinish = f.actions.finish;
    let loseResponse = true;
    f.actions.finish = async (...args) => {
      const receipt = await originalFinish(...args);
      if (loseResponse && args[1] === 'cancelled' && args[2] === 'fca_stop_acknowledged') throw new Error('ack_response_lost');
      return receipt;
    };
    await f.driver.tick(); await until(() => f.calls.length === 1, 'model dispatch before stop');
    const [active] = f.driver.runtime.activeSteps('owner'); expect(active).toBeDefined();
    await f.driver.stop(task.id, 'stop requested'); await f.driver.drain();
    expect(f.store.get(active!.lease.id)).toMatchObject({ state: 'cancelled', result: 'fca_stop_acknowledged' });
    await f.driver.close();
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('stopping');
    expect(restored.runtime.pendingReceipts('owner')).toHaveLength(1);
    loseResponse = false; await restored.tick(); await restored.drain();
    expect(restored.runtime.pendingReceipts('owner')).toEqual([]);
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(restored.runtime.activeSteps('owner')).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it('persists local cancellation before a disconnected worker can receive its acknowledgement', async () => {
    const f = fixture((_input, signal) => blocked(signal).promise);
    const task = f.child('cancel-outbox'), originalFinish = f.actions.finish;
    let disconnected = true;
    f.actions.finish = async (...args) => {
      if (disconnected) throw new Error('worker_disconnected_before_apply');
      return originalFinish(...args);
    };
    await f.driver.tick(); await until(() => f.calls.length === 1, 'model dispatch before stop');
    await f.driver.stop(task.id, 'stop requested'); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('stopping');
    const [receipt] = f.driver.runtime.pendingReceipts('owner');
    expect(receipt).toMatchObject({ taskId: task.id, state: 'cancelled' });
    expect(f.driver.runtime.resume('owner', task.id)).toBeNull();
    await f.driver.close(); f.advance();
    expect(f.store.get(receipt!.lease.id)?.state).toBe('unknown');
    disconnected = false;
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(f.store.get(receipt!.lease.id)).toMatchObject({ state: 'cancelled', result: 'fca_stop_acknowledged' });
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(restored.runtime.activeSteps('owner')).toEqual([]);
    expect(restored.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it('recovers an expired unsent lease into one new decision using its original no-dispatch proof', async () => {
    const f = fixture(() => output({ kind: 'wait', summary: 'First actual decision' }));
    const task = f.child('unsent');
    const action = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${task.id}:${task.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    expect(action).not.toBeNull();
    expect(f.driver.runtime.beginStep('owner', task.id, leaseOf(action!), task.revision)).not.toBeNull();
    expect(f.store.get(action!.id)?.sent).toBe(false);
    expect(f.calls).toEqual([]);
    await f.driver.close(); f.advance();
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(f.store.get(action!.id)).toMatchObject({ state: 'cancelled', sent: false, result: 'lease_expired', generation: action!.generation + 1 });
    expect(f.calls).toHaveLength(1);
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('waiting');
    expect(restored.runtime.snapshot('owner', task.id)?.history).toHaveLength(1);
    expect(restored.runtime.pendingReceipts('owner')).toEqual([]);
  });

  it('denies cross-scope task tools through the real runner and returns no foreign task content', async () => {
    let foreignId = '';
    const f = fixture(() => output({ kind: 'tools', calls: [
      { id: 'read-other', name: 'task.get', input: { id: foreignId } },
      { id: 'send-other', name: 'task.send', input: { id: foreignId, message: 'unauthorized input' } },
      { id: 'list-owner', name: 'task.list', input: {} },
    ] }));
    const foreignRoot = f.driver.runtime.ensureRoot('other');
    const foreign = f.driver.runtime.createChild('other', foreignRoot.id, { title: 'FOREIGN_SECRET', goal: 'FOREIGN_SECRET_GOAL' }, 'foreign'); foreignId = foreign.id;
    const own = f.child('own');
    await f.driver.tick(); await f.driver.drain();
    expect(f.calls.map(call => call.task.id)).toEqual([own.id]);
    const history = f.driver.runtime.snapshot('owner', own.id)!.history;
    const results = (history[1] as { results: Array<{ id: string; ok: boolean; text: string }> }).results;
    expect(results.map(result => result.ok)).toEqual([false, false, true]);
    expect(JSON.stringify(results)).not.toContain('FOREIGN_SECRET');
    expect(f.driver.runtime.snapshot('other', foreign.id)?.messages).toEqual([]);
    expect(f.driver.runtime.get('other', foreign.id)?.phase).toBe('ready');
  });

  it('replays only the original segment acknowledgement after a lost finish and restart', async () => {
    const f = fixture(() => output({ kind: 'wait', summary: 'Durably recorded response' }));
    const task = f.child('receipt');
    const originalFinish = f.actions.finish, originalReconcile = f.actions.reconcile, originalGet = f.actions.get;
    let disconnected = true;
    f.actions.finish = async (...args) => { if (disconnected) throw new Error('worker_disconnected'); return originalFinish(...args); };
    f.actions.reconcile = async (...args) => { if (disconnected) throw new Error('worker_disconnected'); return originalReconcile(...args); };
    f.actions.get = async (...args) => { if (disconnected) throw new Error('worker_disconnected'); return originalGet(...args); };
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('waiting');
    expect(f.driver.runtime.snapshot('owner', task.id)?.history).toHaveLength(1);
    const [receipt] = f.driver.runtime.pendingReceipts('owner'); expect(receipt).toBeDefined();
    expect(f.calls).toHaveLength(1);
    await f.driver.close(); f.advance(); disconnected = false;
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(f.store.get(receipt!.lease.id)).toMatchObject({ state: 'completed', sent: false });
    expect(restored.runtime.pendingReceipts('owner')).toEqual([]);
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('waiting');
    expect(restored.runtime.snapshot('owner', task.id)?.history).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
  });
});
