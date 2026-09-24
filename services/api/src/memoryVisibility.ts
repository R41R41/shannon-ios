import { visibleMemoryText, isMemoryEvidenceVisible, type CompanionStateSnapshot } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonConversationItem } from './chatModel.js';

/** Keep the durable transcript intact, but don't re-feed forgotten evidence. */
export function visibleConversationHistory(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
): readonly ShannonConversationItem[] {
  const hidden = store.experienceCandidates(scopeKey).filter(item => !visibleMemoryText(state, item.id, item.summary)
    || !isMemoryEvidenceVisible(state, item.userMessage));
  const invalidatedAt = contextInvalidationBoundary(state);
  const count = store.history(scopeKey, threadID).length;
  if (!count) return [];
  return store.conversationHistory(scopeKey, threadID).slice(-count).filter(message =>
    // Legacy replies have no span-level lineage; any may paraphrase a memory.
    !(message.role === 'assistant' && invalidatedAt && message.observedAt <= invalidatedAt)
    && isMemoryEvidenceVisible(state, message.content) && !hidden.some(item =>
      message.sourceExperienceId === item.id || message.content === item.userMessage || message.content === item.shannonReply))
    .map(({role, content}) => ({role, content}));
}

function contextInvalidationBoundary(state: CompanionStateSnapshot): string | undefined {
  return state.memoryControls.flatMap(control => control.contextInvalidatedAt
    ?? (control.status !== 'active' || control.overrideText ? control.updatedAt : []))
    .sort().at(-1);
}

export function mayUseThreadSummary(state: CompanionStateSnapshot): boolean {
  // A rolling summary has no span-level provenance. Until it is rebuilt from
  // visible inputs, omitting it is safer than reintroducing forgotten evidence.
  return !contextInvalidationBoundary(state);
}

export function isForgottenCommitmentEvidence(state: CompanionStateSnapshot, evidence: string): boolean {
  return !isMemoryEvidenceVisible(state, evidence);
}
