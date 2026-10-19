import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { TaskProgressStore } from '../src/mind/action/taskRuntime/store/taskProgressStore.js';
import { TaskBodyRecoveryStore } from '../src/mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import { isPauseNotice, type TaskProgress } from '../src/mind/action/taskRuntime/taskProgressPorts.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { gatedProgress, reportGateDecision, reportGateVerdict, type ReportGateParts } from '../src/mind/action/fca/fcaReportGate.js';
import { createSpokenReports, pausedReportLine } from '../src/mind/action/fca/fcaSpokenReport.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import type { ToolResult } from '../src/mind/tools/toolRegistryPorts.js';
import { AWAITING_PROOF_SUMMARY, BODY_ABSENT_SUMMARY, RECOVERY_LIMIT_SUMMARY, RELEASE_UNPROVEN_SUMMARY, STALE_SUMMARY } from '../src/wiring/fcaBodyRecoveryPolicy.js';
import { estimatesPausedReport, pausedReport, pausedSpoken, pausedSummary, PROVIDER_UNAVAILABLE_SUMMARY } from '../src/wiring/taskPauseNotice.js';

/**
 * Fifth round on the FCA recovery (review of c62cccf): a pause notice is a report of its own. It has its own status (`paused`), the gate
 * does not take it for a failure (M-1), the report it replaced comes back when the owner resumes (M-2), and a call says it in fixed
 * words (M-3). Also the tests the review asked for (L-1), the marker of the estimates' words (L-4) and the index of the migration (L-6).
 */
const MINUTE = 60_000;
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

function clock(start = '2026-10-19T00:00:00.000Z') {
  let time = Date.parse(start);
  return { now: () => new Date(time).toISOString(), advance: (milliseconds: number) => { time += milliseconds; } };
}

function runtimeWorld() {
  const c = clock();
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => true, now: c.now, pausedSummary });
  const store = new TaskProgressStore(db, authority, c.now);
  const root = runtime.ensureRoot('owner');
  let count = 0;
  const child = (title = '採掘') => runtime.createChild('owner', root.id, { title, goal: `${title}をする`, kind: 'research', origin: 'owner_request' } as never, `child-${++count}`);
  const events = (taskId: string) => (db.prepare("SELECT COUNT(*) AS n FROM agent_task_events WHERE task_id=? AND event_type='fca_progress_observed'").get(taskId) as { n: number }).n;
  return { c, db, authority, runtime, store, root, child, events };
}
const NOTICE = '「採掘」は、体が戻らなかったため一時停止しています。体が戻ってから再開できます。';
const SPOKEN = '『採掘』は体が戻らなかったため一時停止しています。再開できます。';

describe('a pause notice stands in for the report it replaced, and gives it back on resume (M-2)', () => {
  it.each([['unread', false, false], ['spoken', true, false], ['heard', true, true]] as const)('keeps an %s report through a pause and a resume, as it was', (_state, spoken, heard) => {
    const w = runtimeWorld();
    const task = w.child();
    w.store.completion('owner', task, 's1', '石は3個集まりました。');
    if (spoken) expect(w.store.speak('owner', task.id, 'result:s1', '石は3個です。')).toBe(true);
    if (heard) expect(w.store.hear('owner', task.id, 'result:s1', '石は3個です。')).toBe(true);
    const before = w.runtime.progress('owner', task.id)!;
    expect(before.report).toMatchObject({ id: 'result:s1', ...(spoken ? { spoken: '石は3個です。' } : {}), ...(heard ? { heard: true } : {}) });
    w.c.advance(MINUTE);
    expect(w.store.pauseNotice('owner', task.id, 'body_not_returned:7', NOTICE, SPOKEN)).toBe(true);
    const paused = w.runtime.progress('owner', task.id)!;
    expect(paused).toMatchObject({ status: 'paused', currentStep: 'fca.result', report: { id: 'paused:body_not_returned:7', text: NOTICE, spoken: SPOKEN } });
    expect(paused.report?.heard).toBeUndefined();
    expect(JSON.stringify(paused)).not.toContain('resume'); // what it stands in for never leaves the store
    w.c.advance(MINUTE);
    w.store.clearPauseNotice(task.id);
    expect(w.runtime.progress('owner', task.id)).toEqual(before);
  });

  it('keeps the report through a second pause too (a pause over a pause stands in for the same one), and a result written later stays the first report', () => {
    const w = runtimeWorld();
    const task = w.child();
    w.store.completion('owner', task, 's1', '石は3個集まりました。');
    expect(w.store.pauseNotice('owner', task.id, 'stale:5', NOTICE)).toBe(true);
    expect(w.store.pauseNotice('owner', task.id, 'body_not_returned:9', NOTICE, SPOKEN)).toBe(true);
    expect(w.runtime.progress('owner', task.id)?.report?.id).toBe('paused:body_not_returned:9');
    w.store.clearPauseNotice(task.id);
    expect(w.runtime.progress('owner', task.id)).toMatchObject({ status: 'received', report: { id: 'result:s1', text: '石は3個集まりました。' } });
  });

  it('writes a pause notice once per key, and does not repeat its event', () => {
    const w = runtimeWorld();
    const task = w.child();
    expect(w.store.pauseNotice('owner', task.id, 'stale:5', NOTICE)).toBe(true);
    const events = w.events(task.id);
    expect(w.store.pauseNotice('owner', task.id, 'stale:5', 'another text')).toBe(false);
    expect(w.runtime.progress('owner', task.id)?.report?.text).toBe(NOTICE);
    expect(w.events(task.id)).toBe(events);
    expect(w.store.pauseNotice('owner', 'no-such-task', 'stale:5', NOTICE)).toBe(false);
    // A notice over no progress at all leaves nothing behind when the owner resumes.
    w.store.clearPauseNotice(task.id);
    expect(w.runtime.progress('owner', task.id)).toBeNull();
  });

  it('puts back what the task observed when the notice is of a row written before the report was kept (findings, places)', () => {
    const w = runtimeWorld();
    const legacy = (id: string, extra: Record<string, unknown>) => w.db.prepare('INSERT INTO fca_task_progress VALUES(?,?,?,?)').run(id, 's', 'paused:old:1', JSON.stringify({
      currentStep: 'fca.result', status: 'failed', startedAt: w.c.now(), updatedAt: w.c.now(), findings: [],
      report: { id: 'paused:old:1', text: NOTICE, updatedAt: w.c.now() }, ...extra }));
    const withFinding = w.child('a'), withPlace = w.child('b'), bare = w.child('c');
    legacy(withFinding.id, { findings: [{ id: 'f1', text: '石は北にある', status: 'unconfirmed', sources: [], updatedAt: w.c.now() }] });
    legacy(withPlace.id, { places: [{ name: '洞窟' }] });
    legacy(bare.id, {});
    for (const task of [withFinding, withPlace, bare]) w.store.clearPauseNotice(task.id);
    expect(w.runtime.progress('owner', withFinding.id)).toMatchObject({ status: 'running', findings: [{ id: 'f1' }] });
    expect(w.runtime.progress('owner', withFinding.id)?.report).toBeUndefined();
    expect(w.runtime.progress('owner', withPlace.id)).toMatchObject({ status: 'running', places: [{ name: '洞窟' }] });
    expect(w.runtime.progress('owner', withPlace.id)?.report).toBeUndefined();
    expect(w.runtime.progress('owner', bare.id)).toBeNull();
  });

  it('is not a result: completion() puts a report that was there before the pause back instead, and writes its own over a notice that stood in for nothing', () => {
    const w = runtimeWorld();
    const kept = w.child('kept'), nothing = w.child('nothing'), legacy = w.child('legacy');
    w.store.completion('owner', kept, 's1', '一つ目の結果です。');
    w.store.pauseNotice('owner', kept.id, 'stale:5', NOTICE);
    w.store.completion('owner', kept, 's2', '二つ目の結果です。'); // a report already sent stays the report
    expect(w.runtime.progress('owner', kept.id)).toMatchObject({ status: 'received', report: { id: 'result:s1', text: '一つ目の結果です。' } });
    w.store.pauseNotice('owner', nothing.id, 'stale:6', NOTICE);
    w.store.completion('owner', nothing, 's3', '結果です。');
    expect(w.runtime.progress('owner', nothing.id)).toMatchObject({ status: 'received', report: { id: 'result:s3', text: '結果です。' } });
    w.db.prepare('INSERT INTO fca_task_progress VALUES(?,?,?,?)').run(legacy.id, 's', 'paused:old:1', JSON.stringify({
      currentStep: 'fca.result', status: 'failed', startedAt: w.c.now(), updatedAt: w.c.now(), findings: [], report: { id: 'paused:old:1', text: NOTICE, updatedAt: w.c.now() } }));
    w.store.completion('owner', legacy, 's4', '結果です。');
    expect(w.runtime.progress('owner', legacy.id)).toMatchObject({ status: 'received', report: { id: 'result:s4' } });
  });

  it('resuming the task through the runtime gives the report back, and its summary words are cleared', () => {
    const w = runtimeWorld();
    const task = w.child();
    w.store.completion('owner', task, 's1', '石は3個集まりました。');
    const before = w.runtime.progress('owner', task.id);
    w.store.pauseNotice('owner', task.id, 'stale:5', NOTICE, SPOKEN);
    w.authority.event('owner', task.id, 'fca_body_paused', w.c.now(), { status: 'paused', pauseReason: 'fca_stopped', summary: BODY_ABSENT_SUMMARY });
    expect(w.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(w.runtime.resume('owner', task.id)).not.toBeNull();
    expect(w.runtime.progress('owner', task.id)).toEqual(before);
    expect(w.runtime.get('owner', task.id)?.summary).toBe('');
  });

  it('a step that records progress while a notice is still there builds on what the notice stood in for', () => {
    const w = runtimeWorld();
    const task = w.child();
    w.store.completion('owner', task, 's1', '石は3個集まりました。');
    w.store.pauseNotice('owner', task.id, 'stale:5', NOTICE);
    const step = { id: 'step-9', scopeKey: 'owner', taskId: task.id } as never;
    expect(w.store.record(step, { operationId: 'op-1', tool: 'web.search', status: 'running' }, () => true)).toBe(true);
    expect(w.runtime.progress('owner', task.id)).toMatchObject({ status: 'running', currentStep: 'web.search', report: { id: 'result:s1' } });
    // Only the runtime's own pause notice says `paused`: an executor's event never does.
    expect(() => w.store.record(step, { operationId: 'op-2', tool: 'fca.result', status: 'paused' as never }, () => true)).toThrow('FCA_PROGRESS');
  });
});

describe('the words of the first commit clear what a pause or a wait said (L-1)', () => {
  it('clears the summary of the wait for the body\'s proof when the first step after it commits, and nothing else', () => {
    const commitWith = (summary: string, commit: { summary?: string }) => {
      const c = clock();
      const h = actionHarness(c.now); cleanups.push(h.close); migrateAgentTasks(h.db);
      const authority = new SQLiteFcaTaskAuthority(h.db);
      const runtime = new SQLiteTaskRuntimeStore(h.db, { authority, leaseValid: () => true, now: c.now, pausedSummary });
      const task = runtime.createChild('owner', runtime.ensureRoot('owner').id, { title: 'x', goal: 'x' }, 'k');
      const queued = h.store.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: `fca:${task.id}:${task.revision}` }, c.now());
      const lease = leaseOf(h.store.claim(queued.id, 'runner', c.now())!);
      const step = runtime.beginStep('owner', task.id, lease, task.revision)!;
      if (summary) authority.event('owner', task.id, 'fca_note', c.now(), { summary }, {});
      expect(runtime.get('owner', task.id)?.summary).toBe(summary);
      expect(runtime.commitStep(step, { disposition: 'continue', history: [], ...commit })).not.toBeNull();
      return runtime.get('owner', task.id)!.summary;
    };
    expect(commitWith(AWAITING_PROOF_SUMMARY, {})).toBe('');
    expect(commitWith(BODY_ABSENT_SUMMARY, {})).toBe('');
    expect(commitWith('石を3個集めました。', {})).toBe('石を3個集めました。');
    expect(commitWith(AWAITING_PROOF_SUMMARY, { summary: '次は木を切ります。' })).toBe('次は木を切ります。');
  });
});

describe('the gate does not take a pause notice for a failure (M-1)', () => {
  const noon = Date.parse('2026-10-19T03:00:00.000Z');
  const iso = (value: number) => new Date(value).toISOString();
  const task = (id: string, goal: string, createdAt: number, phase = 'stopped', extra: Partial<TaskView> = {}): TaskView => ({ id, scopeKey: 'owner', parentId: 'conversation',
    kind: 'research', origin: 'owner_request', title: goal, goal, completionCriteria: '', status: phase === 'completed' ? 'completed' : 'paused', pauseReason: null,
    summary: '', revision: 1, createdAt: iso(createdAt), updatedAt: iso(createdAt + MINUTE), phase, childIds: [], ...extra }) as TaskView;
  const pause = (updatedAt: number, status: TaskProgress['status'] = 'paused', id = 'paused:body_not_returned:7'): TaskProgress => ({ currentStep: 'fca.result', status,
    startedAt: iso(updatedAt), updatedAt: iso(updatedAt), findings: [], report: { id, text: NOTICE, updatedAt: iso(updatedAt), spoken: SPOKEN } });
  const failure = (updatedAt: number): TaskProgress => ({ currentStep: 'fca.result', status: 'failed', startedAt: iso(updatedAt), updatedAt: iso(updatedAt), findings: [],
    report: { id: 'step:capped', text: '止まりました。', updatedAt: iso(updatedAt) } });
  function world(tasks: Array<[TaskView, TaskProgress | null]>, at = noon) {
    const parts: ReportGateParts = { ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => at, history: () => [], runtime: {
      get: (_scope, id) => tasks.find(([item]) => item.id === id)?.[0] ?? null,
      list: (_scope, options) => tasks.map(([item]) => item).filter(item => !options?.parentId || item.parentId === options.parentId),
      progress: (_scope, id) => tasks.find(([item]) => item.id === id)?.[1] ?? null,
      taskSources: () => [{ stepId: 's', experienceId: 'e', threadId: 'thread', observedAt: iso(at), recalledMemoryIds: [] }],
    } as ReportGateParts['runtime'] };
    const find = (id: string) => tasks.find(([entry]) => entry.id === id)!;
    return { parts, decide: (id: string, view: 'card' | 'call' = 'call') => reportGateDecision(parts, find(id)[0], find(id)[1]!, view),
      verdict: (id: string) => reportGateVerdict(parts, find(id)[0], find(id)[1]!, 'call') };
  }
  const longAgo = noon - 5 * 60 * MINUTE;

  it('reaches the call for a request made hours ago and paused a moment ago; a failure of the same age is dropped', () => {
    const paused = world([[task('a', '石を集める', longAgo), pause(noon - 2 * MINUTE)]]);
    expect([paused.decide('a', 'call'), paused.decide('a', 'card')]).toEqual(['deliver', 'deliver']);
    const failed = world([[task('a', '石を集める', longAgo, 'failed'), failure(noon - 2 * MINUTE)]]);
    expect(failed.decide('a', 'call')).toBe('drop');
  });

  it('measures the age from the notice: an hour after it, it is stale; an older row that said it by its id is the same', () => {
    const old = world([[task('a', '石を集める', longAgo), pause(noon - 90 * MINUTE)]]);
    expect(old.verdict('a')).toMatchObject({ decision: 'drop', reason: 'stale' });
    const legacy = world([[task('a', '石を集める', longAgo), pause(noon - 2 * MINUTE, 'failed')]]);
    expect(legacy.decide('a', 'call')).toBe('deliver');
    const legacyOld = world([[task('a', '石を集める', longAgo), pause(noon - 90 * MINUTE, 'failed')]]);
    expect(legacyOld.decide('a', 'call')).toBe('drop');
  });

  it('is said once: after the voice turn said it, the call drops it', () => {
    const heard = pause(noon - MINUTE);
    heard.report!.heard = true;
    const said = world([[task('a', '石を集める', longAgo), heard]]);
    expect(said.decide('a', 'call')).toBe('drop');
    const shown = gatedProgress(said.parts, id => said.parts.runtime.progress!('owner', id), 'call');
    expect(shown('a')?.report).toBeUndefined();
    const fresh = world([[task('a', '石を集める', longAgo), pause(noon - MINUTE)]]);
    expect(gatedProgress(fresh.parts, id => fresh.parts.runtime.progress!('owner', id), 'call')('a')?.report).toMatchObject({ id: 'paused:body_not_returned:7', spoken: SPOKEN });
  });

  it('is not a failure for its siblings: a real failure is not dropped for a later pause of the same request, a pause is dropped for a later failure', () => {
    const asked = noon - 30 * MINUTE;
    const both = world([
      [task('a', '石を集める', asked, 'failed'), failure(asked + 5 * MINUTE)],
      [task('b', '石を集める', asked + MINUTE), pause(asked + 6 * MINUTE)],
    ]);
    expect([both.decide('a'), both.decide('b')]).toEqual(['deliver', 'deliver']);
    const laterFailure = world([
      [task('a', '石を集める', asked), pause(asked + 5 * MINUTE)],
      [task('b', '石を集める', asked + MINUTE, 'failed'), failure(asked + 6 * MINUTE)],
    ]);
    expect([laterFailure.decide('a'), laterFailure.decide('b')]).toEqual(['drop', 'deliver']);
    const twoPauses = world([
      [task('a', '石を集める', asked), pause(asked + 5 * MINUTE)],
      [task('b', '石を集める', asked + MINUTE), pause(asked + 6 * MINUTE, 'paused', 'paused:stale:9')],
    ]);
    expect([twoPauses.decide('a'), twoPauses.decide('b')]).toEqual(['drop', 'deliver']);
    const answered = world([
      [task('a', '石を集める', asked), pause(asked + 5 * MINUTE)],
      [task('b', '石を集める', asked + MINUTE, 'completed'), { ...failure(asked + 6 * MINUTE), status: 'received' }],
    ]);
    expect(answered.decide('a')).toBe('drop');
  });

  it('isPauseNotice reads the id prefix only', () => {
    expect(isPauseNotice({ id: 'paused:x:1' })).toBe(true);
    expect(isPauseNotice({ id: 'step:capped' })).toBe(false);
    expect(isPauseNotice(undefined)).toBe(false);
  });
});

describe('a call says a pause in fixed, accurate words (M-3)', () => {
  const progress = (spoken?: string): TaskProgress => ({ currentStep: 'fca.result', status: 'paused', startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    findings: [], report: { id: 'paused:body_not_returned:7', text: NOTICE, updatedAt: '2026-10-19T00:00:00.000Z', ...(spoken ? { spoken } : {}) } });
  const task = { id: 't1', goal: '石を集める', title: '採掘', origin: 'owner_request' };

  it.each(['owner', 'operator', 'unknown'] as const)('never asks a model and never says 「結果が届いています」, whoever asked (%s)', by => {
    const speak = vi.fn(async () => '採掘に失敗しました。');
    const written: string[] = [];
    const reports = createSpokenReports({ speaker: { speak }, record: (_scope, _id, _report, text) => { written.push(text); return true; }, localTime: () => 'x', requester: () => by });
    reports.request('owner', task, progress());
    expect(written).toEqual(['『採掘』は一時停止しています。再開できます。']);
    expect(speak).not.toHaveBeenCalled();
    expect(written[0]).not.toContain('結果が届いています');
  });

  it('leaves a sentence that was written with the notice as it is', () => {
    const written: string[] = [];
    const reports = createSpokenReports({ speaker: null, record: (_scope, _id, _report, text) => { written.push(text); return true; }, localTime: () => 'x' });
    reports.request('owner', task, progress(SPOKEN));
    expect(written).toEqual([]);
  });

  it('builds the sentence from the title and the reason of each pause, and a plain one for a reason it does not know', () => {
    const say = (summary: string) => pausedSpoken('採掘', pausedReport('採掘', summary));
    expect(say(BODY_ABSENT_SUMMARY)).toBe(SPOKEN);
    expect(say(PROVIDER_UNAVAILABLE_SUMMARY)).toBe('『採掘』はモデルの応答が続けて得られなかったため一時停止しています。再開できます。');
    expect(say(RECOVERY_LIMIT_SUMMARY)).toBe('『採掘』は同じ依頼が短い間に何度も中断されたため一時停止しています。再開できます。');
    expect(say(STALE_SUMMARY)).toBe('『採掘』は前回の操作から時間がたちすぎているため一時停止しています。再開できます。');
    expect(say(RELEASE_UNPROVEN_SUMMARY)).toBe('『採掘』は体が前回の操作の解放を確認できなかったため一時停止しています。再開できます。');
    expect(pausedSpoken('採掘', estimatesPausedReport('採掘', 2000))).toBe('『採掘』は確定していない利用料の見積りが上限に近づいたため一時停止しています。再開できます。');
    expect(pausedSpoken('採掘', pausedReport('採掘', '別の理由で止まっています。'))).toBe(pausedReportLine('採掘'));
    expect(pausedReportLine('')).toBe('この依頼は一時停止しています。再開できます。');
    expect([...pausedReportLine('あ'.repeat(40))].length).toBeLessThan(60);
  });
});

describe('the conversation model is told the task is paused, not failed (M-3)', () => {
  const at = '2026-10-19T00:00:00.000Z';
  const spec = { title: 'Public research', goal: 'Find a public source', completionCriteria: 'Source verified', context: 'Public information only' };
  const parsed = (result: ToolResult) => { expect(result.ok).toBe(true); return JSON.parse(result.text) as { id: string }; };

  it('shows the pause as status paused in the current work, with the guidance that says what it means', async () => {
    const h = actionHarness(() => at); cleanups.push(h.close); migrateAgentTasks(h.db);
    const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at, leaseValid: () => false,
      conversationLeaseValid(scope, lease) { const action = h.store.check(lease, at); return action?.scopeKey === scope && action.kind === 'respond' && action.origin === 'owner_request'; } });
    const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
    const thread = conversations.threadId('owner');
    const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true, readSourceVisible: () => false });
    const bridge = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
    let turns = 0;
    const foreground = async <T>(work: () => Promise<T>) => {
      const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${++turns}` }))!;
      const lease = leaseOf(action);
      try { return await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) }, work); }
      finally { await h.actions.finish(lease, 'completed', 'responded'); }
    };
    const begin = () => bridge.begin({ scopeKey: 'owner', threadId: thread, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
    const record = () => conversations.appendTurn('owner', thread, 'Please research this public topic.', 'I admitted the research task.', at);
    let childId = '';
    await foreground(async () => { const turn = begin(); childId = parsed(bridge.executeTaskTool('task.create', spec, { scopeKey: 'owner' }) as ToolResult).id; turn.commit(record().id); });
    expect(runtime.recordPauseNotice!('owner', childId, 'body_not_returned:3', NOTICE, SPOKEN)).toBe(true);
    let prompt = '';
    await foreground(async () => { const turn = begin(); prompt = turn.context(); turn.commit(record().id); });
    expect(prompt).toContain('"status":"paused"');
    expect(prompt).not.toContain('"status":"failed"');
    expect(prompt).toContain('never call it failed');
  });
});

describe('the words of the estimates pause are recognised by their marker, not by the cap\'s digits (L-4)', () => {
  it('recognises the report of any cap, and still nothing else', () => {
    for (const cap of [2000, 1500.5, 0.5, 100000]) expect(pausedSummary(estimatesPausedReport('採掘', cap))).toBe(true);
    expect(pausedSummary('「採掘」は、確定していない利用料の見積りを含めると上限（1,500円）に近づいたので、いったん止めました。再開できます。')).toBe(true);
    expect(pausedSummary('「採掘」は、確定していない利用料の見積りを含めると上限（約1,500円）に近づいたので、いったん止めました。再開できます。')).toBe(true);
    expect(pausedSummary('「採掘」は1件の上限（300円・40歩）に達したので、ここで止めました。')).toBe(false);
    expect(pausedSummary('確定していない利用料の見積りを含めると上限（300円）に近づいたので、いったん止めました。再開できます。')).toBe(false); // not a report of a task
    expect(pausedSummary('「採掘」は、確定していない利用料の見積りを含めると上限（300円）に近づいた。')).toBe(false); // not its tail
  });
});

describe('an index that cannot be made does not take the release attempts with it (L-6)', () => {
  const schema = () => {
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    migrateAgentTasks(db);
    new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), leaseValid: () => false });
    return db;
  };

  it('keeps the attempts table in use when every index fails', () => {
    const db = schema();
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation(sql => { if (/CREATE INDEX/u.test(sql)) throw new Error('SQLITE_BUSY'); return exec(sql); });
    const store = new TaskBodyRecoveryStore(db);
    expect(spy.mock.calls.some(([sql]) => /CREATE INDEX/u.test(sql))).toBe(true);
    store.setReleaseAttempts('a1', 't1', { attempts: 2, held: 1 }, '2026-10-19T00:00:00.000Z');
    expect(store.releaseAttempts('a1')).toEqual({ attempts: 2, held: 1 });
    expect(store.releaseAttemptActionIds()).toEqual(['a1']);
  });

  it('makes both indexes when nothing fails', () => {
    const db = schema();
    db.exec('CREATE TABLE IF NOT EXISTS fca_body_operations (id TEXT PRIMARY KEY, task_id TEXT, command_json TEXT)');
    new TaskBodyRecoveryStore(db);
    const names = (table: string) => (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map(index => index.name);
    expect(names('fca_task_messages')).toContain('fca_task_messages_source');
    expect(names('fca_body_operations')).toContain('fca_body_operations_task');
  });
});
