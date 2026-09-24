import type { CompanionStateStore, ShannonActionReceipt } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import type { OrganizeSession, OrganizeStore } from './organize.js';
import type { AetherProposalStore } from './aetherProposal.js';
import { applyExplicitCommitmentCommand } from './commitmentCommands.js';
import { contentPreview, containsUnresolvedConversationReference, resolveConversationContent } from './conversationReference.js';
import { ShannonMemoryService } from './memoryService.js';

export interface UserUtterance { id: string; text: string }
export interface ConversationCommandDependencies {
  stateStore: CompanionStateStore; conversationStore: ConversationStore;
  organizeStore?: OrganizeStore; aetherProposals?: AetherProposalStore;
}

/** Only the actual user utterance can authorize a proposal. Tool-model
 * paraphrases and retrieved material must never be passed as this argument. */
export function executeConversationCommand(
  scopeKey: string, threadId: string, utterance: UserUtterance, at: string,
  dependencies: ConversationCommandDependencies,
): { reply: string; receipt?: ShannonActionReceipt; organizeSession?: OrganizeSession } | null {
  const text = utterance.text.trim().replace(/[。！!]$/u, '');
  if (/^(?:例えば|もし|仮に)/u.test(text)) return null;
  const task = text.match(/^(?:[「"])?(.{1,500}?)(?:[」"])?を(?:タスクにして|タスクに追加して)$/u);
  if (task && dependencies.organizeStore) {
    const resolved = resolveConversationContent(task[1]!, scopeKey, threadId, at,
      dependencies.stateStore.snapshot(scopeKey), dependencies.conversationStore, 500, 'task');
    if ('clarification' in resolved) return { reply: resolved.clarification };
    const session = dependencies.organizeStore.create({ scopeKey, threadId,
      sourceMessageIds: [...resolved.sourceMessageIds, `utterance:${utterance.id}`], requestKey: utterance.id,
      drafts: [{ title: resolved.content, details: resolved.content }],
    }, at);
    return { organizeSession: session, reply: `「${session.items[0]?.title}」のタスク案を作ったよ。トークの整理カードで確認して反映してね。まだタスク本体は変更していないよ。`,
      receipt: { id: session.id, capability: 'voyager.propose', status: 'proposed', summary: '確認待ちのタスク案', occurredAt: session.createdAt } };
  }
  const note = text.match(/^(?:[「"])?([\s\S]{1,6000}?)(?:[」"])?を(?:ノート|メモ)に(?:残して|保存して|して)$/u);
  if (note) {
    const resolved = resolveConversationContent(note[1]!, scopeKey, threadId, at,
      dependencies.stateStore.snapshot(scopeKey), dependencies.conversationStore, 6_000);
    if ('clarification' in resolved) return { reply: resolved.clarification };
    if (!dependencies.aetherProposals?.configured) return { reply: 'ノートの提案先が未接続なので、まだ保存できていないよ。設定でノート連携を確認してね。' };
    try {
      const proposal = dependencies.aetherProposals.create(scopeKey, { content: resolved.content, requestKey: utterance.id,
        ...(resolved.referenced ? { reason: `本人の保存依頼に基づく直前の発言 (source: ${resolved.sourceMessageIds.join(', ')})` } : {}),
      });
      return { reply: `「${contentPreview(proposal.content)}」をノートへの保存案として送ったよ。ノート側の提案受信箱で確認してね。まだノート本文には反映していないよ。`,
        receipt: { id: proposal.id, capability: 'aether.propose', status: 'proposed', summary: 'ノートの提案受信箱へ送信', occurredAt: proposal.createdAt } };
    } catch { return { reply: 'ノートへの保存案の結果を確認できなかったよ。重複を避けるため自動で再送せず、提案受信箱を確認してね。' }; }
  }
  const remember = text.match(/^(.{1,180}?)(?:を)?(?:覚えておいて|忘れないで)(?:ね|ください)?$/u);
  if (remember && containsUnresolvedConversationReference(remember[1]!)) {
    const resolved = resolveConversationContent(remember[1]!, scopeKey, threadId, at,
      dependencies.stateStore.snapshot(scopeKey), dependencies.conversationStore, 2_000, 'memory');
    if ('clarification' in resolved) return { reply: resolved.clarification };
    if (!resolved.sourceExperienceId) return { reply: '覚えておく内容をそのまま教えてくれる？ まだ記憶は変更していないよ。' };
    try {
      new ShannonMemoryService(dependencies.stateStore, dependencies.conversationStore, () => at)
        .mutate(scopeKey, { memoryId: resolved.sourceExperienceId, action: 'pin' });
    } catch { return { reply: 'その発言を記憶に固定したことを確認できなかったよ。まだ保存できたとは言えないので、記憶の詳細を確認してね。' }; }
    return { reply: `「${contentPreview(resolved.content)}」というあなたの発言を、出典のある会話の記憶として固定したよ。`,
      receipt: { id: resolved.sourceExperienceId, capability: 'memory.control', status: 'completed',
        summary: '参照元の会話の記憶を固定', occurredAt: at } };
  }
  const memory = applyExplicitCommitmentCommand(dependencies.stateStore, dependencies.conversationStore, scopeKey, text, at);
  if (!memory) return null;
  if (!memory.startsWith('[Verified')) return { reply: memory };
  const action = memory.match(/action=(\w+)/u)?.[1];
  return { reply: action === 'complete' ? 'その約束を完了にしたよ。'
    : action === 'dismiss' ? 'その約束を取り消したよ。'
    : action === 'forget' ? 'その約束と元の会話を、今後の想起に使わないようにしたよ。'
    : '約束の期限を変更したよ。記憶の詳細で確認できるよ。',
    receipt: { id: memory.match(/id=([^;]+)/u)?.[1] ?? utterance.id, capability: 'memory.control',
      status: 'completed', summary: action ?? 'memory updated', occurredAt: at } };
}
