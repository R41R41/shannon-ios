import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type Anthropic from '@anthropic-ai/sdk';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaBodyLifecycle, FcaModel, FcaModelInput, FcaModelOutput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaProgressHooks } from '../src/mind/action/fca/fcaProgressPorts.js';
import { decideInterruptibly } from '../src/mind/action/fca/fcaUrgentDecision.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { createAnthropicFcaModel, type AnthropicFcaClient, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { message } from './support/anthropicFixtures.js';
import { LLMC_CATALOG_SELECTOR } from '../src/wiring/minecraftLlmcWiring.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';

/**
 * mb-llmc r8 (production run 32, 2026-10-22: the decision for a wither skeleton in sight took 10.3 s; she was hit three times in 2.3 s and
 * thrown off the bridge; the answer reached the body 0.1 s after her death): a decision awaited is thrown away when a hostile comes, asked
 * again at once on the body's present state; what the thrown-away request cost is booked, and its answer is never used, whenever it comes.
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const request = (transient?: Record<string, unknown>): FcaModelInput => ({ task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [],
  history: [], tools: [], ...(transient ? { transient } : {}) });
const output = (marker: string): FcaModelOutput => ({ decision: { kind: 'wait', summary: marker }, history: [] });

describe('decideInterruptibly', () => {
  it('a decision no hostile interrupts is the one asked: its seconds are told to the body', async () => {
    const decided: unknown[] = [];
    const out = await decideInterruptibly({ body: { interrupt: () => null, decided: info => decided.push(info) }, signal: new AbortController().signal,
      request: request({ map: 'm' }), ask: async () => { await sleep(20); return output('first'); }, again: async asked => asked, pollMs: 5 });
    expect(out.decision).toEqual({ kind: 'wait', summary: 'first' });
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ aborted: false, thrownMs: 0 });
  });

  it('a hostile that comes: the awaited request is aborted and thrown away, the one asked again is the decision, a late answer is never read', async () => {
    const signals: AbortSignal[] = [], asked: FcaModelInput[] = [], decided: Array<Record<string, unknown>> = [], thrown: number[] = [];
    let polls = 0, late = false;
    const result = await decideInterruptibly({
      body: { interrupt: () => ++polls >= 3 ? '近接の敵' : null, decided: info => decided.push(info) }, signal: new AbortController().signal,
      request: request({ map: 'whole' }), pollMs: 5,
      ask: async (asking, signal) => {
        signals.push(signal);
        asked.push(asking);
        if (signals.length === 1) {
          // The request the server goes on with whatever the client does: it answers 100 ms later, aborted or not.
          await sleep(100);
          late = true;
          return output('A: the thrown-away request\'s answer');
        }
        return output('B: the decision asked again');
      },
      again: async asking => ({ ...asking, transient: { map: 'whole', urgent: ['近接の敵'] } }), interrupted: info => thrown.push(info.thrownMs) });
    expect(result.decision).toEqual({ kind: 'wait', summary: 'B: the decision asked again' });
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(asked[1]!.transient).toEqual({ map: 'whole', urgent: ['近接の敵'] });
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeLessThan(100);
    expect(decided).toEqual([expect.objectContaining({ aborted: true, thrownMs: thrown[0] })]);
    await sleep(150);
    expect(late).toBe(true);
    expect(result.decision).toEqual({ kind: 'wait', summary: 'B: the decision asked again' });
  });

  it('one interrupt a decision; a stop of the step ends it; no live state or no port: asked as it was', async () => {
    let asks = 0;
    await decideInterruptibly({ body: { interrupt: () => '敵' }, signal: new AbortController().signal, request: request({ map: 'm' }), pollMs: 2,
      ask: async () => { asks += 1; await sleep(asks === 1 ? 60 : 5); return output('x'); }, again: async asking => asking });
    expect(asks).toBe(2);
    const stop = new AbortController();
    const stopped = decideInterruptibly({ body: { interrupt: () => null }, signal: stop.signal, request: request({ map: 'm' }), pollMs: 2,
      ask: (_asking, signal) => new Promise<FcaModelOutput>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('FCA_MODEL_ABORTED')))),
      again: async asking => asking });
    stop.abort();
    await expect(stopped).rejects.toThrow('FCA_MODEL_ABORTED');
    let polled = 0;
    await decideInterruptibly({ body: { interrupt: () => { polled += 1; return '敵'; } }, signal: new AbortController().signal, request: request(), pollMs: 2,
      ask: async () => { await sleep(20); return output('x'); }, again: async asking => asking });
    await decideInterruptibly({ body: undefined, signal: new AbortController().signal, request: request({ map: 'm' }), pollMs: 2,
      ask: async () => output('x'), again: async asking => asking });
    expect(polled).toBe(0);
  });
});

describe('the model adapter: what the thrown-away request cost is booked (production: it is let finish within its stop grace)', () => {
  const nativeUsage = (read: number, creation: number) => ({ input_tokens: 4_000, output_tokens: 600, cache_creation_input_tokens: creation, cache_read_input_tokens: read,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: creation } });
  const answer = (usage = nativeUsage(44_000, 900)) => message([{ type: 'tool_use', id: 'toolu_1', name: 'fca_wait', input: { summary: 's' } }], 'tool_use',
    { model: 'claude-opus-5-5', usage });
  const modelInput = (): FcaModelInput => ({ task: { id: 'task-1', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], history: [], tools: [] });

  it('within its stop grace the real usage is booked when the request ends, and its answer is thrown away', async () => {
    const receipts: AnthropicFcaUsage[] = [];
    const controller = new AbortController();
    const execution: ActionExecution = { lease: { id: 'action', holder: 'api', generation: 1 }, signal: controller.signal,
      permit: async () => { throw new Error('runner_already_checked_permit'); } };
    const client: AnthropicFcaClient = { messages: { create: async () => { await sleep(40); return answer() as unknown as Anthropic.Message; } } };
    const model = createAnthropicFcaModel({ client, model: 'claude-opus-5-5', stopGraceMilliseconds: 1_000, recordUsage: usage => { receipts.push(usage); } });
    const thrownAway = inActionExecution(execution, () => model.decide(modelInput(), controller.signal));
    setTimeout(() => controller.abort(new Error('FCA_URGENT_INTERRUPT')), 5);
    await expect(thrownAway).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: true, cachedInputTokens: 44_000, cacheCreationInputTokens: 900, outputTokens: 600 });
    expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0.03);
    expect(receipts[0]!.estimatedCostUsd).toBeLessThan(0.1);
  });

  it('without a grace the request is cut and booked at the bound of one nobody confirmed (never nothing)', async () => {
    const receipts: AnthropicFcaUsage[] = [];
    const controller = new AbortController();
    const client: AnthropicFcaClient = { messages: { create: (_body, options) => new Promise<Anthropic.Message>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted by the signal')));
    }) } };
    const model = createAnthropicFcaModel({ client, model: 'claude-opus-5-5', recordUsage: usage => { receipts.push(usage); } });
    const thrownAway = model.decide(modelInput(), controller.signal);
    setTimeout(() => controller.abort(new Error('FCA_URGENT_INTERRUPT')), 5);
    await expect(thrownAway).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ usageComplete: false });
    expect(receipts[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });
});

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const at = '2026-10-22T00:00:00.000Z';
const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };

/** One step of the common runner: the first decision hangs (the server answers 400 ms later whatever the client does), a hostile comes at 60 ms. */
async function interruptedStep() {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at, leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを討伐してください', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], signals: AbortSignal[] = [], executed: string[] = [], lines: string[] = [], decided: unknown[] = [];
  let hostile = false, rebuilt = 0, contexts = 0;
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => { contexts += 1; return { revision: 0, observation: null }; },
    async guard() { return true; }, toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false,
    transient: () => hostile ? { urgent: ['wither_skeleton #696 6.1m'], answer: '急ぎの答え方' } : { map: 'whole', landmarks: ['T'] },
    interrupt: () => hostile ? 'wither_skeleton #696 6.1m・見える' : null, rebuilding: () => { rebuilt += 1; }, decided: info => decided.push(info) };
  const progress: FcaProgressHooks = { context: () => ({ conditions: [], verification: null, failures: [], replans: [] }), observed() {},
    async verifyCompletion(_call, permit) { await permit(); return { status: 'not_verified', bindingId: 'goal', checks: [], suggestedChecks: [] }; } };
  const model: FcaModel = {
    async decide(input, signal) {
      inputs.push(input);
      signals.push(signal);
      const marker = inputs.length === 1 ? 'A' : 'B', id = `toolu_${marker}`;
      if (marker === 'A') await sleep(400);
      return { decision: { kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: { marker } }] },
        history: [{ role: 'assistant', content: [{ type: 'tool_use', id, name: 'mc_act', input: { marker } }] }] };
    },
    toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; },
  };
  const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: 'r8-urgent', kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
  const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
  const tools = combineFcaTools({ definitions: [ACT], async execute(call) { executed.push((call.input as { marker: string }).marker); return { ok: true, text: '済', retryable: true }; } });
  // The mode's shape (`llmcStepParts`): a transient task with a fixed menu, so that the request carries the body's live state.
  const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true, model,
    tools: { ...tools, progress }, obsMode: 'transient', selector: LLMC_CATALOG_SELECTOR, history: { codec: anthropicFcaHistoryCodec } };
  setTimeout(() => { hostile = true; }, 60);
  const logged = console.info;
  console.info = (line: string) => { lines.push(String(line)); };
  try { await runFcaStep(step, ports, new AbortController().signal); } finally { console.info = logged; }
  const metrics = () => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);
  return { inputs, signals, executed, decided, metrics, rebuilt: () => rebuilt, contexts: () => contexts, history: () => runtime.snapshot('owner', task.id)!.history };
}

describe('the common runner: a hostile comes while the decision is awaited (run 32)', () => {
  it('asks again on the body\'s present state and acts on that answer only: the thrown-away answer, 340 ms later, changes nothing', async () => {
    const run = await interruptedStep();
    expect(run.inputs).toHaveLength(2);
    expect(run.signals[0]!.aborted).toBe(true);
    expect(run.signals[1]!.aborted).toBe(false);
    expect(run.inputs[0]!.transient).toEqual({ map: 'whole', landmarks: ['T'] });
    expect(run.inputs[1]!.transient).toEqual({ urgent: ['wither_skeleton #696 6.1m'], answer: '急ぎの答え方' });
    expect(run.rebuilt()).toBe(1);
    expect(run.contexts()).toBeGreaterThanOrEqual(2);
    expect(run.executed).toEqual(['B']);
    expect(run.decided).toEqual([expect.objectContaining({ aborted: true })]);
    // The server's answer to the thrown-away request arrives now (400 ms in): nothing is acted on, nothing is stored.
    await sleep(450);
    expect(run.executed).toEqual(['B']);
    expect(JSON.stringify(run.history())).toContain('toolu_B');
    expect(JSON.stringify(run.history())).not.toContain('toolu_A');
  });

  it('the decision\'s line says it was urgent and for how long the thrown-away request had run; its time is not the decision\'s', async () => {
    const run = await interruptedStep();
    const [line] = run.metrics();
    expect(line).toMatchObject({ urgent: true });
    const thrownMs = (line!.interrupt as { thrownMs: number }).thrownMs;
    expect(thrownMs).toBeGreaterThanOrEqual(40);
    expect(thrownMs).toBeLessThan(300);
    // The thrown-away call ends at 400 ms, after the line was written: it does not add to llmMs; the decision asked again took a few ms.
    expect(line!.llmMs as number).toBeLessThan(200);
  });
});
