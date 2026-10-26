import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { FCA_STRETCH, NEWS_HEAD } from '../src/mind/action/fca/fcaStretch.js';
import type { FcaBodyLifecycle, FcaBodyQueue, FcaDecision, FcaModelInput, FcaQueueNews, FcaQueueWake, FcaToolCall, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';

/**
 * The step that goes on while the body works through its queue (design minebot-task-queue, 2026-10-26), in the common runner with a queue played by
 * hand: it decides again when the queue says so, with the history so far and no recall; the results of the items come once, at the end of the round
 * they ended in; it commits once, when nothing is open; a decision asked before a drop is thrown away; the failure ladder counts the items' results.
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-26T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const act = (id: string, why = 'x'): FcaDecision => ({ kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: { hands: [{ do: 'wait' }], why } }] });
const complete: FcaDecision = { kind: 'complete', summary: 'done' };

interface Step { wake: FcaQueueWake; ends?: Array<{ item: string; ok: boolean; text: string; kind?: 'ran' | 'dropped' }>; bump?: boolean }
/** A queue the test drives: `put` an item as the tool does; each `ready` takes the next step of the script. */
function fakeQueue(script: Step[]) {
  const open = new Set<string>(), news: FcaQueueNews[] = [];
  let version = 0, counter = 0, noted: number[] = [], cancelled = 0, drains = 0, waited = 0;
  const call: FcaToolCall = { id: 'c', name: MC_ACT_TOOL, input: {} };
  const end = (item: string, ok: boolean, text: string, kind: 'ran' | 'dropped' = 'ran') => {
    open.delete(item);
    news.push({ kind, item, call, operationId: `op:${item}`, result: ok ? toolOk(text) : { ...toolOk(text), ok: false, failure: 'failed' as never }, ms: 100, label: `${item} [p1] x` });
  };
  const queue: FcaBodyQueue = {
    openIds: () => new Set(open), open: () => open.size > 0, version: () => version,
    noteDecision: ms => { noted.push(ms); },
    dropWaiting: () => 0,
    cancelAll: () => { cancelled += 1; for (const item of [...open]) end(item, false, '捨てた: 止めた', 'dropped'); },
    take: () => news.splice(0),
    async ready({ drain }) {
      if (drain) {
        drains += 1;
        for (const item of [...open]) end(item, true, `${item} 済み`);
        return 'empty';
      }
      waited += 1;
      const step = script.shift() ?? { wake: 'empty' as const };
      await sleep(5);
      for (const done of step.ends ?? []) end(done.item, done.ok, done.text, done.kind);
      if (step.bump) version += 1;
      return step.wake;
    },
  };
  return { queue, put: () => { counter += 1; open.add(`q${counter}`); return `q${counter}`; }, bump: () => { version += 1; },
    stats: () => ({ noted, cancelled, drains, waited, open: [...open] }) };
}

function fixture(decisions: Array<FcaDecision | ((input: FcaModelInput) => Promise<FcaDecision>)>, queue: ReturnType<typeof fakeQueue> | null, options: {
  recall?: boolean; stale?: () => boolean; messages?: () => boolean } = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [], noted: string[] = [];
  let recalls = 0, commits = 0;
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }),
    async guard() { return true; }, guardFor: async () => !(options.stale?.() ?? false), toolSignal: (_name, parent) => parent, async close() {},
    recallWanted: () => true, transient: () => ({ map: 'm' }), noteNews: text => { noted.push(text); }, ...(queue ? { queue: queue.queue } : {}) };
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `st-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true,
      bodyRecall: { async packet() { recalls += 1;
        return { packet: { contextVersion: 'v', observedAt: at, status: 'no_match', items: [], sourceIds: [] },
          measure: { poolMs: null, pool: 0, groups: 0, shown: 0, chars: 0, tags: [], jev: null } }; }, cancel() {} },
      model: { async decide(input, signal) {
        const index = inputs.length;
        inputs.push(input);
        const next = decisions[index] ?? { kind: 'wait', summary: 'end' } as FcaDecision;
        const decision = typeof next === 'function' ? await Promise.race([next(input), new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })]) : next;
        return { decision, history: [{ role: 'user', content: `decision ${index + 1}` }, { role: 'assistant', content: `turn ${index + 1}` }] };
      },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text, ok: item.ok })) }; } },
      tools: combineFcaTools({ definitions: [ACT], async execute() { return toolOk(queue ? `列に入れた ${queue.put()}` : 'act 全部済み'); } }) };
    const logged = console.info, said = console.log;
    console.info = (line: string) => { lines.push(String(line)); };
    console.log = (line: string) => { lines.push(String(line)); };
    try { await runFcaStep(step, ports, new AbortController().signal); } finally { console.info = logged; console.log = said; }
    commits += 1;
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
  };
  const metrics = () => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);
  return { run, inputs, lines, noted, runtime, task, db, recalls: () => recalls, commits: () => commits, metrics };
}
const text = (value: unknown) => JSON.stringify(value);

describe('a step with items open decides again', () => {
  it('without a queue, or when the queue does not ask for another decision, it is one decision and one commit, as before', async () => {
    const plain = fixture([act('a')], null);
    await plain.run();
    expect(plain.inputs).toHaveLength(1);
    expect(plain.metrics()[0]).not.toHaveProperty('stretch');
    const queue = fakeQueue([{ wake: 'empty' }]);
    const f = fixture([act('a'), act('b')], queue);
    await f.run();
    // The queue says nothing more to decide on: what is open runs out and the step ends with its one decision.
    expect(f.inputs).toHaveLength(1);
    expect(queue.stats().waited).toBe(1);
    expect(queue.stats().drains).toBe(1);
  });

  it('decides again when the queue says remaining, from the history so far, with no recall and no messages, and commits once when nothing is open', async () => {
    const queue = fakeQueue([{ wake: 'remaining' }, { wake: 'remaining' }, { wake: 'empty', ends: [{ item: 'q3', ok: true, text: 'q3 済み' }] }]);
    const f = fixture([act('a'), act('b'), act('c'), { kind: 'wait', summary: 'end' }], queue);
    await f.run();
    expect(f.inputs.length).toBeGreaterThanOrEqual(3);
    expect(f.recalls()).toBe(1);
    expect(f.inputs[1]!.messages).toEqual([]);
    expect(f.inputs[1]!.recall).toBeUndefined();
    // The second request reads the first round: its decision and its results, ahead of its own message.
    expect(text(f.inputs[1]!.history)).toContain('decision 1');
    expect(text(f.inputs[1]!.history)).toContain('列に入れた q1');
    expect(text(f.inputs[2]!.history)).toContain('列に入れた q2');
    expect(f.commits()).toBe(1);
    expect(f.metrics()).toHaveLength(1);
    expect(f.metrics()[0]).toMatchObject({ stretch: { rounds: 3, thrown: false } });
    const committed = f.runtime.snapshot('owner', f.task.id)!.history;
    expect(text(committed)).toContain('turn 1');
    expect(text(committed)).toContain('turn 3');
  });

  it('the time the model took is told to the queue, once for each decision after the first too', async () => {
    const queue = fakeQueue([{ wake: 'remaining' }, { wake: 'empty' }]);
    const f = fixture([act('a'), act('b'), { kind: 'wait', summary: 'end' }], queue);
    await f.run();
    expect(queue.stats().noted.length).toBe(f.inputs.length);
  });
});

describe('the results of the items', () => {
  it('stand once, at the end of the last tool result of the round they ended in, under the news head', async () => {
    const queue = fakeQueue([{ wake: 'remaining', ends: [{ item: 'q1', ok: true, text: 'act 全部済み（3/3）' }] }, { wake: 'empty' }]);
    const f = fixture([act('a'), act('b')], queue);
    await f.run();
    const second = text(f.inputs[1]!.history);
    expect(second).toContain(`${NEWS_HEAD}\\nq1 [p1] x: act 全部済み（3/3）`);
    expect(second.split('act 全部済み（3/3）')).toHaveLength(2);
    // The round that has news has them in its own result, after its words.
    expect(second.indexOf('列に入れた q1')).toBeLessThan(second.indexOf(NEWS_HEAD));
  });

  it('a result that is a failure is counted by the ladder like a call that failed; a dropped item counts for nothing', async () => {
    const queue = fakeQueue([{ wake: 'dropped', ends: [{ item: 'q1', ok: false, text: 'act 0/1 済みで止まった（failure）' },
      { item: 'q2', ok: false, text: '捨てた: 前の項目 q1 が止まった', kind: 'dropped' }] }]);
    const f = fixture([{ kind: 'tools', calls: [{ id: 'a', name: MC_ACT_TOOL, input: {} }, { id: 'b', name: MC_ACT_TOOL, input: {} }] }], queue);
    await f.run();
    const checkpoint = f.runtime.snapshot('owner', f.task.id)!.checkpoint as { consecutiveToolFailures?: number };
    expect(checkpoint.consecutiveToolFailures).toBe(1);
    expect(text(f.runtime.snapshot('owner', f.task.id)!.history)).toContain('捨てた: 前の項目 q1 が止まった');
  });

  it('a news with no tool result to carry it (the decision after was a completion) goes to the next decision once, and the queue is drained first', async () => {
    const queue = fakeQueue([{ wake: 'remaining' }]);
    const f = fixture([act('a'), complete], queue);
    await f.run();
    expect(queue.stats().drains).toBeGreaterThanOrEqual(1);
    expect(f.noted.join('\n')).toContain('q1 [p1] x: q1 済み');
  });
});

describe('a queue that changes, and the limits', () => {
  it('a decision asked before a drop is thrown away, the step ends there and commits what it has', async () => {
    const queue = fakeQueue([{ wake: 'remaining' }]);
    const f = fixture([act('a'), async () => { queue.bump(); await sleep(400); return act('b'); }], queue);
    await f.run();
    expect(f.metrics()[0]).toMatchObject({ stretch: { rounds: 2, thrown: true } });
    expect(f.commits()).toBe(1);
    expect(text(f.runtime.snapshot('owner', f.task.id)!.history)).not.toContain('turn 2');
    expect(text(f.runtime.snapshot('owner', f.task.id)!.history)).toContain('turn 1');
  });

  it('after the limit of decisions it adds nothing more and waits for the queue to run dry', async () => {
    const script: Step[] = Array.from({ length: FCA_STRETCH.maxDecisions + 2 }, () => ({ wake: 'remaining' as const }));
    const queue = fakeQueue(script);
    const f = fixture(Array.from({ length: 20 }, (_, index) => act(`a${index}`)), queue);
    await f.run();
    expect(f.inputs.length).toBe(FCA_STRETCH.maxDecisions);
    expect(queue.stats().drains).toBeGreaterThanOrEqual(1);
    expect(queue.stats().open).toEqual([]);
  });

  it('a body that moved (stale) cancels what is open and ends the step; the failures of the round do not count', async () => {
    const queue = fakeQueue([{ wake: 'remaining' }]);
    const f = fixture([act('a'), act('b')], queue, { stale: () => true });
    await f.run();
    expect(f.inputs).toHaveLength(1);
    expect(queue.stats().cancelled).toBe(1);
    expect(queue.stats().open).toEqual([]);
  });

  it('a wake of message ends the stretch: the open items run out and the step commits', async () => {
    const queue = fakeQueue([{ wake: 'message' }]);
    const f = fixture([act('a'), act('b')], queue);
    await f.run();
    expect(f.inputs).toHaveLength(1);
    expect(queue.stats().drains).toBe(1);
    expect(f.commits()).toBe(1);
  });

  it('an alert decides again with the items still open', async () => {
    const queue = fakeQueue([{ wake: 'alert' }, { wake: 'empty' }]);
    const f = fixture([act('a'), act('b'), { kind: 'wait', summary: 'end' }], queue);
    await f.run();
    expect(f.inputs.length).toBeGreaterThanOrEqual(2);
    expect(text(f.inputs[1]!.history)).toContain('列に入れた q1');
  });
});
