import {
  isForgetCitedMemoriesCommand,
  isMemoryInquiry,
  type CompanionStateEvent,
  type CompanionStateStore,
  type ShannonActionReceipt,
} from '@shannon/cognition';
import type { CognitiveIntentStore } from '../../cognitiveIntent.js';
import type { ConversationStore } from './store/conversationStore.js';
import type { TurnMemoryRecall } from '../recall/turnMemoryRecall.js';

const FOLLOW_UP_WINDOW_MILLISECONDS = 10 * 60_000;

/**
 * 「それは忘れて」 right after an owner memory inquiry forgets exactly the
 * items Shannon cited in that answer: experiences through the existing memory
 * controls (restorable from Memory), and Shannon knowledge by retirement with
 * a recorded reason. No other memory is touched; ambiguity changes nothing.
 */
export function forgetCitedMemories(
  scopeKey: string, threadId: string, text: string, at: string,
  dependencies: {
    stateStore: CompanionStateStore; conversationStore: ConversationStore;
    cognitiveIntents?: CognitiveIntentStore; memoryRecall?: TurnMemoryRecall | null;
  },
): { reply: string; receipt?: ShannonActionReceipt } | null {
  if (!isForgetCitedMemoriesCommand(text) || !dependencies.cognitiveIntents) return null;
  const history = dependencies.conversationStore.conversationHistory(scopeKey, threadId);
  const answer = history.at(-1);
  const question = history.at(-2);
  if (answer?.role !== 'assistant' || question?.role !== 'user' || !isMemoryInquiry(question.content)) return null;
  if (Date.parse(at) - Date.parse(answer.observedAt) > FOLLOW_UP_WINDOW_MILLISECONDS) {
    return { reply: '少し前の回答なので、どの記憶のことか確定できません。もう一度「〇〇について何を覚えてる？」と聞いてから指示してください。まだ何も忘れていません。' };
  }
  const cycle = dependencies.cognitiveIntents.recentCycles(scopeKey, 20)
    .find(receipt => receipt.threadId === threadId && receipt.action === 'respond' && receipt.occurredAt >= question.observedAt);
  if (!cycle) return { reply: 'どの記憶を引用したか確認できませんでした。まだ何も忘れていません。' };
  const experiences = cycle.recalledMemoryIDs.filter(id => !id.includes(':'));
  const knowledge = cycle.recalledMemoryIDs.filter(id => id.startsWith('knowledge:'));
  if (!experiences.length && !knowledge.length) return { reply: 'さっきの回答で引用した個別の記憶はありませんでした。まだ何も忘れていません。' };
  const candidates = dependencies.conversationStore.experienceCandidates(scopeKey);
  const events: CompanionStateEvent[] = experiences.map(id => ({ type: 'memory-control-upserted', control: {
    memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
    changeReason: '記憶の問い合わせへの回答から本人が忘却を指示', contextInvalidatedAt: at,
    ...(candidates.find(item => item.id === id)?.userMessage ? { sourceEvidence: candidates.find(item => item.id === id)!.userMessage } : {}),
  } }));
  if (events.length) dependencies.stateStore.apply(scopeKey, { type: 'memory-transaction', events });
  const retired = dependencies.memoryRecall?.retireKnowledge(scopeKey, knowledge, '所有者が記憶の問い合わせへの回答から忘却を指示', at) ?? [];
  return {
    reply: `さっき挙げた記憶${experiences.length ? `（会話${experiences.length}件）` : ''}${retired.length ? `とボク自身のメモ${retired.length}件` : ''}を、今後の想起に使わないようにしました。会話の記憶は「記憶」画面から元に戻せます。`,
    receipt: { id: cycle.id, capability: 'memory.control', status: 'completed',
      summary: `引用した記憶を忘却（会話${experiences.length}件・メモ${retired.length}件）`, occurredAt: at },
  };
}
