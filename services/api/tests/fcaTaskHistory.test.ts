import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { planFcaHistory, prepareFcaHistory } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummaryInput } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
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
function fixture(path = ':memory:', legacy = false) {
  const h = actionHarness(() => at, path); migrateAgentTasks(h.db); let leaseAllowed = true;
  if (legacy) h.db.exec(`CREATE TABLE fca_task_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),step_id TEXT NOT NULL UNIQUE,entries_json TEXT NOT NULL,committed_at TEXT NOT NULL)`);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at,
    leaseValid(scope, taskId, lease, time) { const action = h.store.check(lease, time); return leaseAllowed && !!action
      && action.scopeKey === scope && action.kind === 'agentTask' && action.sourceId.startsWith(`fca:${taskId}:`); } });
  const root = runtime.ensureRoot('owner'), task = runtime.createChild('owner', root.id, { title: 'history', goal: 'history' }, 'history');
  async function begin() {
    const current = runtime.get('owner', task.id)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${task.id}:${current.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    expect(action).not.toBeNull(); const step = runtime.beginStep('owner', task.id, leaseOf(action!)); expect(step).not.toBeNull(); return step!;
  }
  async function finish(step: TaskStep, index: number) {
    expect(runtime.commitStep(step, { disposition: 'continue', history: entries(index) })).not.toBeNull();
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

  it('keeps fewer recent rounds native when the recent ones alone are too long (owner test 2026-10-13: two research rounds)', async () => {
    const f = fixture(); await f.append(3); const window = f.window();
    const plan = planFcaHistory(window, codec, { ...policy, maximumNativeCharacters: 1 });
    expect(plan.kind).toBe('compact');
    if (plan.kind !== 'compact') return;
    // Three rounds, all recent by the policy: the oldest is summarized, the two newest stay (the next batch goes on if needed).
    expect(plan.input.rounds.map(round => round.sequence)).toEqual([window.rounds[0]!.sequence]);
    expect(plan.request.retained.map(round => round.sequence)).toEqual(window.rounds.slice(1).map(round => round.sequence));
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

  it('migrates old append-only history and records actual committed task status', async () => {
    const f = fixture(':memory:', true); await f.append(2);
    expect(f.window().rounds.map(round => round.status)).toEqual(['queued', 'queued']);
    const step = await f.begin(); f.runtime.send('owner', f.root.id, f.task.id, 'new evidence', 'late');
    expect(f.runtime.commitStep(step, { disposition: 'complete', history: entries(3) })?.task.status).toBe('queued');
    expect(f.window().rounds.at(-1)?.status).toBe('queued');
    expect(f.db.prepare('SELECT count(*) AS count FROM fca_task_history').get()?.count).toBe(3);
  });
});
