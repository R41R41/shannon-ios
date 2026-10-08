import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaDecision, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelectionRequest } from '../src/mind/selectors/selectorsPorts.js';
import { shannonTool } from '../src/mind/tools/toolRegistryPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';

const databases: DatabaseSync[] = [];
const at = '2026-10-09T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(decide: (input: FcaModelInput) => FcaDecision | Promise<FcaDecision>) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Selected task', goal: 'Perform the requested work', completionCriteria: 'Observed result' }, 'selected');
  const inputs: FcaModelInput[] = [], results: Array<readonly { id: string; text: string; ok: boolean }[]> = [];
  const ports: FcaStepPorts = { runtime, ownerAlone: () => true, permit: async () => true,
    model: { async decide(input) { inputs.push(input); return { decision: await decide(input), history: [{ role: 'assistant', content: 'synthetic native turn' }] }; },
      toolResults(value) { results.push(value); return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } } };
  let sequence = 0;
  function begin(id = task.id) {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `fca-test-${++sequence}`, kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', id, leaseOf(action), runtime.get('owner', id)!.revision)!;
    expect(step).not.toBeNull(); return step;
  }
  function finish(step: ReturnType<typeof begin>) { actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id); }
  async function run() { const step = begin(); const result = await runFcaStep(step, ports, new AbortController().signal); finish(step); return result; }
  return { runtime, actions, root, task, ports, inputs, results, begin, finish, run };
}
const tools = (name: string, id = 'call', input: unknown = {}): FcaDecision => ({ kind: 'tools', calls: [{ id, name, input }] });

describe('FCA selection checkpoints and tool recovery', () => {
  it('reuses selection across successful rounds and reselects on admitted input, child state, catalog changes and failures', async () => {
    let invalid = false;
    const f = fixture(() => tools('task.list', 'list', invalid ? { unknown: true } : {}));
    const selections: FcaToolSelectionRequest[] = [];
    f.ports.selector = { async select(request) { selections.push(request); return { names: ['task.list'], source: 'jev' }; } };
    await f.run(); await f.run();
    expect(selections).toHaveLength(1);
    expect(f.inputs[0]!.tools.map(tool => tool.name)).toEqual(['task.list']);
    expect(f.inputs[0]!.catalog?.map(tool => tool.name)).toEqual(['task.create', 'task.list', 'task.get', 'task.send']);
    expect(Object.keys(selections[0]!.tools[0]!)).toEqual(['name', 'description']);
    f.runtime.send('owner', f.root.id, f.task.id, 'New input', 'new-input');
    await f.run(); await f.run();
    expect(selections).toHaveLength(2);
    const child = f.runtime.createChild('owner', f.task.id, { title: 'New child', goal: 'A delegated goal' }, 'child');
    await f.run(); expect(selections).toHaveLength(3);
    const childStep = f.begin(child.id); f.runtime.commitStep(childStep, { disposition: 'wait', summary: 'Waiting' }); f.finish(childStep);
    await f.run(); expect(selections).toHaveLength(4);
    f.ports.tools = { definitions: [shannonTool('web.search')!], async execute() { throw new Error('should not execute'); } };
    await f.run(); expect(selections).toHaveLength(5);
    invalid = true; await f.run(); expect(selections).toHaveLength(5);
    invalid = false; await f.run(); expect(selections).toHaveLength(6);
    expect(selections.at(-1)!.recentResults.at(-1)).toMatchObject({ name: 'task.list', ok: false });
    expect(f.runtime.snapshot('owner', f.task.id)!.checkpoint).toMatchObject({ fcaToolSelection: { version: 1, refresh: false, names: ['task.list'] } });
  });

  it('does not let input delivered during a decision change that admitted selection, but uses it next round', async () => {
    let first = true;
    const f = fixture(() => {
      if (first) { first = false; f.runtime.send('owner', f.root.id, f.task.id, 'Arrived later', 'later'); }
      return tools('task.list');
    });
    const seen: string[] = [];
    f.ports.selector = { async select(request) { seen.push(request.state); return { names: ['task.list'], source: 'jev' }; } };
    await f.run();
    expect(seen).toHaveLength(1); expect(seen[0]).not.toContain('Arrived later');
    await f.run();
    expect(seen).toHaveLength(2); expect(seen[1]).toContain('Arrived later');
  });

  it('opens only allowed tools, and opening cannot execute an unselected tool in the same response', async () => {
    let round = 0, executions = 0;
    const f = fixture(() => ++round === 1 ? { kind: 'tools', calls: [
      { id: 'open', name: 'tool.open', input: { name: 'web_search' } },
      { id: 'too-early', name: 'web.search', input: { query: 'synthetic' } },
    ] } : tools('web.search', 'search', { query: 'synthetic' }));
    f.ports.selector = { async select() { return { names: [], source: 'jev' }; } };
    f.ports.tools = { definitions: [shannonTool('web.search')!], async execute(request) {
      executions++; expect(request).toMatchObject({ scopeKey: 'owner', taskId: f.task.id, name: 'web.search' });
      expect(request.operationId).toMatch(/:search$/u); return { ok: true, text: 'Observed search result', retryable: false };
    } };
    await f.run(); expect(executions).toBe(0);
    expect(f.inputs[0]!.tools).toEqual([]);
    expect(f.results[0]!.map(result => result.ok)).toEqual([true, false]);
    await f.run(); expect(executions).toBe(1);
    expect(f.inputs[1]!.tools.map(tool => tool.name)).toEqual(['web.search']);
    expect(f.runtime.snapshot('owner', f.task.id)!.checkpoint).toMatchObject({ fcaToolSelection: { opened: ['web.search'] } });
    f.runtime.send('owner', f.root.id, f.task.id, 'A new request', 'new-request');
    await f.run();
    expect(f.inputs[2]!.tools).toEqual([]); expect(executions).toBe(1);
    expect(f.runtime.snapshot('owner', f.task.id)!.checkpoint).toMatchObject({ fcaToolSelection: { opened: [] } });
  });

  it('refuses opening a tool absent from the allowed catalog and falls back to all schemas for a malformed selector result', async () => {
    const f = fixture(() => tools('tool.open', 'open', { name: 'private_tool' }));
    f.ports.selector = { async select() { return { names: ['private.tool'], source: 'jev' }; } };
    await f.run();
    expect(f.inputs[0]!.tools.map(tool => tool.name)).toEqual(['task.create', 'task.list', 'task.get', 'task.send']);
    expect(f.results[0]![0]!.ok).toBe(false);
    expect(f.runtime.snapshot('owner', f.task.id)!.checkpoint).toMatchObject({ fcaToolSelection: { opened: [], refresh: true } });
  });

  it('preserves the full stage-one tool offer when no selector is configured', async () => {
    const f = fixture(() => tools('task.list'));
    await f.run();
    expect(f.inputs[0]!.tools.map(tool => tool.name)).toEqual(['task.create', 'task.list', 'task.get', 'task.send']);
    expect(f.inputs[0]).not.toHaveProperty('catalog');
    expect(f.runtime.snapshot('owner', f.task.id)!.checkpoint).not.toHaveProperty('fcaToolSelection');
  });
});

describe('FCA external-tool source and unknown-outcome boundaries', () => {
  it('checks source visibility before selection and again after selection, before the model', async () => {
    const f = fixture(() => tools('task.list'));
    let visible = false, selections = 0, permits = 0;
    f.ports.sourcesVisible = () => visible;
    f.ports.permit = async () => { permits++; return true; };
    f.ports.selector = { async select() { selections++; visible = false; return { names: [], source: 'jev' }; } };
    const step = f.begin();
    await expect(runFcaStep(step, f.ports, new AbortController().signal)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(selections).toBe(0); expect(f.inputs).toHaveLength(0); expect(permits).toBe(0);
    visible = true;
    await expect(runFcaStep(step, f.ports, new AbortController().signal)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(selections).toBe(1); expect(f.inputs).toHaveLength(0); expect(permits).toBe(2);
  });

  it('rechecks source visibility after the asynchronous permit, before any model input is used', async () => {
    const f = fixture(() => tools('task.list')); let visible = true;
    f.ports.sourcesVisible = () => visible;
    f.ports.permit = async () => { visible = false; return true; };
    f.ports.selector = { async select() { throw new Error('must not select'); } };
    await expect(runFcaStep(f.begin(), f.ports, new AbortController().signal)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(f.inputs).toHaveLength(0);
  });

  it('records task projection sources before their text enters the round', async () => {
    const f = fixture(() => tools('task.get', 'get', { id: f.root.id }));
    const observed: string[][] = [];
    f.ports.observeTasks = ids => { observed.push([...ids]); return true; };
    await f.run();
    expect(observed).toEqual([[f.root.id]]); expect(f.results[0]![0]!.ok).toBe(true);
    f.ports.observeTasks = () => false;
    await f.run();
    expect(f.results[1]![0]!.ok).toBe(false);
    expect(f.results[1]![0]!.text).not.toContain(f.root.goal);
  });

  it('records visible child-context sources before selection and omits invisible child summaries', async () => {
    const f = fixture(() => tools('task.list'));
    const visibleChild = f.runtime.createChild('owner', f.task.id, { title: 'Visible child', goal: 'Visible source' }, 'visible-child');
    const hiddenChild = f.runtime.createChild('owner', f.task.id, { title: 'Hidden child', goal: 'HIDDEN_SOURCE' }, 'hidden-child');
    const childStep = f.begin(visibleChild.id);
    f.runtime.commitStep(childStep, { disposition: 'wait', summary: 'Observed public evidence' }); f.finish(childStep);
    let captured = false;
    f.ports.taskVisible = id => id !== hiddenChild.id;
    f.ports.observeTasks = ids => { if (ids.includes(visibleChild.id)) captured = true; return true; };
    f.ports.selector = { async select(request) {
      expect(captured).toBe(true); expect(request.state).toContain('Observed public evidence');
      expect(request.state).not.toContain('Hidden child'); return { names: ['task.list'], source: 'jev' };
    } };
    await f.run();
    expect(f.inputs[0]!.children?.map(child => child.id)).toEqual([visibleChild.id]);
    f.ports.observeTasks = () => false;
    await expect(runFcaStep(f.begin(), f.ports, new AbortController().signal)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(f.inputs).toHaveLength(1);
  });

  it('rechecks sources between external calls and holds before persisting now-withheld content', async () => {
    const f = fixture(() => ({ kind: 'tools', calls: [
      { id: 'first', name: 'web.search', input: { query: 'one' } }, { id: 'second', name: 'web.search', input: { query: 'two' } },
    ] }));
    let visible = true, executions = 0;
    f.ports.sourcesVisible = () => visible;
    f.ports.tools = { definitions: [shannonTool('web.search')!], async execute() { executions++; visible = false;
      return { ok: true, text: 'PRIVATE_RESULT_AFTER_FORGET', retryable: false }; } };
    const step = f.begin();
    await expect(runFcaStep(step, f.ports, new AbortController().signal)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(executions).toBe(1);
    expect(f.results).toHaveLength(0);
    expect(f.runtime.snapshot('owner', f.task.id)!.history).toEqual([]);
  });

  it('propagates uncertain external failures once, without fabricating a result or committing progress', async () => {
    const f = fixture(() => tools('web.search'));
    const unknown = new Error('OUTSIDE_RESULT_UNKNOWN'); let executions = 0;
    f.ports.tools = { definitions: [shannonTool('web.search')!], async execute() { executions++; throw unknown; } };
    const step = f.begin();
    await expect(runFcaStep(step, f.ports, new AbortController().signal)).rejects.toBe(unknown);
    expect(executions).toBe(1); expect(f.results).toEqual([]);
    expect(f.runtime.snapshot('owner', f.task.id)!.history).toEqual([]);
    expect(f.runtime.pendingReceipts('owner')).toEqual([]);
  });
});

describe('FCA runner history preparation', () => {
  it('uses the planner bootstrap then appends only new native rounds, while originals remain durable', async () => {
    let index = 0;
    const f = fixture(() => tools('task.list', `list-${++index}`));
    const decide = f.ports.model.decide.bind(f.ports.model);
    f.ports.model.decide = async (input, signal) => {
      const output = await decide(input, signal);
      return { ...output, history: [{ role: 'user', content: `Round ${index}` }, { role: 'assistant', content: [
        { type: 'thinking', thinking: `PRIVATE-${index}`, signature: `SIGNATURE-${index}` },
        { type: 'tool_use', id: `list-${index}`, name: 'task_list', input: {} },
      ] }] };
    };
    await f.run(); await f.run(); await f.run();
    const original = structuredClone(f.runtime.snapshot('owner', f.task.id)!.history);
    let summaries = 0;
    f.ports.history = { codec: anthropicFcaHistoryCodec,
      summarizer: { async summarize(input) { summaries++; expect(JSON.stringify(input)).not.toMatch(/PRIVATE-|SIGNATURE-/u);
        return { '目的': ['Find the requested evidence'], '途中': ['Task list was inspected'] }; } },
      policy: { maximumRounds: 2, recentRounds: 1 } };
    await f.run();
    const bootstrap = f.inputs[3]!.history;
    expect(bootstrap).toHaveLength(1);
    expect(JSON.stringify(bootstrap)).not.toMatch(/PRIVATE-|SIGNATURE-/u);
    expect(JSON.stringify(bootstrap)).toContain('Round 3');
    expect(f.runtime.snapshot('owner', f.task.id)!.history.slice(0, original.length)).toEqual(original);
    await f.run();
    expect(f.inputs[4]!.history[0]).toEqual(bootstrap[0]);
    expect(JSON.stringify(f.inputs[4]!.history)).toContain('SIGNATURE-4');
    expect(JSON.stringify(f.inputs[4]!.history)).not.toContain('SIGNATURE-3');
    expect(summaries).toBe(1);
  });

  it('holds before selection or the decision when a summary loses its source visibility', async () => {
    const f = fixture(() => tools('task.list'));
    await f.run(); await f.run();
    let visible = true;
    f.ports.sourcesVisible = () => visible;
    f.ports.history = { codec: { bootstrap: text => [{ role: 'user', content: text }],
      project: round => [{ id: round.stepId, role: 'assistant', content: 'Public result' }] },
      summarizer: { async summarize() { visible = false; return { '目的': ['Research'] }; } },
      policy: { maximumRounds: 1, recentRounds: 1 } };
    f.ports.selector = { async select() { throw new Error('must not select'); } };
    const step = f.begin();
    await expect(runFcaStep(step, f.ports, new AbortController().signal)).rejects.toThrow();
    expect(f.inputs).toHaveLength(2);
    expect(f.runtime.history('owner', f.task.id)!.summary).toBeNull();
  });
});
