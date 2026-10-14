/**
 * The shapes of the initiative store (moved unchanged out of `initiativeStore.ts` for its size, 2026-10-14); the store re-exports
 * them, so every reader imports them as before.
 */
export interface InitiativeMessage {
  id: string;
  threadId: string;
  content: string;
  expression: 'curious' | 'excited' | 'thinking';
  sourceTitle: string;
  sourceURL: string;
  createdAt: string;
  readAt?: string;
  /** Set when the message is what she says about one look at the room (`bodyLook.ts`). */
  bodyLookId?: string;
  /**
   * Whether the message is about what she saw of the room (`roomLookSource.ts`): a notice outside the Talk must not
   * quote it. Always sent by this store (true or false), so a client can tell this server from one without the field.
   */
  roomLook?: boolean;
  /** `reach_out` with its `reason` when she started the message on her own from her own activity (`reachOutDelivery.ts`). */
  kind?: 'reach_out'; reason?: string;
}

export interface InitiativeInbox {
  unreadMessages(scopeKey: string): readonly InitiativeMessage[];
  markRead(scopeKey: string, threadId?: string, readAt?: string): number;
}

export type InitiativeLoopResult = Readonly<{
  considered: number;
  sent: number;
  stopped: 'quiet-hours' | 'no-owner' | 'today-is-enough' | 'recent-conversation' | 'nothing-worth-saying'
    | 'reserved-for-commitment' | null;
}>;

export interface InitiativeEvaluationSummary {
  windowDays: number;
  runs: number;
  eligibleRuns: number;
  delivered: number;
  deliveryRate: number;
  candidatesConsidered: number;
  repeatedCandidatesSuppressed: number;
  deliveredBySource: readonly Readonly<{ sourceTitle: string; count: number }>[];
  stopped: Readonly<Record<Exclude<InitiativeLoopResult['stopped'], null>, number>>;
}

export interface InitiativeEvaluationReader {
  initiativeEvaluation(windowDays?: number, at?: string): InitiativeEvaluationSummary;
}
