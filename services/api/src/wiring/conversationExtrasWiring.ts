import type { DatabaseSync } from 'node:sqlite';
import { REPORT_CARD_NOTE_KIND, type ConversationExtrasPorts } from '../contracts/conversationExtrasContract.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReactionRoute, REACTIONS_PATH } from '../infra/http/reactionRoutes.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import type { FeedbackService } from '../mind/learning/feedbackService.js';
import { MessageReactions } from '../mind/learning/messageReactions.js';
import { SQLiteMessageReactions } from '../mind/learning/store/sqliteMessageReactions.js';
import type { StoredConversationMessage } from '../mind/memory/conversationContract.js';

/**
 * Rich chat (`docs/rich-chat-contract.md`): the owner's reactions (their store, route and the line her next turn reads) and the
 * conversation projection that shows report cards only while their work is still his to see.
 */
export function createConversationExtras(parts: {
  /** The conversation store's own connection (`composeLearning`), so the reactions read its messages. */
  database: DatabaseSync; ownerScope: string; now(): string;
  ownerAlone(scopeKey: string): boolean;
  feedback(): Pick<FeedbackService, 'project' | 'change'> | null;
  /** The work's sources are still visible to the owner alone (the 「いま」 guard). Absent or throwing: hidden. */
  reportVisible(taskId: string): boolean;
}) {
  const reactions = new MessageReactions({ store: new SQLiteMessageReactions(parts.database), ownerScopeKey: parts.ownerScope, now: parts.now,
    ownerAlone: parts.ownerAlone, feedback: parts.feedback });
  const visible = (taskId: string) => { try { return parts.reportVisible(taskId) === true; } catch { return false; } };
  const ports: ConversationExtrasPorts = {
    project(scopeKey, threadId, messages, ownerAlone) {
      const mine = scopeKey === parts.ownerScope && ownerAlone;
      let reacted: ReadonlyMap<string, string[]> = new Map();
      if (mine) { try { reacted = reactions.forMessages(scopeKey, threadId); } catch { /* No reactions, never a guess. */ } }
      return Object.freeze(messages.flatMap((message): StoredConversationMessage[] => {
        const { reactions: _stale, ...plain } = message;
        const card = message.reportCard ?? null, note = message.sourceExperienceId?.startsWith(`${REPORT_CARD_NOTE_KIND}:`) === true;
        if ((card || note) && (!mine || !card || !visible(card.taskId))) return [];
        const emojis = mine ? reacted.get(message.id) : undefined;
        return [Object.freeze({ ...plain, ...(emojis?.length ? { reactions: Object.freeze([...emojis]) } : {}) })];
      }));
    },
    turnContext(scopeKey, threadId, ownerAlone) {
      if (scopeKey !== parts.ownerScope || !ownerAlone) return '';
      try { return reactions.turnContext(scopeKey, threadId); } catch { return ''; }
    },
  };
  const route = createReactionRoute({ reactions, ownerScopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone });
  return { reactions, ports, route,
    /** The HTTP server's one dispatch for `/v1/reactions`; false for any other path. */
    async serve(request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, url: URL): Promise<boolean> {
      if (url.pathname !== REACTIONS_PATH) return false;
      await route(request, response, principal);
      return true;
    } };
}

/** On the conversation store's own connection, so the reactions read its messages and write beside them. */
export function configuredConversationExtras(store: Pick<SQLiteShannonStore, 'composeLearning'>,
  parts: Omit<Parameters<typeof createConversationExtras>[0], 'database'>) {
  return store.composeLearning(database => createConversationExtras({ ...parts, database }));
}
