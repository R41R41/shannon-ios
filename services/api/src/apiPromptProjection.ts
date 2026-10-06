import type { AgentTask } from './mind/action/agentTasks/agentTaskStore.js';
import { agentTaskNeedsOwner, agentTaskStateLabel } from './mind/action/agentTasks/agentTaskVocabulary.js';

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
      ? ` / 必要な許可: ${task.pendingApproval.title}（理由: ${task.pendingApproval.reason}${task.pendingApproval.resource ? ` / 対象: ${task.pendingApproval.resource}` : ''}）`
      : '';
    const action = task.currentAction
      ? ` / ${agentTaskNeedsOwner(task) ? '持ち主が次にすること' : '現在'}: ${task.currentAction}` : '';
    return `- ${task.title} [${task.status}] 状態名=${agentTaskStateLabel(task)} / ${task.summary}${action}${approval}`.slice(0, 700);
  });
  return [
    '[Codex作業の現在状態 — Azure DB上の事実・会話履歴より優先]',
    ...lines,
    'これは全トークにまたがる作業一覧である。別トークから尋ねられても、該当する作業名と最新状態をここから答える。',
    'waiting_approval（許可待ち）は実行中ではなく、記載された許可をユーザーが操作するまで停止中である。過去の会話にある古い進捗説明を繰り返さない。',
    '状態名が「続きが必要」のpausedは、ユーザーが止めたのではなく、記載された次の一手をユーザーが行うまで止まっている。「一時停止中」はユーザー自身が止めた作業である。',
    'ユーザーへ作業の状態を伝えるときは、状態名（提案・準備中・作業中・許可待ち・続きが必要・一時停止中・完了・失敗・中止）をそのまま使う。',
    'ユーザーが進捗・完了・作業途中かを尋ねたら、この状態を根拠に答える。completedを作業中、cancelledを再開中、runningを未開始とは言わない。',
  ].join('\n');
}
