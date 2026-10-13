import { VISION_LIMITS } from '../../contracts/visionContract.js';
import type { VisionBudgetPurpose, VisionDayTotals } from './store/visionBudgetStore.js';

/**
 * The vision budget and its degrade levels (Syzygy ADR-0011 §7.2 and §7.3). Every paid vision call (Decisions, the notice's line,
 * an escalated look) is reserved before it is sent; a call whose usage is unknown keeps its reservation. The level is computed from
 * the day's spend, the recent Decisions latency and failures, and the stop switch:
 *
 * | level | signal | effect |
 * |---|---|---|
 * | 0 | normal | everything runs |
 * | 1 | 80 % of the daily cap, or the decision p95 above twice its target | fewer notices, no escalation |
 * | 2 | the cap, or failures in a row | no image decisions; the camera stops watching; FCA hears 「今は見えない」 |
 * | 3 | the stop switch | no decision at all |
 */
export type VisionDegradeLevel = 0 | 1 | 2 | 3;

export interface VisionBudgetLedger {
  totals(scopeKey: string, day: string): VisionDayTotals;
  reserve(scopeKey: string, day: string, purpose: VisionBudgetPurpose, amountUsd: number, capUsd: number, at: string): string | null;
  settle(reservationId: string, actualUsd: number, at: string): boolean;
  hold(reservationId: string, knownUsd: number | null, at: string): boolean;
}

export const VISION_BUDGET_DEFAULTS = Object.freeze({
  /** ¥300 at ¥150 to the dollar. */
  dailyCapUsd: VISION_LIMITS.dailyCapYen / VISION_LIMITS.yenPerUsd,
  /** The measured call was about 600 input tokens ($0.00006); the reservation is a wide upper bound until usage is known. */
  decisionReserveUsd: 0.001,
  /** A notice's one short line from the voice path's model (held at this bound: its usage is booked by the model's own route). */
  noticeLineReserveUsd: 0.003,
  /** An escalated look: one image to the conversation model. */
  escalateReserveUsd: 0.01,
  /** ADR-0011 §4.4 / §10 answer 4: the image Decisions p95 target. */
  decisionP95TargetMs: 2_000,
  /** Failures in a row that drop to level 2, and how long level 2 lasts after the last one. */
  failuresForLevel2: 3,
  failureCooldownMs: 5 * 60_000,
  /** Decisions whose time counts toward the p95. */
  latencyWindow: 20,
});

export interface VisionBudgetOptions {
  ledger: VisionBudgetLedger;
  /** The owner's day of an instant (his time zone). */
  dayKey(at: string): string;
  /** The stop switch: level 3 while it is on. */
  halted(): boolean;
  dailyCapUsd?: number;
}

export interface VisionDegradeSignals { spentUsd: number; capUsd: number; p95Ms: number | null; failuresInRow: number; lastFailureAt: number | null }

/** The level for the signals at `now` (pure). */
export function visionDegradeLevel(signals: VisionDegradeSignals, halted: boolean, now: number): VisionDegradeLevel {
  if (halted) return 3;
  const failing = signals.failuresInRow >= VISION_BUDGET_DEFAULTS.failuresForLevel2 && signals.lastFailureAt !== null
    && now - signals.lastFailureAt < VISION_BUDGET_DEFAULTS.failureCooldownMs;
  if (signals.spentUsd >= signals.capUsd || failing) return 2;
  const slow = signals.p95Ms !== null && signals.p95Ms > 2 * VISION_BUDGET_DEFAULTS.decisionP95TargetMs;
  return signals.spentUsd >= 0.8 * signals.capUsd || slow ? 1 : 0;
}

/** p95 of a list of milliseconds (nearest rank), or null when empty. */
export function p95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? null;
}

export interface VisionReservation { id: string; purpose: VisionBudgetPurpose; amountUsd: number }

export class VisionBudget {
  private readonly latencies: number[] = [];
  private failuresInRow = 0;
  private lastFailureAt: number | null = null;
  readonly capUsd: number;

  constructor(private readonly options: VisionBudgetOptions) {
    this.capUsd = options.dailyCapUsd ?? VISION_BUDGET_DEFAULTS.dailyCapUsd;
  }

  spentUsd(scopeKey: string, at: string): number {
    const totals = this.options.ledger.totals(scopeKey, this.options.dayKey(at));
    return totals.settledUsd + totals.heldUsd + totals.reservedUsd;
  }

  level(scopeKey: string, at: string): VisionDegradeLevel {
    const signals: VisionDegradeSignals = { spentUsd: this.spentUsd(scopeKey, at), capUsd: this.capUsd, p95Ms: p95(this.latencies),
      failuresInRow: this.failuresInRow, lastFailureAt: this.lastFailureAt };
    return visionDegradeLevel(signals, this.options.halted(), Date.parse(at));
  }

  /** Reserves before a paid call, or null when the cap would be passed. */
  reserve(scopeKey: string, purpose: VisionBudgetPurpose, at: string): VisionReservation | null {
    const amountUsd = purpose === 'decision' ? VISION_BUDGET_DEFAULTS.decisionReserveUsd
      : purpose === 'notice_line' ? VISION_BUDGET_DEFAULTS.noticeLineReserveUsd : VISION_BUDGET_DEFAULTS.escalateReserveUsd;
    const id = this.options.ledger.reserve(scopeKey, this.options.dayKey(at), purpose, amountUsd, this.capUsd, at);
    return id ? { id, purpose, amountUsd } : null;
  }

  /** A known cost settles the reservation; an unknown one keeps it. Never throws (a ledger error keeps the reservation). */
  close(reservation: VisionReservation, usage: { usageComplete: boolean; estimatedCostUsd: number } | null, at: string): void {
    try {
      if (usage?.usageComplete) this.options.ledger.settle(reservation.id, usage.estimatedCostUsd, at);
      else this.options.ledger.hold(reservation.id, usage ? usage.estimatedCostUsd : null, at);
    } catch { /* the row stays `reserved`, which keeps counting */ }
  }

  /** A Decisions call ended: its time counts toward the p95, and a failure toward level 2. */
  observed(outcome: { ok: boolean; elapsedMs: number | null }, now: number): void {
    if (outcome.elapsedMs !== null && Number.isFinite(outcome.elapsedMs)) {
      this.latencies.push(outcome.elapsedMs);
      if (this.latencies.length > VISION_BUDGET_DEFAULTS.latencyWindow) this.latencies.shift();
    }
    if (outcome.ok) {
      this.failuresInRow = 0;
      return;
    }
    this.failuresInRow += 1;
    this.lastFailureAt = now;
  }
}
