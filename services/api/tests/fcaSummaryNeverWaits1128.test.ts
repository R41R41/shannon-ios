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
 * 11/28 (end run 18, Ray's request): a history summary never stops a decision. Past the policy it is asked beside the step; past the hard
 * bounds the step replays its history with the oldest rounds left out (logged) instead of waiting; the summary is installed by the next step
 * with every round since it was asked kept after it; a summary that failed is asked again later; one is never asked twice at once.
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

function fixture(options: { summaryMs: number; fail?: () => boolean }) {
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
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }) };
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
        summarizer: { async summarize() { summaries += 1; await sleep(options.summaryMs);
          if (options.fail?.()) throw new Error('FCA_SUMMARY_INVALID');
          return TEMPLATE; } },
        ahead: { port, hard: { maximumConversationTokens: 3_000, maximumRounds: 1_000 } } },
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

const notesOf = (lines: readonly string[]) => metrics(lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []);
const tokensOf = (input: FcaModelInput) => anthropicFcaHistoryCodec.tokens!(input.history);
const text = (input: FcaModelInput) => JSON.stringify(input.history);
const HARD_TOKENS = 3_000;

describe('a history summary never stops a decision (end run 18: 339 s of 1,400 s)', () => {
  const rounds = 40;
  it('with a slow summary, no step waits for it, even past the hard bounds, and only one summary is asked at a time', async () => {
    const f = fixture({ summaryMs: 600 });
    let slowest = 0;
    for (let index = 0; index < rounds; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeLessThan(200);
    expect(notesOf(f.lines)).toContain('dropped');
    // Rounds that passed the hard bounds while it was pending left their oldest rounds out, counted and logged content-free.
    expect(f.lines.some(line => /^Shannon FCA history summary dropped task=[^ ]+ summary=pending omittedRounds=[0-9]+ clipped=[0-9]+$/u.test(line))).toBe(true);
    // The 40 rounds run in well under one summary's 600 ms plus the steps: at most the first was asked, then asked again after it was installed.
    expect(f.summaries()).toBeLessThanOrEqual(2);
  });

  it('keeps every replay within the hard bound of the conversation while it drops', async () => {
    const f = fixture({ summaryMs: 600 });
    for (let index = 0; index < rounds; index++) await f.run();
    expect(f.lines.some(line => line.includes('history summary dropped'))).toBe(true);
    for (const input of f.inputs) expect(tokensOf(input)).toBeLessThanOrEqual(HARD_TOKENS);
  });

  it('keeps the newest rounds when it drops the oldest', async () => {
    const f = fixture({ summaryMs: 600 });
    for (let index = 0; index < rounds; index++) await f.run();
    const dropping = f.lines.findIndex(line => line.includes('history summary dropped'));
    expect(dropping).toBeGreaterThanOrEqual(0);
    const last = f.inputs.at(-1)!;
    expect(text(last)).toContain(`decision ${f.inputs.length - 2} `);
    expect(text(last)).not.toContain('decision 0 ');
  });

  it('uses the summary from the next step when it is ready, with the rounds made meanwhile kept after it', async () => {
    const f = fixture({ summaryMs: 150 });
    let installedAt = -1;
    for (let index = 0; index < rounds && installedAt < 0; index++) {
      await f.run();
      if (notesOf(f.lines).includes('installed')) installedAt = index;
      else await sleep(40);
    }
    expect(installedAt).toBeGreaterThan(0);
    expect(f.summary()).not.toBeNull();
    const first = f.inputs.at(-1)!;
    // The bootstrap holds the summary and the rounds since it was asked; the one just before this step is in it.
    expect(text(first)).toContain('fca_public_history');
    expect(text(first)).toContain(`decision ${f.inputs.length - 2} `);
  });

  it('goes on when a summary fails, and asks again a few rounds later', async () => {
    let failing = true;
    const f = fixture({ summaryMs: 20, fail: () => failing });
    let slowest = 0;
    for (let index = 0; index < 30; index++) { slowest = Math.max(slowest, await f.run()); await sleep(25); }
    expect(slowest).toBeLessThan(200);
    const failedCalls = f.summaries();
    expect(failedCalls).toBeGreaterThanOrEqual(2);
    expect(failedCalls).toBeLessThan(30 / 2);
    failing = false;
    for (let index = 0; index < 12 && f.summary() === null; index++) { await f.run(); await sleep(25); }
    expect(f.summary()).not.toBeNull();
  });
});
