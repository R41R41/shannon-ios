import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { createFcaObservationMonitor } from '../src/mind/action/fca/fcaObservation.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaTaskObservationMonitor } from '../src/wiring/fcaTaskObservationWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { FcaExternalTools, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaGoalCondition } from '../src/mind/action/fca/fcaProgressPorts.js';
import { toolFailure, toolOk } from '../src/mind/tools/shannonTools.js';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
const tool = (name: string, effect: 'read' | 'write' = 'read', cost: 'none' | 'model' = 'none'): FcaToolDefinition => ({ name, effect, cost,
  input: { type: 'object', properties: {}, required: [], additionalProperties: false }, description: name, domain: 'task_runtime', surfaces: ['text'], audiences: ['owner_alone'] });
const call = (name: string, input: unknown = {}, operationId = 'step:call') => ({ name, input, operationId, taskId: 'task', scopeKey: 'owner', signal: new AbortController().signal });
const condition = (tool: string, path: string, expected: string | boolean | number, operator: FcaGoalCondition['operator'] = 'eq'): FcaGoalCondition => ({ id: 'expected', tool, input: {}, path, operator, expected });

describe('domain-generic common FCA verification and bounded recovery', () => {
  it.each([
    ['Minecraft native dragon event', 'minecraft.observe', 'facts.dragonDefeatedEvent', true, { facts: { dragonDefeatedEvent: true } }],
    ['document exact current version', 'document.read', 'version', 7, { version: 7, content: 'owner requested content' }],
    ['research canonical retrieved source', 'research.sources', 'sourceIds', 'retrieval:source-1', { sourceIds: ['retrieval:source-1'] }],
  ] as const)('fresh trusted binding verifies %s, never merely action acknowledgement', async (_, name, path, expected, observation) => {
    const reads: string[] = [];
    const base: FcaExternalTools = { definitions: [tool(name)], async execute(request) { reads.push(request.operationId); return toolOk(JSON.stringify(observation)); } };
    const tools = createFcaProgressTools(base, { binding: { id: 'original-request:1', conditions: [condition(name, path, expected, Array.isArray(observation[Object.keys(observation)[0] as keyof typeof observation]) ? 'contains' : 'eq')] }, permit: async () => {} });
    const result = await tools.progress.verifyCompletion(call('goal.verify'), async () => {});
    expect(result.status).toBe('verified'); expect(result.bindingId).toBe('original-request:1'); expect(result.checks[0]!.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(reads).toEqual(['step:call:verify:bound:expected']);
  });
  it('cannot replace a trusted boss predicate with a trivial model-suggested predicate or a write/paid tool', async () => {
    const base: FcaExternalTools = { definitions: [tool('minecraft.observe'), tool('write', 'write'), tool('search', 'read', 'model')], async execute() { return toolOk(JSON.stringify({ connected: true, facts: { dragonDefeatedEvent: false } })); } };
    const tools = createFcaProgressTools(base, { binding: { id: 'dragon-request', conditions: [condition('minecraft.observe', 'facts.dragonDefeatedEvent', true)] }, permit: async () => {} });
    expect((await tools.execute(call('goal.set_conditions', { conditions: [condition('write', '', true)] }))).failure).toBe('invalid_input');
    expect((await tools.execute(call('goal.set_conditions', { conditions: [condition('search', '', true)] }))).failure).toBe('invalid_input');
    expect((await tools.execute(call('goal.set_conditions', { conditions: [condition('minecraft.observe', 'connected', true)] }))).ok).toBe(true);
    const result = await tools.progress.verifyCompletion(call('goal.verify'), async () => {});
    expect(result.status).toBe('not_verified'); expect(result.suggestedChecks[0]!.passed).toBe(true); expect(result.checks[0]!.passed).toBe(false);
  });
  it('takes a read tool by the name the model sees (Minebot lane run 1: mc_goal-evidence) and says what was wrong when it refuses', async () => {
    const reads: string[] = [];
    const base: FcaExternalTools = { definitions: [tool('mc.goal-evidence'), tool('minecraft.observe'), tool('mc.move-to', 'write'), tool('web.search', 'read', 'model')],
      async execute(request) { reads.push(request.name); return toolOk(JSON.stringify({ connected: true })); } };
    const tools = createFcaProgressTools(base, { permit: async () => {} });
    const accepted = await tools.execute(call('goal.set_conditions', { conditions: [{ ...condition('mc_goal-evidence', 'connected', true), id: 'connected-body' }] }));
    expect(accepted.ok).toBe(true);
    expect(tools.progress.context().conditions).toEqual([{ ...condition('mc.goal-evidence', 'connected', true), id: 'connected-body' }]);
    expect((await tools.progress.verifyCompletion(call('goal.verify'), async () => {})).suggestedChecks[0]).toMatchObject({ tool: 'mc.goal-evidence', passed: true });
    expect(reads).toEqual(['mc.goal-evidence']);
    for (const name of ['mc_move-to', 'web_search', 'mc_unknown']) {
      const refused = await tools.execute(call('goal.set_conditions', { conditions: [{ ...condition(name, '', true), id: 'bad' }] }));
      expect(refused).toMatchObject({ ok: false, failure: 'invalid_input' });
      expect(refused.text).toContain('条件 bad の tool');
      expect(refused.text).toContain('mc_goal-evidence, minecraft_observe');
      expect(refused.text).not.toContain('mc_move-to,');
    }
    const malformed = await tools.execute(call('goal.set_conditions', { conditions: [{ id: 'no-expected', tool: 'minecraft_observe', input: {}, path: 'a', operator: 'eq' }] }));
    expect(malformed.text).toContain('条件の形が合いません');
    expect(tools.progress.context().conditions).toHaveLength(1);
  });
  it('labels unbound completion self_reported and suggested check evidence separately', async () => {
    const tools = createFcaProgressTools({ definitions: [tool('document.read')], async execute() { return toolOk('{"version":7}'); } }, { permit: async () => {} });
    await tools.execute(call('goal.set_conditions', { conditions: [condition('document.read', 'version', 7)] }));
    expect(await tools.progress.verifyCompletion(call('goal.verify'), async () => {})).toMatchObject({ status: 'self_reported', bindingId: null, checks: [], suggestedChecks: [{ passed: true }] });
  });
  it('replans only observed failures, preserves checkpoint limits across segments and never swallows uncertain effects', async () => {
    let dispatched = 0;
    const base: FcaExternalTools = { definitions: [tool('write', 'write')], async execute() { dispatched++; throw new Error('OUTCOME_UNKNOWN'); } };
    let tools = createFcaProgressTools(base, { permit: async () => {} });
    await expect(tools.execute(call('write'))).rejects.toThrow('OUTCOME_UNKNOWN');
    const plan = { failureOperationId: 'original:write', summary: 'Read current version first', nextSteps: ['Inspect original operation result'] };
    expect((await tools.execute(call('task.replan', plan))).failure).toBe('refused');
    tools.progress.observed('original:write', 'write', toolFailure('conflict', 'Version changed', { retryable: false }));
    for (let index = 0; index < 3; index++) {
      expect((await tools.execute(call('task.replan', plan))).ok).toBe(true);
      tools = createFcaProgressTools(base, { checkpoint: tools.checkpoint!(), permit: async () => {} });
    }
    expect((await tools.execute(call('task.replan', plan))).failure).toBe('limit'); expect(dispatched).toBe(1);
  });
  it('checks visibility around awaited observations and rejects prototype paths', async () => {
    let allowed = true;
    const tools = createFcaProgressTools({ definitions: [tool('document.read')], async execute() { allowed = false; return toolOk('{"version":7}'); } }, {
      binding: { id: 'doc-request', conditions: [condition('document.read', 'version', 7)] }, permit: async () => { if (!allowed) throw new Error('FCA_SOURCE_WITHHELD'); },
    });
    expect((await tools.execute(call('goal.set_conditions', { conditions: [condition('document.read', '__proto__.version', 7)] }))).failure).toBe('invalid_input');
    await expect(tools.progress.verifyCompletion(call('goal.verify'), async () => {})).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(tools.progress.context().verification).toBeNull();
  });
  it('refuses completion with failed trusted evidence under actual SQLite authority, then records fresh verified proof', async () => {
    const h = actionHarness(() => '2026-10-09T00:00:00.000Z'); cleanups.push(h.close);
    let version = 6, reads = 0; const inputs: FcaModelInput[] = [];
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => '2026-10-09T00:00:00.000Z',
      model: { async decide(input) { inputs.push(input); return { decision: { kind: 'complete', summary: 'Updated to version 7' }, history: [{ role: 'assistant', content: 'completion proposal' }] }; }, toolResults: results => ({ role: 'user', results }) },
      stepPorts: (_, step) => ({ tools: createFcaProgressTools({ definitions: [tool('document.read')], async execute() { reads++; return toolOk(JSON.stringify({ version })); } }, {
        checkpoint: step.snapshot.checkpoint, binding: { id: 'owner-document:version-7', conditions: [condition('document.read', 'version', 7)] }, permit: async () => {},
      }) }),
    }); cleanups.push(() => driver.close());
    const task = driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id, { title: 'Update', goal: 'Document must be version 7', completionCriteria: 'Read exact version 7' }, 'doc-request');
    await driver.tick(); await driver.drain(); expect(driver.runtime.get('owner', task.id)!.phase).toBe('ready');
    expect(driver.runtime.snapshot('owner', task.id)!.checkpoint).toMatchObject({ fcaProgress: { verification: { status: 'not_verified', bindingId: 'owner-document:version-7' } } });
    version = 7; await driver.tick(); await driver.drain();
    expect(driver.runtime.get('owner', task.id)!.phase).toBe('completed'); expect(reads).toBe(2); expect(inputs[1]!.progress!.verification!.status).toBe('not_verified');
    expect(driver.runtime.pendingReceipts('owner')).toEqual([]);
  });
});

describe('common observation generation fencing', () => {
  it('fences a stale document write after canonical inbox input arrives during inference', async () => {
    vi.useFakeTimers();
    const h = actionHarness(() => '2026-10-09T00:00:00.000Z'); cleanups.push(h.close);
    let resolve!: (value: { decision: { kind: 'tools'; calls: { id: string; name: string; input: object }[] }; history: unknown[] }) => void;
    let called = false, writes = 0;
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => '2026-10-09T00:00:00.000Z',
      model: { async decide() { called = true; return new Promise(yes => { resolve = yes; }); }, toolResults: results => ({ role: 'user', results }) },
      stepPorts: (runtime, step) => ({
        observations: [createFcaTaskObservationMonitor({ runtime, step, allowed: () => true, sourcesVisible: () => true, taskVisible: () => true,
          observeTasks: ids => runtime.inheritTaskSources(step, ids), intervalMilliseconds: 250 })],
        tools: { definitions: [tool('document.write', 'write')], async execute() { writes++; return toolOk('Written'); } },
      }),
    }); cleanups.push(() => driver.close());
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: 'Document', goal: 'Write after checking current instructions' }, 'request');
    await driver.tick();
    for (let index = 0; index < 100 && !called; index++) await Promise.resolve();
    expect(called).toBe(true);
    driver.runtime.send('owner', root.id, task.id, 'Use the changed document version', 'new-owner-input');
    await vi.advanceTimersByTimeAsync(250);
    resolve({ decision: { kind: 'tools', calls: [{ id: 'write', name: 'document.write', input: {} }] }, history: [{ role: 'assistant', content: 'old decision' }] });
    await driver.drain();
    expect(writes).toBe(0); expect(driver.runtime.get('owner', task.id)!.phase).toBe('ready');
    expect(driver.runtime.pendingMessageIds!('owner', task.id)).toContain('new-owner-input');
  });
  it('polls while a domain operation waits, interrupts only declared safe operations, drains on close', async () => {
    vi.useFakeTimers(); let generation = 'version:1'; const sources: string[][] = [];
    const monitor = createFcaObservationMonitor({ async read() { return { generation, data: { version: generation }, sourceIds: ['document:1'] }; },
      observeSources(ids) { sources.push([...ids]); return true; }, interruptible: name => name === 'safe.read', intervalMilliseconds: 250 });
    monitor.start(new AbortController().signal); await monitor.guard(0); const initial = monitor.revision();
    const parent = new AbortController(); const read = monitor.toolSignal('safe.read', parent.signal), write = monitor.toolSignal('write', parent.signal);
    generation = 'version:2'; await vi.advanceTimersByTimeAsync(250);
    expect(read.aborted).toBe(true); expect(write).toBe(parent.signal); expect(write.aborted).toBe(false);
    expect(await monitor.guard(initial)).toBe(false); expect(monitor.context().observation!.generation).toBe('version:2');
    await monitor.close(); const count = sources.length; await vi.advanceTimersByTimeAsync(1000); expect(sources).toHaveLength(count);
  });
  it('does not release source-withheld observations to inference', async () => {
    const monitor = createFcaObservationMonitor({ async read() { return { generation: '1', data: { secret: 'hidden' }, sourceIds: ['private'] }; }, observeSources: () => false, interruptible: () => false });
    monitor.start(new AbortController().signal); await expect(monitor.guard(0)).rejects.toThrow('FCA_SOURCE_WITHHELD'); expect(monitor.context().observation).toBeNull(); await monitor.close();
  });
});
