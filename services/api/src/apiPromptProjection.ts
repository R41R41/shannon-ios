import type { AgentTask } from './agentTaskStore.js';

export function voiceHistoryProjection(history: readonly { role: 'user' | 'assistant'; content: string }[]): string {
  const rows = history.slice(-12).map(item => {
    const speaker = item.role === 'user' ? 'User' : 'Shannon';
    const content = item.content.trim().replace(/\s+/gu, ' ').slice(0, 600);
    return `${speaker}: ${content}`;
  }).filter(row => !row.endsWith(': '));
  if (!rows.length) return '';
  const projection = `[Recent conversation]\n${rows.join('\n')}`;
  return projection.length <= 6_000 ? projection : `${projection.slice(-5_999)}…`;
}

export function agentTaskPromptProjection(tasks: readonly AgentTask[], currentThreadID?: string): string {
  const relevant = tasks
    .filter(task => task.status !== 'proposed')
    .sort((left, right) => {
      const leftActive = ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(left.status) ? 1 : 0;
      const rightActive = ['queued', 'starting', 'running', 'waiting_approval', 'paused'].includes(right.status) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      const leftHere = left.conversationThreadID === currentThreadID ? 1 : 0;
      const rightHere = right.conversationThreadID === currentThreadID ? 1 : 0;
      if (leftHere !== rightHere) return rightHere - leftHere;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 5);
  if (relevant.length === 0) return '';
  const lines = relevant.map(task => {
    const approval = task.status === 'waiting_approval' && task.pendingApproval
      ? ` / 必要な確認: ${task.pendingApproval.title}（理由: ${task.pendingApproval.reason}${task.pendingApproval.resource ? ` / 対象: ${task.pendingApproval.resource}` : ''}）`
      : '';
    const action = task.currentAction ? ` / 現在: ${task.currentAction}` : '';
    return `- ${task.title} [${task.status}] ${task.summary}${action}${approval}`.slice(0, 700);
  });
  return [
    '[Codex作業の現在状態 — Azure DB上の事実・会話履歴より優先]',
    ...lines,
    'これは全トークにまたがる作業一覧である。別トークから尋ねられても、該当する作業名と最新状態をここから答える。',
    'waiting_approvalは実行中ではなく、記載された確認をユーザーが操作するまで停止中である。過去の会話にある古い進捗説明を繰り返さない。',
    'ユーザーが進捗・完了・作業途中かを尋ねたら、この状態を根拠に答える。completedを作業中、cancelledを再開中、runningを未開始とは言わない。',
  ].join('\n');
}
