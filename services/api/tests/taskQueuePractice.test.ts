import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import type { FcaDecision, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { forgetLlmcQueues } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { queueBody, queueFor } from './support/llmcQueueHarness.js';

/**
 * The practice ground without the API (design minebot-task-queue 11.4, step 1): the head's runner, tools, queue and control joined to the body's own
 * control loop and queue (the body's source, `TQ_BODY_ROOT`: the root of a copy of the body's worktree) through the poll, with a model that
 * says what it was told to and a body whose hands are timed waits with the outcomes the test gives. Checked: the items run one after another with
 * no gap, the next decision is asked when the running item has T left, a bad end drops what waits and every receipt closes, a replace takes the
 * waiting items off, a pre that does not hold starts nothing, a stop stops all, and the step commits with nothing unsettled. No model is called.
 * Without `TQ_BODY_ROOT` these tests are skipped.
 */
const BODY = process.env.TQ_BODY_ROOT;
const at = () => new Date().toISOString();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); forgetActNodes(); forgetLlmcQueues(); });

interface Plan { ms: number; outcome?: 'completed' | 'failed'; result?: string; failureType?: string }
interface Ran { item: string; id: string; startedAt: number; endedAt: number; outcome: string }

const actJson = (ok: boolean, text: string) => JSON.stringify({ v: 1, ok, done: ok ? 1 : 0, of: 1, ms: 100, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20,
  ...(ok ? {} : { stoppedBy: 'failure', stoppedWhy: text }), lines: [{ i: 1, do: 'wait', status: ok ? 'done' : 'stopped', line: text }] });

async function practice(parts: { script: (item: string, why: string) => Plan; decisions: Array<(input: FcaModelInput, now: number) => FcaDecision | Promise<FcaDecision>>;
  check?: (words: string) => { ok: boolean; words: string }; decisionMs?: number[] }) {
  const { CommonFcaControlLoop } = await import(/* @vite-ignore */ `${BODY}/backend/src/services/minebot/integration/commonFca/controlLoop.ts`);
  const h = actionHarness(at), store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.now(), ownerAlone: () => true, pollMilliseconds: 5, frameMilliseconds: 5_000,
    leaseValid: lease => !!h.store.check(lease, at())?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const ran: Ran[] = [], executed: string[] = [];
  let sequence = 0;
  let running: { item: string; id: string } | null = null;
  const actuator = {
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose, maxDurationMs: 180_000 }],
    observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: at(), receivedAt: at(), connected: true,
      state: { world: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, localMap: '', nearbyThreats: [] } }, facts: { connected: true, alive: true } }),
    candidates: () => [],
    async release() { return true; },
    check: (condition: unknown) => parts.check?.(JSON.stringify(condition)) ?? { ok: true, words: '' },
    progress: () => running ? { hand: 1, of: 1, iteration: 1, repeat: 1 } : null,
    async execute(command: { id: string; connectionId: string; queue?: { item: string }; arguments?: { why?: string } }, signal: AbortSignal) {
      const item = command.queue?.item ?? command.id, plan = parts.script(item, String(command.arguments?.why ?? ''));
      const entry: Ran = { item, id: command.id, startedAt: performance.now(), endedAt: 0, outcome: '' };
      ran.push(entry);
      executed.push(item);
      running = { item, id: command.id };
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, plan.ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      running = null;
      entry.endedAt = performance.now();
      const base = { id: command.id, connectionId: command.connectionId, inputsReleased: true, observedAt: at() };
      if (signal.aborted) { entry.outcome = 'cancelled'; return { ...base, outcome: 'cancelled' as const, result: `${item} は取り消された` }; }
      entry.outcome = plan.outcome ?? 'completed';
      return entry.outcome === 'completed' ? { ...base, outcome: 'completed' as const, result: actJson(true, plan.result ?? `${item} 済み`) }
        : { ...base, outcome: 'failed' as const, failureType: plan.failureType ?? 'failed', result: actJson(false, plan.result ?? `${item} 失敗`) };
    },
  };
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:1', token: 't', serverId: 'world', actuator, pollMilliseconds: 10,
    fetcher: (async (_url: string, init: { body: string }) => {
      try { return new Response(JSON.stringify(control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, JSON.parse(init.body))), { status: 200 }); }
      catch { return new Response('x', { status: 400 }); }
    }) as unknown as typeof fetch });
  loop.start();
  cleanups.push(async () => { await loop.stop(); });
  for (let count = 0; count < 400 && !control.frame('minecraft:world'); count++) await delay(5);
  const requests: Array<{ at: number; input: FcaModelInput }> = [];
  const decisionAt: number[] = [];
  const queues: Array<ReturnType<typeof queueFor>> = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide(input) {
      const index = requests.length;
      requests.push({ at: performance.now(), input });
      decisionAt.push(performance.now());
      await delay(parts.decisionMs?.[index] ?? 30);
      const make = parts.decisions[index];
      const decision = make ? await make(input, performance.now()) : { kind: 'wait', summary: 'end' } as FcaDecision;
      return { decision, history: [{ role: 'user', content: `decision ${index + 1}` }, { role: 'assistant', content: `turn ${index + 1}` }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => {
      const queue = queueFor(control, step);
      queues.push(queue);
      return { keepBodyTools: () => true, body: queueBody(queue, [], { control, step }), tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
        llmc: { plan: () => undefined, queue } }) };
    },
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'End', goal: 'エンドラを討伐して' }, 'owner-request');
  store.bind(task.id, 'minecraft:world');
  cleanups.push(async () => { await driver.close(); h.close(); });
  const run = async () => { await driver.tick(); await driver.drain(); };
  const unsettled = () => h.db.prepare("SELECT id, phase FROM fca_body_operations WHERE phase!='settled'").all() as Array<{ id: string; phase: string }>;
  const outcomes = () => h.db.prepare("SELECT json_extract(command_json,'$.queue.item') AS item, json_extract(receipt_json,'$.outcome') AS outcome, json_extract(receipt_json,'$.failureType') AS failureType FROM fca_body_operations ORDER BY rowid").all() as Array<{ item: string | null; outcome: string | null; failureType: string | null }>;
  return { run, ran, executed, requests, driver, task, store, control, unsettled, outcomes, queues, decisionAt, loop };
}
/** A call as the model adapter hands it over: the short forms put into JSON (`candidateInput`). */
const act = (why: string, seconds = 1, extra: Record<string, unknown> = {}) => ({ id: `c-${why}`, name: MC_ACT_TOOL,
  input: expandShortAct({ hands: [`wait ${seconds}`], why, ...extra }).input });
const tools = (...calls: ReturnType<typeof act>[]): FcaDecision => ({ kind: 'tools', calls });
const text = (value: unknown) => JSON.stringify(value);

describe.skipIf(!BODY)('the practice ground: the head and the body joined, no model', () => {
  it('two items of one decision run one after the other with no gap, and the step commits with nothing unsettled', async () => {
    const f = await practice({ script: () => ({ ms: 400 }), decisions: [() => tools(act('[p1] 一つ目', 1), act('[p1] 二つ目', 2))] });
    await f.run();
    expect(f.executed).toEqual(['q1', 'q2']);
    const gap = f.ran[1]!.startedAt - f.ran[0]!.endedAt;
    expect(gap).toBeLessThan(300);
    expect(f.unsettled()).toEqual([]);
    expect(f.outcomes()).toEqual([{ item: 'q1', outcome: 'completed', failureType: null }, { item: 'q2', outcome: 'completed', failureType: null }]);
  });

  it('asks the next decision when the running item has T left, not before, and not after it has ended', async () => {
    // Each decision took 600 ms: T is its median, 2 s at least. An item of 3 s (a 3 s wait) has 2 s left after 1 s.
    const f = await practice({ script: () => ({ ms: 3_000 }), decisionMs: [30, 600], decisions: [() => tools(act('[p1] 長い', 3)), () => ({ kind: 'wait', summary: 'end' })] });
    await f.run();
    const startedAt = f.ran[0]!.startedAt, asked = f.decisionAt[1]! - startedAt;
    expect(asked).toBeGreaterThan(700);
    expect(asked).toBeLessThan(2_000);
    expect(f.ran[0]!.endedAt).toBeGreaterThan(f.decisionAt[1]!);
    expect(f.unsettled()).toEqual([]);
  }, 20_000);

  it('a bad end drops what waits (it never started, its hands did not move), the news says so, and every receipt is closed', async () => {
    const f = await practice({ script: item => item === 'q1' ? { ms: 300, outcome: 'failed', result: '掘れない' } : { ms: 300 },
      decisions: [() => tools(act('[p1] 掘る', 1), act('[p1] 焼く', 2)), (input) => { void input; return tools(act('[p1] 次', 1)); }] });
    await f.run();
    expect(f.executed).toEqual(['q1']);
    expect(f.outcomes()).toEqual([{ item: 'q1', outcome: 'failed', failureType: 'failed' }, { item: 'q2', outcome: 'cancelled', failureType: 'queue_dropped' }]);
    expect(f.unsettled()).toEqual([]);
    const committed = text(f.driver.runtime.snapshot('owner', f.task.id)!.history);
    expect(committed).toContain('捨てた: 前の項目 q1 が止まった');
    expect(committed).toContain('掘れない');
  });

  it('a replace takes the running item off (the body stops it) and the new item follows the one before', async () => {
    const f = await practice({ script: item => ({ ms: item === 'q2' ? 5_000 : 1_000 }), decisionMs: [30, 100],
      decisions: [() => tools(act('[p1] 一', 1), act('[p1] 二', 2)), () => tools(act('[p1] 三', 3, { replace: ['q2'] }))] });
    await f.run();
    // q2 had begun when the decision came (the model is asked once nothing waits): it is stopped, and q3 starts as soon as the body has let go.
    expect(f.executed).toEqual(['q1', 'q2', 'q3']);
    expect(f.ran[1]!.endedAt - f.ran[1]!.startedAt).toBeLessThan(3_000);
    expect(f.outcomes().map(row => [row.item, row.outcome])).toEqual([['q1', 'completed'], ['q2', 'cancelled'], ['q3', 'completed']]);
    expect(f.unsettled()).toEqual([]);
  }, 20_000);

  it('an item whose pre does not hold starts nothing, and the ones behind it are dropped', async () => {
    const f = await practice({ script: () => ({ ms: 200 }), check: words => words.includes('iron_ore') ? { ok: false, words: 'iron_ore 1/3' } : { ok: true, words: '' },
      decisions: [() => tools(act('[p1] 掘る', 1), act('[p1] 焼く', 2, { pre: 'have:iron_ore>=3' }), act('[p1] 取る', 3))] });
    await f.run();
    expect(f.executed).toEqual(['q1']);
    expect(f.outcomes().map(row => [row.item, row.outcome, row.failureType])).toEqual([['q1', 'completed', null], ['q2', 'failed', 'precondition'], ['q3', 'cancelled', 'queue_dropped']]);
    expect(text(f.driver.runtime.snapshot('owner', f.task.id)!.history)).toContain('前提を満たさず始めなかった: iron_ore 1/3');
    expect(f.unsettled()).toEqual([]);
  });

  it('the fourth item is not sent, and the model is told the queue is full', async () => {
    const f = await practice({ script: () => ({ ms: 300 }), decisions: [() => tools(act('[p1] 一', 1), act('[p1] 二', 2), act('[p1] 三', 3), act('[p1] 四', 4))] });
    await f.run();
    expect(f.executed).toEqual(['q1', 'q2', 'q3']);
    expect(text(f.requests[1]?.input.history ?? []) + text(f.driver.runtime.snapshot('owner', f.task.id)!.history)).toContain('列がいっぱい');
    expect(f.unsettled()).toEqual([]);
  }, 20_000);

  it('the body stands still only briefly between items over a longer run (the gaps are printed)', async () => {
    const f = await practice({ script: () => ({ ms: 350 }), decisionMs: [30, 30, 30],
      decisions: [() => tools(act('[p1] 一', 0.5), act('[p1] 二', 0.6), act('[p1] 三', 0.7)), () => tools(act('[p1] 四', 0.8), act('[p1] 五', 0.9))] });
    await f.run();
    const gaps = f.ran.slice(1).map((entry, index) => entry.startedAt - f.ran[index]!.endedAt).sort((a, b) => a - b);
    console.info(`practice gaps ms: ${gaps.map(gap => Math.round(gap)).join(' ')} (items ${f.ran.length})`);
    expect(f.ran.length).toBeGreaterThanOrEqual(4);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(150);
    expect(gaps.at(-1)).toBeLessThan(300);
    expect(f.unsettled()).toEqual([]);
  }, 20_000);

  it('stopping the task stops the running item and drops the rest, and nothing is left unsettled', async () => {
    const f = await practice({ script: () => ({ ms: 10_000 }), decisions: [() => tools(act('[p1] 長い', 10), act('[p1] 次', 1))] });
    const running = f.run();
    for (let count = 0; count < 400 && !f.ran.length; count++) await delay(5);
    await f.driver.stop(f.task.id, 'test_stop');
    await running;
    for (let count = 0; count < 200 && f.unsettled().length; count++) await delay(10);
    expect(f.unsettled()).toEqual([]);
    expect(f.ran).toHaveLength(1);
    expect(f.ran[0]!.outcome).toBe('cancelled');
  }, 20_000);

  it('a reflex that cut the item is no fault of the model: it is told as it is, the rest dropped, and the ladder does not count it as the model\'s failure', async () => {
    const f = await practice({ script: item => item === 'q1' ? { ms: 200, outcome: 'failed', failureType: 'interrupted_by_reflex', result: '反射が止めた' } : { ms: 200 },
      decisions: [() => tools(act('[p1] 歩く', 1), act('[p1] 掘る', 2))] });
    await f.run();
    expect(f.outcomes().map(row => row.outcome)).toEqual(['failed', 'cancelled']);
    expect(f.unsettled()).toEqual([]);
  });
});
