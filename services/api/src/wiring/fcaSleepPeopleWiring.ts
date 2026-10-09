import type { PlatformConversationSummarizer } from '../surfaces/platform/platformPeopleSummaries.js';
import type { ImpressionUpdater, ImpressionOutcome } from '../mind/memory/impressionUpdater.js';
import type { SleepFcaPhaseHandler } from '../mind/sleep/sleepFcaPorts.js';

interface Target { callId: string; personId?: string }
interface Cursor { version: 1; stage: 'summaries' | 'impressions'; targets: readonly Target[]; index: number }
interface Planned { cursor: Cursor; apply: () => string }

/** Saved IDs select the next bounded period; inference outputs and source text never enter the checkpoint. */
export function createFcaSleepPeoplePhase(options: {
  summaries: PlatformConversationSummarizer; impressions: ImpressionUpdater;
  observeSources(ids: readonly string[]): boolean;
  sourcesVisible(ids: readonly string[]): boolean;
}): SleepFcaPhaseHandler {
  return {
    async decide({ job, state, signal }) {
      signal.throwIfAborted();
      const cursor: Cursor = state === null || state === undefined ? { version: 1 as const, stage: 'summaries' as const, index: 0,
        targets: options.summaries.fcaTargets(job.scopeKey, job.startAt, job.endAt).map(callId => ({ callId })) } : checked(state);
      const target = cursor.targets[cursor.index];
      if (!target) return { cursor, apply: () => 'finished' } satisfies Planned;
      const apply = cursor.stage === 'summaries'
        ? await options.summaries.prepareFca(job.scopeKey, target.callId, signal, options.observeSources, options.sourcesVisible)
        : await options.impressions.prepareFca(job.scopeKey, target.callId, target.personId!, signal, options.observeSources);
      signal.throwIfAborted();
      return { cursor, apply } satisfies Planned;
    },
    async apply(raw, { job, signal }) {
      signal.throwIfAborted();
      const plan = raw as Planned;
      if (!plan || typeof plan.apply !== 'function') throw new Error('SLEEP_PEOPLE_PLAN_INVALID');
      const cursor = checked(plan.cursor), outcome = plan.apply() as ImpressionOutcome | 'written' | 'finished';
      const summary = JSON.stringify({ phase: 'people', operation: cursor.stage, outcome });
      // These are shared caps: no later platform-person request may consume another call this night.
      if (outcome === 'budget' || outcome === 'cap') return { done: true, summary };
      if (cursor.index + 1 < cursor.targets.length) return { done: false, state: { ...cursor, index: cursor.index + 1 }, summary };
      if (cursor.stage === 'impressions') return { done: true, summary };
      const targets = options.impressions.fcaTargets(job.scopeKey, job.startAt, job.endAt);
      return { done: targets.length === 0, state: { version: 1, stage: 'impressions', targets, index: 0 }, summary };
    },
  };
}

function checked(value: unknown): Cursor {
  const cursor = value as Cursor;
  if (!cursor || cursor.version !== 1 || !['summaries', 'impressions'].includes(cursor.stage)
    || !Array.isArray(cursor.targets) || cursor.targets.length > (cursor.stage === 'summaries' ? 8 : 48)
    || !Number.isSafeInteger(cursor.index) || cursor.index < 0 || cursor.index > cursor.targets.length
    || cursor.targets.some(target => typeof target.callId !== 'string' || !target.callId || target.callId.length > 200
      || (cursor.stage === 'impressions' && (typeof target.personId !== 'string' || !target.personId || target.personId.length > 200)))) {
    throw new Error('SLEEP_PEOPLE_STATE_INVALID');
  }
  return structuredClone(cursor);
}
