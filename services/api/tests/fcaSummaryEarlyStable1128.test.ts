import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { createFcaHistoryAhead, prepareFcaHistory } from '../src/mind/action/fca/fcaHistory.js';
import { continuesFcaEpoch, pinFcaCoreTools, withCoreAnchor } from '../src/mind/action/fca/fcaCoreTools.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { FcaBodyLifecycle, FcaBodyQueue, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';

/**
 * 11/28 (end run 18 replay, plan G2: no waiting, the largest input no larger than the policy's, few changes of the first message): everything about
 * the history is decided at the start of a step. The summary is asked there once the policy is passed, installed there when ready, and the replay is
 * cut there to a floor (the hard bound less the largest growth of a recent step) when the step would end past the bound; a floor keeps its first
 * message until the summary is installed. Nothing between the decisions of a stretch asks, installs or cuts, so a stretch never changes the first
 * message of its replay. No path waits for a model: a stale core's new epoch begins with a floor, and a floor that cannot fit falls back to the public
 * epoch.
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

function fixture(options: { summaryMs: number; fail?: () => boolean; hard?: Partial<FcaHistoryPolicy>; filler?: (decision: number) => number; transient?: boolean }) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
    leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], lines: string[] = [];
  let summaries = 0, wakes = 0, refusing = 0, refused = 0;
  const originalCommit = runtime.commitCompaction.bind(runtime);
  runtime.commitCompaction = ((...args: Parameters<typeof originalCommit>) => {
    if (refusing > 0) { refusing -= 1; refused += 1; return false; }
    return originalCommit(...args);
  }) as typeof runtime.commitCompaction;
  const summarizer = { async summarize() { summaries += 1; if (Number.isFinite(options.summaryMs)) await sleep(options.summaryMs); else await new Promise<never>(() => undefined);
    if (options.fail?.()) throw new Error('FCA_SUMMARY_INVALID');
    return TEMPLATE; } };
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
        summarizer,
        ahead: { port, hard: options.hard ?? HARD } },
      ...(options.transient ? { obsMode: 'transient' as const, selector: { async select(request: { tools: readonly { name: string }[] }) { return { names: request.tools.map(tool => tool.name), source: 'jev' as const }; } } } : {}),
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
  /** `prepareFcaHistory` alone, `times` times in one step, as the runner calls it with a stale core (`forceEpoch`). */
  const prepare = async (forceEpoch: () => boolean, times = 1) => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `p-${inputs.length}-${Math.random()}`, kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const said = console.log, replays: Awaited<ReturnType<typeof prepareFcaHistory>>[] = [];
    console.log = (line: string) => { lines.push(String(line)); };
    const began = performance.now();
    try {
      for (let time = 0; time < times; time++) replays.push(await prepareFcaHistory(step, { runtime, codec: anthropicFcaHistoryCodec, summarizer, permit: async () => true, sourcesVisible: () => true },
        new AbortController().signal, POLICY, { forceEpoch, ahead: { port, hard: options.hard ?? HARD, detach: work => work(new AbortController().signal) }, patient: true }));
    } finally { console.log = said; }
    return { replays, ms: performance.now() - began };
  };
  return { runtime, task, inputs, lines, run, prepare, summaries: () => summaries, aheadState: () => port.get(task.id)?.state, refuseCommits: (count: number) => { refusing = count; }, refusedCommits: () => refused, summary: () => runtime.history('owner', task.id)?.summary ?? null };
}
const metrics = (lines: readonly string[]) => lines.filter(line => line.startsWith('{"event":"fca_decision_metrics"')).map(line => JSON.parse(line) as Record<string, unknown>);
const notesOf = (lines: readonly string[]) => metrics(lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []);
const tokensOf = (input: FcaModelInput) => anthropicFcaHistoryCodec.tokens!(input.history);
const firstOf = (input: FcaModelInput) => JSON.stringify(input.history[0]);
/** How many times consecutive decisions' replays start with another message, from the first on. */
const epochBreaks = (inputs: readonly FcaModelInput[]) => inputs.slice(1).filter((input, index) => input.history.length > 0 && inputs[index]!.history.length > 0
  && firstOf(input) !== firstOf(inputs[index]!)).length;

describe('the summary is asked only at the start of a step, once the policy is passed', () => {
  it('asks at the first step whose stored history is past the policy, and never before', async () => {
    const f = fixture({ summaryMs: 600 });
    let asked = -1;
    for (let index = 0; index < 40 && asked < 0; index++) {
      await f.run();
      if (f.summaries() > 0) asked = index;
    }
    expect(asked).toBeGreaterThan(0);
    // The ask came with the step that started past the conversation bound of the policy (2,000 tokens), not a few decisions ahead of it.
    expect(tokensOf(f.inputs[asked]!)).toBeGreaterThan(POLICY.maximumConversationTokens!);
    expect(tokensOf(f.inputs[asked - 1]!)).toBeLessThanOrEqual(tokensOf(f.inputs[asked]!));
  });

  it('asks nothing in the middle of a stretch, however far it grows past the policy; the next step asks', async () => {
    const f = fixture({ summaryMs: 600, filler: decision => decision >= 3 ? 120 : 0 });
    for (let index = 0; index < 3; index++) await f.run();
    expect(f.summaries()).toBe(0);
    await f.run(6);
    expect(f.summaries()).toBe(0);
    expect(notesOf(f.lines)).not.toContain('started');
    await f.run();
    expect(f.summaries()).toBe(1);
    expect(notesOf(f.lines).filter(note => note === 'started')).toHaveLength(1);
  });

  it('never asks a second summary while one is pending (a summary that does not come back is asked once)', async () => {
    const f = fixture({ summaryMs: Infinity });
    for (let index = 0; index < 60; index++) await f.run(index % 3);
    expect(f.summaries()).toBe(1);
  });
});

describe('nothing changes in the middle of a stretch', () => {
  /** Only the whole replay's tokens are bounded (the price step), here at 4,000; five rounds of 540 tokens are stored, and decision 8 adds 660 at once. */
  const STRETCH_HARD = { maximumConversationTokens: 100_000, maximumReplayTokens: 4_000, maximumRounds: 1_000 };
  const jump = (decision: number) => decision < 5 ? 150 : decision === 8 ? 300 : 0;

  it('keeps the first message of every decision of a stretch when one decision adds a great deal, and cuts at the next step instead (no waiting)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: STRETCH_HARD, filler: jump });
    for (let index = 0; index < 5; index++) await f.run();
    const before = f.inputs.length, droppedBefore = f.lines.filter(line => /history summary dropped task=/u.test(line)).length;
    const slowest = await f.run(6);
    const stretch = f.inputs.slice(before);
    expect(stretch.length).toBeGreaterThanOrEqual(6);
    expect(slowest).toBeLessThan(1_000);
    expect(new Set(stretch.map(firstOf)).size).toBe(1);
    // The decision that added 660 tokens passed the bound inside the stretch (allowed: nothing is cut between decisions) and was sent whole.
    expect(Math.max(...stretch.map(tokensOf))).toBeGreaterThan(4_000);
    expect(f.lines.filter(line => /history summary dropped task=/u.test(line)).length).toBe(droppedBefore);
    expect(JSON.stringify(stretch.at(-1)!.history)).toContain('decision 8 ');
    // The next step starts by cutting: a new first message, within the bound, the step's own rounds kept after it.
    await f.run();
    const next = f.inputs.at(-1)!;
    expect(firstOf(next)).not.toBe(firstOf(stretch[0]!));
    expect(tokensOf(next)).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(next.history)).toContain('decision 8 ');
    expect(f.lines.filter(line => /history summary dropped task=/u.test(line)).length).toBe(droppedBefore + 1);
  });

  it('installs a ready summary at the start of the next step, not between the decisions of a stretch', async () => {
    const f = fixture({ summaryMs: 5, hard: { maximumConversationTokens: 100_000, maximumReplayTokens: 6_000, maximumRounds: 1_000 }, filler: decision => decision >= 8 ? 90 : 0 });
    for (let index = 0; index < 9; index++) await f.run();
    expect(f.summaries()).toBe(0);
    // The summary is asked at the head of the stretch (the stored history is past the policy there) and is ready a few decisions into it.
    const before = f.inputs.length;
    await f.run(10);
    const stretch = f.inputs.slice(before);
    expect(f.summaries()).toBeGreaterThan(0);
    expect(new Set(stretch.map(firstOf)).size).toBe(1);
    expect(f.summary()).toBeNull();
    for (let wait = 0; wait < 200 && f.aheadState() === 'pending'; wait++) await sleep(10);
    await f.run();
    expect(f.summary()).not.toBeNull();
    expect(notesOf(f.lines)).toContain('installed');
    expect(firstOf(f.inputs.at(-1)!)).not.toBe(firstOf(stretch[0]!));
  });

  it('leaves the next step in the epoch the stretch ended in (the anchor is the first message the stretch had)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: STRETCH_HARD, filler: jump });
    for (let index = 0; index < 5; index++) await f.run();
    await f.run(6);
    const last = f.inputs.at(-1)!;
    await f.run();
    const pin = withCoreAnchor(pinFcaCoreTools([]), last.history, []);
    expect(continuesFcaEpoch(pin, f.inputs.at(-1)!.history)).toBe(false);
    const cut = f.inputs.at(-1)!;
    await f.run();
    expect(continuesFcaEpoch(withCoreAnchor(pinFcaCoreTools([]), cut.history, []), f.inputs.at(-1)!.history)).toBe(true);
  });
});

describe('a floor stands until the summary is installed', () => {
  /** Steady growth of about 210 tokens a step with a spike of about 660 on every eighth decision (the stages' knowledge): a bound of 6,000 tokens. */
  const FLOOR_HARD = { maximumConversationTokens: 6_000, maximumRounds: 1_000 };
  const spike = (decision: number) => decision % 8 === 0 ? 300 : 0;
  it('starts every dropped step with the same message until it is cut again (the epoch is not ended every step)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: FLOOR_HARD, filler: spike });
    for (let index = 0; index < 60; index++) await f.run();
    const dropped = f.lines.filter(line => /history summary dropped task=/u.test(line)).length;
    const standing = metrics(f.lines).flatMap(line => (line.summaryAhead as string[] | undefined) ?? []).filter(note => note === 'dropped').length;
    expect(standing).toBeGreaterThan(20);
    expect(dropped).toBeGreaterThanOrEqual(1);
    // Every cut ends the epoch once; between cuts the replay continues it. Without the floor each of the 20 dropped steps was a new epoch.
    expect(dropped).toBeLessThanOrEqual(standing / 2);
    expect(epochBreaks(f.inputs)).toBeLessThanOrEqual(dropped + 1);
    for (const input of f.inputs) expect(tokensOf(input)).toBeLessThanOrEqual(FLOOR_HARD.maximumConversationTokens);
  });

  it('is cut only when the next step would pass the bound, and to what the steps used lately (not to a share of it)', async () => {
    const f = fixture({ summaryMs: Infinity, hard: FLOOR_HARD, filler: spike });
    for (let index = 0; index < 60; index++) await f.run();
    const heads = f.inputs.filter((input, index) => index > 1 && firstOf(input) !== firstOf(f.inputs[index - 1]!));
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // A new floor leaves the headroom (900 tokens here) and the largest growth of a recent step (about 870) below the bound, and is not far under that.
    for (const input of heads) {
      expect(tokensOf(input)).toBeLessThanOrEqual(FLOOR_HARD.maximumConversationTokens - 900 - 800);
      expect(tokensOf(input)).toBeGreaterThan(FLOOR_HARD.maximumConversationTokens * 0.4);
    }
  });

  it('is not a new epoch for the core pin: the anchor of one dropped step is the next step\'s first message', async () => {
    const f = fixture({ summaryMs: Infinity, hard: FLOOR_HARD, filler: spike });
    for (let index = 0; index < 60; index++) await f.run();
    let continued = 0, ended = 0;
    for (let index = 1; index < f.inputs.length; index++) {
      const previous = f.inputs[index - 1]!, input = f.inputs[index]!;
      if (!f.lines.length || !input.history.length || !previous.history.length) continue;
      const pin = withCoreAnchor(pinFcaCoreTools([]), previous.history, []);
      if (continuesFcaEpoch(pin, input.history)) continued += 1; else ended += 1;
    }
    expect(continued).toBeGreaterThan(ended * 2);
  });
});

describe('no path of a step waits for a summary, or loses one', () => {
  it('never waits for a slow summary, even as it cuts', async () => {
    const f = fixture({ summaryMs: Infinity });
    let slowest = 0;
    for (let index = 0; index < 40; index++) slowest = Math.max(slowest, await f.run(index % 3));
    expect(slowest).toBeLessThan(500);
  });

  it('does not wait when a stale core forces a new epoch: it begins with a floor, and the floor stands while the force is asked again', async () => {
    const f = fixture({ summaryMs: Infinity });
    for (let index = 0; index < 2; index++) await f.run();
    const native = firstOf(f.inputs.at(-1)!);
    const first = await f.prepare(() => true, 2);
    expect(first.ms).toBeLessThan(500);
    expect(f.summaries()).toBe(0);
    expect(JSON.stringify(first.replays[0]!.history[0])).toContain('fca_public_history');
    expect(JSON.stringify(first.replays[0]!.history[0])).not.toBe(native);
    // Asked again (the core is still stale), the standing floor is the replay: the same first message, no second cut.
    expect(JSON.stringify(first.replays[1]!.history[0])).toBe(JSON.stringify(first.replays[0]!.history[0]));
    expect(f.lines.filter(line => /history summary dropped task=/u.test(line))).toHaveLength(1);
  });

  it('does not wait when no floor fits (the smallest does not): the public epoch of the fallback is replayed and one summary is asked', async () => {
    const f = fixture({ summaryMs: Infinity, hard: { maximumConversationTokens: 3_000, maximumReplayTokens: 50, maximumRounds: 1_000 } });
    let slowest = 0;
    for (let index = 0; index < 30; index++) slowest = Math.max(slowest, await f.run());
    expect(slowest).toBeLessThan(500);
    expect(f.summaries()).toBe(1);
    expect(f.lines.some(line => /history summary dropped task=/u.test(line))).toBe(true);
  });

  it('keeps a summary whose commit was fenced and installs it at the next step, without asking another', async () => {
    const f = fixture({ summaryMs: 10 });
    f.refuseCommits(1);
    // The summary comes back a few steps after it was asked (a detached call takes its own time); the first install is refused.
    for (let index = 0; index < 300 && f.refusedCommits() === 0; index++) {
      await f.run();
      await sleep(10);
    }
    expect(f.refusedCommits()).toBe(1);
    expect(f.summaries()).toBe(1);
    expect(f.summary()).toBeNull();
    expect(f.aheadState()).toBe('ready');
    await f.run();
    expect(f.summary()).not.toBeNull();
    expect(f.summaries()).toBe(1);
  });
});

describe('the runner keeps the core pin on the first message of the replay', () => {
  it('starts a new pin epoch exactly when the replay\'s first message changed at the start of a step (through the runner, not by hand)', async () => {
    const f = fixture({ summaryMs: 30, transient: true });
    for (let index = 0; index < 60; index++) await f.run(index % 4);
    const pinned = f.lines.filter(line => /"event":"fca_core_tools"/u.test(line) && /"epoch":"new"/u.test(line)).length;
    const changes = epochBreaks(f.inputs);
    expect(f.summaries()).toBeGreaterThan(2);
    expect(changes).toBeGreaterThan(2);
    expect(pinned).toBe(changes + 1);
  });
});
