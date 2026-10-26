import type { ActionLease, ActionThreads } from '../contracts/actionThreadContract.js';
import { currentActionExecution } from '../infra/context/actionExecution.js';
import type { TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskBudgetStore } from '../mind/action/taskRuntime/store/taskBudgetStore.js';
import { estimatesPausedReport } from './taskPauseNotice.js';

/**
 * One budget for FCA steps (Syzygy ADR-0009 stage 2, E3; owner answer 3):
 * - a task the owner asked for has a cap of its own, 300 yen and 40 steps; at the cap it stops with a report, and it never
 *   touches her own budget;
 * - an own-time task (E4) reserves each step from her day's budget (2000 yen) before it runs and settles the actual yen after,
 *   through the same reservations as her other own-time steps, and stops when the reservation is refused or its own cap is hit.
 * - a Minecraft request the owner made, as admitted (not a child it starts, nor another task that touched the body), has a larger
 *   cap, 2000 yen (owner answer of 2026-10-13, the new-architecture Minebot validation lane); its steps are bounded loosely so that
 *   the yen and the owner's stop end a run.
 *
 * Confirmed and estimated charges are kept apart (Minebot parity audit M-4, 2026-10-19). A request that timed out or lost its
 * connection may have been billed or not; it is booked at an upper bound as an ESTIMATE, in the task's own bucket
 * (`fca_task_budget_estimates`), and stays on record in full. The cap check counts the confirmed yen, plus the not yet reviewed
 * estimates up to `ESTIMATE_SHARE` (20%) of the cap: estimates alone can never fail a task. When only the estimates would take the task
 * over its cap, the task is PAUSED (`task_estimates`; the owner may resume it), the estimates so far are marked as reviewed, and the
 * confirmed spend alone then decides, as before. An actual charge that becomes known replaces its estimate
 * (`TaskBudgetStore.settleEstimate`).
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

/** `task_estimates`: only unconfirmed charges would take the task over its cap; it is paused (the owner may resume it), not failed. */
export type BudgetVerdict = { ok: true; reservationId?: string }
  | { ok: false; code: 'task_cap' | 'own_time_budget' | 'task_estimates'; report: string };

/** The most of a task's cap that charges nobody confirmed can take in the cap check. */
export const ESTIMATE_SHARE = 0.2;
/** What one more request is assumed to cost when this step has booked none yet (yen). */
const NEXT_REQUEST_FLOOR_YEN = 1;

export interface FcaBudget {
  /**
   * Adds a paid call's cost to the step running in this execution. `estimated`: the cost is an upper bound of a charge nobody confirmed
   * (a request that timed out or lost its connection, or an answer without usable usage), booked apart from the confirmed spend.
   */
  recordUsage(usd: number, estimated?: boolean): void;
  before(task: TaskView, lease: ActionLease): Promise<BudgetVerdict>;
  after(task: TaskView, lease: ActionLease, reservationId?: string): Promise<void>;
  /**
   * Whether the step holding this lease still has room, inside its task's cap, for one more request: what the task has confirmed, this
   * step's confirmed and estimated bookings so far (the estimates up to their share of the cap) and the largest single request this
   * step booked (at least one yen) must fit within the cap, equal included. A decision's retries stop where it turns false
   * (`FcaStepPorts.retryAllowed`). Absent: always true.
   */
  room?(task: TaskView, lease: ActionLease): boolean;
}

/** One step's bookings in flight, in USD: what is confirmed, what is an unconfirmed upper bound, and the largest single request. */
interface Booked { confirmed: number; estimated: number; largest: number }

const capped = (task: TaskView, cap: { yen: number; steps: number }) =>
  `「${task.title.slice(0, 60)}」は1件の上限（${cap.yen}円・${cap.steps}歩）に達したので、ここで止めました。`;

const estimatesPaused = (task: TaskView, cap: { yen: number }) => estimatesPausedReport(task.title, cap.yen);

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
   * A lower yen cap for one admitted Minecraft request, or null: the operator's cap, which is its `--budget-yen` (2026-10-14) or the
   * newest `minecraft budget` change to it (2026-10-26; `OperatorAuditStore.budgetYen`, read at every check, so a change holds from the
   * task's next decision). It only lowers the request's cap (an operator may not raise it above the request cap), and touches no other task.
   */
  taskCapYen?(taskId: string): number | null;
}): FcaBudget {
  const booked = new Map<string, Booked>();
  const counted = (task: TaskView) => task.origin === 'own_time' || (task.origin === 'owner_request' && ['research', 'generic'].includes(task.kind));
  const yenOf = (cost: number) => cost > 0 ? options.ownTime?.yen(cost) ?? Math.ceil(cost * 160) : 0;
  /** The unconfirmed yen that count toward the cap check: a bounded share of it, so that estimates alone never end a task. */
  const share = (estimatedYen: number, cap: { yen: number }) => Math.min(estimatedYen, cap.yen * ESTIMATE_SHARE);
  return {
    // Only a step this budget opened is counted (calls outside a counted step are not kept), and at most a bounded few are in flight.
    recordUsage(cost, estimated = false) {
      const lease = currentActionExecution()?.lease.id;
      const mine = lease ? booked.get(lease) : undefined;
      if (!mine || !Number.isFinite(cost) || cost <= 0) return;
      if (estimated) mine.estimated += cost;
      else mine.confirmed += cost;
      mine.largest = Math.max(mine.largest, cost);
    },
    async before(task, lease) {
      if (!counted(task)) return { ok: true };
      if (booked.size >= IN_FLIGHT) booked.delete(booked.keys().next().value!);
      booked.set(lease.id, { confirmed: 0, estimated: 0, largest: 0 });
      const cap = capOf(task, options);
      const spent = options.store.spent(task.id);
      if (spent.steps >= cap.steps || spent.yen >= cap.yen) {
        booked.delete(lease.id);
        options.store.capped(task.id, task.scopeKey, task.origin, options.now());
        return { ok: false, code: 'task_cap', report: capped(task, cap) };
      }
      // Only the unconfirmed charges would take it over: the owner is asked (the task is paused), nothing fails, and from here those
      // estimates are reviewed and no longer count toward a pause. The confirmed spend alone decides the cap, as before.
      if (spent.yen + share(spent.openEstimatedYen, cap) >= cap.yen) {
        booked.delete(lease.id);
        options.store.acknowledgeEstimates(task.id, options.now());
        return { ok: false, code: 'task_estimates', report: estimatesPaused(task, cap) };
      }
      if (task.origin !== 'own_time') return { ok: true };
      const own = options.ownTime;
      const budget = own?.budget(task.scopeKey);
      const reservationId = `fca:${lease.id}:${lease.generation}`;
      const reserved = own && budget && !budget.exhausted
        && await options.actions.reserve(lease, reservationId, own.dayKey(options.now()), OWN_TIME_STEP_ESTIMATE_YEN, budget.capYen, budget.spentYen)
          .catch(() => false);
      if (!reserved) booked.delete(lease.id);
      return reserved ? { ok: true, reservationId } : { ok: false, code: 'own_time_budget', report: '今日の自分の予算の残りが足りないので、ここで止めました。' };
    },
    room(task, lease) {
      const mine = booked.get(lease.id);
      if (!counted(task) || !mine) return true;
      const cap = capOf(task, options), spent = options.store.spent(task.id);
      const confirmed = spent.yen + yenOf(mine.confirmed);
      const unconfirmed = share(spent.openEstimatedYen + yenOf(mine.estimated), cap);
      // Room for one more request, not merely for less than the cap: the largest this step has booked (a request about as large again).
      return confirmed + unconfirmed + Math.max(NEXT_REQUEST_FLOOR_YEN, yenOf(mine.largest)) <= cap.yen;
    },
    async after(task, lease, reservationId) {
      const mine = booked.get(lease.id) ?? { confirmed: 0, estimated: 0, largest: 0 };
      booked.delete(lease.id);
      if (!counted(task)) return;
      const at = options.now();
      // The total is what it always was; the part that is an upper bound of an unconfirmed charge is booked apart from the confirmed one.
      const yen = yenOf(mine.confirmed + mine.estimated), estimatedYen = Math.min(yen, yenOf(mine.estimated));
      try {
        // The cap counts paid steps only (owner answer 3): a step that called no model costs nothing and is not a step of it.
        if (yen > 0) options.store.add(task.id, task.scopeKey, task.origin, yen - estimatedYen, at);
        if (estimatedYen > 0) options.store.addEstimate(task.id, task.scopeKey, task.origin, `${lease.id}:${lease.generation}`, estimatedYen, at);
        // Her day's budget is her real money: it counts everything that may have been charged.
        if (yen > 0 && task.origin === 'own_time') options.ownTime?.recordSpend(task.scopeKey, at, { yen, usd: mine.confirmed + mine.estimated });
      } finally {
        // The reservation is settled (or released with 0) whatever the records did.
        if (task.origin === 'own_time' && reservationId) await options.actions.settle(lease, reservationId, yen).catch(() => false);
      }
    },
  };
}
