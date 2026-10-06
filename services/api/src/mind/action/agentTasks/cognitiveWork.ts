import type { ShannonVerifiedWork } from '@shannon/cognition';
import type { AgentTask } from './agentTaskStore.js';
import type { CognitiveIntentStore } from '../../../cognitiveIntent.js';

/**
 * Projects durable Agent Host evidence into one explicitly linked objective.
 * Model prose and title similarity never participate in this transition.
 */
export function synchronizeIntentWithAgentTask(
  store: CognitiveIntentStore,
  scopeKey: string,
  task: AgentTask,
  at: string,
): void {
  if (!task.cognitiveIntentID) return;
  store.updateVerifiedWork(scopeKey, task.cognitiveIntentID, verifiedWork(task), nextVerifiedStep(task), at);
}

export function verifiedWork(task: AgentTask): ShannonVerifiedWork {
  const plan = task.plan.slice(0, 20).map(item => Object.freeze({ title: item.title, status: item.status }));
  return Object.freeze({
    taskId: task.id,
    title: task.title,
    status: task.status === 'proposed' ? 'queued' : task.status,
    summary: task.summary,
    ...(task.currentAction ? { currentAction: task.currentAction } : {}),
    plan: Object.freeze(plan),
    completedPlanSteps: plan.filter(item => item.status === 'completed').length,
    totalPlanSteps: plan.length,
    testsPassed: task.tests.filter(test => test.status === 'passed').length,
    testsFailed: task.tests.filter(test => test.status === 'failed').length,
    updatedAt: task.updatedAt,
  });
}

function nextVerifiedStep(task: AgentTask): string {
  if (task.status === 'waiting_approval' && task.pendingApproval) {
    return `「${task.pendingApproval.title}」を確認する`;
  }
  if (task.status === 'completed') return '完了した作業結果と検証内容を確認する';
  if (task.status === 'failed') return '失敗理由を確認し、修正方針を決める';
  if (task.status === 'cancelled') return '中止した作業を再開するか決める';
  if (task.status === 'paused') return task.currentAction || '一時停止した作業を再開するか決める';
  if (task.currentAction) return task.currentAction;
  const active = task.plan.find(item => item.status === 'running') ?? task.plan.find(item => item.status === 'pending');
  if (active) return active.title;
  if (task.status === 'queued' || task.status === 'starting') return '作業環境の開始を待つ';
  return '検証済みの作業状態を確認する';
}
