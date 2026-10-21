import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaBodyInvestigation, FcaBodyLifecycle, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { createFcaLookahead, type FcaLookahead } from '../src/mind/action/fca/fcaLookahead.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';

/**
 * mb-llmc r4 in the common runner: the body's investigation runs before the decision (after the first checks, before the lookahead is
 * taken), a decision asked ahead is not taken after a surprise, what it did is in the metrics line, and a failing one never fails the step.
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-22T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };

function fixture(options: { investigate?: () => Promise<FcaBodyInvestigation | null>; lookahead?: FcaLookahead }) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'ネザーへ', completionCriteria: 'Observed result' }, 'body');
  const order: string[] = [], inputs: FcaModelInput[] = [], lines: string[] = [];
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => { order.push('context'); return { revision: 0, observation: null }; },
    async guard() { return true; }, toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false,
    transient: () => { order.push('transient'); return { map: 'm' }; },
    ...(options.investigate ? { investigate: async () => { order.push('investigate'); return options.investigate!(); } } : {}) };
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `r4-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true,
      ...(options.lookahead ? { lookahead: options.lookahead } : {}),
      model: { async decide(input) {
        order.push('model');
        inputs.push(input);
        return { decision: { kind: 'tools', calls: [{ id: `toolu_${inputs.length}`, name: MC_ACT_TOOL, input: {} }] },
          history: [{ role: 'user', content: 'decision' }, { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${inputs.length}`, name: 'mc_act', input: {} }] }] };
      },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      tools: combineFcaTools({ definitions: [ACT], async execute() { return { ok: true, text: 'act 全部済み', retryable: false }; } }) };
    const logged = console.info, said = console.log;
    console.info = (line: string) => { lines.push(String(line)); };
    console.log = (line: string) => { lines.push(String(line)); };
    try { await runFcaStep(step, ports, new AbortController().signal); }
    finally { console.info = logged; console.log = said; }
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
  };
  return { run, order, inputs, lines };
}
const metrics = (lines: readonly string[]) => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);

describe('the investigation in the runner (r4)', () => {
  it('runs before the request is built and the model asked, and says what it did in the metrics line', async () => {
    const f = fixture({ investigate: async () => ({ surprises: ['fall'], probes: 2, answered: 1, ms: 120 }) });
    await f.run();
    expect(f.order.indexOf('investigate')).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf('investigate')).toBeLessThan(f.order.indexOf('context'));
    expect(f.order.indexOf('context')).toBeLessThan(f.order.indexOf('model'));
    expect(metrics(f.lines)[0]).toMatchObject({ probe: { surprises: ['fall'], probes: 2, answered: 1 } });
    expect((metrics(f.lines)[0]!.probe as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  it('no surprise: nothing in the metrics line; a failing investigation never fails the step', async () => {
    const quiet = fixture({ investigate: async () => null });
    await quiet.run();
    expect(metrics(quiet.lines)[0]).not.toHaveProperty('probe');
    const broken = fixture({ investigate: async () => { throw new Error('body gone'); } });
    await broken.run();
    expect(broken.inputs).toHaveLength(1);
  });

  it('a decision asked ahead is dropped after a surprise (it was asked without it), and taken when there was none', async () => {
    const taken: string[] = [], dropped: string[] = [];
    const base = createFcaLookahead({ wanted: () => false });
    const lookahead: FcaLookahead = { ...base, take(step) { taken.push(step.taskId); return base.take(step); },
      drop(taskId, reason) { dropped.push(reason); base.drop!(taskId, reason); } };
    let surprise = true;
    const f = fixture({ lookahead, investigate: async () => surprise ? { surprises: ['repeat'], probes: 2, answered: 2, ms: 5 } : null });
    await f.run();
    expect(dropped).toEqual(['surprise']);
    expect(taken).toHaveLength(0);
    surprise = false;
    await f.run();
    expect(taken).toHaveLength(1);
    expect(dropped).toEqual(['surprise']);
  });

  it('without investigate (switch off) the step is as before: no probe, the lookahead taken', async () => {
    const taken: string[] = [];
    const base = createFcaLookahead({ wanted: () => false });
    const f = fixture({ lookahead: { ...base, take(step) { taken.push(step.taskId); return base.take(step); } } });
    await f.run();
    expect(f.order).not.toContain('investigate');
    expect(taken).toHaveLength(1);
    expect(metrics(f.lines)[0]).not.toHaveProperty('probe');
  });
});

describe('the lookahead\'s drop', () => {
  it('forgets what was kept for the task and says why, once', () => {
    const lines: string[] = [];
    const lookahead = createFcaLookahead({ wanted: () => true, log: line => lines.push(line) });
    lookahead.keep({ taskId: 't', historyLength: 0, lastTurn: 'null', preparedAt: Date.now(), request: {} as never,
      output: { decision: { kind: 'tools', calls: [] }, history: [] }, selection: null });
    lookahead.drop!('t', 'surprise');
    lookahead.drop!('t', 'surprise');
    expect(lines).toEqual(['Shannon FCA lookahead wasted task=t reason=surprise']);
    expect(lookahead.take({ taskId: 't', snapshot: { history: [], messages: [] } } as never)).toBeNull();
  });
});
