import type { SleepConsolidationOutcome } from '../sleepConsolidation.js';

export interface TurnRefinementJobPayload {
  kind: 'turn-refinement';
  experienceId: string;
  userMessage: string;
  observedAt?: string;
  timeZone?: string;
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
  sourceExperienceId?: string;
}

export interface BackgroundJobStore {
  enqueueTurnRefinement(scopeKey: string, experienceId: string, userMessage: string, observedAt: string, timeZone?: string): void;
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
  applySleepOutcome(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    outcome: SleepConsolidationOutcome,
  ): void;
  pendingBackgroundJobCount(): number;
}
