import type { UserFact } from '@shannon/cognition';

export interface TurnRefinementJobPayload {
  kind: 'turn-refinement';
  experienceId: string;
  userMessage: string;
}

export interface SleepConsolidationJobPayload {
  kind: 'sleep-consolidation';
  dayKey: string;
  startAt: string;
  endAt: string;
}

export type BackgroundJobPayload = TurnRefinementJobPayload | SleepConsolidationJobPayload;

export interface ClaimedBackgroundJob {
  id: string;
  scopeKey: string;
  payload: BackgroundJobPayload;
  attempts: number;
}

export interface DailyUserMessage {
  content: string;
  observedAt: string;
}

export interface BackgroundJobStore {
  enqueueTurnRefinement(scopeKey: string, experienceId: string, userMessage: string, observedAt: string): void;
  recoverUnqueuedTurnRefinements(nowIso: string): number;
  enqueueSleepConsolidations(dayKey: string, startAt: string, endAt: string, nowIso: string): number;
  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string): ClaimedBackgroundJob | null;
  completeClaimedBackgroundJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    operation: () => void,
  ): void;
  failClaimedBackgroundJob(job: ClaimedBackgroundJob, workerId: string, nowIso: string, errorCode: string): void;
  dailyUserMessages(scopeKey: string, startAt: string, endAt: string): readonly DailyUserMessage[];
  applySleepFacts(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    facts: readonly UserFact[],
  ): void;
  pendingBackgroundJobCount(): number;
}
