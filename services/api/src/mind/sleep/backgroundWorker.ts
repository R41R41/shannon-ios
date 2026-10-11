import { randomUUID } from 'node:crypto';
import type { CompanionStateStore, SelfInterest } from '@shannon/cognition';
import type { BackgroundJobStore, ClaimedBackgroundJob } from './store/backgroundJobStore.js';
import { TurnRefinementProcessor } from './backgroundUpdates.js';
import type { ConversationStore, MemoryProposals } from '../memory/memoryPorts.js';
import { observeAsync, observeSync, observerHandoff, withObserverRun } from '../../infra/observer/observerContext.js';
import { isSqliteBusy } from '../../infra/sqlite/sqliteBusy.js';
import {
  consolidateSleepMemory,
  LocalRuleSleepMemoryAnalyzer,
  type SleepMemoryAnalyzer,
} from './sleepConsolidation.js';

export interface BackgroundWorkerOptions {
  workerId?: string;
  /** Fresh owner nights are admitted by the API Task Hub; durable bound jobs never return to this worker. */
  fcaSleepScope?: string;
  timeZone?: string;
  sleepHour?: number;
  leaseMilliseconds?: number;
  now?: () => Date;
  reportError?: (code: string) => void;
  minimumSleepMessages?: number;
  /** Shannon knowledge building piggybacks on each completed sleep batch; its failure never fails the batch. */
  knowledgeConsolidator?: { consolidate(scopeKey: string, startAt: string, endAt: string): Promise<unknown> };
  /** The replay summary of the turn's thread is refreshed after its refinement; its failure never fails the job. */
  replaySummarizer?: { refreshForTurn(scopeKey: string, experienceId: string): Promise<unknown> };
  /** Her impressions of the owner are updated after the turn's refinement; a failure never fails the job. */
  impressionUpdater?: { observeTurn(scopeKey: string, experienceId: string): Promise<unknown> };
  /** Syzygy ADR-0008 stage 3 (F5): what a turn teaches is proposed to the memory outbox (absent: written here, as it was). */
  memoryProposals?: MemoryProposals | null;
  stage5?: boolean;
  selfInterests?: (scopeKey: string) => readonly SelfInterest[];
}

export class ShannonBackgroundWorker {
  readonly workerId: string;
  private readonly processor: TurnRefinementProcessor;
  private readonly timeZone: string;
  private readonly sleepHour: number;
  private readonly leaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly reportError: (code: string) => void;
  private readonly minimumSleepMessages: number;
  private readonly knowledgeConsolidator: BackgroundWorkerOptions['knowledgeConsolidator'];
  private readonly replaySummarizer: BackgroundWorkerOptions['replaySummarizer'];
  private readonly impressionUpdater: BackgroundWorkerOptions['impressionUpdater'];
  private readonly stage5: boolean;
  private readonly selfInterests: BackgroundWorkerOptions['selfInterests'];
  private readonly localSleepAnalyzer = new LocalRuleSleepMemoryAnalyzer();
  private nextMaintenanceAt = 0;
  private readonly fcaSleepScope?: string;

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly jobStore: BackgroundJobStore,
    private readonly sleepAnalyzer: SleepMemoryAnalyzer,
    options: BackgroundWorkerOptions = {},
  ) {
    this.fcaSleepScope = options.fcaSleepScope;
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.processor = new TurnRefinementProcessor(stateStore, conversationStore, options.memoryProposals ?? null, options.stage5 ?? false);
    this.timeZone = validTimeZone(options.timeZone ?? 'Asia/Tokyo');
    this.sleepHour = validHour(options.sleepHour ?? 3);
    this.leaseMilliseconds = options.leaseMilliseconds ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.reportError = options.reportError ?? (code => console.error('Shannon worker job failed', code));
    this.minimumSleepMessages = Math.max(1, Math.trunc(options.minimumSleepMessages ?? 3));
    this.knowledgeConsolidator = options.knowledgeConsolidator;
    this.replaySummarizer = options.replaySummarizer;
    this.impressionUpdater = options.impressionUpdater;
    this.stage5 = options.stage5 ?? false;
    this.selfInterests = options.selfInterests;
  }

  async runOnce(): Promise<'processed' | 'idle' | 'failed'> {
    const current = this.now();
    if (current.getTime() >= this.nextMaintenanceAt) {
      try {
        this.jobStore.recoverUnqueuedTurnRefinements(current.toISOString());
        this.enqueueDueSleep(current);
        this.nextMaintenanceAt = current.getTime() + 30_000;
      } catch (error) {
        // A busy database (or any store error) is retried on the next poll; it never ends the worker loop.
        this.reportError(`MAINTENANCE_${safeErrorCode(error)}`);
      }
    }
    const nowIso = current.toISOString();
    const leaseUntil = new Date(current.getTime() + this.leaseMilliseconds).toISOString();
    let job: ClaimedBackgroundJob | null;
    try {
      job = this.jobStore.claimNextBackgroundJob(this.workerId, nowIso, leaseUntil, this.fcaSleepScope);
    } catch (error) {
      // Nothing was claimed: report it and let the loop wait its idle interval before the next claim.
      this.reportError(`CLAIM_${safeErrorCode(error)}`);
      return 'idle';
    }
    if (!job) return 'idle';
    try {
      await withObserverRun({ scopeKey: job.scopeKey, surface: 'background' }, () =>
        observeAsync(job.payload.kind === 'turn-refinement' ? 'memory' : 'sleep',
          { operation: job.payload.kind, attempt: job.attempts }, () => this.process(job, nowIso), () => ({ processed: true })));
      return 'processed';
    } catch (error) {
      const code = safeErrorCode(error);
      try {
        this.jobStore.failClaimedBackgroundJob(job, this.workerId, nowIso, code);
      } catch (recordError) {
        // The lease then simply expires and the job becomes claimable again, as after a crash.
        this.reportError(`FAIL_RECORD_${safeErrorCode(recordError)}`);
      }
      this.reportError(code);
      return 'failed';
    }
  }

  private async process(job: ClaimedBackgroundJob, completedAt: string): Promise<void> {
    if (job.payload.kind === 'turn-refinement') {
      const payload = job.payload;
      let processed = false;
      observeSync('store', { operation: payload.kind }, () => this.jobStore.completeClaimedBackgroundJob(job, this.workerId, completedAt, () => {
        this.processor.process(
          job.scopeKey,
          payload.userMessage,
          payload.experienceId,
          payload.observedAt ?? completedAt,
          [], payload.timeZone,
        );
        processed = true;
      }), () => ({ processed }));
      try {
        if (this.replaySummarizer) await observeAsync('memory', { operation: 'replay-summary' },
          () => this.replaySummarizer!.refreshForTurn(job.scopeKey, payload.experienceId), () => ({ completed: true }));
      } catch (error) {
        this.reportError(`REPLAY_SUMMARY_${safeErrorCode(error)}`);
      }
      try {
        if (this.impressionUpdater) await observeAsync('memory', { operation: 'impression-update' },
          () => this.impressionUpdater!.observeTurn(job.scopeKey, payload.experienceId), () => ({ completed: true }));
      } catch (error) {
        this.reportError(`IMPRESSIONS_${safeErrorCode(error)}`);
      }
      return;
    }
    const payload = job.payload;
    const messages = this.jobStore.dailyUserMessages(job.scopeKey, payload.startAt, payload.endAt);
    const outcome = await observeAsync('sleep', { operation: 'consolidate', messageCount: messages.length,
      analyzer: messages.length >= this.minimumSleepMessages ? this.sleepAnalyzer.mode : this.localSleepAnalyzer.mode }, () => consolidateSleepMemory(
      messages.length >= this.minimumSleepMessages ? this.sleepAnalyzer : this.localSleepAnalyzer,
      messages,
      this.stateStore.snapshot(job.scopeKey),
      payload.endAt,
      { scopeKey: job.scopeKey, occurredAt: completedAt, ...(this.stage5 ? { stage5: true, selfInterests: this.selfInterests?.(job.scopeKey) ?? [] } : {}) },
    ), value => ({ factCount: value.facts.length, relationshipCount: value.relationships.length,
      interestCount: value.interests.length, learnedCount: value.report.learned.length, updatedCount: value.report.updated.length }));
    observerHandoff('sleep', 'store', { operation: 'sleep-outcome' });
    observeSync('store', { operation: 'sleep-outcome' }, () => this.jobStore.applySleepOutcome(job, this.workerId, completedAt, outcome),
      () => ({ submitted: true }));
    try {
      if (this.knowledgeConsolidator) await observeAsync('memory', { operation: 'knowledge-consolidation' },
        () => this.knowledgeConsolidator!.consolidate(job.scopeKey, payload.startAt, payload.endAt), () => ({ completed: true }));
    } catch (error) {
      this.reportError(`KNOWLEDGE_CONSOLIDATION_${safeErrorCode(error)}`);
    }
  }

  private enqueueDueSleep(now: Date): void {
    const local = localParts(now, this.timeZone);
    const firstOffset = local.hour >= this.sleepHour ? 1 : 2;
    for (let offset = firstOffset; offset < firstOffset + 7; offset += 1) {
      const date = new Date(Date.UTC(local.year, local.month - 1, local.day) - offset * 86_400_000);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      const start = zonedMidnightToUtc(year, month, day, this.timeZone);
      const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
      const end = zonedMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), this.timeZone);
      const dayKey = `${year}-${pad(month)}-${pad(day)}`;
      this.jobStore.enqueueSleepConsolidations(dayKey, start.toISOString(), end.toISOString(), now.toISOString());
    }
  }
}

function validHour(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 23) throw new Error('SHANNON_SLEEP_HOUR is invalid');
  return value;
}

function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new Error('SHANNON_SLEEP_TIMEZONE is invalid');
  }
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const local = localParts(new Date(candidate), timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour);
    candidate += target - represented;
  }
  return new Date(candidate);
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  if (isSqliteBusy(error)) return 'SQLITE_BUSY';
  return /^[A-Z0-9_:-]{1,120}$/.test(error.message) ? error.message : error.name;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
