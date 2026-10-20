import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { FCA_LOOKAHEAD_RUNNING, createFcaLookahead } from '../src/mind/action/fca/fcaLookahead.js';
import type { FcaDecision, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { shannonTool } from '../src/mind/tools/toolRegistryPorts.js';

/** mb-arch: the next decision asked while the last long call runs, and taken by the next step when still good for it. */
const databases: DatabaseSync[] = [];
const at = '2026-10-20T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(decisions: FcaDecision[]) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'Do the work', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [];
  const lines: string[] = [];
  const lookahead = createFcaLookahead({ wanted: call => call.name === 'web.search', log: line => lines.push(line) });
  const executed: string[] = [];
  let toolOk = true, release: (() => void) | null = null;
  const ports: FcaStepPorts = { runtime, ownerAlone: () => true, permit: async () => true, lookahead,
    model: { async decide(input) { inputs.push(input); return { decision: decisions[inputs.length - 1] ?? { kind: 'wait', summary: 'done' },
      history: [{ role: 'assistant', content: `turn ${inputs.length}` }] }; },
    toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
    tools: { definitions: [shannonTool('web.search')!, { ...shannonTool('web.search')!, name: 'web.fetch' }], async execute(request) {
      executed.push(request.name);
      // The long call: it ends only once the lookahead has been asked (the model has seen the running result).
      if (request.name === 'web.search') await new Promise<void>(resolve => { release = resolve; setTimeout(resolve, 50); });
      return { ok: toolOk, text: `${request.name} result`, retryable: false };
    } } };
  let sequence = 0;
  const begin = () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `look-${++sequence}`, kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
    return runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
  };
  const run = async () => {
    const step = begin();
    const result = await runFcaStep(step, ports, new AbortController().signal);
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
    return result;
  };
  return { runtime, root, task, inputs, lines, executed, run, failTool: () => { toolOk = false; }, release: () => release?.() };
}
const call = (id: string, name: string): FcaDecision => ({ kind: 'tools', calls: [{ id, name, input: {} }] });

describe('FCA lookahead (mb-arch)', () => {
  it('asks the next decision while the long call runs, with its result as running, and the next step takes it without asking', async () => {
    const f = fixture([call('a', 'web.search'), call('b', 'web.fetch')]);
    await f.run();
    expect(f.inputs).toHaveLength(2);
    expect(JSON.stringify(f.inputs[1]!.history.at(-1))).toContain(FCA_LOOKAHEAD_RUNNING);
    await f.run();
    expect(f.inputs).toHaveLength(2);
    expect(f.executed).toEqual(['web.search', 'web.fetch']);
    expect(f.lines.some(line => line.startsWith('Shannon FCA lookahead adopted'))).toBe(true);
    // The history keeps the real result of the long call and the taken decision after it.
    const history = JSON.stringify(f.runtime.snapshot('owner', f.task.id)!.history);
    expect(history).toContain('web.search result');
    expect(history).toContain('turn 2');
  });

  it('drops the prepared decision when the long call did not end well: the next step asks the model', async () => {
    const f = fixture([call('a', 'web.search'), call('b', 'web.fetch'), call('c', 'web.fetch')]);
    f.failTool();
    await f.run();
    await f.run();
    expect(f.inputs).toHaveLength(3);
    expect(f.lines.some(line => line.includes('adopted'))).toBe(false);
  });

  it('wastes it when a message came in meanwhile: the planner must see it', async () => {
    const f = fixture([call('a', 'web.search'), call('b', 'web.fetch'), call('c', 'web.fetch')]);
    await f.run();
    f.runtime.send('owner', f.root.id, f.task.id, 'a new message', 'm1');
    await f.run();
    expect(f.inputs).toHaveLength(3);
    expect(f.lines).toContain(`Shannon FCA lookahead wasted task=${f.task.id} reason=messages`);
  });

  it('takes at most four in a row, then asks the model (and lets the history be summarized)', () => {
    const now = Date.parse(at);
    const lookahead = createFcaLookahead({ wanted: () => true, now: () => now });
    const step = { taskId: 't', revision: 9, snapshot: { history: [1, 2], messages: [] } } as never;
    const prepared = { taskId: 't', historyLength: 2, lastTurn: '2', preparedAt: now, request: {} as never, output: {} as never, selection: null };
    const taken = Array.from({ length: 5 }, () => { lookahead.keep(prepared); return lookahead.take(step) !== null; });
    expect(taken).toEqual([true, true, true, true, false]);
  });
});
