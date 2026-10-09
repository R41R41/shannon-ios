import { afterEach, describe, expect, it } from 'vitest';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { ShannonBackgroundWorker } from '../src/mind/sleep/backgroundWorker.js';
import type { SleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import type { TaskSpec } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { integratedFcaHarness, latch, round, until } from './support/fcaIntegratedHarness.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const message = '私は紅茶が好きです。', statement = 'ユーザーは紅茶が好き';
const proposal = [{ kind: 'user-fact' as const, statement, evidence: message }];
function scheduled(f: ReturnType<typeof integratedFcaHarness>) {
  const source = f.store.appendTurn('owner', 'night', message, '覚えました。', '2026-10-06T12:00:00.000Z');
  expect(f.store.enqueueSleepConsolidations('2026-10-06', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z', f.now())).toBe(1);
  const task = f.sleep!.jobs.admit(f.driver.runtime)!; expect(task).toMatchObject({ kind: 'sleep', origin: 'maintenance', phase: 'ready' });
  const job = f.driver.runtime.sleepTicketForTask('owner', task.id)!;
  return { sourceId: source.id, taskId: task.id, jobId: job.jobId };
}
const status = (f: ReturnType<typeof integratedFcaHarness>, jobId: string) => f.actions.db.prepare('SELECT status,last_error FROM background_jobs WHERE job_id=?').get(jobId);
function fixture(analyzer: SleepMemoryAnalyzer) {
  const f = integratedFcaHarness({ sleep: { analyzer }, decide: input => {
    if (input.task.goal === '石を一つ採る' && !input.history.length) return round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] });
    return round({ kind: 'wait', summary: '次の連絡を待つ' });
  } });
  cleanup.push(() => f.close()); return f;
}

describe('sleep joins the existing common FCA lifecycle through the production sleep factory', () => {
  it('shares two background slots with body/research while conversation continues, and completes the canonical night only after writer and segment acknowledgement', async () => {
    const entered = latch(), release = latch(); let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze(messages) {
      analyses++; expect(messages.map(item => item.content)).toEqual([message]); entered.release(); await release.promise; return proposal;
    } }); cleanup.push(release.release);
    const night = scheduled(f); f.advance(1);
    const foreground = await f.talk('石を採り、別の調査も続けてください。', async turn => {
      expect((await turn.call('minecraft.request', { goal: '石を一つ採る' })).ok).toBe(true);
      const result = await turn.call('task.create', { title: '公開資料', goal: '公開資料を確認する', completionCriteria: '確認済み' });
      expect(result.ok).toBe(true); return JSON.parse(result.text).id as string;
    });
    await f.driver.tick(); await entered.promise;
    // A short ordinary task may occupy the second slot first; its receipt releases that same slot for the body.
    await until(() => f.bodyStore.pending('minecraft:world').length > 0 ||
      f.driver.runtime.get('owner', foreground.value)?.phase === 'waiting' && f.driver.runtime.pendingReceipts('owner').length === 0,
    'a regular task must progress alongside the sleeping task');
    await f.driver.tick(); const command = await f.command();
    expect(f.actions.store.list('owner').filter(action => action.state === 'running')).toHaveLength(2);
    await f.talk('整理と採掘を続けたまま、こちらで話しましょう。');
    expect(f.foregroundCalls()).toBe(2);
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('executing');
    expect(f.store.claimNextBackgroundJob('legacy', f.now(), new Date(Date.parse(f.now()) + 60_000).toISOString())).toBeNull();
    f.acknowledge(command); release.release(); await f.driver.drain();
    expect(status(f, night.jobId)?.status).toBe('leased');
    expect(f.actions.db.prepare('SELECT status FROM sleep_runs WHERE sleep_run_id=?').get(night.jobId)).toEqual({ status: 'running' });
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(false);
    for (let n = 0; n < 2; n++) await f.tick();
    expect(analyses).toBe(1);
    expect(f.driver.runtime.snapshot('owner', night.taskId)?.checkpoint).toMatchObject({ sleepFca: {
      phase: 'memory', state: { writerBarrier: 1 },
    } });
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(false);
    await f.writeMemory();
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(true);

    for (let n = 0; n < 8 && f.driver.runtime.get('owner', night.taskId)?.phase !== 'completed'; n++) { await f.tick(); await f.writeMemory(); }
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('completed');
    expect(status(f, night.jobId)?.status).toBe('completed');
    expect(analyses).toBe(1);
    expect(f.actions.db.prepare("SELECT COUNT(*) AS n FROM experience_events WHERE event_type='sleep.completed'").get()).toEqual({ n: 1 });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.driver.runtime.get('owner', foreground.value)?.phase).toBe('waiting');
    const sleepHistory = f.driver.runtime.snapshot('owner', night.taskId)!;
    expect(JSON.stringify(sleepHistory.history)).not.toContain(message);
    expect(JSON.stringify(sleepHistory.checkpoint)).not.toContain(statement);
    f.sleep!.jobs.reconcile(f.driver.runtime);
    expect(f.actions.db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE activity_type='sleep'").get()).toEqual({ n: 1 });
  });

  it('continues only restricted maintenance with others present, without owner tools or privilege inheritance', async () => {
    let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze() { analyses++; return proposal; } });
    const night = scheduled(f), root = f.driver.runtime.ensureRoot('owner');
    const ordinary = f.driver.runtime.createChild('owner', root.id, { title: 'Owner task', goal: 'Private task' }, 'owner-request');
    f.setOwnerAlone(false);
    for (let n = 0; n < 8 && f.driver.runtime.get('owner', night.taskId)?.phase !== 'completed'; n++) { await f.tick(); await f.writeMemory(); }
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('completed');
    expect(f.driver.runtime.get('owner', ordinary.id)?.phase).toBe('ready');
    expect(f.calls).toEqual([]); expect(analyses).toBe(1);
    expect(f.poll().commands).toEqual([]);
    expect(f.driver.runtime.taskSources('owner', root.id)).toEqual([]);
    expect(f.driver.runtime.createChild.bind(f.driver.runtime, 'owner', root.id,
      { title: 'Escalation', goal: 'Escalation', origin: 'maintenance' } as unknown as TaskSpec, 'escalate')).toThrow('FCA_OWN_TIME_NOT_ADMITTED');
    const history = JSON.stringify(f.driver.runtime.snapshot('owner', night.taskId)?.history);
    expect(history).toContain('"sleepFca":1');
    expect(history).not.toMatch(/task\.create|web\.search|mc\.dig/u);
  });

  it('holds a lost nightly model result across restart and never falls back to the legacy worker', async () => {
    let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze() { analyses++; throw new Error('paid_result_unknown'); } });
    const night = scheduled(f); await f.tick();
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('unknown');
    expect(status(f, night.jobId)).toMatchObject({ status: 'leased', last_error: 'fca_result_unknown' });
    f.advance(180_000);
    expect(f.store.claimNextBackgroundJob('legacy', f.now(), new Date(Date.parse(f.now()) + 60_000).toISOString())).toBeNull();
    await f.restart(); for (let n = 0; n < 3; n++) await f.tick();
    expect(analyses).toBe(1);
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('unknown');
    expect(status(f, night.jobId)?.status).toBe('leased');
    expect(f.rows().filter(row => row.origin === 'sleep')).toEqual([]);
    await f.talk('夜の整理の結果が不明でも会話を続けてください。');
    expect(f.foregroundCalls()).toBe(1);
  });

  it('keeps same-owner turn refinement and other scopes on the legacy worker while a bound night never falls back, even expired and disabled', async () => {
    let analyses = 0;
    const analyzer: SleepMemoryAnalyzer = { mode: 'local-rules', async analyze() { analyses++; return proposal; } };
    const f = fixture(analyzer), night = scheduled(f);
    f.store.enqueueTurnRefinement('owner', night.sourceId, message, '2026-10-06T12:00:00.000Z');
    const worker = new ShannonBackgroundWorker(f.store, f.store, f.store, analyzer, {
      workerId: 'legacy', now: () => new Date(f.now()), fcaSleepScope: 'owner', memoryProposals: f.ports.proposals,
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(f.actions.db.prepare('SELECT status FROM background_jobs WHERE dedupe_key=?').get(`turn:${night.sourceId}`)).toEqual({ status: 'completed' });
    expect(status(f, night.jobId)?.status).toBe('leased');
    expect(analyses).toBe(0);

    f.store.appendTurn('other-scope', 'their-night', '別の範囲の会話です。', 'はい。', '2026-10-06T13:00:00.000Z');
    expect(f.store.enqueueSleepConsolidations('2026-10-06', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z', f.now())).toBe(1);
    f.advance(180_000);
    // No excludedSleepScope is the legacy/OFF contract: the durable binding still owns the old night.
    const other = f.store.claimNextBackgroundJob('legacy-off', f.now(), new Date(Date.parse(f.now()) + 60_000).toISOString());
    expect(other).toMatchObject({ scopeKey: 'other-scope', payload: { kind: 'sleep-consolidation' } });
    f.store.completeClaimedBackgroundJob(other!, 'legacy-off', f.now(), () => {});
    expect(f.store.claimNextBackgroundJob('legacy-off', f.now(), new Date(Date.parse(f.now()) + 60_000).toISOString())).toBeNull();
    expect(status(f, night.jobId)?.status).toBe('leased');
    expect(analyses).toBe(0);
  });

  it('keeps the canonical night leased until the final segment receipt is confirmed after restart', async () => {
    let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze() { analyses++; return proposal; } });
    const night = scheduled(f);
    const phase = () => (f.driver.runtime.snapshot('owner', night.taskId)?.checkpoint as { sleepFca?: { phase?: string } } | null)?.sleepFca?.phase;
    await f.tick(); expect(phase()).toBe('memory');
    await f.restart(); await f.tick();
    expect(phase()).toBe('memory'); expect(analyses).toBe(1);
    for (let n = 0; n < 8 && phase() !== 'done'; n++) { await f.writeMemory(); await f.tick(); }
    expect(phase()).toBe('done');
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('ready');
    const finish = f.actions.actions.finish;
    f.actions.actions.finish = async (...args) => { if (args[2] === 'fca_segment_committed') throw new Error('worker_disconnected'); return finish(...args); };
    await f.tick();
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('completed');
    const [receipt] = f.driver.runtime.pendingReceipts('owner'); expect(receipt?.taskId).toBe(night.taskId);
    expect(status(f, night.jobId)?.status).toBe('leased');
    expect(f.actions.db.prepare("SELECT COUNT(*) AS n FROM experience_events WHERE event_type='sleep.completed'").get()).toEqual({ n: 0 });
    f.advance(31_000); f.actions.store.transaction(() => f.actions.store.sweep(f.now()));
    expect(f.actions.store.get(receipt!.lease.id)?.state).toBe('unknown');
    await f.restart(); await f.tick();
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(status(f, night.jobId)?.status).toBe('completed');
    expect(analyses).toBe(1);
    expect(f.actions.db.prepare("SELECT COUNT(*) AS n FROM experience_events WHERE event_type='sleep.completed'").get()).toEqual({ n: 1 });
    await f.tick(); expect(analyses).toBe(1);
  });

  it('waits for actual nightly model cancellation before releasing the action and closing the job', async () => {
    const entered = latch(), aborted = latch(), unwind = latch(); let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze(_messages, context) {
      analyses++; context!.signal!.addEventListener('abort', aborted.release, { once: true });
      entered.release(); await unwind.promise; context!.signal!.throwIfAborted(); return proposal;
    } }); cleanup.push(unwind.release);
    const night = scheduled(f); await f.driver.tick(); await entered.promise;
    await f.driver.stop(night.taskId, 'owner_stop_sleep'); await aborted.promise;
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('stopping');
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    f.sleep!.jobs.reconcile(f.driver.runtime); expect(status(f, night.jobId)?.status).toBe('leased');
    unwind.release(); await f.driver.drain(); f.sleep!.jobs.reconcile(f.driver.runtime);
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('stopped');
    expect(f.actions.store.list('owner').find(action => action.origin === 'maintenance')).toMatchObject({ state: 'cancelled', result: 'fca_stop_acknowledged' });
    expect(status(f, night.jobId)).toMatchObject({ status: 'failed', last_error: 'fca_stopped' });
    expect(f.rows().filter(row => row.origin === 'sleep')).toEqual([]);
    const stopped = f.driver.runtime.get('owner', night.taskId), admissions = f.actions.store.list('owner').length;
    expect(f.driver.runtime.resume('owner', night.taskId)).toBeNull();
    expect(f.driver.runtime.get('owner', night.taskId)).toEqual(stopped);
    await f.tick(); expect(analyses).toBe(1);
    expect(f.actions.store.list('owner')).toHaveLength(admissions);
  });

  it('does not copy private nightly source references through a closed task.get/list schedule projection', async () => {
    const f = fixture({ mode: 'local-rules', async analyze() { return proposal; } });
    const night = scheduled(f); await f.tick();
    expect(f.driver.runtime.taskSources('owner', night.taskId).some(source => source.recalledMemoryIds.includes(night.sourceId))).toBe(true);
    f.store.threadId('owner', f.store.createThread('owner', '別の会話'));
    const foreground = await f.talk('整理の進み具合だけを確認し、別の作業を始めてください。', async turn => {
      const item = await turn.call('task.get', { id: night.taskId }); expect(item.ok).toBe(true);
      expect(item.text).not.toContain(night.sourceId); expect(item.text).not.toContain(message);
      expect((await turn.call('task.list', {})).ok).toBe(true);
      const child = await turn.call('task.create', { title: '独立した資料', goal: '公開資料を確認する', completionCriteria: '確認済み' });
      expect(child.ok).toBe(true); return JSON.parse(child.text).id as string;
    });
    expect(f.driver.runtime.taskSources('owner', foreground.value).flatMap(source => source.recalledMemoryIds)).not.toContain(night.sourceId);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: night.sourceId, action: 'forget' });
    expect(f.visible('owner', foreground.value)).toBe(true);
    await f.tick(); expect(f.driver.runtime.get('owner', foreground.value)?.phase).toBe('waiting');
  });

  it('withholds a model answer when its original source is forgotten before application', async () => {
    const entered = latch(), release = latch(); let analyses = 0;
    const f = fixture({ mode: 'local-rules', async analyze() { analyses++; entered.release(); await release.promise; return proposal; } });
    cleanup.push(release.release);
    const night = scheduled(f); await f.driver.tick(); await entered.promise;
    expect(f.driver.runtime.taskSources('owner', night.taskId).some(source => source.recalledMemoryIds.includes(night.sourceId))).toBe(true);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: night.sourceId, action: 'forget' });
    release.release(); await f.driver.drain(); f.sleep!.jobs.reconcile(f.driver.runtime);
    expect(f.driver.runtime.get('owner', night.taskId)?.phase).toBe('unknown');
    expect(f.rows().filter(row => row.origin === 'sleep')).toEqual([]);
    await f.writeMemory(); expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(false);
    await f.tick(); expect(analyses).toBe(1);
    expect(status(f, night.jobId)?.status).toBe('leased');
  });
});
