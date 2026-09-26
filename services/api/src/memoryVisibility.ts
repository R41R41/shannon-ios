import { visibleMemoryText, isMemoryEvidenceVisible, type CompanionStateSnapshot } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonConversationItem } from './chatModel.js';

/** Keep the durable transcript intact, but don't re-feed forgotten evidence. */
export function visibleConversationHistory(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
): readonly ShannonConversationItem[] {
  const hidden = store.experienceCandidates(scopeKey).filter(item => !visibleMemoryText(state, item.id, item.summary));
  return store.history(scopeKey, threadID).filter(message => !hidden.some(item =>
    message.content === item.userMessage || message.content === item.shannonReply));
}

export function mayUseThreadSummary(state: CompanionStateSnapshot): boolean {
  // A rolling summary has no span-level provenance. Until it is rebuilt from
  // visible inputs, omitting it is safer than reintroducing forgotten evidence.
  return !state.memoryControls.some(control => control.kind === 'experience' && control.status !== 'active');
}

export function isForgottenCommitmentEvidence(state: CompanionStateSnapshot, evidence: string): boolean {
  return !isMemoryEvidenceVisible(state, evidence);
}
