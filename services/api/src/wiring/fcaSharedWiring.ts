import { observeSync, observerHandoff, withScopedObserverTask } from '../infra/observer/observerContext.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CompanionStateStore } from '@shannon/cognition';
import type { FcaAffectWriter } from '../mind/emotion/emotionPorts.js';
import type { ConversationStore, MemoryProposals } from '../mind/memory/memoryPorts.js';
import { createTaskMemory, taskExperienceDraft } from '../mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../mind/recall/taskRecallPorts.js';
import type { TurnMemoryRecall } from '../mind/recall/turnMemoryRecall.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import { SQLiteFcaEvidenceStore } from '../mind/action/fca/store/fcaEvidenceStore.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { fcaStepLeaseLive } from './actionLeaseRules.js';

/** No new state writer: memory is proposed to the existing outbox; emotion uses its existing atomic writer. */
export function createFcaSharedWiring(parts: {
  db: DatabaseSync; runtime: TaskRuntime; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean; visible: FcaSourceGuard;
  readSourceVisible(scope: string, id: string, at: string): boolean;
  affect?: FcaAffectWriter; memory?: MemoryProposals | null; enrich?: TurnMemoryRecall | null; now?: () => string;
}) {
  const now = parts.now ?? (() => new Date().toISOString());
  const leases = new ActionLeaseReader(parts.db);
  const memory = createTaskMemory({ ...parts, now });
  const recall = createTaskRecall({ ...parts, memory, enrich: parts.enrich ?? null, now });
  const evidence = parts.affect ? new SQLiteFcaEvidenceStore({ db: parts.db, state: parts.affect, now,
    validStep: step => fcaStepIsLive(leases, step, now()),
    sourcesVisible: (scope, id, sources) => { const task = parts.runtime.get(scope, id); return Boolean(task && parts.visible.sources(scope, task, sources)); },
    observeContext: (step, ids) => {
      if (!parts.runtime.inheritTaskSources(step, ids)) return false;
      step.snapshot.sources = parts.runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
      return parts.visible.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources);
    },
    taskVisible: (scope, id) => parts.visible(scope, id),
    ...(parts.memory ? { onOutcome: (outcome: import('../mind/action/fca/fcaEvidencePorts.js').FcaDurableOutcome) => {
      // Pure lookup/open operations are working history, not another independent life episode.
      if (['tool.open', 'task.list', 'task.get', 'memory.search', 'memory.read'].includes(outcome.action.name)) return;
      const actualStatus = outcome.actualTaskStatus;
      // A completion request with unfinished children is a wait, not an achieved goal.
      if (actualStatus && !['completed', 'failed', 'cancelled'].includes(actualStatus)) return;
      const status = actualStatus === 'cancelled' ? 'cancelled' : actualStatus === 'failed' ? 'failure'
        : actualStatus === 'completed' ? 'success' : outcome.result ? outcome.result.ok ? 'success' : 'failure' : 'unobserved';
      const sourceIds = [...new Set(outcome.sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]))];
      const readSourceIds = [...new Set(outcome.sources.flatMap(source => source.readSourceIds ?? []))];
      withScopedObserverTask(outcome.scopeKey, { taskId: outcome.taskId, stepId: outcome.stepId }, () => {
      observerHandoff('prediction', 'memory', { phase: 'propose', status });
      observeSync('memory', { phase: 'task_episode_proposal', status, sourceCount: sourceIds.length, readSourceCount: readSourceIds.length }, () => parts.memory!.propose(taskExperienceDraft({ scopeKey: outcome.scopeKey, taskId: outcome.taskId, outcomeId: outcome.outcomeId,
        observedAt: outcome.observedAt, status,
        goal: outcome.goal.slice(0, 1000), context: `task:${outcome.taskId}`, action: JSON.stringify(outcome.action).slice(0, 1000),
        prediction: outcome.expectation ? JSON.stringify(outcome.expectation).slice(0, 1000) : '', observedResult: outcome.result?.text.slice(0, 4000) ?? '',
        interpretation: outcome.comparison ? JSON.stringify(outcome.comparison).slice(0, 2000) : '結果はこの操作の観測であり、目的全体の達成や原因の証明ではない。', sourceIds, readSourceIds })));
      });
    } } : {}),
  }) : undefined;
  return { memory, recall, evidence,
    observeMemory(step: TaskStep, ids: readonly string[]) {
      if (!parts.ownerAlone()) return false;
      const observationId = createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex');
      if (!parts.runtime.observeSources(step, { observationId, recalledMemoryIds: ids })) return false;
      step.snapshot.sources = parts.runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
      return parts.visible.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources);
    },
  };
}

/** Exact native step and original action lease; caller holds the same SQLite transaction for evidence writes. */
function fcaStepIsLive(leases: ActionLeaseReader, step: TaskStep, at: string): boolean {
  return fcaStepLeaseLive(leases.checkpointed(step.lease.id, step.taskId), step, at);
}
