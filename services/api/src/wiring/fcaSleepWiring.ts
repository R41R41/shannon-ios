import { createFcaSleepTaskEvidence } from './fcaSleepTaskEvidence.js';
import { withSleepWriterBarrier } from './fcaSleepWriterBarrier.js';
import { randomUUID } from 'node:crypto';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../mind/memory/store/peopleMemoryStore.js';
import { PlatformPeople } from '../mind/memory/platformPeople.js';
import { ImpressionUpdater, createConfiguredImpressionAnalyzer } from '../mind/memory/impressionUpdater.js';
import { createConfiguredPlatformSummaryWriter, PlatformConversationSummarizer } from '../surfaces/platform/platformPeopleSummaries.js';
import { createConfiguredKnowledgeAnalyzer, ShannonKnowledgeConsolidator, type KnowledgeAnalyzer } from '../mind/sleep/knowledgeConsolidation.js';
import { createConfiguredSleepMemoryAnalyzer, type SleepMemoryAnalyzer } from '../mind/sleep/sleepConsolidation.js';
import { createSleepFcaStep } from '../mind/sleep/sleepFcaPhases.js';
import type { SleepFcaPhaseHandler } from '../mind/sleep/sleepFcaPorts.js';
import type { TaskRuntime, TaskStep, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { peopleFactReaders } from './peopleFactsWiring.js';
import { configuredSkillExport, configuredSkillMemory, skillSleepConsolidator } from './skillMemoryWiring.js';
import { createFcaSleepJobs } from './fcaSleepJobs.js';
import { createFcaSleepMemory } from './fcaSleepMemory.js';
import { sleepSourcesVisible } from './fcaSleepSources.js';
import { createFcaSleepPeoplePhase } from './fcaSleepPeopleWiring.js';

/** Same Task Hub/runner/scheduler. Only the bounded nightly model and restricted tool policy vary by task. */
export function createFcaSleepWiring(parts: { store: SQLiteShannonStore; ownerScope: string;
  values: Readonly<Record<string, string | undefined>>; now?: () => string;
  analyzer?: SleepMemoryAnalyzer; knowledgeAnalyzer?: KnowledgeAnalyzer | null;
  /** Optional deterministic dependencies for integration tests; production uses the configured original models. */
  peoplePhase?: (observeSources: (ids: readonly string[]) => boolean) => SleepFcaPhaseHandler;
  /** Tests: whether a body task is working (the night waits while it is), and how long it may wait. */
  jobs?: Parameters<typeof createFcaSleepJobs>[3];
}) {
  const { store, ownerScope, values } = parts, db = store.fcaDatabase();
  if (!store.memoryProposals()) throw new Error('FCA_SLEEP_MEMORY_OUTBOX_REQUIRED');
  const now = parts.now ?? (() => new Date().toISOString());
  const jobs = createFcaSleepJobs(db, ownerScope, now, parts.jobs);
  const memory = store.memoryProposals();
  const skillMemory = configuredSkillMemory(values, { database: db, databasePath: null, createsSchema: true });
  const skills = skillMemory ? skillSleepConsolidator(values, { memory: skillMemory.memory, store, choices: store.choiceLedger(), now }) : null;
  const exportSkills = skillMemory ? configuredSkillExport(values, { memory: skillMemory.memory, store }) : null;
  const people = new SQLitePeopleMemoryStore(db);
  const summaries = new PlatformConversationSummarizer(people, new PlatformPeople(people, store, undefined, memory, peopleFactReaders(store, now)),
    createConfiguredPlatformSummaryWriter(values, store), store, { now });
  const impressions = new ImpressionUpdater(store, store, store.impressionStore(), createConfiguredImpressionAnalyzer(values, store), store,
    { environment: values, now, people, memory, timeZone: values.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo' });
  const analyzer = parts.analyzer ?? createConfiguredSleepMemoryAnalyzer(values, store);
  const knowledge = new ShannonKnowledgeConsolidator(store, store, store,
    parts.knowledgeAnalyzer === undefined ? createConfiguredKnowledgeAnalyzer(values, store) : parts.knowledgeAnalyzer, store, { memory, now, taskEvidence: createFcaSleepTaskEvidence(db) });
  const visible = (runtime: TaskRuntime, task: TaskView) => task.scopeKey === ownerScope
    && sleepSourcesVisible(store, ownerScope, runtime.taskSources(ownerScope, task.id), skillMemory?.memory ?? null, people);
  function step(runtime: TaskRuntime, current: TaskStep) {
    const job = jobs.job(runtime, current.snapshot.task);
    if (!job) throw new Error('FCA_SLEEP_TICKET_LOST');
    const assertCurrent = () => {
      const task = runtime.get(current.scopeKey, current.taskId);
      return !!task && task.phase === 'executing' && jobs.allowed(runtime, task) && visible(runtime, task);
    };
    const observeSources = (ids: readonly string[]) => {
      if (!runtime.observeSources(current, { observationId: `sleep-${randomUUID()}`, recalledMemoryIds: ids })) throw new Error('FCA_SLEEP_SOURCE_LOST');
      current.snapshot.sources = runtime.taskSources(current.scopeKey, current.taskId, current.messageIds);
      if (!assertCurrent()) throw new Error('FCA_SLEEP_SOURCE_WITHHELD');
      return true;
    };
    const sleep = createSleepFcaStep({ job, checkpoint: (current.snapshot.checkpoint as { sleepFca?: unknown } | null)?.sleepFca,
      assertCurrent, handlers: {
        memory: withSleepWriterBarrier(store, createFcaSleepMemory({ store, jobs, taskId: current.taskId, analyzer,
          minimumMessages: positiveInteger(values.SHANNON_SLEEP_MIN_MESSAGES, 3), now, observeSources, assertCurrent }), ['sleep']),
        knowledge: withSleepWriterBarrier(store, knowledge.fcaPhase(observeSources), ['knowledge']),
        ...(skills ? { skills: skills.fcaPhase({ observeSources }) } : {}),
        people: withSleepWriterBarrier(store, parts.peoplePhase ? parts.peoplePhase(observeSources) : createFcaSleepPeoplePhase({ summaries, impressions, observeSources, sourcesVisible: ids => sleepSourcesVisible(store, ownerScope, [{ kind: 'memory', stepId: current.id, experienceId: null, threadId: null, observedAt: now(), recalledMemoryIds: ids }], skillMemory?.memory ?? null, people) }), ['platform', 'impressions']),
        ...(exportSkills ? { export: { async decide({ signal }) { signal.throwIfAborted(); return null; },
          async apply(_answer, { job: item, signal }) {
            signal.throwIfAborted(); const result = await exportSkills(item.scopeKey, now(), signal); signal.throwIfAborted();
            if (result && (result.status !== 'done' || result.failed)) throw new Error('FCA_SLEEP_EXPORT_UNCONFIRMED');
            return { done: true, summary: result ? `スキルの写し: 作成${result.created}・更新${result.updated}・取り下げ${result.withdrawn}` : 'この範囲にはスキルの写しを配布しません。' };
          } } satisfies SleepFcaPhaseHandler } : {}),
      } });
    return { ...sleep, selector: undefined, taskTools: false, executionAllowed: assertCurrent, sourcesVisible: assertCurrent,
      taskVisible: () => false, observeTasks: () => false };
  }
  return { jobs, step, visible, close() { people.close(); skillMemory?.close(); } };
}
function positiveInteger(value: string | undefined, fallback: number) {
  if (!value?.trim()) return fallback;
  const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error('SHANNON_WORKER_ENV_INVALID');
  return number;
}
