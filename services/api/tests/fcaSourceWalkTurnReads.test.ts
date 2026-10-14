import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskSource } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { run6RecallShape } from './support/run6RecallShape.js';

/**
 * Minecraft run 10 (2026-10-14), profiled on a copy of the production database: one walk of a long task's provenance fetched
 * 5,366 remembered turns (190 distinct), each 40-id memory read fetching its lineage again: 0.9–1.5 s of the API's thread.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[]): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled });

describe('one walk reads each remembered turn once', () => {
  it('fetches each turn of the walk at most once, and finds the same verdicts', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = run6RecallShape({ turns: 600, tasks: 40, recalledPerTask: 40, taskRecallsOfTasks: 10, readsPerTask: 6, skills: 6 });
    cleanups.push(() => f.close());
    const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
      model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    let clock = Date.parse(f.world.now());
    const visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
      ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => clock });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '鉄', goal: '鉄', completionCriteria: '持ち物' }, 'reads');
    const probe = (id: string) => visible.sources('owner', task, [memoryRow(`p:${id}`, f.world.now(), [id])]);
    const pool = [...f.tasks, ...f.turns.slice(20, 200)].filter(probe).slice(0, 80);
    const base = Date.parse(f.world.now()) - 3_600_000;
    const rows = Array.from({ length: 120 }, (_, index) => memoryRow(`m:${index}`, new Date(base + index * 10_000).toISOString(), pool.slice(index % 50, index % 50 + 30)));
    const fetched = new Map<string, number>();
    const original = f.world.store.experiencesById.bind(f.world.store);
    vi.spyOn(f.world.store, 'experiencesById').mockImplementation((scope: string, ids: readonly string[]) => {
      for (const id of ids) fetched.set(id, (fetched.get(id) ?? 0) + 1);
      return original(scope, ids);
    });
    clock += 60_000;
    expect(visible.sources('owner', task, rows)).toBe(true);
    expect(Math.max(...fetched.values())).toBe(1);
    // The forgotten turn in a late row: still hidden.
    clock += 60_000;
    expect(visible.sources('owner', task, [...rows, memoryRow('m:late', new Date(base + 2_000_000).toISOString(), [f.turns.at(-1)!])])).toBe(false);
  });
});
