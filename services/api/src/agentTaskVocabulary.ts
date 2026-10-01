import type { AgentTask } from './agentTaskStore.js';

/**
 * One user-facing word per task state, shared by push text, prompt projection, and spoken replies.
 * The Apple clients use the same words (`docs/design/screens/ios/work.yaml`, `vocabulary`).
 */
export function agentTaskStateLabel(task: Pick<AgentTask, 'status' | 'pauseReason' | 'currentAction'>): string {
  switch (task.status) {
    case 'proposed': return '提案';
    case 'queued':
    case 'starting': return '準備中';
    case 'running': return '作業中';
    case 'waiting_approval': return '許可待ち';
    case 'paused': return agentTaskNeedsOwner(task) ? '続きが必要' : '一時停止中';
    case 'completed': return '完了';
    case 'failed': return '失敗';
    case 'cancelled': return '中止';
  }
}

/** A pause the host left for the owner, as opposed to one the owner asked for. */
export function agentTaskNeedsOwner(task: Pick<AgentTask, 'status' | 'pauseReason' | 'currentAction'>): boolean {
  if (task.status !== 'paused') return false;
  return task.pauseReason ? task.pauseReason === 'needs_owner' : Boolean(task.currentAction);
}
