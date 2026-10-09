export interface TaskExternalEvent {
  /** Stable upstream identity, never generated again for a retry. */
  eventId: string;
  experienceIds: readonly string[];
  observedAt: string;
  text: string;
}
