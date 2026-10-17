import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { FCA_BODY_HISTORY_POLICY, FCA_HISTORY_POLICY, planFcaHistory, prepareFcaHistory } from '../src/mind/action/fca/fcaHistory.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummaryInput } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { isProvenanceReference } from '../src/infra/sqlite/fcaProvenanceSets.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, observeAsync, withObserverRun, withObserverTask } from '../src/infra/observer/observerContext.js';

const at = '2026-10-09T00:00:00.000Z', closers = new Set<() => void>(), directories: string[] = [];
afterEach(() => { for (const close of closers) close(); closers.clear(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const entries = (index: number) => [
  { role: 'user', content: `public input ${index}` },
  { role: 'assistant', content: [{ type: 'thinking', thinking: `private-${index}`, signature: `signed-${index}` },
    { type: 'tool_use', id: `call-${index}`, name: 'task_list', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: `public result ${index}` }] },
];
// The provider owns validation/projection. This deterministic codec exposes only the public test transcript.
const codec: FcaHistoryCodec = {
  project: round => [{ id: `${round.sequence}:user`, role: 'user', content: `public input ${round.sequence}` },
    { id: `${round.sequence}:call`, role: 'tool_call', content: 'task_list {}', callId: `call-${round.sequence}` },
    { id: `${round.sequence}:result`, role: 'tool_result', content: `public result ${round.sequence}`, callId: `call-${round.sequence}` }],
  bootstrap: text => [{ role: 'user', content: text }],
};
const policy: Partial<FcaHistoryPolicy> = { maximumRounds: 8, recentRounds: 3, maximumSummaryCharacters: 5_000, maximumBatches: 32 };
const summary = { '目的': ['Finish the supplied task'], '途中': ['Keep observed results'], coversFromId: 'forged', coversToId: 'forged' };
function fixture(path = ':memory:', legacy = false, provenanceRefs = false) {
  const h = actionHarness(() => at, path); migrateAgentTasks(h.db); let leaseAllowed = true;
  if (legacy) h.db.exec(`CREATE TABLE fca_task_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),step_id TEXT NOT NULL UNIQUE,entries_json TEXT NOT NULL,committed_at TEXT NOT NULL)`);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at,
    leaseValid(scope, taskId, lease, time) { const action = h.store.check(lease, time); return leaseAllowed && !!action
      && action.scopeKey === scope && action.kind === 'agentTask' && action.sourceId.startsWith(`fca:${taskId}:`); },
    ...(provenanceRefs ? { provenanceRefs: true } : {}) });
  const root = runtime.ensureRoot('owner'), task = runtime.createChild('owner', root.id, { title: 'history', goal: 'history' }, 'history');
  async function begin() {
    const current = runtime.get('owner', task.id)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${task.id}:${current.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    expect(action).not.toBeNull(); const step = runtime.beginStep('owner', task.id, leaseOf(action!)); expect(step).not.toBeNull(); return step!;
  }
  async function finish(step: TaskStep, index: number, history: unknown[] = entries(index)) {
    expect(runtime.commitStep(step, { disposition: 'continue', history })).not.toBeNull();
    await h.actions.finish(step.lease, 'completed', 'fca_segment_committed'); runtime.acknowledgeReceipt('owner', step.id);
  }
  async function append(count: number) { for (let index = 1; index <= count; index++) await finish(await begin(), index); }
  const close = () => { h.close(); closers.delete(close); }; closers.add(close);
  const window = () => runtime.history('owner', task.id)!;
  const ports = (summarize = async (_input: FcaHistorySummaryInput): Promise<unknown> => summary) => ({
    runtime, codec, summarizer: { summarize }, permit: async () => true, sourcesVisible: () => true,
  });
  return { ...h, runtime, root, task, begin, finish, append, close, window, ports, denyLease: () => { leaseAllowed = false; } };
}

describe('exact complete-round FCA history compaction', () => {
  it.each(['working', 'throwing'] as const)('hands back only freshly committed compaction with a %s observer', async mode => {
    const f = fixture(); await f.append(10); const step = await f.begin();
    const original = f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all();
    const events: ObserverDraft[] = []; let summaries = 0;
    const restore = installObserverSink(event => { if (mode === 'throwing') throw new Error('sink failed'); events.push(event); });
    try {
      const prepare = () => withObserverRun({ scopeKey: 'owner', surface: 'fixture' }, () => withObserverTask({ taskId: step.taskId, stepId: step.id }, () =>
        observeAsync('fca', {}, () => prepareFcaHistory(step, f.ports(async () => { summaries++; return summary; }), new AbortController().signal, policy))));
      const replay = await prepare(); expect(await prepare()).toEqual(replay);
      expect(summaries).toBeGreaterThan(0);
      expect(f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all()).toEqual(original);
      if (mode === 'working') {
        const returns = events.filter(event => event.kind === 'handoff' && event.fromNode === 'compact' && event.toNode === 'context');
        expect(returns).toHaveLength(1);
        expect(returns[0]).toMatchObject({ taskId: step.taskId, stepId: step.id, output: { phase: 'history_replay', compactedBatches: summaries } });
        expect(events.find(event => event.spanId === returns[0]!.sourceSpanId && event.kind === 'span.completed')?.output).toEqual({ committed: true });
        expect(JSON.stringify(events)).not.toMatch(/private-|signed-|public input|public result/u);
      } else expect(events).toEqual([]);
    } finally { restore(); }
  });

  it('does not hand back a cancelled compaction as replayable history', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin(), abort = new AbortController();
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    try {
      await expect(withObserverRun({ scopeKey: 'owner', surface: 'fixture' }, () => prepareFcaHistory(step,
        f.ports(async () => { abort.abort(); return summary; }), abort.signal, policy))).rejects.toThrow();
      expect(events.some(event => event.kind === 'handoff' && event.fromNode === 'fca' && event.toNode === 'compact')).toBe(true);
      expect(events.some(event => event.kind === 'handoff' && event.fromNode === 'compact')).toBe(false);
      expect(f.window().summary).toBeNull();
    } finally { restore(); }
  });

  it('covers an exact 100-round prefix in bounded batches and preserves every original signed byte', async () => {
    const f = fixture(); await f.append(100); const step = await f.begin();
    const original = f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all();
    const inputs: FcaHistorySummaryInput[] = [];
    const replay = await prepareFcaHistory(step, f.ports(async input => { inputs.push(structuredClone(input)); return summary; }), new AbortController().signal, policy);
    const stored = f.window();
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every(input => JSON.stringify(input).length <= policy.maximumSummaryCharacters!)).toBe(true);
    expect(inputs.flatMap(input => input.rounds.map(round => round.sequence))).toEqual(Array.from({ length: 97 }, (_, index) => index + 1));
    expect(JSON.stringify(inputs)).not.toMatch(/private-|signed-|"thinking"/u);
    expect(stored.summary).toMatchObject({ fromSequence: 1, throughSequence: 97, resetThroughSequence: 100,
      template: { coversFromId: 'fca-round:1', coversToId: 'fca-round:97' } });
    expect(stored.rounds.map(round => round.sequence)).toEqual([98, 99, 100]);
    expect(replay.history).toEqual([{ role: 'user', content: stored.summary!.bootstrapText }]);
    const bootstrap = JSON.parse(stored.summary!.bootstrapText) as { rounds: Array<{ sequence: number; messages: unknown[] }> };
    expect(bootstrap.rounds.map(round => round.sequence)).toEqual([98, 99, 100]);
    expect(JSON.stringify(bootstrap)).not.toMatch(/private-|signed-|"thinking"/u);
    expect(replay.summaryText.length).toBeLessThanOrEqual(900);
    expect(f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all()).toEqual(original);
    expect(f.runtime.snapshot('owner', f.task.id)!.history).toHaveLength(300);
    expect(f.runtime.history('foreign', f.task.id)).toBeNull();
  });

  it('reuses the identical bootstrap across new native rounds and a database restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fca-history-')); directories.push(directory);
    const path = join(directory, 'tasks.sqlite'), first = fixture(path); await first.append(10);
    const step = await first.begin(), replay = await prepareFcaHistory(step, first.ports(), new AbortController().signal, policy);
    const bootstrap = replay.history[0]; await first.finish(step, 11); first.close();
    const restored = fixture(path), next = await restored.begin();
    const again = await prepareFcaHistory(next, restored.ports(async () => { throw new Error('unexpected summary call'); }), new AbortController().signal, policy);
    expect(again.history).toEqual([bootstrap, ...entries(11)]);
    expect(JSON.stringify(again.history)).toContain('signed-11');
    expect(JSON.stringify(again.history)).not.toContain('signed-10');
    expect(restored.window().summary?.resetThroughSequence).toBe(10);
  });

  it('rejects skipped coverage, partial retained bootstrap, stale revisions, forged sources and empty summaries', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin();
    const planned = planFcaHistory(f.window(), codec, policy); expect(planned.kind).toBe('compact'); if (planned.kind !== 'compact') return;
    const request = { ...planned.request, template: summary };
    expect(f.runtime.commitCompaction(step, { ...request, sequences: request.sequences.filter((_, index) => index !== 1) }, () => true)).toBe(false);
    expect(f.runtime.commitCompaction(step, { ...request, retained: request.retained.slice(1) }, () => true)).toBe(false);
    expect(f.runtime.commitCompaction(step, { ...request, sourceRevision: 'forged' }, () => true)).toBe(false);
    expect(f.runtime.commitCompaction(step, { ...request, tailSequence: request.tailSequence + 1 }, () => true)).toBe(false);
    expect(f.runtime.commitCompaction(step, { ...request, template: {} }, () => true)).toBe(false);
    expect(f.runtime.commitCompaction(step, request, () => true)).toBe(true);
    expect(f.runtime.commitCompaction(step, request, () => true)).toBe(false);
    expect(f.window().summary?.revision).toBe(1);
  });

  it('fences summary installation and replay under lease, stop and fresh forgetting controls', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin();
    const planned = planFcaHistory(f.window(), codec, policy); if (planned.kind !== 'compact') throw new Error('plan');
    expect(f.runtime.commitCompaction(step, { ...planned.request, template: summary }, () => false)).toBe(false);
    expect(f.runtime.commitCompaction({ ...step, lease: { ...step.lease, generation: step.lease.generation + 1 } }, { ...planned.request, template: summary }, () => true)).toBe(false);
    const replay = await prepareFcaHistory(step, f.ports(), new AbortController().signal, policy);
    let visible = false;
    const guarded = { ...f.ports(async () => { throw new Error('should never summarize'); }), sourcesVisible: () => visible };
    await expect(prepareFcaHistory(step, guarded, new AbortController().signal, policy)).rejects.toThrow('FCA_HISTORY_HELD');
    visible = true;
    expect(await prepareFcaHistory(step, guarded, new AbortController().signal, policy)).toEqual(replay);
    f.runtime.stop('owner', f.task.id, 'owner stop');
    await expect(prepareFcaHistory(step, guarded, new AbortController().signal, policy)).rejects.toThrow('FCA_HISTORY_HELD');
    expect(f.window().summary?.revision).toBe(1);
  });

  it('keeps messages arriving during summarization pending for the next segment', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin();
    await prepareFcaHistory(step, f.ports(async () => {
      f.runtime.send('owner', f.root.id, f.task.id, 'arrived during summary', 'late'); return summary;
    }), new AbortController().signal, policy);
    expect(step.messageIds).toEqual([]);
    expect(f.runtime.commitStep(step, { disposition: 'wait', history: entries(11) })?.task.phase).toBe('ready');
    expect(f.runtime.snapshot('owner', f.task.id)?.messages).toMatchObject([{ id: 'late', text: 'arrived during summary' }]);
  });

  it('does not install a result after cancellation, lease expiry or a source becoming withheld', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin(), controller = new AbortController();
    await expect(prepareFcaHistory(step, f.ports(async () => { controller.abort(); return summary; }), controller.signal, policy)).rejects.toThrow();
    expect(f.window().summary).toBeNull();
    let visible = true;
    await expect(prepareFcaHistory(step, { ...f.ports(async () => { visible = false; return summary; }), sourcesVisible: () => visible },
      new AbortController().signal, policy)).rejects.toThrow('FCA_HISTORY_HELD');
    expect(f.window().summary).toBeNull();
    await expect(prepareFcaHistory(step, f.ports(async () => { f.denyLease(); return summary; }), new AbortController().signal, policy))
      .rejects.toThrow('FCA_HISTORY_COMMIT_FENCED');
    expect(f.window().summary).toBeNull();
  });

  it('holds incomplete or individually oversized rounds without truncating their coverage', async () => {
    const f = fixture(); await f.append(10); const window = f.window();
    expect(() => planFcaHistory(window, { ...codec, project: () => null }, policy)).toThrow('FCA_HISTORY_INCOMPLETE_ROUND');
    expect(() => planFcaHistory(window, codec, { ...policy, maximumSummaryCharacters: 1 })).toThrow('FCA_HISTORY_ROUND_LIMIT');
    expect(() => planFcaHistory({ ...window, rounds: window.rounds.slice(-1) }, codec, { ...policy, maximumNativeCharacters: 1 })).toThrow('FCA_HISTORY_RECENT_LIMIT');
    expect(f.window().summary).toBeNull();
  });

  it('keeps fewer recent rounds in the bootstrap when they would pass its share of the budget (owner test 2026-10-13: two research rounds)', async () => {
    const f = fixture(); await f.append(3); const window = f.window();
    const plan = planFcaHistory(window, codec, { ...policy, maximumNativeCharacters: 1 });
    expect(plan.kind).toBe('compact');
    if (plan.kind !== 'compact') return;
    // Three rounds, all recent by the policy, but their bootstrap would pass its share of the budget (a third): only the newest
    // stays whole, and the two older ones are summarized in one call (Minebot lane 2026-10-14, task 788da00a: a summary per step).
    expect(plan.input.rounds.map(round => round.sequence)).toEqual(window.rounds.slice(0, 2).map(round => round.sequence));
    expect(plan.request.retained.map(round => round.sequence)).toEqual([window.rounds[2]!.sequence]);
  });

  it('covers a round longer than the summary input whole, its longest texts shortened for the summary only', async () => {
    const f = fixture(); await f.append(2); const window = f.window();
    const long = '福岡のおすすめ。'.repeat(2_000);
    const wide: FcaHistoryCodec = { ...codec, project: round => codec.project(round)!.map(message => message.role === 'tool_result' ? { ...message, content: long } : message) };
    const plan = planFcaHistory(window, wide, { ...policy, maximumNativeCharacters: 1, maximumSummaryCharacters: 5_000 });
    expect(plan.kind).toBe('compact');
    if (plan.kind !== 'compact') return;
    const [round] = plan.input.rounds;
    expect(plan.input.rounds).toHaveLength(1);
    expect(round!.messages.map(message => message.id)).toEqual([...wide.project(window.rounds[0]!)!.map(message => message.id), `fca-round:${window.rounds[0]!.sequence}:status`]);
    expect(round!.messages.find(message => message.role === 'tool_result')!.content).toMatch(/^福岡のおすすめ。.*要約用に後略/su);
    expect(JSON.stringify(plan.input).length).toBeLessThanOrEqual(5_000);
    // Review of 1a647abc: a cut never splits a surrogate pair, wherever it falls.
    for (const pad of [0, 1]) {
      const emoji: FcaHistoryCodec = { ...codec, project: round => codec.project(round)!.map(message => message.role === 'tool_result'
        ? { ...message, content: `${'a'.repeat(pad)}${'😀'.repeat(3_000)}` } : message) };
      const cut = planFcaHistory(window, emoji, { ...policy, maximumNativeCharacters: 1, maximumSummaryCharacters: 5_000 });
      if (cut.kind !== 'compact') throw new Error('expected a compaction');
      const text = cut.input.rounds[0]!.messages.find(message => message.role === 'tool_result')!.content;
      expect(text, String(pad)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });

  it('measures reproducible tool definitions apart from the history budget, within their own bound (Minebot lane 2026-10-14)', async () => {
    const f = fixture(); await f.append(1); const window = f.window();
    const definitions = { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'mc_x', description: 'd'.repeat(46_000) } } }] };
    const widened = { ...window, rounds: window.rounds.map(round => ({ ...round, entries: [round.entries[0], definitions, ...round.entries.slice(1)] })) };
    const reproducible: FcaHistoryCodec = { ...codec, reproducible: entry => entry === definitions };
    // Counted with the rest, the round is over 20,000 characters; measured apart, it is replayed native and unchanged.
    const plan = planFcaHistory(widened, reproducible, { ...policy, maximumNativeCharacters: 20_000 });
    expect(plan).toMatchObject({ kind: 'ready', replay: { history: widened.rounds[0]!.entries } });
    expect(plan.kind === 'ready' && plan.replay.clippedMessages).toBe(undefined);
    // A codec that does not mark them counts them as before; past their own bound they are compacted like the rest.
    expect(planFcaHistory(widened, codec, { ...policy, maximumNativeCharacters: 20_000 })).toMatchObject({ kind: 'ready', replay: { clippedMessages: 0 } });
    expect(planFcaHistory(widened, reproducible, { ...policy, maximumNativeCharacters: 20_000, maximumToolDefinitionCharacters: 40_000 }))
      .toMatchObject({ kind: 'ready', replay: { clippedMessages: 0 } });
    // Review P3-1: both together have their own bound too.
    expect(planFcaHistory(widened, reproducible, { ...policy, maximumNativeCharacters: 20_000, maximumReplayCharacters: 40_000 }))
      .toMatchObject({ kind: 'ready', replay: { clippedMessages: 0 } });
  });

  it('replays a newest round too long by itself as a clipped public epoch for this step only (Minebot lane 2026-10-14)', async () => {
    const f = fixture(); await f.append(1);
    const original = f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all();
    const long = 'エンドの観測。'.repeat(12_000);
    // The native round as stored carries the long observation in its first user message.
    const widen = (value: ReturnType<typeof f.window>) => ({ ...value, rounds: value.rounds.map(round => ({ ...round,
      entries: [{ role: 'user', content: long }, ...round.entries.slice(1)] })) });
    const window = widen(f.window());
    const wide: FcaHistoryCodec = { ...codec, project: round => codec.project(round)!.map(message => message.role === 'user' ? { ...message, content: long } : message) };
    const plan = planFcaHistory(window, wide, { ...policy, maximumNativeCharacters: 20_000 });
    if (plan.kind !== 'ready') throw new Error('expected a replay');
    expect(plan.replay.clippedMessages).toBe(1);
    expect(plan.replay.history).toHaveLength(1);
    expect(JSON.stringify(plan.replay.history).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(plan.replay.history)).not.toMatch(/private-|signed-/u);
    const epoch = JSON.parse((plan.replay.history[0] as { content: string }).content) as { kind: string; summary: unknown; rounds: Array<{ messages: Array<{ role: string; callId?: string; content: string }> }> };
    expect(epoch).toMatchObject({ kind: 'fca_public_history', summary: null });
    const messages = epoch.rounds[0]!.messages;
    // Every message stays in order with its call id; only the longest text is cut, with a marker.
    expect(messages.map(message => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(messages.filter(message => message.callId).map(message => message.callId)).toEqual(['call-1', 'call-1']);
    expect(messages[0]!.content).toMatch(/^エンドの観測。.*…（長いため後略: \d+字）$/su);
    // Deterministic while the round stays the newest, so the prefix it starts is reused; nothing is stored.
    expect(planFcaHistory(widen(f.window()), wide, { ...policy, maximumNativeCharacters: 20_000 })).toEqual(plan);
    expect(f.window().summary).toBeNull();
    expect(f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all()).toEqual(original);
    // After a summary epoch, the summary stays in front of the clipped round.
    const step = await f.begin(); await f.finish(step, 2); const next = await f.begin();
    await prepareFcaHistory(next, f.ports(), new AbortController().signal, { ...policy, recentRounds: 1, maximumNativeCharacters: 100 }).catch(() => undefined);
    const summarized = f.window();
    expect(summarized.summary?.throughSequence).toBe(1);
    const after = planFcaHistory(widen(summarized), wide, { ...policy, maximumNativeCharacters: 20_000 });
    if (after.kind !== 'ready') throw new Error('expected a replay');
    expect(JSON.parse((after.replay.history[0] as { content: string }).content).summary).toEqual(summarized.summary!.template);
    expect(after.replay.summaryText).not.toBe('');
  });

  it('replays a public epoch for the step when the summary answer is unusable, storing nothing (Minebot lane run 2, 2026-10-14)', async () => {
    const f = fixture(); await f.append(10); const step = await f.begin();
    const original = f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all();
    const invalid = Object.assign(new Error('FCA_SUMMARY_INVALID'), { reason: 'template' });
    let calls = 0;
    const unusable = f.ports(async () => { calls++; throw invalid; });
    const replay = await prepareFcaHistory(step, unusable, new AbortController().signal, policy);
    expect(calls).toBe(1); // one summary call, never a hidden retry
    expect(replay.history).toHaveLength(1);
    expect(JSON.stringify(replay.history)).not.toMatch(/private-|signed-/u);
    const epoch = JSON.parse((replay.history[0] as { content: string }).content) as { kind: string; omittedRounds?: number; rounds: Array<{ messages: Array<{ callId?: string }> }> };
    expect(epoch.kind).toBe('fca_public_history');
    expect(epoch.omittedRounds).toBeUndefined();
    expect(epoch.rounds.flatMap(round => round.messages.flatMap(message => message.callId ? [message.callId] : [])))
      .toEqual(Array.from({ length: 10 }, (_, index) => [`call-${index + 1}`, `call-${index + 1}`]).flat());
    expect(f.window().summary).toBeNull();
    expect(f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all()).toEqual(original);
    // Too long even with every text at its shortest: the oldest rounds are left out, and counted, down to the newest one.
    const narrow = await prepareFcaHistory(step, unusable, new AbortController().signal, { ...policy, maximumNativeCharacters: 1_000 });
    const narrowEpoch = JSON.parse((narrow.history[0] as { content: string }).content) as { omittedRounds: number; rounds: Array<{ sequence: number }> };
    expect(narrowEpoch.omittedRounds).toBeGreaterThan(0);
    expect(narrowEpoch.rounds.at(-1)!.sequence).toBe(f.window().rounds.at(-1)!.sequence);
    expect(narrowEpoch.omittedRounds + narrowEpoch.rounds.length).toBe(10);
    expect(JSON.stringify(narrow.history).length).toBeLessThanOrEqual(1_000);
    // A lost response or an abort is never treated as a known unusable answer.
    await expect(prepareFcaHistory(step, f.ports(async () => { throw new Error('FCA_MODEL_RESPONSE_UNKNOWN'); }), new AbortController().signal, policy))
      .rejects.toThrow('FCA_MODEL_RESPONSE_UNKNOWN');
    const aborted = new AbortController();
    await expect(prepareFcaHistory(step, f.ports(async () => { aborted.abort(); throw invalid; }), aborted.signal, policy)).rejects.toThrow('FCA_SUMMARY_INVALID');
  });

  /** A decision-shaped round: a decision message with a long recall packet (restated each decision), a call and its result. */
  const decisionRound = (index: number) => [
    { role: 'user', content: JSON.stringify({ task: { id: 'task', title: 'history', goal: 'history', completionCriteria: '' }, messages: [],
      recall: { status: 'ready', items: [{ id: `memory-${index}`, summary: '記憶'.repeat(2_500) }] }, body: `観測 ${index} ${'x'.repeat(800)}` }) },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: `signed-${index}` }, { type: 'tool_use', id: `call-${index}`, name: 'task_list', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: `結果 ${index} ${'y'.repeat(200)}` }] },
  ];
  const hysteresis: Partial<FcaHistoryPolicy> = { maximumNativeCharacters: 6_000, recentRounds: 6, maximumRounds: 24, maximumSummaryCharacters: 5_000, maximumBatches: 8 };

  it('measures a decision message without its restated parts, which the whole replay bound still counts', async () => {
    const f = fixture(); const step = await f.begin(); await f.finish(step, 1, decisionRound(1));
    // 5,000 characters of recall alone pass the 6,000-character native budget with the rest of the round: the public part does not.
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, hysteresis)).toMatchObject({ kind: 'ready', replay: { summary: null } });
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, hysteresis)).not.toHaveProperty('replay.clippedMessages');
    expect(planFcaHistory(f.window(), { ...anthropicFcaHistoryCodec, measured: undefined }, hysteresis))
      .toMatchObject({ kind: 'ready', replay: { clippedMessages: expect.any(Number) } });
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, { ...hysteresis, maximumReplayCharacters: 5_000 }))
      .toMatchObject({ kind: 'ready', replay: { clippedMessages: expect.any(Number) } });
  });

  it('compacts a replay whose estimated tokens pass the bound below the price step, though its characters fit', async () => {
    const f = fixture();
    for (let index = 1; index <= 3; index++) { const step = await f.begin(); await f.finish(step, index, decisionRound(index)); }
    const tokens = anthropicFcaHistoryCodec.tokens!(f.window().rounds.flatMap(round => round.entries));
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, { ...hysteresis, maximumReplayTokens: tokens })).toMatchObject({ kind: 'ready' });
    const over = planFcaHistory(f.window(), anthropicFcaHistoryCodec, { ...hysteresis, maximumReplayTokens: tokens - 1 });
    expect(over.kind).toBe('compact');
    // Without an estimate from the codec, characters alone decide, as before.
    expect(planFcaHistory(f.window(), { ...anthropicFcaHistoryCodec, tokens: undefined }, { ...hysteresis, maximumReplayTokens: 1 })).toMatchObject({ kind: 'ready' });
  });

  it('keeps a post-summary bootstrap within a third of the budget, so a summary leaves room for several native rounds', async () => {
    const f = fixture(); const inputs: FcaHistorySummaryInput[] = []; const summarySteps: number[] = [];
    for (let index = 1; index <= 24; index++) {
      const step = await f.begin(), before = inputs.length;
      const replay = await prepareFcaHistory(step, { ...f.ports(async input => { inputs.push(structuredClone(input)); return summary; }),
        codec: anthropicFcaHistoryCodec }, new AbortController().signal, hysteresis);
      if (inputs.length > before) {
        summarySteps.push(index);
        expect(f.window().summary!.bootstrapText.length).toBeLessThanOrEqual(2_000 + JSON.stringify(summary).length + 200);
        expect(replay.history).toEqual([{ role: 'user', content: f.window().summary!.bootstrapText }]);
      }
      await f.finish(step, index, decisionRound(index));
    }
    // Every round is covered once, in order, and a summary step is followed by native steps (Minebot lane 2026-10-14: every step).
    expect(inputs.flatMap(input => input.rounds.map(round => round.sequence))).toEqual(
      Array.from({ length: inputs.flatMap(input => input.rounds).length }, (_, index) => index + 1));
    expect(summarySteps.length).toBeLessThanOrEqual(8);
    const gaps = summarySteps.slice(1).map((value, index) => value - summarySteps[index]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
    expect(inputs.some(input => input.rounds.length > 1)).toBe(true);
  });

  it('migrates old append-only history and records actual committed task status', async () => {
    const f = fixture(':memory:', true); await f.append(2);
    expect(f.window().rounds.map(round => round.status)).toEqual(['queued', 'queued']);
    const step = await f.begin(); f.runtime.send('owner', f.root.id, f.task.id, 'new evidence', 'late');
    expect(f.runtime.commitStep(step, { disposition: 'complete', history: entries(3) })?.task.status).toBe('queued');
    expect(f.window().rounds.at(-1)?.status).toBe('queued');
    expect(f.db.prepare('SELECT count(*) AS count FROM fca_task_history').get()?.count).toBe(3);
  });
});

// P4 (owner 2026-10-17): a body task's summaries are rare, by Haiku: compacted past ~24k conversation tokens, down to ~8k with the
// newest 6 rounds whole. Everything below is the policy (`FCA_BODY_HISTORY_POLICY`) with the real codec and a stored history.
describe('a body task\'s rare history summaries (FCA_BODY_HISTORY_POLICY)', () => {
  /** A decision-shaped round of about `characters` Japanese characters of body report (about 1.1 tokens each), with a call and its result. */
  const bodyRound = (index: number, characters: number) => [
    { role: 'user', content: JSON.stringify({ task: { id: 'task', title: 'history', goal: 'history', completionCriteria: '' }, messages: [], body: `観測${index}${'観'.repeat(characters)}` }) },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: `signed-${index}` }, { type: 'tool_use', id: `call-${index}`, name: 'task_list', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: `結果${index}` }] },
  ];
  const tokensOf = (entries: readonly unknown[]) => anthropicFcaHistoryCodec.tokens!(entries);
  const conversation = (f: ReturnType<typeof fixture>) => tokensOf(f.window().rounds.flatMap(round => round.entries));
  const body = { ...FCA_BODY_HISTORY_POLICY };
  const live = (f: ReturnType<typeof fixture>, summarize?: (input: FcaHistorySummaryInput) => Promise<unknown>) =>
    ({ ...f.ports(summarize), codec: anthropicFcaHistoryCodec });

  it('names the owner\'s numbers: 24,000 to trigger, 8,000 to reach, the newest 6 whole', () => {
    expect(FCA_BODY_HISTORY_POLICY).toMatchObject({ maximumConversationTokens: 24_000, compactedConversationTokens: 8_000, recentRounds: 6 });
    expect(FCA_HISTORY_POLICY).not.toHaveProperty('maximumConversationTokens');
    expect(() => planFcaHistory({ revision: 0, sourceRevision: '', tailSequence: 0, summary: null, rounds: [] }, anthropicFcaHistoryCodec,
      { maximumConversationTokens: 1_000, compactedConversationTokens: 2_000 })).toThrow('FCA_HISTORY_POLICY');
  });

  it('compacts exactly when the conversation passes 24,000 tokens, and not for the round count the default allows', async () => {
    const f = fixture(); let compacted = -1;
    for (let index = 1; index <= 40 && compacted < 0; index++) {
      await f.finish(await f.begin(), index, bodyRound(index, 1_000));
      const plan = planFcaHistory(f.window(), anthropicFcaHistoryCodec, body);
      if (plan.kind === 'compact') compacted = index; else expect(conversation(f)).toBeLessThanOrEqual(24_000);
    }
    expect(compacted).toBeGreaterThan(6);
    expect(conversation(f)).toBeGreaterThan(24_000);
    // The default policy keeps the same history as it is (24 rounds, 75,000 tokens): nothing there to compact yet.
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, {})).toMatchObject({ kind: 'ready' });
    // Many short rounds: the default's 24 rounds decide, the body's tokens do not.
    const g = fixture();
    for (let index = 1; index <= 30; index++) await g.finish(await g.begin(), index, bodyRound(index, 50));
    expect(conversation(g)).toBeLessThan(24_000);
    expect(planFcaHistory(g.window(), anthropicFcaHistoryCodec, {}).kind).toBe('compact');
    expect(planFcaHistory(g.window(), anthropicFcaHistoryCodec, body)).toMatchObject({ kind: 'ready' });
  });

  it('does not count rebuildable tool definitions against the conversation bound, but the whole replay bound still holds', async () => {
    const f = fixture(), definition = { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'mc.big', description: '説明'.repeat(15_000), input_schema: { type: 'object' } } } }] };
    expect(anthropicFcaHistoryCodec.reproducible!(definition)).toBe(true);
    await f.finish(await f.begin(), 1, [definition, ...bodyRound(1, 500)]);
    await f.finish(await f.begin(), 2, bodyRound(2, 500));
    expect(conversation(f)).toBeGreaterThan(24_000);
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, body)).toMatchObject({ kind: 'ready' });
    expect(planFcaHistory(f.window(), anthropicFcaHistoryCodec, { ...body, maximumReplayTokens: 20_000 }).kind).toBe('compact');
  });

  it('compacts down to 8,000 tokens with the newest 6 rounds whole, then stays quiet', async () => {
    const f = fixture(); const inputs: FcaHistorySummaryInput[] = [];
    let steps = 0;
    for (; steps < 60 && !inputs.length; steps++) {
      const step = await f.begin();
      const replay = await prepareFcaHistory(step, live(f, async input => { inputs.push(structuredClone(input)); return summary; }), new AbortController().signal, body);
      if (inputs.length) {
        const stored = f.window();
        expect(tokensOf(replay.history)).toBeLessThanOrEqual(8_000);
        expect(stored.rounds).toHaveLength(6);
        const kept = JSON.parse(stored.summary!.bootstrapText) as { rounds: Array<{ sequence: number }> };
        expect(kept.rounds.map(round => round.sequence)).toEqual(stored.rounds.map(round => round.sequence));
        expect(inputs[0]!.rounds.at(-1)!.sequence).toBe(stored.rounds[0]!.sequence - 1);
        expect(JSON.stringify(inputs)).not.toMatch(/signed-|"thinking"/u);
      }
      await f.finish(step, steps + 1, bodyRound(steps + 1, 700));
    }
    expect(inputs).toHaveLength(1);
    // The next steps replay the bootstrap and new rounds without another summary until 24,000 tokens again.
    for (let more = 0; more < 8; more++) {
      const step = await f.begin();
      await prepareFcaHistory(step, live(f, async () => { throw new Error('unexpected summary'); }), new AbortController().signal, body);
      await f.finish(step, 100 + more, bodyRound(100 + more, 700));
    }
  });

  it('keeps fewer than 6 rounds only while they alone would pass the 8,000-token target, never fewer than the newest one', async () => {
    const f = fixture(); const inputs: FcaHistorySummaryInput[] = [];
    for (let index = 1; index <= 12; index++) await f.finish(await f.begin(), index, bodyRound(index, 3_000));
    const step = await f.begin();
    const replay = await prepareFcaHistory(step, live(f, async input => { inputs.push(structuredClone(input)); return summary; }), new AbortController().signal, body);
    const kept = f.window().rounds.length;
    expect(inputs.length).toBeGreaterThan(0);
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThan(6);
    expect(tokensOf(replay.history)).toBeLessThanOrEqual(8_000);
  });

  it('stores a body summary\'s items up to 120 characters, and no more', async () => {
    const f = fixture(); await f.append(10);
    const long = (length: number) => 'あ'.repeat(length);
    await prepareFcaHistory(await f.begin(), f.ports(async () => ({ '目的': [long(100)], '次': [long(130)] })), new AbortController().signal, policy);
    const template = f.window().summary!.template as unknown as Record<string, string[]>;
    expect([...template['目的']![0]!]).toHaveLength(100);
    expect([...template['次']![0]!]).toHaveLength(120);
  });

  it('replays a clipped public epoch, with no stored change, when the body summarizer gives no usable answer', async () => {
    const f = fixture();
    for (let index = 1; index <= 30; index++) await f.finish(await f.begin(), index, bodyRound(index, 1_000));
    const step = await f.begin(), original = f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all();
    const invalid = Object.assign(new Error('FCA_SUMMARY_INVALID'), { reason: 'template' });
    const replay = await prepareFcaHistory(step, live(f, async () => { throw invalid; }), new AbortController().signal, body);
    const epoch = JSON.parse((replay.history[0] as { content: string }).content) as { kind: string; rounds: unknown[] };
    expect(epoch.kind).toBe('fca_public_history');
    expect(epoch.rounds.length).toBeGreaterThan(0);
    expect(f.window().summary).toBeNull();
    expect(f.db.prepare('SELECT sequence,entries_json FROM fca_task_history ORDER BY sequence').all()).toEqual(original);
  });
});

// `SHANNON_FCA_PROVENANCE_REFS`: a round keeps its sources by reference, and the compaction's lineage (`TaskHistoryStore.commit`)
// is the union of the rounds' resolved sources, exactly as over copies.
describe.each([[true], [false]])('history rounds with provenance by reference %s', byReference => {
  it('commits a compaction whose lineage is every compacted round\'s sources and the current ones', async () => {
    const f = fixture(':memory:', false, byReference);
    const observe = (step: TaskStep, id: string) => {
      expect(f.runtime.observeSources(step, { observationId: id, recalledMemoryIds: [`recalled-${id}`] })).toBe(true);
      step.snapshot.sources = f.runtime.taskSources('owner', f.task.id, step.messageIds);
    };
    for (let index = 1; index <= 10; index++) { const step = await f.begin(); observe(step, `o${index}`); await f.finish(step, index); }
    const stored = f.db.prepare('SELECT sources_json FROM fca_task_history ORDER BY sequence').all() as Array<{ sources_json: string }>;
    expect(stored.every(row => isProvenanceReference(row.sources_json) === byReference)).toBe(true);
    const step = await f.begin(); observe(step, 'current');
    const planned = planFcaHistory(f.window(), codec, policy); expect(planned.kind).toBe('compact'); if (planned.kind !== 'compact') return;
    expect(f.runtime.commitCompaction(step, { ...planned.request, template: summary }, () => true)).toBe(true);
    const lineage = f.window().summary!.sources.flatMap(source => source.recalledMemoryIds);
    const compacted = planned.request.sequences.length;
    expect(lineage).toEqual(expect.arrayContaining([...Array.from({ length: compacted }, (_, index) => `recalled-o${index + 1}`), 'recalled-current']));
    // A retained round reads back its own (cumulative) list, through its reference or its copy.
    const retained = f.window().rounds.at(-1)!.sources.flatMap(source => source.recalledMemoryIds);
    expect(retained).toEqual(expect.arrayContaining(Array.from({ length: 10 }, (_, index) => `recalled-o${index + 1}`)));
  });
});
