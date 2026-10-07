import { WITHHELD_TOOL, isWithheldReason, withheldRail, type WithheldDraft } from '../../contracts/withheldActionContract.js';
import { autonomyDayKey, type AutonomyConfig } from './autonomyBudget.js';
import type { AutonomousActionRequest, AutonomyDecision } from './autonomyPolicy.js';

/**
 * What a refusal of her own time's gate is as a withheld action (Syzygy ADR-0008 §14, `contracts/withheldActionContract.ts`).
 * Core: approval and budget. Pure: the gate's own decision, read as closed values.
 */

/** Told each step her own time's gate did not allow (`ShannonAutonomyService.authorize`); never throws, never changes the decision. */
export type GateRefusalObserver = (scopeKey: string, request: Partial<AutonomousActionRequest>, decision: AutonomyDecision, at: string) => void;

/** The withheld action of a decision that did not allow the step; null for an allowed one. */
export function withheldOfDecision(request: Partial<AutonomousActionRequest>, decision: AutonomyDecision, at: string, config: Pick<AutonomyConfig, 'timeZone'>): WithheldDraft | null {
  if (decision.decision === 'allow' || !isWithheldReason(decision.reason)) return null;
  const symbol = (value: unknown) => (typeof value === 'string' && WITHHELD_TOOL.test(value) ? value : null);
  // What she tried: the tool, else the domain she declared (the gate's own domain may be the rule that caught it, `spending`).
  const tool = symbol(request.tool) ?? symbol(request.domain) ?? (decision.domain !== 'unknown' ? symbol(decision.domain) : null) ?? 'unknown';
  return {
    surface: 'autonomy', tool, reason: decision.reason, rail: withheldRail(decision.reason),
    ...(decision.reason === 'budget_exhausted' ? { retryAt: nextOwnerDayStart(at, config) } : {}),
  };
}

/** The first minute of the owner's next day (her budget's day), at or after an instant. */
export function nextOwnerDayStart(at: string, config: Pick<AutonomyConfig, 'timeZone'>): string {
  const start = Date.parse(at);
  const today = autonomyDayKey(at, config);
  let step = start;
  // Quarter hours up to a day and a half, then minutes back: every time zone's day starts on a minute.
  while (autonomyDayKey(new Date(step).toISOString(), config) === today && step - start < 36 * 3_600_000) step += 15 * 60_000;
  let minute = step - 15 * 60_000;
  while (autonomyDayKey(new Date(minute).toISOString(), config) === today && minute < step) minute += 60_000;
  return new Date(Math.floor(minute / 60_000) * 60_000).toISOString();
}
