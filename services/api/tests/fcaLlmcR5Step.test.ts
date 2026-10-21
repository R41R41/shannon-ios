import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaBodyLifecycle, FcaModel, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaProgressHooks } from '../src/mind/action/fca/fcaProgressPorts.js';
import { createFcaLookahead } from '../src/mind/action/fca/fcaLookahead.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';

/**
 * mb-llmc r5 in the common runner (production run 28, 2026-10-22, owner 「止めて直す」): a completion turned back is a mistake told in one line
 * and no step toward the stop unless they come in a row; no decision asked ahead after a failed act or a surprise, and one thrown away is
 * written down; the history's summary made beside the steps when the replay passes its policy by its characters.
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-22T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const RECEIPT = (kind: string) => JSON.stringify({ received: true, requestedDecision: kind });

interface Options {
  script?: Array<'tools' | 'complete'>; mistake?: boolean; troubled?: () => boolean; surprised?: () => boolean;
  lookahead?: ReturnType<typeof createFcaLookahead>; act?: () => Promise<{ ok: boolean; text: string }>;
  history?: { policy: Partial<FcaHistoryPolicy>; hard: Partial<FcaHistoryPolicy>; summaryMs: number };
}
function fixture(options: Options) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを討伐してください', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [];
  let summaries = 0;
  const port = createFcaHistoryAhead();
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }),
    ...(options.troubled ? { troubled: options.troubled } : {}),
    ...(options.surprised ? { investigate: async () => options.surprised!() ? { surprises: ['repeat'], probes: 0, answered: 0, ms: 1 } : null } : {}) };
  const progress: FcaProgressHooks = { context: () => ({ conditions: [], verification: null, failures: [], replans: [] }), observed() {},
    async verifyCompletion(_call, permit) { await permit(); return { status: 'not_verified', bindingId: 'goal', checks: [], suggestedChecks: [] }; } };
  const model: FcaModel = {
    async decide(input) {
      const index = inputs.length;
      inputs.push(input);
      const kind = options.script?.[index] ?? 'tools', id = `toolu_${index}`;
      const head = { role: 'user', content: `decision ${index} ${'x'.repeat(400)}` };
      if (kind === 'complete') {
        return { decision: { kind: 'complete', summary: 'エンドラ討伐は未達成です。ここで区切ります' },
          history: [head, { role: 'assistant', content: [{ type: 'tool_use', id, name: 'fca_complete', input: { summary: 's' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: RECEIPT('complete') }] }] };
      }
      return { decision: { kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: {} }] },
        history: [head, { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mc_act', input: { hands: [{ do: 'walk' }] } }] }] };
    },
    toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; },
  };
  /** The provider's message of a completion's receipt, with the line in its place (as `amendAnthropicControl` does). */
  const amend = (turn: unknown, text: string) => {
    const message = turn as { role: string; content: Array<Record<string, unknown>> };
    return Array.isArray(message?.content) && message.content[0]?.content === RECEIPT('complete')
      ? { role: 'user', content: [{ ...message.content[0], content: text, is_error: true }] } : null;
  };
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `r5-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision);
    if (!step) return -1;
    const tools = combineFcaTools({ definitions: [ACT], async execute() {
      const result = options.act ? await options.act() : { ok: true, text: `act 全部済み ${'cobblestone'.repeat(40)}` };
      return { ...result, retryable: true };
    } });
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true, model,
      tools: { ...tools, progress },
      ...(options.mistake ? { completionMistake: { line: (n: number) => `完了の誤り（続けて ${n} 回目）`, amend } } : {}),
      ...(options.lookahead ? { lookahead: options.lookahead } : {}),
      ...(options.history ? { history: { codec: anthropicFcaHistoryCodec, policy: options.history.policy,
        summarizer: { async summarize() { summaries += 1; await sleep(options.history!.summaryMs);
          return Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木を集めた`]])); } },
        ahead: { port, hard: options.history.hard } } } : {}) };
    const logged = console.info, said = console.log, warned = console.warn;
    console.info = (line: string) => { lines.push(String(line)); };
    console.log = (line: string) => { lines.push(String(line)); };
    console.warn = (line: string) => { lines.push(String(line)); };
    const began = performance.now();
    try { await runFcaStep(step, ports, new AbortController().signal); }
    finally { console.info = logged; console.log = said; console.warn = warned; }
    const ms = performance.now() - began;
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
    return ms;
  };
  return { run, inputs, lines, phase: () => runtime.get('owner', task.id)?.phase, summaries: () => summaries };
}

describe('a completion turned back (run 28: the fifth of the task stopped it, 263 s early)', () => {
  it('is no step toward the stop while a step of tools comes between; five in a row still stop the task', async () => {
    const f = fixture({ mistake: true, script: ['complete', 'complete', 'tools', 'complete', 'complete', 'tools', 'complete', 'complete', 'complete',
      'complete', 'complete'] });
    for (let index = 0; index < 10; index++) {
      await f.run();
      expect(f.phase()).toBe('ready');
    }
    await f.run();
    expect(f.phase()).toBe('stopped');
  });

  it('is told to the model in one line in place of its receipt, with how many in a row', async () => {
    const f = fixture({ mistake: true, script: ['complete', 'complete', 'tools'] });
    await f.run(); await f.run(); await f.run();
    const last = (input: FcaModelInput) => JSON.stringify(input.history.at(-1));
    expect(last(f.inputs[1]!)).toContain('完了の誤り（続けて 1 回目）');
    expect(last(f.inputs[1]!)).not.toContain('received');
    expect(last(f.inputs[2]!)).toContain('完了の誤り（続けて 2 回目）');
  });

  it('without the port (another task): every turned-back completion counts, from the start, as before', async () => {
    const f = fixture({ script: ['complete', 'complete', 'tools', 'complete', 'complete', 'tools', 'complete'] });
    for (let index = 0; index < 6; index++) await f.run();
    expect(f.phase()).toBe('ready');
    await f.run();
    expect(f.phase()).toBe('stopped');
    expect(JSON.stringify(f.inputs[1]!.history.at(-1))).toContain('received');
  });
});

describe('the lookahead (run 28: about 0.5 a decision, 12 taken, 22% thrown away after a failed act)', () => {
  it('is not asked after a failed act or after a surprise', async () => {
    const wanted: string[] = [];
    const base = createFcaLookahead({ wanted: () => true, delayMs: 0 });
    const lookahead = { ...base, wanted: (call: never, taskId: string) => { wanted.push(taskId); return base.wanted(call, taskId); } };
    let troubled = true, surprised = false;
    const f = fixture({ lookahead, troubled: () => troubled, surprised: () => surprised });
    await f.run();
    expect(wanted).toHaveLength(0);
    troubled = false; surprised = true;
    await f.run();
    expect(wanted).toHaveLength(0);
    surprised = false;
    await f.run();
    expect(wanted).toHaveLength(1);
  });

  it('one asked and thrown away because its act failed is written down as wasted', async () => {
    const lookahead = createFcaLookahead({ wanted: () => true, delayMs: 0, log: line => console.info(line) });
    const f = fixture({ lookahead, act: async () => { await sleep(60); return { ok: false, text: 'act 0/1 済みで止まった（failure: 一歩ではない）' }; } });
    await f.run();
    expect(f.lines).toContain(`Shannon FCA lookahead wasted task=${f.inputs[0]!.task.id} reason=failed`);
  });
});

describe('the summary beside the steps when the replay passes its policy by its characters (run 28: five summaries in their steps, 81 s)', () => {
  it('the step that passes the policy asks it beside itself and does not wait: the hard bound gives the characters room too', async () => {
    const f = fixture({ history: { policy: { maximumRounds: 100, recentRounds: 1, maximumNativeCharacters: 6_000, maximumConversationTokens: 100_000,
      compactedConversationTokens: 1_000 }, hard: { maximumConversationTokens: 100_000 }, summaryMs: 300 } });
    const metrics = () => f.lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);
    const started = () => metrics().some(line => (line.summaryAhead as string[] | undefined)?.includes('started'));
    const times: number[] = [];
    for (let index = 0; index < 16 && f.summaries() === 0; index++) times.push(await f.run());
    expect(f.summaries()).toBe(1);
    expect(started()).toBe(true);
    expect(Math.max(...times)).toBeLessThan(250);
  });
});
