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
import { fcaOutcomeEpisode } from '../mind/action/fca/fcaOutcomeEpisode.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { fcaStepLeaseLive } from './actionLeaseRules.js';

/** No new state writer: memory is proposed to the existing outbox; emotion uses its existing atomic writer. */
export function createFcaSharedWiring(parts: {
  db: DatabaseSync; runtime: TaskRuntime; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean; visible: FcaSourceGuard;
  readSourceVisible(scope: string, id: string, at: string): boolean;
  affect?: FcaAffectWriter; memory?: MemoryProposals | null; enrich?: TurnMemoryRecall | null; now?: () => string;
  /** `SHANNON_FCA_SEGMENT_STALE_MINUTES` (`fcaEvidenceSegments.ts`). */
  segmentStaleMinutes?: number;
  /** `SHANNON_FCA_PROVENANCE_REFS`: evidence rows store their sources by reference (`fcaProvenanceSets.ts`). */
  provenanceRefs?: boolean;
}) {
  const now = parts.now ?? (() => new Date().toISOString());
  const leases = new ActionLeaseReader(parts.db);
  const memory = createTaskMemory({ ...parts, now });
  const recall = createTaskRecall({ ...parts, memory, enrich: parts.enrich ?? null, now });
  const evidence = parts.affect ? new SQLiteFcaEvidenceStore({ db: parts.db, state: parts.affect, now,
    validStep: step => fcaStepIsLive(leases, step, now()),
    ...(parts.segmentStaleMinutes ? { segmentStaleMinutes: parts.segmentStaleMinutes } : {}),
    ...(parts.provenanceRefs ? { provenanceRefs: true } : {}),
    sourcesVisible: (scope, id, sources) => { const task = parts.runtime.get(scope, id); return Boolean(task && parts.visible.sources(scope, task, sources)); },
    sourcesCovered: (scope, id, verified, candidate) => {
      const task = parts.runtime.get(scope, id);
      return Boolean(task && parts.visible.covers?.(scope, task, verified, candidate));
    },
    sourcesResidual: (scope, id, verified, candidate) => {
      const task = parts.runtime.get(scope, id);
      return task && parts.visible.residual ? parts.visible.residual(scope, task, verified, candidate) : null;
    },
    ...(parts.visible.walks ? { walkCounts: parts.visible.walks } : {}),
    observeContext: (step, ids) => {
      if (!parts.runtime.inheritTaskSources(step, ids)) return false;
      step.snapshot.sources = parts.runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
      return parts.visible.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources);
    },
    taskVisible: (scope, id) => parts.visible(scope, id),
    ...(parts.memory ? { onOutcome: (outcome: import('../mind/action/fca/fcaEvidencePorts.js').FcaDurableOutcome) => {
      // One episode per outcome, or per segment of a body's actions (owner decision 2026-10-14, `fcaOutcomeEpisode.ts`).
      const record = fcaOutcomeEpisode(outcome);
      if (!record) return;
      const sourceCount = record.sourceIds.length, readSourceCount = record.readSourceIds?.length ?? 0, status = record.status;
      withScopedObserverTask(outcome.scopeKey, { taskId: outcome.taskId, stepId: outcome.stepId }, () => {
      observerHandoff('prediction', 'memory', { phase: 'propose', status });
      observeSync('memory', { phase: 'task_episode_proposal', status, sourceCount, readSourceCount },
        () => parts.memory!.propose(taskExperienceDraft(record)));
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
