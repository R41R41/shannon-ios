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
 * - a Minecraft request the owner made, as admitted (not a child it starts, nor another task that touched the body), has a larger
 *   cap, 2000 yen (owner answer of 2026-10-13, the new-architecture Minebot validation lane); its steps are bounded loosely so that
 *   the yen and the owner's stop end a run.
 */
export const OWNER_TASK_CAP = Object.freeze({ yen: 300, steps: 40 });
export const MINECRAFT_TASK_CAP = Object.freeze({ yen: 2000, steps: 300 });
export const OWN_TIME_TASK_CAP = Object.freeze({ yen: 150, steps: 10 });
/** Steps counted at once (each is removed when it settles; an abandoned one gives way to the newest). */
const IN_FLIGHT = 32;
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

/** The cap of one task: her own time's, an admitted Minecraft request's (lowered by an operator's cap), or an owner task's. */
function capOf(task: TaskView, options: { minecraftRequest?(task: TaskView): boolean; taskCapYen?(taskId: string): number | null }) {
  if (task.origin === 'own_time') return OWN_TIME_TASK_CAP;
  if (!options.minecraftRequest?.(task)) return OWNER_TASK_CAP;
  const lower = options.taskCapYen?.(task.id) ?? null;
  return lower !== null && lower > 0 && lower < MINECRAFT_TASK_CAP.yen ? { ...MINECRAFT_TASK_CAP, yen: lower } : MINECRAFT_TASK_CAP;
}

export function fcaBudget(options: {
  actions: ActionThreads; store: TaskBudgetStore; now(): string; ownTime?: OwnTimeBudgetPort | null;
  /** Whether the task is a Minecraft request the owner made, as admitted (`admittedMinecraftRequest`); absent, no task is. */
  minecraftRequest?(task: TaskView): boolean;
  /**
   * A lower yen cap for one admitted Minecraft request, or null: the operator's `--budget-yen` (2026-10-14). It only lowers the
   * request's cap, never raises it, and touches no other task.
   */
  taskCapYen?(taskId: string): number | null;
}): FcaBudget {
  const usd = new Map<string, number>();
  const counted = (task: TaskView) => task.origin === 'own_time' || (task.origin === 'owner_request' && ['research', 'generic'].includes(task.kind));
  return {
    // Only a step this budget opened is counted (calls outside a counted step are not kept), and at most a bounded few are in flight.
    recordUsage(cost) {
      const lease = currentActionExecution()?.lease.id;
      if (lease && usd.has(lease) && Number.isFinite(cost) && cost > 0) usd.set(lease, usd.get(lease)! + cost);
    },
    async before(task, lease) {
      if (!counted(task)) return { ok: true };
      if (usd.size >= IN_FLIGHT) usd.delete(usd.keys().next().value!);
      usd.set(lease.id, 0);
      const cap = capOf(task, options);
      const spent = options.store.spent(task.id);
      if (spent.steps >= cap.steps || spent.yen >= cap.yen) {
        usd.delete(lease.id);
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
      if (!reserved) usd.delete(lease.id);
      return reserved ? { ok: true, reservationId } : { ok: false, code: 'own_time_budget', report: '今日の自分の予算の残りが足りないので、ここで止めました。' };
    },
    async after(task, lease, reservationId) {
      const cost = usd.get(lease.id) ?? 0;
      usd.delete(lease.id);
      if (!counted(task)) return;
      const at = options.now();
      const yen = cost > 0 ? options.ownTime?.yen(cost) ?? Math.ceil(cost * 160) : 0;
      try {
        // The cap counts paid steps only (owner answer 3): a step that called no model costs nothing and is not a step of it.
        if (yen > 0) options.store.add(task.id, task.scopeKey, task.origin, yen, at);
        if (yen > 0 && task.origin === 'own_time') options.ownTime?.recordSpend(task.scopeKey, at, { yen, usd: cost });
      } finally {
        // The reservation is settled (or released with 0) whatever the records did.
        if (task.origin === 'own_time' && reservationId) await options.actions.settle(lease, reservationId, yen).catch(() => false);
      }
    },
  };
}
