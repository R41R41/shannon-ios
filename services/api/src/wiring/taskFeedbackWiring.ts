import { createHash } from 'node:crypto';
import type { ActionThreads, ActionView } from '../contracts/actionThreadContract.js';
import type { AgentTaskStore, TaskResultProof, TaskTreeLearningCallbacks } from '../mind/action/agentTasks/agentTasksPorts.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { FeedbackService } from '../mind/learning/feedbackService.js';

export const VERIFIED_TASK_REPLY = '作業を完了し、完了の条件を確認しました。結果は作業の詳細で確認できます。';

/** The task outbox runs after its transaction. Canonical execution acknowledgement is refreshed before delivery. */
export function taskFeedbackWiring(parts: {
  tasks: AgentTaskStore; conversation: ConversationStore; actions: ActionThreads | null;
  ownerScope: string; now(): string; ownerAlone(scope: string): boolean;
  feedback(): FeedbackService | null; flush(): void;
  /** Existing accounting: Host task costs are unreported (0 in the choice ledger), not measured free execution. */
  costYen?(scope: string, proof: TaskResultProof): number;
}) {
  let views: ReadonlyMap<string, ActionView> | null = null;
  let refreshing: Promise<void> | null = null;
  const trusted = (scope: string, taskId: string) => {
    if (scope !== parts.ownerScope) return null;
    const tree = parts.tasks.taskTrees?.get(scope, taskId);
    return tree?.origin === 'owner_request' && tree.budgetLane === 'owner' && tree.ownerInformed
      && tree.permissionId ? tree : null;
  };
  const actionFor = (scope: string, taskId: string, actionId: string | undefined) => {
    const view=actionId?views?.get(actionId):null;
    return view?.scopeKey===scope&&view.kind==='agentTask'&&view.origin==='owner_request'&&view.sourceId===taskId?view:null;
  };
  const callbacks: TaskTreeLearningCallbacks = {
    taskDispatched(scope, input) {
      const feedback = parts.feedback();
      if (!feedback || !views) return false;
      if (!trusted(scope, input.taskId)) return true;
      const action = actionFor(scope, input.taskId, input.actionId);
      if (!action) return false;
      // A recovered event does not fabricate historical presence. Its original dispatch ID still deduplicates the choice.
      const contemporaneous = Math.abs(Date.parse(parts.now()) - Date.parse(input.at)) < 1000;
      feedback.taskDispatched(scope, { ...input, presence: input.expectation?.presence ?? (contemporaneous
        ? parts.ownerAlone(scope) ? 'alone' : 'others' : 'unknown'), ...(input.expectation ? {expectation:input.expectation} : {}) });
      return true;
    },
    taskVerified(scope, proof, at) {
      const feedback = parts.feedback();
      if (!feedback || !views) return false;
      if (!trusted(scope, proof.taskId)) return true;
      const current = parts.tasks.taskTrees?.proofStatus(scope, proof.taskId);
      if (!current || current.status === 'unknown') return false;
      if (current.status !== 'verified' || !sameProof(current.proof, proof)) return true;
      const action = actionFor(scope, proof.taskId, proof.actionId);
      if (!action || action.state === 'unknown' || !['completed', 'failed', 'cancelled'].includes(action.state)) return false;
      if (action.state !== 'completed' || action.id !== proof.actionId || action.lastHolder !== proof.holder
        || ![proof.generation, proof.generation + 1].includes(action.generation)) return true;
      const task = parts.tasks.get(scope, proof.taskId);
      if (!task || task.status !== 'completed' || task.conversationThreadID !== proof.threadId) return true;
      if (!parts.conversation.appendNoteOnce) return false;
      const costYen = parts.costYen?.(scope, proof) ?? 0;
      if (!Number.isFinite(costYen) || costYen < 0) return false;
      feedback.taskVerified(scope, proof.taskId, proof.attemptId, at, costYen);
      const messageId = createHash('sha256').update(JSON.stringify(['verified-task-result', scope, proof.taskId, proof.attemptId])).digest('hex');
      // A closed verified result, not Host prose, paths or a model's claim. The original note and audience survive callback retries.
      const message = parts.conversation.appendNoteOnce(scope, proof.threadId, messageId, VERIFIED_TASK_REPLY,
        at, 'agent-task-result', parts.ownerAlone(scope));
      feedback.bindTaskReply(scope, { taskId: proof.taskId, threadId: proof.threadId, messageId: message.id, reply: message.content });
      return true;
    },
    taskUnusable(scope, input) {
      if (input.reason === 'unknown') return true; // Retain the original pending choice until the canonical receipt is recovered.
      const feedback = parts.feedback();
      if (!feedback) return false;
      if (trusted(scope, input.taskId)) feedback.taskUnusable(scope, input.taskId, input.attemptId, input.at);
      return true;
    },
  };
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const pending=parts.tasks.taskTrees?.pendingLearningActions(parts.ownerScope)??[];
        const ids=[...new Set(pending.map(item=>item.actionId))];
        const read=parts.actions?await Promise.all(ids.map(id=>parts.actions!.get(parts.ownerScope,id))):[];
        views=new Map(read.flatMap(view=>view?[[view.id,view] as const]:[]));
        parts.flush();
      } catch { views = null; /* The durable task callback remains pending; no guessed receipt. */ }
      finally { refreshing = null; }
    })();
    return refreshing;
  };
  return { callbacks, refresh };
}

function sameProof(left: TaskResultProof, right: TaskResultProof): boolean {
  return ['taskId', 'nodeId', 'treeRevision', 'attemptId', 'actionId', 'generation', 'holder', 'threadId', 'status']
    .every(key => left[key as keyof TaskResultProof] === right[key as keyof TaskResultProof])
    && JSON.stringify([...left.evidenceIds].sort()) === JSON.stringify([...right.evidenceIds].sort());
}
