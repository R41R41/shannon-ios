import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { createFcaHistoryAhead, FCA_SUMMARY_DEFER_MS } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { FcaBodyLifecycle, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';

/**
 * 11/28 (end run 18): a history summary must not begin in the dragon's approach and landing (`FcaBodyLifecycle.deferSummary`): a step past the hard
 * bounds goes on with the whole replay, for at most `FCA_SUMMARY_DEFER_MS`, and the summary is still asked beside it.
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

function fixture(options: { summaryMs: number; defer: () => boolean; clock: () => number }) {
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
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }), deferSummary: options.defer };
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
        ahead: { port, hard: { maximumConversationTokens: 3_000, maximumRounds: 1_000 }, clock: options.clock } },
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

describe('the history summary deferred while the body asks (the dragon phase 2 and 3)', () => {
  const rounds = 16;
  it('without the deferral, a step past the hard bounds waits for the summary', async () => {
    const f = fixture({ summaryMs: 600, defer: () => false, clock: () => 0 });
    let slowest = 0;
    for (let index = 0; index < rounds; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeGreaterThan(250);
  });

  it('with it, no step waits or summarizes in its own step, and the summary is still asked beside', async () => {
    const f = fixture({ summaryMs: 600, defer: () => true, clock: () => 0 });
    let slowest = 0;
    for (let index = 0; index < rounds; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeLessThan(200);
    const notes = metrics(f.lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []);
    expect(notes).toContain('deferred');
    expect(notes).toContain('started');
    expect(f.summaries()).toBe(1);
  });

  it('only for FCA_SUMMARY_DEFER_MS: after it the step waits for the summary as before', async () => {
    let now = 0;
    const f = fixture({ summaryMs: 600, defer: () => true, clock: () => now });
    for (let index = 0; index < rounds; index++) await f.run();
    now = FCA_SUMMARY_DEFER_MS + 1;
    let slowest = 0;
    for (let index = 0; index < 4; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeGreaterThan(250);
  });

  it('the limit is counted again for the next approach (the body stops asking, then asks again)', async () => {
    let now = 0, asking = true;
    const f = fixture({ summaryMs: 600, defer: () => asking, clock: () => now });
    await f.run();
    now = FCA_SUMMARY_DEFER_MS + 1;
    asking = false;
    await f.run();
    asking = true;
    let slowest = 0;
    for (let index = 0; index < rounds; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeLessThan(200);
  });
});

describe('the bed burst texts keep to the facts of run 18 (11/28)', () => {
  it('say the stand is not the waiting cell, and give phase 2 as the sampled 14 to 49 seconds, not 13 to 21', async () => {
    const { BED_BURST_DESCRIPTION } = await import('../src/contracts/minecraftBedBurstContract.js');
    const { PROBE_DESCRIPTION } = await import('../src/contracts/minecraftProbeContract.js');
    expect(BED_BURST_DESCRIPTION).toContain('待つ場所（止まり木から10〜14m）と起爆に立つ場所（stand）は別');
    expect(BED_BURST_DESCRIPTION).toContain('14〜49秒');
    expect(BED_BURST_DESCRIPTION).not.toContain('13〜21');
    expect(PROBE_DESCRIPTION).not.toContain('no_layout_within_twelve');
    expect(BED_BURST_DESCRIPTION).not.toContain('新しく読めない');
  });
});
