import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { FcaBodyLifecycle, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';

/**
 * mb-llmc r3 in the common runner (production run 27, 2026-10-22): the history's summary made beside the steps instead of in them (eight
 * summaries were waited for, 169 s, up to 36 s), and an urgent step that asks the model at once (no recall, no summary while it fits).
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-22T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const TEMPLATE = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木を集めた`]]));
/** Small bounds so that a few rounds pass them: compaction after about ten rounds, never past the hard bound. */
const POLICY: Partial<FcaHistoryPolicy> = { maximumRounds: 100, recentRounds: 1, maximumConversationTokens: 2_000, compactedConversationTokens: 200 };

function fixture(options: { ahead: boolean; summaryMs: number; urgent?: () => boolean; recallWanted?: boolean }) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [];
  let summaries = 0, recalls = 0;
  const port = createFcaHistoryAhead();
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => options.recallWanted ?? false, transient: () => ({ map: 'm' }),
    ...(options.urgent ? { urgent: options.urgent } : {}) };
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `r3-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const index = inputs.length;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true,
      bodyRecall: { async packet() { recalls += 1;
        return { packet: { contextVersion: 'v', observedAt: at, status: 'no_match', items: [], sourceIds: [] },
          measure: { poolMs: null, pool: 0, groups: 0, shown: 0, chars: 0, tags: [], jev: null } }; }, cancel() {} },
      history: { codec: anthropicFcaHistoryCodec, policy: POLICY,
        summarizer: { async summarize() { summaries += 1; await sleep(options.summaryMs); return TEMPLATE; } },
        ...(options.ahead ? { ahead: { port, hard: { maximumConversationTokens: 100_000 } } } : {}) },
      model: { async decide(input) {
        inputs.push(input);
        const id = `toolu_${index}`;
        return { decision: { kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: {} }] },
          history: [{ role: 'user', content: `decision ${index} ${'状態'.repeat(20)}` },
            { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mc_act', input: { hands: [{ do: 'walk' }] } }] }] };
      },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      tools: combineFcaTools({ definitions: [ACT], async execute() { return { ok: true, text: `act 全部済み ${'丸石'.repeat(20)}`, retryable: false }; } }) };
    const logged = console.info, said = console.log;
    console.info = (line: string) => { lines.push(String(line)); };
    console.log = (line: string) => { lines.push(String(line)); };
    const began = performance.now();
    try { await runFcaStep(step, ports, new AbortController().signal); }
    finally { console.info = logged; console.log = said; }
    const ms = performance.now() - began;
    actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
    return ms;
  };
  return { runtime, task, inputs, lines, run, summaries: () => summaries, recalls: () => recalls,
    summary: () => runtime.history('owner', task.id)?.summary ?? null };
}
const metrics = (lines: readonly string[]) => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);

describe('the history summary made beside the steps (run 27: 8 summaries waited for, 169 s)', () => {
  it('without it, the step that passes the bound waits for the summary', async () => {
    const f = fixture({ ahead: false, summaryMs: 300 });
    const times: number[] = [];
    for (let index = 0; index < 14; index++) times.push(await f.run());
    expect(f.summaries()).toBeGreaterThanOrEqual(1);
    expect(Math.max(...times)).toBeGreaterThan(280);
  });

  it('with it, no step waits: the summary is asked beside one and installed by a later one with no model call of its own', async () => {
    const f = fixture({ ahead: true, summaryMs: 300 });
    const times: number[] = [];
    for (let index = 0; index < 24 && !metrics(f.lines).some(line => (line.summaryAhead as string[] | undefined)?.includes('started')); index++) times.push(await f.run());
    times.push(await f.run());
    expect(Math.max(...times)).toBeLessThan(200);
    expect(f.summaries()).toBe(1);
    expect(f.summary()).toBeNull();
    await sleep(350);
    times.push(await f.run());
    expect(Math.max(...times)).toBeLessThan(200);
    expect(f.summary()).not.toBeNull();
    // The new epoch starts from the bootstrap, which holds the summary and every round since it was asked.
    const first = f.inputs.at(-1)!.history[0] as { role: string; content: string };
    expect(first.role).toBe('user');
    expect(first.content).toContain('fca_public_history');
    expect(metrics(f.lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? [])).toContain('installed');
    expect(metrics(f.lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? [])).toContain('started');
    expect(f.summaries()).toBe(1);
  });
});

describe('an urgent step (run 27: 12.8 s from a creeper at 3.9 m to the next decision, the blast first)', () => {
  it('asks no recall, even after an event, and says it in the metrics line', async () => {
    const f = fixture({ ahead: true, summaryMs: 0, urgent: () => true, recallWanted: true });
    await f.run();
    expect(f.recalls()).toBe(0);
    expect(metrics(f.lines)[0]).toMatchObject({ urgent: true });
  });

  it('a step that is not urgent asks the recall after an event, as before', async () => {
    const f = fixture({ ahead: true, summaryMs: 0, urgent: () => false, recallWanted: true });
    await f.run();
    expect(f.recalls()).toBe(1);
    expect(metrics(f.lines)[0]!.urgent).toBeUndefined();
  });

  it('an urgent step does not wait for a summary even past the hard bound of the conversation, while the whole replay fits', async () => {
    const f = fixture({ ahead: false, summaryMs: 300, urgent: () => true });
    // Without `ahead` the old path summarizes in the step; with it and urgent the conversation may reach the replay's bound.
    const g = fixture({ ahead: true, summaryMs: 300, urgent: () => true });
    let slowest = 0;
    for (let index = 0; index < 14; index++) { await f.run(); slowest = Math.max(slowest, await g.run()); }
    expect(f.summaries()).toBeGreaterThanOrEqual(1);
    expect(slowest).toBeLessThan(200);
  });
});
