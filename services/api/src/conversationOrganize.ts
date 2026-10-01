import type { ConversationStore } from './conversationStore.js';
import { messagesAfterCursor, type OrganizeExtractor, type OrganizeStore } from './organize.js';

/** One preparation contract. The caller still owns persistence and UI delivery. */
export async function prepareConversationOrganize(
  scopeKey: string, threadId: string, at: string,
  conversationStore: ConversationStore, organizeStore: OrganizeStore, extractor: OrganizeExtractor,
) {
  const source = messagesAfterCursor(conversationStore.conversationHistory(scopeKey, threadId),
    organizeStore.cursor(scopeKey, threadId)).slice(-100);
  const drafts = await extractor.extract(scopeKey, source.map(item => ({ role: item.role, content: item.content })));
  const session = organizeStore.create({ scopeKey, threadId, sourceMessageIds: source.map(item => item.id), drafts }, at);
  const reply = drafts.length
    ? `Voyagerへ送るタスク案を${drafts.length}件まとめました。内容を確認して、採用する案を選んでください。`
    : '今回の範囲には、Voyagerへ送るタスク案は見つかりませんでした。';
  return { session, reply };
}
