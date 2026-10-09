import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { SleepAnalysisContext } from '../src/mind/sleep/sleepConsolidation.js';
import { createFcaSleepWiring } from '../src/wiring/fcaSleepWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const message = '私は紅茶が好きです。', statement = 'ユーザーは紅茶が好き';
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

async function fixture(options: { forgotten?: boolean; enabled?: boolean; second?: boolean } = {}) {
  const world = selfInterestWorld(options.enabled ?? true);
  cleanups.push(world.close);
  const oldEvidence = world.source('星の観測をもっと試したい。');
  const secondEvidence = options.second ? world.source('鉱物の観察も試したい。') : undefined;
  if (options.enabled !== false) {
    world.add('天文', [oldEvidence]); if (secondEvidence) world.add('鉱物', [secondEvidence]); await world.night();
  }
  const item = world.memory?.snapshot('owner').items[0];
  const second = world.memory?.snapshot('owner').items[1];
  if (options.forgotten) world.mutate({ itemId: item!.id, expectedRevision: item!.revision, action: 'forget' });
  world.advance(86_400_000);
  const current = world.source(message);
  const actions = actionHarness(world.now, world.path, world.store.fcaDatabase());
  const entered = latch(), release = latch(); let calls = 0, context: SleepAnalysisContext | undefined;
  const sleep = createFcaSleepWiring({ store: world.store, ownerScope: 'owner', now: world.now,
    values: { SHANNON_SKILLS: 'off', SHANNON_SLEEP_MIN_MESSAGES: '1' }, knowledgeAnalyzer: null,
    peoplePhase: () => ({ async decide() { return null; }, async apply() { return { done: true, summary: 'No people work' }; } }),
    analyzer: { mode: 'local-rules', async analyze(messages, input) {
      calls++; context = input; expect(messages.map(row => row.sourceExperienceId)).toEqual([current]);
      entered.release(); await release.promise; return [{ kind: 'user-fact', statement, evidence: message }];
    } },
  });
  const driver = createTaskRuntimeWiring({ db: actions.db, actions: actions.actions, scopeKey: 'owner', now: world.now,
    ownerAlone: () => false, model: { async decide() { throw new Error('ordinary model must not run'); }, toolResults: results => results },
    sleepTicket: sleep.jobs.ticket, maintenanceAllowed: sleep.jobs.allowed,
    canRunTask: (runtime, id) => sleep.visible(runtime, runtime.get('owner', id)!), stepPorts: sleep.step });
  cleanups.push(async () => { release.release(); await driver.close(); sleep.close(); actions.close(); });
  const baseline = Number(actions.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM memory_outbox').get()!.n);
  expect(world.store.enqueueSleepConsolidations('2026-10-08', '2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z', world.now())).toBe(1);
  const task = sleep.jobs.admit(driver.runtime)!;
  const sources = () => driver.runtime.taskSources('owner', task.id).flatMap(source => source.recalledMemoryIds);
  const submitted = () => actions.db.prepare("SELECT op_id FROM memory_outbox WHERE seq>? AND origin='sleep' AND op_id LIKE 'sleep:%'").all(baseline);
  const tick = async () => { sleep.jobs.reconcile(driver.runtime); await driver.tick(); await driver.drain(); sleep.jobs.reconcile(driver.runtime); };
  async function start() {
    await driver.tick();
    for (let n = 0; n < 500 && !calls; n++) await delay(1);
    expect(calls).toBe(1); await entered.promise;
  }
  async function complete() {
    release.release(); await driver.drain();
    for (let n = 0; n < 10 && driver.runtime.get('owner', task.id)?.phase !== 'completed'; n++) { await world.writer().drain(); await tick(); }
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(calls).toBe(1);
  }
  return { ...world, actions, sleep, driver, task, oldEvidence, secondEvidence, current, item, second, release, sources, submitted, start, complete, tick,
    calls: () => calls, context: () => context };
}

describe('common sleep self-interest provenance and paid-answer fence', () => {
  it('retains every visible item and its older evidence, then uses the existing writer to complete', async () => {
    const f = await fixture({ second: true }); await f.start();
    expect(f.context()?.selfInterests).toEqual([f.item, f.second]);
    expect(new Set(f.sources())).toEqual(new Set([f.current, `self-interest:${f.item!.id}`, f.oldEvidence,
      `self-interest:${f.second!.id}`, f.secondEvidence]));
    expect(f.submitted()).toEqual([]);
    f.release.release(); await f.driver.drain();
    expect(f.submitted().length).toBeGreaterThan(0);
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(false);
    await f.complete();
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(true);
    expect(f.actions.store.list('owner').every(action => action.origin === 'maintenance' && action.state === 'completed')).toBe(true);
  });

  it('fences a newly adopted item that changes the model input set before apply', async () => {
    const f = await fixture(); await f.start();
    f.advance(1); f.add('鉱物', [f.current]); await f.night();
    expect(f.memory!.snapshot('owner').items).toHaveLength(2);
    f.release.release(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('unknown');
    expect(f.submitted()).toEqual([]);
    expect(f.calls()).toBe(1);
  });

  it.each(['pin', 'forget', 'evidence-forget', 'evidence-correct'] as const)('does not apply or replay when %s changes while the model waits', async change => {
    const f = await fixture(); await f.start(); f.advance(1);
    if (change === 'pin' || change === 'forget') {
      f.mutate({ itemId: f.item!.id, expectedRevision: f.item!.revision, action: change });
    } else {
      f.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.oldEvidence, kind: 'experience',
        status: change === 'evidence-forget' ? 'forgotten' : 'active', pinned: false, updatedAt: f.now(),
        contextInvalidatedAt: f.now(), changeReason: 'owner', ...(change === 'evidence-correct' ? { overrideText: '今は別の関心です。' } : {}) } });
    }
    if (change === 'pin') expect(f.sleep.visible(f.driver.runtime, f.driver.runtime.get('owner', f.task.id)!)).toBe(true);
    f.release.release(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('unknown');
    expect(f.submitted()).toEqual([]);
    for (let n = 0; n < 3; n++) await f.tick();
    expect(f.calls()).toBe(1);
    expect(f.store.snapshot('owner').userFacts.some(fact => fact.statement === statement)).toBe(false);
  });

  it('keeps already forgotten rows redacted without poisoning a new independent night', async () => {
    const f = await fixture({ forgotten: true }); await f.start();
    expect(f.context()?.selfInterests).toMatchObject([{ title: '（表示しない関心）', evidenceRefs: [], forgotten: true }]);
    expect(f.sources()).toEqual([f.current]);
    await f.complete();
  });

  it('checks old self-interest lineage on later phases instead of laundering it through a successful first phase', async () => {
    const f = await fixture(); await f.start(); f.release.release(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    await f.writer().drain();
    f.advance(1);
    f.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.oldEvidence, kind: 'experience',
      status: 'forgotten', pinned: false, updatedAt: f.now(), changeReason: 'owner' } });
    expect(f.sleep.visible(f.driver.runtime, f.driver.runtime.get('owner', f.task.id)!)).toBe(false);
    const admissions = f.actions.store.list('owner').length;
    await f.tick();
    expect(f.actions.store.list('owner')).toHaveLength(admissions);
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    expect(f.calls()).toBe(1);
  });

  it('preserves the disabled self-interest input shape and adds no interest provenance', async () => {
    const f = await fixture({ enabled: false }); await f.start();
    expect(f.context()).not.toHaveProperty('stage5');
    expect(f.context()).not.toHaveProperty('selfInterests');
    expect(f.sources()).toEqual([f.current]);
    await f.complete();
  });
});
