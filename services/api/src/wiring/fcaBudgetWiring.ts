import type { ActionLease, ActionThreads } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import type { TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskBudgetStore } from '../mind/action/taskRuntime/store/taskBudgetStore.js';

/**
 * One budget for FCA steps (Syzygy ADR-0009 stage 2, E3; owner answer 3):
 * - a task the owner asked for has a cap of its own, 300 yen and 40 steps; at the cap it stops with a report, and it never
 *   touches her own budget;
 * - an own-time task (E4) reserves each step from her day's budget (2000 yen) before it runs and settles the actual yen after,
 *   through the same reservations as her other own-time steps, and stops when the reservation is refused or its own cap is hit.
 */
export const OWNER_TASK_CAP = Object.freeze({ yen: 300, steps: 40 });
export const OWN_TIME_TASK_CAP = Object.freeze({ yen: 150, steps: 10 });
/** The reservation of one own-time FCA step: a decision of the FCA model with its history (an upper estimate). */
export const OWN_TIME_STEP_ESTIMATE_YEN = 30;

export interface OwnTimeBudgetPort {
  dayKey(at: string): string;
  budget(scopeKey: string): { capYen: number; spentYen: number; exhausted: boolean };
  /** The actual cost of a settled step, written where her day's spend is counted. */
  recordSpend(scopeKey: string, at: string, spend: { yen: number; usd: number }): void;
  yen(usd: number): number;
}

export type BudgetVerdict = { ok: true; reservationId?: string } | { ok: false; code: 'task_cap' | 'own_time_budget'; report: string };

export interface FcaBudget {
  /** Adds a paid call's cost to the step running in this execution. */
  recordUsage(usd: number): void;
  before(task: TaskView, lease: ActionLease): Promise<BudgetVerdict>;
  after(task: TaskView, lease: ActionLease, reservationId?: string): Promise<void>;
}

const capped = (task: TaskView, cap: { yen: number; steps: number }) =>
  `「${task.title.slice(0, 60)}」は1件の上限（${cap.yen}円・${cap.steps}歩）に達したので、ここで止めました。`;

export function fcaBudget(options: { actions: ActionThreads; store: TaskBudgetStore; now(): string; ownTime?: OwnTimeBudgetPort | null }): FcaBudget {
  const usd = new Map<string, number>();
  const counted = (task: TaskView) => task.origin === 'own_time' || (task.origin === 'owner_request' && ['research', 'generic'].includes(task.kind));
  return {
    recordUsage(cost) {
      const lease = currentActionExecution()?.lease.id;
      if (lease && Number.isFinite(cost) && cost > 0) usd.set(lease, (usd.get(lease) ?? 0) + cost);
    },
    async before(task, lease) {
      if (!counted(task)) return { ok: true };
      const cap = task.origin === 'own_time' ? OWN_TIME_TASK_CAP : OWNER_TASK_CAP;
      const spent = options.store.spent(task.id);
      if (spent.steps >= cap.steps || spent.yen >= cap.yen) {
        options.store.capped(task.id, task.scopeKey, task.origin, options.now());
        return { ok: false, code: 'task_cap', report: capped(task, cap) };
      }
      if (task.origin !== 'own_time') return { ok: true };
      const own = options.ownTime;
      const budget = own?.budget(task.scopeKey);
      const reservationId = `fca:${lease.id}:${lease.generation}`;
      const reserved = own && budget && !budget.exhausted
        && await options.actions.reserve(lease, reservationId, own.dayKey(options.now()), OWN_TIME_STEP_ESTIMATE_YEN, budget.capYen, budget.spentYen)
          .catch(() => false);
      return reserved ? { ok: true, reservationId } : { ok: false, code: 'own_time_budget', report: '今日の自分の予算の残りが足りないので、ここで止めました。' };
    },
    async after(task, lease, reservationId) {
      const cost = usd.get(lease.id) ?? 0;
      usd.delete(lease.id);
      if (!counted(task)) return;
      const at = options.now();
      const yen = options.ownTime?.yen(cost) ?? Math.ceil(cost * 160);
      options.store.add(task.id, task.scopeKey, task.origin, yen, at);
      if (task.origin !== 'own_time' || !reservationId) return;
      try { options.ownTime?.recordSpend(task.scopeKey, at, { yen, usd: cost }); } catch { /* the reservation still settles */ }
      await options.actions.settle(lease, reservationId, yen).catch(() => false);
    },
  };
}
