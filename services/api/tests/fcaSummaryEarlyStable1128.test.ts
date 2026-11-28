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
import { continuesFcaEpoch, pinFcaCoreTools, withCoreAnchor } from '../src/mind/action/fca/fcaCoreTools.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { FcaBodyLifecycle, FcaBodyQueue, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';

/**
 * 11/28 (end run 18 replay: the largest input 132,376 to about 160,000 tokens with no waiting, and a dropped replay's first message changing with
 * every round): the summary is asked early (a few decisions before the policy, counting what the step has added), the replay of a stretch is held
 * to the hard bounds between its decisions, and a replay that is cut keeps its first message (a floor) until the summary is installed, so that a
 * dropped step continues the epoch instead of ending it. None of it waits for a model.
 */
const databases: DatabaseSync[] = [];
const at = '2026-10-22T00:00:00.000Z';
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const TEMPLATE = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木を集めた`]]));
const POLICY: Partial<FcaHistoryPolicy> = { maximumRounds: 100, recentRounds: 1, maximumConversationTokens: 2_000, compactedConversationTokens: 200 };
const HARD = { maximumConversationTokens: 3_000, maximumRounds: 1_000 };
const HARD_TOKENS = 3_000;

/** A queue that asks for `wakes` more decisions in each step, then runs dry. */
function queueOf() {
  const open = new Set<string>();
  let left = 0, version = 0, counter = 0;
  const queue: FcaBodyQueue = {
    openIds: () => new Set(open), open: () => open.size > 0, version: () => version, noteDecision: () => undefined, dropWaiting: () => 0,
    cancelAll: () => { open.clear(); }, closeStep: () => undefined, closing: () => false, take: () => [],
    async ready({ drain }) {
      if (drain || left <= 0) { open.clear(); return 'empty'; }
      left -= 1;
      await sleep(1);
      return 'remaining';
    },
  };
  return { queue, begin: (wakes: number) => { left = wakes; }, put: () => { counter += 1; open.add(`q${counter}`); version += 1; } };
}

function fixture(options: { summaryMs: number; fail?: () => boolean; hard?: Partial<FcaHistoryPolicy>; filler?: (decision: number) => number }) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [];
  let summaries = 0, wakes = 0;
  const port = createFcaHistoryAhead(), items = queueOf();
  const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }),
    get queue() { return wakes > 0 ? items.queue : undefined; } } as FcaBodyLifecycle;
  const run = async (stretch = 0) => {
    wakes = stretch;
    items.begin(stretch);
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `e-${inputs.length}-${Math.random()}`, kind: 'agentTask',
      origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true,
      bodyRecall: { async packet() { return { packet: { contextVersion: 'v', observedAt: at, status: 'no_match', items: [], sourceIds: [] },
          measure: { poolMs: null, pool: 0, groups: 0, shown: 0, chars: 0, tags: [], jev: null } }; }, cancel() {} },
      history: { codec: anthropicFcaHistoryCodec, policy: POLICY,
        summarizer: { async summarize() { summaries += 1; if (Number.isFinite(options.summaryMs)) await sleep(options.summaryMs); else await new Promise<never>(() => undefined);
          if (options.fail?.()) throw new Error('FCA_SUMMARY_INVALID');
          return TEMPLATE; } },
        ahead: { port, hard: options.hard ?? HARD } },
      model: { async decide(input) {
        const index = inputs.length;
        inputs.push(input);
        const id = `toolu_${index}`;
        return { decision: { kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: {} }] },
          history: [{ role: 'user', content: `decision ${index} ${'状態'.repeat(20)}${'知識'.repeat(options.filler?.(index) ?? 0)}` },
            { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mc_act', input: { hands: [{ do: 'walk' }] } }] }] };
      },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      tools: combineFcaTools({ definitions: [ACT], async execute() { if (wakes > 0) items.put();
        return toolOk(`act 全部済み ${'丸石'.repeat(20)}`); } }) };
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
  return { runtime, task, inputs, lines, run, summaries: () => summaries, summary: () => runtime.history('owner', task.id)?.summary ?? null };
}
const metrics = (lines: readonly string[]) => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);
const notesOf = (lines: readonly string[]) => metrics(lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []);
const tokensOf = (input: FcaModelInput) => anthropicFcaHistoryCodec.tokens!(input.history);
const firstOf = (input: FcaModelInput) => JSON.stringify(input.history[0]);
/** How many times consecutive decisions' replays start with another message, from the first on. */
const epochBreaks = (inputs: readonly FcaModelInput[]) => inputs.slice(1).filter((input, index) => input.history.length > 0 && inputs[index]!.history.length > 0
  && firstOf(input) !== firstOf(inputs[index]!)).length;

describe('the summary is asked before the policy is passed', () => {
  it('asks while the replay is still within the policy, a few decisions ahead', async () => {
    const f = fixture({ summaryMs: 600 });
    let asked = -1;
    for (let index = 0; index < 40 && asked < 0; index++) {
      await f.run();
      if (f.summaries() > 0) asked = index;
    }
    expect(asked).toBeGreaterThan(0);
    // The step that asked replayed a history still within the policy's conversation bound (2,000 tokens): asked early, not once it was past.
    expect(tokensOf(f.inputs[asked]!)).toBeLessThanOrEqual(POLICY.maximumConversationTokens!);
  });

  it('counts what a stretch has added: a stored history far below the policy still asks, once the step has grown past it', async () => {
    const f = fixture({ summaryMs: 600, filler: decision => decision >= 3 ? 120 : 0 });
    for (let index = 0; index < 3; index++) await f.run();
    expect(f.summaries()).toBe(0);
    await f.run(6);
    expect(f.summaries()).toBe(1);
    expect(notesOf(f.lines)).toContain('started');
  });
});

describe('a stretch is held to the hard bounds between its decisions', () => {
  /** Only the whole replay's tokens are bounded (the price step), here at 4,000; five rounds of 540 tokens are stored, and decision 8 adds 660 at once. */
  const STRETCH_HARD = { maximumConversationTokens: 100_000, maximumReplayTokens: 4_000, maximumRounds: 1_000 };
  const jump = (decision: number) => decision < 5 ? 150 : decision === 8 ? 300 : 0;
  it('keeps every input within the hard bound when one decision adds a great deal, with a summary still pending (no waiting)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: STRETCH_HARD, filler: jump });
    for (let index = 0; index < 5; index++) await f.run();
    const before = f.inputs.length;
    const slowest = await f.run(6);
    expect(f.inputs.length - before).toBeGreaterThanOrEqual(6);
    expect(slowest).toBeLessThan(1_000);
    for (const input of f.inputs) expect(tokensOf(input)).toBeLessThanOrEqual(4_000);
    expect(f.lines.some(line => /^Shannon FCA history summary dropped task=/u.test(line))).toBe(true);
    // The step's own rounds stay whole after the cut.
    expect(JSON.stringify(f.inputs.at(-1)!.history)).toContain('decision 8 ');
  });

  it('installs a ready summary in the middle of a stretch once the conversation is past its policy', async () => {
    const f = fixture({ summaryMs: 20, hard: { maximumConversationTokens: 100_000, maximumReplayTokens: 6_000, maximumRounds: 1_000 }, filler: decision => decision >= 8 ? 90 : 0 });
    for (let index = 0; index < 8; index++) await f.run();
    const before = f.inputs.length;
    await f.run(10);
    expect(f.summary()).not.toBeNull();
    expect(notesOf(f.lines)).toContain('installed');
    // The replay got smaller in the middle of the step: some decision of it is shorter than the one before it.
    const mid = f.inputs.slice(before);
    expect(mid.some((input, index) => index > 0 && tokensOf(input) < tokensOf(mid[index - 1]!))).toBe(true);
    for (const input of f.inputs) expect(tokensOf(input)).toBeLessThanOrEqual(6_000);
  });

  it('leaves the next step in the epoch the stretch ended in (the anchor follows the cut)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: STRETCH_HARD, filler: jump });
    for (let index = 0; index < 5; index++) await f.run();
    const before = f.inputs.length;
    await f.run(6);
    const last = f.inputs.at(-1)!;
    expect(firstOf(last)).not.toBe(firstOf(f.inputs[before - 1]!));
    await f.run();
    const next = f.inputs.at(-1)!;
    const pin = withCoreAnchor(pinFcaCoreTools([]), last.history, []);
    expect(continuesFcaEpoch(pin, next.history)).toBe(true);
  });
});

describe('a dropped replay keeps its first message', () => {
  it('starts every dropped step with the same message until it is cut again (the epoch is not ended every step)', async () => {
    const f = fixture({ summaryMs: Infinity });
    for (let index = 0; index < 60; index++) await f.run();
    const dropped = f.lines.filter(line => /history summary dropped task=/u.test(line)).length;
    const standing = metrics(f.lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []).filter(note => note === 'dropped').length;
    expect(standing).toBeGreaterThan(20);
    expect(dropped).toBeGreaterThanOrEqual(1);
    // Every cut ends the epoch once; between cuts the replay continues it. Without the floor each of the 20 dropped steps was a new epoch.
    expect(dropped).toBeLessThanOrEqual(standing / 4);
    expect(epochBreaks(f.inputs)).toBeLessThanOrEqual(dropped + 1);
    for (const input of f.inputs) expect(tokensOf(input)).toBeLessThanOrEqual(HARD_TOKENS);
  });

  it('is not a new epoch for the core pin: the anchor of one dropped step is the next step\'s first message', async () => {
    const f = fixture({ summaryMs: Infinity });
    for (let index = 0; index < 60; index++) await f.run();
    let continued = 0, ended = 0;
    for (let index = 1; index < f.inputs.length; index++) {
      const previous = f.inputs[index - 1]!, input = f.inputs[index]!;
      if (!f.lines.length || !input.history.length || !previous.history.length) continue;
      const pin = withCoreAnchor(pinFcaCoreTools([]), previous.history, []);
      if (continuesFcaEpoch(pin, input.history)) continued += 1; else ended += 1;
    }
    expect(continued).toBeGreaterThan(ended * 3);
  });

  it('never waits for a slow summary, even as it cuts', async () => {
    const f = fixture({ summaryMs: Infinity });
    let slowest = 0;
    for (let index = 0; index < 40; index++) slowest = Math.max(slowest, await f.run(index % 3));
    expect(slowest).toBeLessThan(500);
  });
});
