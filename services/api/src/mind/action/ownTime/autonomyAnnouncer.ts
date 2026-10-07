/**
 * Tells the owner about a budget request the way Shannon tells them anything else:
 * one ordinary initiative message in her voice, in the most recent Talk.
 *
 * The request is limited to one per owner-local day by the budget store, and this
 * message is keyed by that request, so it never repeats. It does not use the day's
 * single spontaneous-topic slot, which stays with the initiative loop.
 *
 * Outside the proactive gate (Syzygy ADR-0008 stage 3, coordinator decision): the request is a system notice of her budget that the
 * owner must answer, not a message she starts about something, so neither the owner-active hold nor the topic check applies to it.
 */
export { budgetRequestMessage, SQLiteAutonomyAnnouncer } from './store/autonomyAnnouncerStore.js';

export interface AutonomyBudgetAnnouncement {
  requestId: string;
  dayKey: string;
  reason: string;
  requestedYen: number;
  capYen: number;
}

export interface AutonomyAnnouncer {
  /** Returns the Talk the message was added to, or null when nothing was sent. */
  announceBudgetRequest(scopeKey: string, announcement: AutonomyBudgetAnnouncement, at: string): string | null;
}

export class DisabledAutonomyAnnouncer implements AutonomyAnnouncer {
  announceBudgetRequest(): string | null { return null; }
}
