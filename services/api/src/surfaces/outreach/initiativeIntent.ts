import { chmodSync, existsSync } from 'node:fs';
import type { ProactiveDeliveryIntent } from '../../mind/attention/attentionPorts.js';
import type { InitiativeEvaluationSummary, InitiativeLoopResult } from './store/initiativeStore.js';

/**
 * Small parts of the initiative store (`store/initiativeStore.ts`), apart for its size.
 *
 * `initiativeIntent`: what the proactive gate (Syzygy ADR-0008 stage 3, owner answer 2) is told of one initiative where it would be
 * written. The loop chooses and writes at once, so the intent arises when it is written (the gate's expiry is for her own time's
 * thoughts); a promise is `promise`, a goal she follows `follow_up`, a topic of the world `world`, each with its item as the subject.
 * Its topic is what varies (the item's title and summary), not the fixed wording around it (stage 3 review).
 */
export function initiativeIntent(candidate: { source_id: string; item_id: string; title: string; summary?: string | null }, at: string): ProactiveDeliveryIntent {
  return {
    point: 'initiative', reason: candidate.source_id === 'commitment' ? 'promise' : candidate.source_id === 'intent' ? 'follow_up' : 'world',
    subject: candidate.item_id, arisenAt: at, text: [candidate.title, candidate.summary ?? ''].join(' ').trim() || null,
  };
}

/** What writing one initiative came to: written, not written for a reason of the store, or held by the gate with its code. */
export type InitiativeWrite = 'sent' | 'skipped' | `held:${string}`;

/**
 * The first of `candidates` that is written, in order (stage 3 review M4): a hold of that candidate (repeat, expiry, reused topic)
 * moves on to the next; a hold that would hold any of them (the owner active, the gate's own error) stops.
 */
export function firstWritten<T>(candidates: readonly T[], write: (candidate: T) => InitiativeWrite): InitiativeWrite | 'none' {
  for (const candidate of candidates) {
    const written = write(candidate);
    if (written === 'sent' || written === 'skipped' || written === 'held:owner_active' || written === 'held:gate_error') return written;
  }
  return 'none';
}

/** The evaluation summary of the loop's recent runs (moved unchanged out of the store for its size). */
export function evaluationSummary(
  days: number, rows: Array<{ considered: number; sent: number; repeated_suppressed: number; stopped: string | null }>, sourceRows: Array<{ source_title: string; count: number }>,
): InitiativeEvaluationSummary {
  const stopped = {
    'quiet-hours': 0, 'no-owner': 0, 'today-is-enough': 0,
    'recent-conversation': 0, 'nothing-worth-saying': 0, 'reserved-for-commitment': 0,
  } satisfies Record<Exclude<InitiativeLoopResult['stopped'], null>, number>;
  for (const row of rows) if (row.stopped && row.stopped in stopped) stopped[row.stopped as keyof typeof stopped] += 1;
  const eligible = rows.filter(row => row.stopped !== 'quiet-hours' && row.stopped !== 'no-owner');
  const delivered = rows.reduce((sum, row) => sum + Number(row.sent), 0);
  return Object.freeze({
    windowDays: days,
    runs: rows.length,
    eligibleRuns: eligible.length,
    delivered,
    deliveryRate: eligible.length ? Math.round((delivered / eligible.length) * 10_000) / 10_000 : 0,
    candidatesConsidered: rows.reduce((sum, row) => sum + Number(row.considered), 0),
    repeatedCandidatesSuppressed: rows.reduce((sum, row) => sum + Number(row.repeated_suppressed), 0),
    deliveredBySource: Object.freeze(sourceRows.map(row => Object.freeze({
      sourceTitle: row.source_title,
      count: Number(row.count),
    }))),
    stopped: Object.freeze(stopped),
  });
}

/** The database and its WAL files readable by the service user only (unchanged from the store). */
export function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}
