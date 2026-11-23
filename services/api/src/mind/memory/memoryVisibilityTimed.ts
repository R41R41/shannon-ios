import type { CompanionStateSnapshot, MemoryAudience } from '@shannon/cognition';
import type { ShannonConversationItem } from '../../infra/models/chatModel.js';
import type { ConversationStore } from './store/conversationStore.js';
import { visibleMessages } from './memoryVisibility.js';

/** The same history as `visibleConversationHistory`, with the time each message was said (`observedAt`), for a prompt that dates what was said. */
export function visibleConversationHistoryTimed(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
  present: MemoryAudience,
): readonly (ShannonConversationItem & { observedAt: string })[] {
  const count = store.history(scopeKey, threadID).length;
  if (!count) return [];
  return visibleMessages(state, store, scopeKey, store.conversationHistory(scopeKey, threadID).slice(-count), present)
    .map(entry => ({ ...entry.item, observedAt: entry.message.observedAt }));
}
