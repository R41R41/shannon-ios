import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionLease } from '@shannon/mind';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { ESTIMATE_SHARE, fcaBudget } from '../src/wiring/fcaBudgetWiring.js';

/**
 * Minebot parity audit M-4 (2026-10-19): the unknown bounds of requests that timed out (up to three per decision, five rounds) could
 * take a whole 2,000 yen cap and make `budget.before` fail the task. They are now kept apart from the confirmed spend; estimates count
 * toward the cap only up to a share of it, and when only they would take a task over, it is paused, not failed.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2026-10-19T09:00:00.000Z', now = () => at;
const lease: ActionLease = { id: 'action-1', generation: 1, holder: 'runner' };
const task = { id: 't-mc', scopeKey: 'owner', origin: 'owner_request', kind: 'generic', title: 'マイクラ' } as never;
const actions = {} as unknown as ActionThreads;

function world(cap = 100) {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  const store = new TaskBudgetStore(db);
  const budget = fcaBudget({ actions, store, now, minecraftRequest: () => true, taskCapYen: () => cap });
  /** Runs `book` inside a step of this budget, as the model adapter does: the step is opened by `before`, and closed by `after`. */
  const step = async (book: () => void, stepLease: ActionLease = lease) => {
    const verdict = await budget.before(task, stepLease);
    if (!verdict.ok) return verdict;
    await inActionExecution({ lease: stepLease, signal: new AbortController().signal, permit: async () => true } as never, async () => { book(); });
    await budget.after(task, stepLease);
    return verdict;
  };
  return { db, store, budget, step };
}
const usdOfYen = (yen: number) => yen / 160 - 1e-9; // just under the yen, so that sums of these round up to the sum of the yen

describe('estimated charges are booked apart from the confirmed spend', () => {
  it('books a request nobody confirmed as an estimate, and the answered ones as confirmed, with the same total as before', async () => {
    const { store, budget, step } = world(2000);
    await step(() => { budget.recordUsage(usdOfYen(30)); budget.recordUsage(usdOfYen(40), true); });
    expect(store.spent('t-mc')).toMatchObject({ steps: 1, yen: 30, estimatedYen: 40, openEstimatedYen: 40 });
    // An estimate alone is a paid step too (it may have been billed), at no confirmed yen.
    await step(() => { budget.recordUsage(usdOfYen(25), true); }, { ...lease, id: 'action-2' });
    expect(store.spent('t-mc')).toMatchObject({ steps: 2, yen: 30, estimatedYen: 65, openEstimatedYen: 65 });
  });

  it('replaces an estimate by the actual charge when it becomes known, without counting a step again', async () => {
    const { store, budget, step } = world(2000);
    await step(() => { budget.recordUsage(usdOfYen(10)); budget.recordUsage(usdOfYen(40), true); });
    expect(store.settleEstimate('t-mc', 'action-1:1', 12, at)).toBe(true);
    expect(store.spent('t-mc')).toMatchObject({ steps: 1, yen: 22, estimatedYen: 0, openEstimatedYen: 0 });
    expect(store.settleEstimate('t-mc', 'action-1:1', 12, at)).toBe(false); // an estimate is replaced once
  });
});

describe('the records of estimates remain (L-6)', () => {
  const rows = (db: DatabaseSync) => db.prepare('SELECT request_key,yen,acknowledged_at,settled_at,actual_yen FROM fca_task_budget_estimates ORDER BY request_key').all();

  it('keeps the settled estimate\'s row, marked settled with the actual charge, and no longer counts it as an estimate', async () => {
    const { db, store, budget, step } = world(2000);
    await step(() => { budget.recordUsage(usdOfYen(10)); budget.recordUsage(usdOfYen(40), true); });
    expect(store.settleEstimate('t-mc', 'action-1:1', 12, '2026-10-19T10:00:00.000Z')).toBe(true);
    expect(rows(db)).toEqual([expect.objectContaining({ request_key: 'action-1:1', yen: 40, settled_at: '2026-10-19T10:00:00.000Z', actual_yen: 12 })]);
    expect(store.spent('t-mc')).toMatchObject({ yen: 22, estimatedYen: 0, openEstimatedYen: 0 });
    expect(store.settleEstimate('t-mc', 'action-1:1', 99, at)).toBe(false); // once
    expect(rows(db)[0]).toMatchObject({ actual_yen: 12 });
    expect(store.spent('t-mc').yen).toBe(22);
  });

  it('does not add a new charge onto an estimate the owner was already asked about: it is a row of its own, open', async () => {
    const { db, store } = world(100);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 30, at);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 5, at); // still open: added to
    expect(store.spent('t-mc')).toMatchObject({ estimatedYen: 35, openEstimatedYen: 35 });
    store.acknowledgeEstimates('t-mc', at);
    expect(store.spent('t-mc')).toMatchObject({ estimatedYen: 35, openEstimatedYen: 0 });
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 7, at); // the same key, after the owner was asked
    expect(store.spent('t-mc')).toMatchObject({ estimatedYen: 42, openEstimatedYen: 7 });
    expect(rows(db).map(row => [row.request_key, row.yen, row.acknowledged_at])).toEqual([['k1', 35, at], ['k1+1', 7, null]]);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 3, at);
    expect(rows(db).map(row => [row.request_key, row.yen])).toEqual([['k1', 35], ['k1+1', 10]]);
  });

  it('does not add onto a settled estimate either, and settles each row by its own key', async () => {
    const { db, store } = world(100);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 30, at);
    expect(store.settleEstimate('t-mc', 'k1', 4, at)).toBe(true);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 9, at);
    expect(rows(db).map(row => [row.request_key, row.yen, row.actual_yen])).toEqual([['k1', 30, 4], ['k1+1', 9, null]]);
    expect(store.spent('t-mc')).toMatchObject({ yen: 4, estimatedYen: 9, openEstimatedYen: 9 });
    expect(store.settleEstimate('t-mc', 'k1+1', 2, at)).toBe(true);
    expect(store.spent('t-mc')).toMatchObject({ yen: 6, estimatedYen: 0 });
  });

  it('adds the two columns to a table an earlier build made, keeping what it held', () => {
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    db.exec(`CREATE TABLE fca_task_budget_estimates (task_id TEXT NOT NULL, request_key TEXT NOT NULL, scope_key TEXT NOT NULL, origin TEXT NOT NULL,
      yen REAL NOT NULL CHECK (yen >= 0), acknowledged_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, request_key));
      INSERT INTO fca_task_budget_estimates VALUES ('t-mc','old','owner','owner_request',12,NULL,'${at}');`);
    const store = new TaskBudgetStore(db);
    expect(store.spent('t-mc')).toMatchObject({ estimatedYen: 12, openEstimatedYen: 12 });
    expect(store.settleEstimate('t-mc', 'old', 3, at)).toBe(true);
    new TaskBudgetStore(db); // opening it again changes nothing
    expect(rows(db)).toEqual([expect.objectContaining({ request_key: 'old', settled_at: at, actual_yen: 3 })]);
  });
});

describe('the cap check counts estimates up to a share of the cap, and pauses instead of failing', () => {
  it('lets a task whose estimates are all it has run, however large they are, while the confirmed spend is low', async () => {
    const { store, budget } = world(100);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 500, at); // five times the cap, all unconfirmed
    expect(await budget.before(task, lease)).toEqual({ ok: true });
    expect(store.spent('t-mc').cappedAt).toBeNull();
  });

  it('pauses it when only the estimates (their share of 20%) would take it over the cap, and never marks it capped', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 85, at);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 300, at);
    expect(ESTIMATE_SHARE).toBe(0.2);
    const verdict = await budget.before(task, lease);
    expect(verdict).toMatchObject({ ok: false, code: 'task_estimates', report: expect.stringContaining('見積り') });
    const spent = store.spent('t-mc');
    expect(spent.cappedAt).toBeNull();
    expect(spent).toMatchObject({ yen: 85, estimatedYen: 300, openEstimatedYen: 0 }); // on record in full, reviewed once the owner was asked
    // The owner resumes: the confirmed spend alone decides, and the task runs.
    expect(await budget.before(task, lease)).toEqual({ ok: true });
  });

  it('does not pause while the share still fits: 79 confirmed and 300 estimated is 99 of 100', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 79, at);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 300, at);
    expect(await budget.before(task, lease)).toEqual({ ok: true });
  });

  it('still fails a task whose confirmed spend reached the cap, estimates or not', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 100, at);
    expect(await budget.before(task, lease)).toMatchObject({ ok: false, code: 'task_cap' });
    expect(store.spent('t-mc').cappedAt).toBe(at);
  });

  it('pauses again only for estimates booked after the owner was asked', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 85, at);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k1', 300, at);
    expect((await budget.before(task, lease)).ok).toBe(false);
    expect((await budget.before(task, lease)).ok).toBe(true);
    store.addEstimate('t-mc', 'owner', 'owner_request', 'k2', 40, at);
    expect(await budget.before(task, lease)).toMatchObject({ ok: false, code: 'task_estimates' });
  });
});

describe('room for one more request', () => {
  it('needs room for a request as large as the largest this step booked, equal included, not merely less than the cap', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 70, at);
    await budget.before(task, lease);
    await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => true } as never, async () => {
      expect(budget.room!(task, lease)).toBe(true); // nothing booked yet: one yen would fit
      budget.recordUsage(usdOfYen(10)); // 80 confirmed, and one more request as large as the largest (10 yen): 90
      expect(budget.room!(task, lease)).toBe(true);
      budget.recordUsage(usdOfYen(10)); // 90 + 10 is exactly the cap: it fits
      expect(budget.room!(task, lease)).toBe(true);
      budget.recordUsage(usdOfYen(1)); // 91 + 10 is over the cap, though 91 itself is still under it (the rule before this fix said yes)
      expect(budget.room!(task, lease)).toBe(false);
    });
  });

  it('is false when the next request could not fit, and counts estimates only up to their share', async () => {
    const { store, budget } = world(100);
    store.add('t-mc', 'owner', 'owner_request', 85, at);
    await budget.before(task, lease);
    await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => true } as never, async () => {
      budget.recordUsage(usdOfYen(10), true); // an estimate of 10 yen: 85 + 10 (the share is 20) + a next request of 10 > 100
      expect(budget.room!(task, lease)).toBe(false);
    });
    const { store: other, budget: wide } = world(2000);
    other.add('t-mc', 'owner', 'owner_request', 100, at);
    await wide.before(task, lease);
    await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => true } as never, async () => {
      wide.recordUsage(usdOfYen(150), true); // 100 + share(150 of 400) + next 150 is well inside 2000
      expect(wide.room!(task, lease)).toBe(true);
    });
  });
});
