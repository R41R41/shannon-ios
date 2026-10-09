import { isOwnerOnly, ownerSpoke, visibleMemoryText } from '@shannon/cognition';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { MemoryWithholding } from '../mind/memory/memoryVisibilityPorts.js';
import type { DailyUserMessage } from '../mind/sleep/store/backgroundJobStore.js';
import { consolidateSleepMemory, LocalRuleSleepMemoryAnalyzer, type SleepMemoryAnalyzer, type SleepConsolidationOutcome } from '../mind/sleep/sleepConsolidation.js';
import type { SleepFcaPhaseHandler } from '../mind/sleep/sleepFcaPorts.js';
import type { createFcaSleepJobs } from './fcaSleepJobs.js';
import { stage5MemoryReaders } from './stage5MemoryWiring.js';

/** Model output stays within this step. Checkpoints contain only progress, never source text. */
export function createFcaSleepMemory(parts: { store: SQLiteShannonStore; jobs: ReturnType<typeof createFcaSleepJobs>;
  taskId: string; analyzer: SleepMemoryAnalyzer; minimumMessages: number; observeSources(ids: readonly string[]): void;
  assertCurrent(): boolean; now(): string }): SleepFcaPhaseHandler {
  let messages: readonly DailyUserMessage[] | null = null;
  let selfInterestSnapshot: string | undefined;
  const read = (scope: string, start: string, end: string) => {
    const state = parts.store.snapshot(scope);
    const candidates = parts.store.experienceCandidates(scope);
    const withheld = new MemoryWithholding(state, parts.store, scope, candidates);
    const visible = new Set(candidates.filter(item => isOwnerOnly(item.disclosure?.audience) && ownerSpoke(item.disclosure)
      && visibleMemoryText(state, item.id, item.summary) !== null && !withheld.withholdsExperience(item)).map(item => item.id));
    return parts.store.dailyUserMessages(scope, start, end).filter(message => message.sourceExperienceId && visible.has(message.sourceExperienceId));
  };
  return {
    async decide({ job, signal }) {
      signal.throwIfAborted(); messages = read(job.scopeKey, job.startAt, job.endAt);
      const readers = stage5MemoryReaders(parts.store);
      const selfInterests = readers.selfInterests?.(job.scopeKey);
      selfInterestSnapshot = JSON.stringify(selfInterests);
      const memory = parts.store.selfInterests();
      // Redacted rows contain only closed owner controls; never revive their hidden evidence.
      const interestSources = selfInterests?.filter(item => !item.forgotten && memory?.visible(job.scopeKey, item))
        .flatMap(item => [`self-interest:${item.id}`, ...item.evidenceRefs]) ?? [];
      parts.observeSources([...new Set([...messages.flatMap(message => message.sourceExperienceId ?? []), ...interestSources])]);
      return consolidateSleepMemory(messages.length >= parts.minimumMessages ? parts.analyzer : new LocalRuleSleepMemoryAnalyzer(),
        messages, parts.store.snapshot(job.scopeKey), job.endAt, { scopeKey: job.scopeKey, occurredAt: parts.now(), signal,
          ...(readers.stage5 ? { stage5: true, selfInterests } : {}) });
    },
    async apply(answer, { job, signal }) {
      return underWriteLock(parts.store.fcaDatabase(), null, '', () => {
        signal.throwIfAborted(); if (!messages) throw new Error('FCA_SLEEP_MEMORY_RECEIPT_LOST');
        if (!parts.assertCurrent()) throw new Error('FCA_SLEEP_SOURCE_WITHHELD');
        const ids = new Set(read(job.scopeKey, job.startAt, job.endAt).map(message => message.sourceExperienceId));
        if (messages.some(message => !ids.has(message.sourceExperienceId))) throw new Error('FCA_SLEEP_SOURCE_WITHHELD');
        // The same write lock covers the fresh owner revision/generation/visibility check and proposal submission.
        if (JSON.stringify(stage5MemoryReaders(parts.store).selfInterests?.(job.scopeKey)) !== selfInterestSnapshot)
          throw new Error('FCA_SLEEP_SELF_INTEREST_CHANGED');
        parts.store.applySleepOutcome(parts.jobs.claimed(job), parts.jobs.workerId(parts.taskId), parts.now(), answer as SleepConsolidationOutcome, false);
        return { done: true, summary: '記憶整理の結果を既存の記憶ライターへ提出しました。' };
      }, 'fca_sleep_memory_apply');
    },
  };
}
