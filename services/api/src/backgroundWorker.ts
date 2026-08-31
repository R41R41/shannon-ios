import { randomUUID } from 'node:crypto';
import type { CompanionStateStore } from '@shannon/cognition';
import type { BackgroundJobStore, ClaimedBackgroundJob } from './backgroundJobStore.js';
import { TurnRefinementProcessor } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import { consolidateUserFacts, type SleepMemoryAnalyzer } from './sleepConsolidation.js';

export interface BackgroundWorkerOptions {
  workerId?: string;
  timeZone?: string;
  sleepHour?: number;
  leaseMilliseconds?: number;
  now?: () => Date;
  reportError?: (code: string) => void;
}

export class ShannonBackgroundWorker {
  readonly workerId: string;
  private readonly processor: TurnRefinementProcessor;
  private readonly timeZone: string;
  private readonly sleepHour: number;
  private readonly leaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly reportError: (code: string) => void;
  private nextMaintenanceAt = 0;

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly jobStore: BackgroundJobStore,
    private readonly sleepAnalyzer: SleepMemoryAnalyzer,
    options: BackgroundWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.processor = new TurnRefinementProcessor(stateStore, conversationStore);
    this.timeZone = validTimeZone(options.timeZone ?? 'Asia/Tokyo');
    this.sleepHour = validHour(options.sleepHour ?? 3);
    this.leaseMilliseconds = options.leaseMilliseconds ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.reportError = options.reportError ?? (code => console.error('Shannon worker job failed', code));
  }

  async runOnce(): Promise<'processed' | 'idle' | 'failed'> {
    const current = this.now();
    if (current.getTime() >= this.nextMaintenanceAt) {
      this.jobStore.recoverUnqueuedTurnRefinements(current.toISOString());
      this.enqueueDueSleep(current);
      this.nextMaintenanceAt = current.getTime() + 30_000;
    }
    const nowIso = current.toISOString();
    const leaseUntil = new Date(current.getTime() + this.leaseMilliseconds).toISOString();
    const job = this.jobStore.claimNextBackgroundJob(this.workerId, nowIso, leaseUntil);
    if (!job) return 'idle';
    try {
      await this.process(job, nowIso);
      return 'processed';
    } catch (error) {
      const code = safeErrorCode(error);
      this.jobStore.failClaimedBackgroundJob(job, this.workerId, nowIso, code);
      this.reportError(code);
      return 'failed';
    }
  }

  private async process(job: ClaimedBackgroundJob, completedAt: string): Promise<void> {
    if (job.payload.kind === 'turn-refinement') {
      const payload = job.payload;
      this.jobStore.completeClaimedBackgroundJob(job, this.workerId, completedAt, () => {
        this.processor.process(job.scopeKey, payload.userMessage, payload.experienceId);
      });
      return;
    }
    const messages = this.jobStore.dailyUserMessages(job.scopeKey, job.payload.startAt, job.payload.endAt);
    const facts = await consolidateUserFacts(
      this.sleepAnalyzer,
      messages,
      this.stateStore.snapshot(job.scopeKey),
      job.payload.endAt,
    );
    this.jobStore.applySleepFacts(job, this.workerId, completedAt, facts);
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
  return /^[A-Z0-9_:-]{1,120}$/.test(error.message) ? error.message : error.name;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
