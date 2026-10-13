import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { observedTaskRuntime } from '../src/infra/observer/observerTaskRuntime.js';
import { createFcaTouchWiring } from '../src/wiring/fcaTouchWiring.js';
import { touchSourcesVisible } from '../src/wiring/fcaTouchSources.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';

// Hotfix 2026-10-14: the 1 s wake re-read every receipt ever made, re-acknowledged it and checked its sources through memory,
// with overlapping ticks (~94% CPU on production with 27 finished receipts).
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(options: { finish?: () => Promise<void> } = {}) {
  const now = () => '2026-10-14T00:00:00.000Z', h = actionHarness(now); migrateAgentTasks(h.db);
  const runtime = observedTaskRuntime(new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now,
    leaseValid: () => true, conversationLeaseValid: () => true }), () => true);
  const root = runtime.ensureRoot('owner'), counts = { reads: 0, finish: 0, active: 0, maxActive: 0 };
  const actions: ActionThreads = { ...h.actions, async finish(lease, state, code) {
    counts.finish += 1; counts.active += 1; counts.maxActive = Math.max(counts.maxActive, counts.active);
    try { await options.finish?.(); return await h.actions.finish(lease, state, code); } finally { counts.active -= 1; }
  } };
  const touch = createFcaTouchWiring({ db: h.db, runtime, actions, ownerScope: 'owner', now, selector: { async select() { return null; } },
    allowed: () => true, sourceVisible: () => { counts.reads += 1; return true; }, threadId: () => null });
  cleanups.push(async () => { await touch.close(); h.close(); });
  const insert = (index: number, fields: { state?: string; observed?: number; result?: number; reaction?: string | null } = {}) => {
    const input = { scopeKey: 'owner', deviceId: 'phone', touchId: `t${index}`, experienceId: `exp-${index}`, observedAt: now(), audience: 'owner',
      touch: { type: 'pet' }, emotion: {}, stateVersion: 1, stances: [], stanceSourceIds: [`stance-${index}-a`, `stance-${index}-b`], gestures: ['wave'] };
    h.db.prepare(`INSERT INTO fca_touch_receipts(operation_id,scope_key,device_id,touch_id,input_json,target_id,state,gesture,lease_json,expires_at,issued,
      observed_delivered,result_delivered,reaction_json,reaction_delivered) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,0)`)
      .run(`touch:${index}`, 'owner', 'phone', `t${index}`, JSON.stringify(input), root.id, fields.state ?? 'applied', 'wave',
        JSON.stringify({ id: `act-${index}`, generation: 1, holder: 'gone' }), '2026-10-13T00:00:00.000Z',
        fields.observed ?? 1, fields.result ?? 1, fields.reaction ?? null);
  };
  const delivered = (index: number) => h.db.prepare('SELECT observed_delivered o,result_delivered r FROM fca_touch_receipts WHERE operation_id=?').get(`touch:${index}`);
  return { touch, counts, insert, delivered };
}

describe('the touch receipt tick', () => {
  it('reads no memory for finished, delivered receipts and acknowledges each only once per process', async () => {
    const f = harness();
    for (let index = 0; index < 30; index += 1) f.insert(index);
    await f.touch.tick();
    expect(f.counts.reads).toBe(0); // Nothing left to deliver: no source check at all.
    expect(f.counts.finish).toBe(30); // The first tick of a process acknowledges each once (a restart may have lost one).
    for (let tick = 0; tick < 5; tick += 1) await f.touch.tick();
    expect(f.counts).toMatchObject({ reads: 0, finish: 30 });
  });

  it('still delivers a pending receipt, checks its sources once, and then leaves it alone', async () => {
    const f = harness();
    for (let index = 0; index < 10; index += 1) f.insert(index);
    await f.touch.tick(); f.counts.reads = 0;
    f.insert(99, { observed: 0, result: 0 });
    await f.touch.tick();
    expect(f.delivered(99)).toEqual({ o: 1, r: 1 });
    expect(f.counts.reads).toBe(3); // One touch: its experience and two stance sources, per-source port.
    await f.touch.tick(); await f.touch.tick();
    expect(f.counts.reads).toBe(3);
  });

  it('runs one tick at a time', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = harness({ finish: () => gate });
    for (let index = 0; index < 3; index += 1) f.insert(index);
    const first = f.touch.tick(), second = f.touch.tick();
    expect(second).toBe(first);
    release(); await Promise.all([first, second]);
    expect(f.counts).toMatchObject({ finish: 3, maxActive: 1 });
    const third = f.touch.tick(); expect(third).not.toBe(first); await third;
  });

  it('retries only an acknowledgement that threw', async () => {
    let fail = true;
    const f = harness({ finish: async () => { if (fail) { fail = false; throw new Error('mind worker unreachable'); } } });
    for (let index = 0; index < 5; index += 1) f.insert(index);
    await f.touch.tick(); expect(f.counts.finish).toBe(5);
    await f.touch.tick(); expect(f.counts.finish).toBe(6);
    await f.touch.tick(); expect(f.counts.finish).toBe(6);
  });
});

describe('one shared snapshot for a touch\'s sources', () => {
  it('answers exactly as one read per source, forgetting and owner presence included', async () => {
    const w = memoryWorld(); cleanups.push(() => w.close()); let owner = true;
    const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => owner, now: w.now });
    const ids: string[] = [];
    ids.push(w.store.appendTurn('owner', 'thread', 'ボクの猫の名前はミケです', 'ミケ、いい名前ですね', w.now()).id); w.advance(1000);
    ids.push(w.store.appendTurn('owner', 'thread', 'ミケが今朝も鳴いていた', 'ミケは元気そうですね', w.now()).id); w.advance(1000);
    ids.push(w.store.appendTurn('owner', 'thread', '明日は雨らしい', '傘を持っていきましょう', w.now()).id); w.advance(1000);
    for (let index = 0; index < 45; index += 1) ids.push(w.store.appendTurn('owner', 'thread', `資料 ${index}`, '記録', w.now()).id);
    const batch = touchSourcesVisible({ memory, state: w.store, conversations: w.store });
    const single = (scope: string, list: readonly string[]) => list.every(id => memory.read(scope, [id], OWNER_AUDIENCE).length > 0);
    const cases = [[ids[0]!], [ids[1]!], [ids[2]!], [ids[2]!, ids[2]!], [ids[0]!, ids[2]!], [ids[2]!, 'missing'], ids, ids.slice(2)];
    const compare = () => cases.map(list => [batch('owner', list), single('owner', list)]);
    expect(compare().every(([a, b]) => a === b)).toBe(true);
    expect(batch('owner', ids.slice(2))).toBe(true);
    w.advance(1000); new ShannonMemoryService(w.store, w.store, w.now).mutate('owner', { memoryId: ids[0]!, action: 'forget' });
    const after = compare();
    expect(after.every(([a, b]) => a === b)).toBe(true);
    expect(batch('owner', [ids[0]!])).toBe(false);
    expect(batch('owner', [ids[2]!])).toBe(true);
    expect(batch('owner', ids)).toBe(false);
    expect(batch('other', [ids[2]!])).toBe(false);
    let snapshots = 0; const counted = { snapshot: (scope: string) => { snapshots += 1; return w.store.snapshot(scope); } };
    const countedMemory = createTaskMemory({ state: counted, conversations: w.store, ownerScope: 'owner', ownerAlone: () => owner, now: w.now });
    touchSourcesVisible({ memory: countedMemory, state: counted, conversations: w.store })('owner', ids.slice(2, 5));
    expect(snapshots).toBe(1); // One state read for the touch, where each source used to take its own.
    owner = false;
    expect(batch('owner', [ids[2]!])).toBe(false);
    expect(single('owner', [ids[2]!])).toBe(false);
  });
});
