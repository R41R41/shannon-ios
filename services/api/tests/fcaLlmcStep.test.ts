import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { permitDue } from '../src/mind/action/fca/fcaStepCost.js';
import { createFcaPlanTools, PLAN_UPDATE_TOOL } from '../src/mind/action/fca/fcaPlanTools.js';
import type { FcaBodyLifecycle, FcaDecision, FcaModelInput, FcaToolCall, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { planFromSeeds } from '@shannon/mind';

/**
 * Design mb-llm-centric 2.3 and 2.7 in the common runner: the plan's path in every decision and its flat copy committed with the step,
 * and a step's fixed cost (the lease asked once, no recall without an event).
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-21T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const shortAct = { hands: [{ do: 'eat' }] };

function body(recallWanted: boolean): FcaBodyLifecycle & { recalls: number } {
  return { recalls: 0, start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => recallWanted, transient: () => ({ map: 'm' }) };
}

function fixture(decisions: FcaDecision[], options: { permitMs?: number; recallMs?: number; window?: number; recallWanted?: boolean;
  actMs?: number; plan?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [];
  let permits = 0, recalls = 0;
  const lifecycle = body(options.recallWanted ?? false);
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `llmc-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const plan = options.plan === false ? null : createFcaPlanTools({ taskId: task.id, checkpoint: step.snapshot.checkpoint, log: line => lines.push(line),
      inbox: { take: (_id, held) => held.nodes.length ? null : { tree: planFromSeeds([{ title: '木', children: [{ title: '原木' }] }, { title: '鉄' }])!, note: 'seed' } } });
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle,
      permit: async () => { permits += 1; await sleep(options.permitMs ?? 0); return true; },
      ...(options.window !== undefined ? { permitWindowMs: options.window } : {}),
      ...(plan ? { plan: plan.port } : {}),
      bodyRecall: { async packet() { recalls += 1; await sleep(options.recallMs ?? 0);
        return { packet: { contextVersion: 'v', observedAt: at, status: 'no_match', items: [], sourceIds: [] },
          measure: { poolMs: null, pool: 0, groups: 0, shown: 0, chars: 0, tags: [], jev: null } }; }, cancel() {} },
      model: { async decide(input) { inputs.push(input); return { decision: decisions[inputs.length - 1] ?? { kind: 'wait', summary: 'done' },
        history: [{ role: 'assistant', content: `turn ${inputs.length}` }] }; },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      tools: combineFcaTools(...(plan ? [plan.tools] : []), { definitions: [ACT], async execute() {
        await sleep(options.actMs ?? 0);
        return { ok: true, text: 'act 全部済み', retryable: false };
      } }) };
    const began = performance.now();
    const result = await runFcaStep(step, ports, new AbortController().signal);
    const ms = performance.now() - began;
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
    return { result, ms };
  };
  return { db, runtime, task, inputs, lines, run, permits: () => permits, recalls: () => recalls };
}
const act = (id: string, input: unknown, extra: FcaToolCall[] = []): FcaDecision =>
  ({ kind: 'tools', calls: [...extra, { id, name: MC_ACT_TOOL, input }] });

describe('plan tree in the runner (design 2.7)', () => {
  it('reads the path to the current node into each decision, and commits plan_json and an event when the plan changes', async () => {
    const f = fixture([act('a', shortAct, [{ id: 'p', name: PLAN_UPDATE_TOOL, input: { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] } }]), act('b', shortAct)]);
    await f.run();
    expect(f.inputs[0]!.plan).toMatchObject({ now: 'p1.1 原木', path: ['木'], next: ['p2 鉄'] });
    const row = f.db.prepare('SELECT plan_json FROM agent_tasks WHERE task_id=?').get(f.task.id) as { plan_json: string };
    expect(JSON.parse(row.plan_json)).toEqual([
      { id: 'p1', title: '木', status: 'completed' }, { id: 'p1.1', title: '　原木', status: 'completed' }, { id: 'p2', title: '鉄', status: 'running' }]);
    const events = f.db.prepare("SELECT payload_json FROM agent_task_events WHERE task_id=? AND event_type='fca_plan_updated'").all(f.task.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(events.at(-1)!.payload_json))).toMatchObject({ nodes: 3, done: 2, current: 'p2' });
    expect(f.lines.some(line => line.startsWith('Shannon FCA plan updated'))).toBe(true);
    await f.run();
    expect(f.inputs[1]!.plan).toMatchObject({ now: 'p2 鉄', done: '2/3' });
    const checkpoint = f.runtime.snapshot('owner', f.task.id)!.checkpoint as { fcaPlanTree?: { revision: number } };
    expect(checkpoint.fcaPlanTree?.revision).toBe(2);
  });

  it('a task without a plan port has no plan in its decision and writes no plan_json (the switch off)', async () => {
    const f = fixture([act('a', shortAct)], { plan: false });
    await f.run();
    expect(f.inputs[0]!.plan).toBeUndefined();
    const row = f.db.prepare('SELECT plan_json FROM agent_tasks WHERE task_id=?').get(f.task.id) as { plan_json: string };
    expect(row.plan_json).toBe('[]');
  });
});


