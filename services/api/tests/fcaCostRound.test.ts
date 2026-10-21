import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FcaModelOutput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaSharedContext } from '../src/mind/action/fca/fcaEvidencePorts.js';
import { FCA_EARLIER_ACTION_FAILED } from '../src/mind/action/fca/fcaRunnerWords.js';
import { failureRefreshes } from '../src/mind/action/fca/fcaToolState.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { bodySharedContext } from '../src/infra/models/anthropic/anthropicFcaContext.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';
import { definition as harnessDefinition } from './fcaCoreToolsHarness.js';

/**
 * The cost round of 2026-10-19 (production run 15: $0.143 and 25 s a decision, 24 decisions to an iron pickaxe where L104 took 16):
 * the earlier-failure guard that goes with the batch rule, the shared context a body decision reads, and the scheduler's next turn.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const output = (decision: FcaModelOutput['decision']): FcaModelOutput => ({ decision, history: [{ role: 'assistant', native: 'private' }] });
const tool = (name: string, effect: 'read' | 'write'): FcaToolDefinition => ({ name, description: name,
  input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect, cost: 'none',
  audiences: ['owner_alone'], surfaces: ['text'] });

function driverWith(parts: { decide(count: number): FcaModelOutput; execute(name: string, count: number): { ok: boolean; text: string };
  continueAtOnce?: boolean; canRunTask?(): boolean; canScheduleTask?(): boolean; keepBody?: boolean }) {
  const time = '2026-10-19T08:00:00.000Z';
  const h = actionHarness(() => time);
  let count = 0;
  const executed: string[] = [], results: Array<Array<{ id: string; text: string; ok: boolean }>> = [];
  const noted: string[] = [], evidence: string[] = [];
  const definitions = [tool('mc.craft-one', 'write'), tool('mc.place-block-at', 'write'), tool('minecraft.observe', 'read'),
    { ...tool('goal.set_conditions', 'write'), domain: 'task_runtime' as const }, { ...tool('folder.create', 'write'), domain: 'host_folder' as const }];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now: () => time, ownerAlone: () => true,
    ...(parts.continueAtOnce ? { continueAtOnce: true } : {}),
    ...(parts.canRunTask ? { canRunTask: () => parts.canRunTask!() } : {}), ...(parts.canScheduleTask ? { canScheduleTask: () => parts.canScheduleTask!() } : {}),
    model: { async decide() { count++; return parts.decide(count); }, toolResults: list => { results.push([...list]); return { role: 'user', results: list }; } },
    stepPorts: () => ({ keepBodyTools: () => parts.keepBody !== false,
      evidence: { async prepare() { return { affect: {} as never, recentOutcomes: [] }; }, beforeActions: () => true,
        observed: (_step: unknown, call: { id: string }) => { evidence.push(`observed:${call.id}`); }, unknown() {},
        notRun: (_step: unknown, call: { id: string }) => { evidence.push(`notRun:${call.id}`); }, committed() {}, flush() {} },
      tools: { definitions, async execute(call) {
      executed.push(call.name);
      const answer = parts.execute(call.name, count);
      return answer.ok ? { ok: true, text: answer.text, retryable: false } : { ok: false, text: answer.text, failure: 'failed', retryable: true };
    } }, body: { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true,
      toolSignal: (_name: string, parent: AbortSignal) => parent, close: async () => {}, noteResult: (call: { name: string }) => { noted.push(call.name); } } as never }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: 'iron', goal: 'iron pickaxe', completionCriteria: 'seen' }, 'request-iron');
  return { driver, task, executed, results, noted, evidence, count: () => count };
}

describe('the earlier-failure guard that goes with the batch rule (old Minebot earlier_action_failed)', () => {
  it('runs no body action after one that failed in the same response, still runs the reads, and counts the step by what ran', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({
      decide: count => count === 1 ? output({ kind: 'tools', calls: [{ id: 'a', name: 'mc.craft-one', input: { itemName: 'furnace' } },
        { id: 'b', name: 'mc.place-block-at', input: {} }, { id: 'c', name: 'minecraft.observe', input: {} }, { id: 'd', name: 'mc.craft-one', input: { itemName: 'stick' } }] })
        : output({ kind: 'wait', summary: 'waiting' }),
      execute: name => name === 'mc.craft-one' ? { ok: false, text: 'crafting table needed' } : { ok: true, text: 'seen' },
    });
    await d.driver.tick(); await d.driver.drain();
    expect(d.executed).toEqual(['mc.craft-one', 'minecraft.observe']);
    const [first] = d.results;
    expect(first!.map(result => [result.id, result.ok])).toEqual([['a', false], ['b', false], ['c', true], ['d', false]]);
    expect(first![1]!.text).toBe(FCA_EARLIER_ACTION_FAILED);
    expect(first![3]!.text).toBe(FCA_EARLIER_ACTION_FAILED);
    // The pace ledger hears of what ran only, and a call not run is no event.
    expect(d.noted).toEqual(['mc.craft-one', 'minecraft.observe']);
    expect(d.evidence).toEqual(['observed:a', 'notRun:b', 'observed:c', 'notRun:d']);
    const checkpoint = d.driver.runtime.snapshot('owner', d.task.id)?.checkpoint as Record<string, unknown>;
    // A failed write and a read that worked: as before the guard, not a step of failures only.
    expect(checkpoint.consecutiveToolFailures).toBe(0);
  });
  it('never stops on a failed read, and a response whose body actions all failed before the cut-off counts once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({
      decide: count => count === 1 ? output({ kind: 'tools', calls: [{ id: 'a', name: 'minecraft.observe', input: {} }, { id: 'b', name: 'mc.place-block-at', input: {} }] })
        : count === 2 ? output({ kind: 'tools', calls: [{ id: 'c', name: 'mc.place-block-at', input: {} }, { id: 'd', name: 'mc.craft-one', input: {} }] })
        : output({ kind: 'wait', summary: 'waiting' }),
      execute: name => name === 'minecraft.observe' ? { ok: false, text: 'no frame' }
        : name === 'mc.place-block-at' ? { ok: false, text: 'occupied' } : { ok: true, text: 'crafted' },
    });
    await d.driver.tick(); await d.driver.drain();
    // The read failed: the body action after it still ran (and failed of its own).
    expect(d.executed).toEqual(['minecraft.observe', 'mc.place-block-at']);
    await d.driver.tick(); await d.driver.drain();
    expect(d.executed).toEqual(['minecraft.observe', 'mc.place-block-at', 'mc.place-block-at']);
    // Two steps whose calls that ran all failed: two, not three (the craft was never run).
    expect((d.driver.runtime.snapshot('owner', d.task.id)?.checkpoint as Record<string, unknown>).consecutiveToolFailures).toBe(2);
  });
  it('is the body\'s only: a failed goal or folder write stops no body action, a failed body action stops neither of them', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({
      decide: count => count === 1 ? output({ kind: 'tools', calls: [{ id: 'a', name: 'goal.set_conditions', input: {} }, { id: 'b', name: 'mc.craft-one', input: {} },
        { id: 'c', name: 'folder.create', input: {} }, { id: 'd', name: 'mc.place-block-at', input: {} }] })
        : count === 2 ? output({ kind: 'tools', calls: [{ id: 'e', name: 'mc.place-block-at', input: {} }, { id: 'f', name: 'goal.set_conditions', input: {} }, { id: 'g', name: 'folder.create', input: {} }] })
        : output({ kind: 'wait', summary: 'waiting' }),
      execute: name => name === 'mc.craft-one' ? { ok: true, text: 'crafted' } : { ok: false, text: 'refused' },
    });
    await d.driver.tick(); await d.driver.drain();
    expect(d.executed).toEqual(['goal.set_conditions', 'mc.craft-one', 'folder.create', 'mc.place-block-at']);
    await d.driver.tick(); await d.driver.drain();
    expect(d.executed.slice(4)).toEqual(['mc.place-block-at', 'goal.set_conditions', 'folder.create']);
  });
  it('does not apply to a task that is not a body task', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({ keepBody: false,
      decide: count => count === 1 ? output({ kind: 'tools', calls: [{ id: 'a', name: 'mc.craft-one', input: {} }, { id: 'b', name: 'mc.place-block-at', input: {} }] })
        : output({ kind: 'wait', summary: 'waiting' }),
      execute: name => name === 'mc.craft-one' ? { ok: false, text: 'no table' } : { ok: true, text: 'placed' } });
    await d.driver.tick(); await d.driver.drain();
    expect(d.executed).toEqual(['mc.craft-one', 'mc.place-block-at']);
  });
});

describe('the shared context a body decision reads', () => {
  const context: FcaSharedContext = {
    affect: { version: 1, revision: 4, updatedAt: '2026-10-19T08:00:00.000Z', emotion: { valence: 0.1 }, feeling: 'calm', causes: [] } as never,
    recentOutcomes: [
      { eventId: 'e-own', taskId: 't', operationId: 's:toolu_1', name: 'mc.craft-one', observation: 'observed', result: { ok: false, text: 'OWN-RESULT-TEXT' },
        expectation: null, comparison: null, appraisalRevision: 2 },
      { eventId: 'e-child', taskId: 'child', operationId: 'c:toolu_2', name: 'web.search', observation: 'observed', result: { ok: true, text: 'CHILD-RESULT' },
        expectation: null, comparison: null, appraisalRevision: 0 },
      { eventId: 'e-unknown', taskId: 't', operationId: 's:toolu_3', name: 'mc.move-to', observation: 'unknown', result: null,
        expectation: { callId: 'toolu_3', source: 'tool_result', observable: { kind: 'text_contains', text: '移動' }, expected: true, probability: 0.8, expectedValue: null, withinMs: 1000 } as never,
        comparison: null, appraisalRevision: 0 },
    ],
  };
  it('keeps the affect whole and what an appraisal names, and leaves out her own result texts, ids and operation ids', () => {
    const compact = bodySharedContext(context, 't');
    expect(compact.affect).toEqual(context.affect);
    expect(compact.recentOutcomes).toEqual([
      { eventId: 'e-own', name: 'mc.craft-one', observation: 'observed', ok: false, appraisalRevision: 2 },
      { eventId: 'e-child', name: 'web.search', observation: 'observed', ok: true, appraisalRevision: 0, taskId: 'child', result: { ok: true, text: 'CHILD-RESULT' } },
      { eventId: 'e-unknown', name: 'mc.move-to', observation: 'unknown', ok: null, appraisalRevision: 0, expectation: context.recentOutcomes[2]!.expectation },
    ]);
    expect(JSON.stringify(compact)).not.toContain('OWN-RESULT-TEXT');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(context).length);
  });
  it('is read in a transient body task\'s live state, never stored, and an appraisal of it is still checked against the whole', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'w', name: 'fca_wait', input: { summary: '待つ' } },
      { type: 'tool_use', id: 'x', name: 'fca_context', input: { expectations: [], appraisals: [{ eventId: 'e-own', revision: 3, value: -0.2, cause: '作業台が遠かった', target: '' }] } }], 'tool_use')]);
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
    const core = harnessDefinition('mc.skill-1', 'minecraft_body');
    const decided = await model.decide({ task: { id: 't', title: 'x', goal: 'x', completionCriteria: 'x' }, messages: [], history: [], tools: [core], coreTools: [core],
      catalog: [], transient: { observation: { marker: 'OBS' } }, body: { revision: 1 }, sharedContext: context } as never, new AbortController().signal);
    const body = fixture.bodies[0]!;
    expect(anthropicRequestViolation(body)).toBeNull();
    const messages = withoutCacheMarkers(body.messages as Array<{ role: string; content: unknown; clear_at?: string }>);
    const live = messages.filter(entry => entry.role === 'system' && entry.clear_at === 'next_user_message').map(entry => String(entry.content));
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]!).sharedContext.recentOutcomes[0]).toEqual({ eventId: 'e-own', name: 'mc.craft-one', observation: 'observed', ok: false, appraisalRevision: 2 });
    const stored = messages.filter(entry => entry.role === 'user').map(entry => JSON.stringify(entry.content)).join('');
    expect(stored).not.toContain('sharedContext');
    expect(stored).not.toContain('OWN-RESULT-TEXT');
    expect(decided.appraisals).toEqual([{ eventId: 'e-own', revision: 3, value: -0.2, cause: '作業台が遠かった', target: '' }]);
  });
});

describe('the scheduler\'s next turn after a step', () => {
  const settle = async (rounds = 200) => { for (let index = 0; index < rounds; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  it('starts the next step at once after one that ran, without waiting for the once-a-second tick', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({ continueAtOnce: true,
      decide: count => count < 4 ? output({ kind: 'tools', calls: [{ id: `c${count}`, name: 'mc.craft-one', input: {} }] }) : output({ kind: 'wait', summary: 'done for now' }),
      execute: () => ({ ok: true, text: 'crafted' }) });
    await d.driver.tick();
    for (let index = 0; index < 50 && d.count() < 4; index++) { await settle(20); await d.driver.drain(); }
    expect(d.count()).toBe(4);
    expect(d.executed).toEqual(['mc.craft-one', 'mc.craft-one', 'mc.craft-one']);
  });
  it('without it, one tick runs one step', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = driverWith({ decide: count => output({ kind: 'tools', calls: [{ id: `c${count}`, name: 'mc.craft-one', input: {} }] }), execute: () => ({ ok: true, text: 'crafted' }) });
    await d.driver.tick(); await d.driver.drain(); await settle(); await d.driver.drain();
    expect(d.count()).toBe(1);
  });
  it('never spins on a task that is scheduled but cannot run', async () => {
    let asked = 0;
    const d = driverWith({ continueAtOnce: true, canScheduleTask: () => true, canRunTask: () => { asked++; return false; },
      decide: () => output({ kind: 'wait', summary: 'x' }), execute: () => ({ ok: true, text: '' }) });
    await d.driver.tick(); await d.driver.drain(); await settle(); await d.driver.drain();
    expect(d.count()).toBe(0);
    expect(asked).toBe(1);
  });
});

describe('the tool selection after a failed call', () => {
  it('is asked again for a legacy menu and for a tool outside the transient core, never for a failed core tool', () => {
    const core = { hash: 'h', anchor: null, steps: 0, tools: [tool('mc.craft-one', 'write')] };
    expect(failureRefreshes({}, 'mc.craft-one')).toBe(true);
    expect(failureRefreshes({ core }, 'mc.craft-one')).toBe(false);
    expect(failureRefreshes({ core }, 'web.search')).toBe(true);
  });
});