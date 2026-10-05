import { visibleMemoryText, type CompanionStateSnapshot, type MemoryDisclosure } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';

/**
 * What a write of hers from a conversation must not repeat (ADR-0002; owner decision 2026-10-05): what the owner
 * asked to keep secret or marked 機微 by hand, and what he asked her to forget (or rejected, or corrected: the
 * original wording). The words are used only to check what her study and folder tools are asked to write
 * (`carriesSecret`, the check her own time uses); they are never given to a model. Her stories and notes may be
 * about him and the people he knows otherwise.
 */
const SECRET_CHARACTERS = 400;
const SECRETS_MAXIMUM = 2_000;

function keptSecret(disclosure: MemoryDisclosure | undefined): boolean {
  return disclosure?.category === 'secret' || (disclosure?.decidedBy === 'owner' && disclosure.sensitivity === 'sensitive');
}

export function conversationSecrets(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): readonly string[] {
  const items = [
    ...state.userFacts.map(item => ({ id: item.id, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.relationships.map(item => ({ id: item.id, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.prospectiveMemories.map(item => ({ id: item.id, texts: [item.summary], disclosure: item.disclosure })),
  ];
  const words = items.filter(item => keptSecret(item.disclosure) || visibleMemoryText(state, item.id, item.texts[0]!) === null).flatMap(item => item.texts);
  const turns = conversations.experienceCandidates(scopeKey)
    .filter(turn => keptSecret(turn.disclosure) || visibleMemoryText(state, turn.id, turn.summary) === null)
    .map(turn => turn.userMessage);
  const all = [...new Set([...words, ...turns].map(text => text.trim().slice(0, SECRET_CHARACTERS)).filter(Boolean))];
  // A list too long to check in full would leave some of it unchecked: the caller then refuses every write.
  if (all.length > SECRETS_MAXIMUM) throw new Error('CONVERSATION_SECRETS_TOO_MANY');
  return all;
}
