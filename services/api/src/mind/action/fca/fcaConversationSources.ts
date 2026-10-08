import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaReadReceipt, FcaObservedSources, FcaSourceGuard } from './fcaConversationPorts.js';
import { shannonTool } from '../../tools/toolRegistryPorts.js';

/** Closed provenance covers replay and its summary lineage without copying either into the task's history. */
export function conversationFcaProvenance(state: CompanionStateSnapshot, conversations: ConversationStore,
  scopeKey: string, threadId: string, recalledMemoryIds: readonly string[]): string[] {
  const withholding = new MemoryWithholding(state, conversations, scopeKey);
  const lineage = conversations.threadSummaryLineage?.(scopeKey, threadId)?.messages
    ?? conversations.conversationHistory(scopeKey, threadId);
  // The shared-state/profile block can contain a fact even when semantic recall did not select it.
  const profile = [
    ...state.userFacts.map(item => [item.id, item.statement] as const),
    ...state.relationships.map(item => [item.id, item.statement] as const),
    ...state.activeMemories.map(item => [item.id, item.summary] as const),
    ...state.prospectiveMemories.filter(item => item.status === 'pending').map(item => [item.id, item.summary] as const),
    ...state.interests.map(item => [memoryIdentifier('interest', item), item] as const),
  ].filter(([id, text]) => visibleMemoryText(state, id, text)).map(([id]) => id);
  return [...new Set([...recalledMemoryIds, ...profile, ...lineage.filter(message => !withholding.withholdsMessage(message))
    .flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : [])])];
}

/** Re-read canonical conversation provenance under today's memory controls; native task history is never edited. */
export function createFcaSourceGuard(parts: {
  runtime: TaskRuntime; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean;
  readSourceVisible?(scopeKey: string, id: string, observedAt: string): boolean;
}): FcaSourceGuard {
  const sourcesVisible: FcaSourceGuard['sources'] = (scopeKey, task, sources, pendingStepId) => {
    if (scopeKey !== parts.ownerScope) return false;
    try {
      if (!parts.ownerAlone()) return false;
      if (task.scopeKey !== scopeKey) return false;
      if (!sources.length) return true; // Direct owner API tasks have no inherited conversation source.
      const state = parts.state.snapshot(scopeKey), withholding = new MemoryWithholding(state, parts.conversations, scopeKey);
      for (const source of sources) {
        if (!source.experienceId) { if (source.stepId !== pendingStepId) return false; continue; }
        if (source.readSourceIds?.some(id => !parts.readSourceVisible?.(scopeKey, id, source.observedAt))) return false;
        const experience = parts.conversations.experiencesById?.(scopeKey, [source.experienceId])[0];
        if (!experience || parts.conversations.threadOfTurn?.(scopeKey, source.experienceId) !== source.threadId) return false;
        if (withholding.withholdsExperience({ ...experience, recalledMemoryIds: source.recalledMemoryIds })
          || withholding.withholdsMessage({ id: source.experienceId, sourceExperienceId: source.experienceId,
            role: 'user', content: experience.userMessage, observedAt: source.observedAt })
          || withholding.withholdsReply({ experienceId: source.experienceId, observedAt: source.observedAt,
            recalledMemoryIds: source.recalledMemoryIds,
            text: [task.title, task.goal, task.completionCriteria, task.summary].join('\n') })) return false;
      }
      return true;
    } catch { return false; }
  };
  return Object.assign((scopeKey: string, taskId: string, pendingStepId?: string) => {
    const task = parts.runtime.get(scopeKey, taskId);
    return Boolean(task && sourcesVisible(scopeKey, task, parts.runtime.taskSources(scopeKey, taskId), pendingStepId));
  }, { sources: sourcesVisible });
}

/** Trusted executor receipts only. Unknown or missing private read metadata is explicit, never treated as public. */
export function fcaReadReceiptSources(receipt: FcaReadReceipt): FcaObservedSources {
  if (!receipt.ok) return {};
  const tool = shannonTool(receipt.name);
  if (tool?.domain === 'task_runtime' || receipt.name === 'web.search' || receipt.name === 'places.search') return {};
  const documents = receipt.documents?.sourceIds ?? receipt.documents?.read;
  if (!documents) return tool?.effect === 'read'
    ? { readSourceIds: [`fca-unresolved://${receipt.name}`] } : {};
  const ids = documents.map(id => {
    if (typeof id !== 'string' || !id || id.length > 200) return 'fca-unresolved://invalid-receipt';
    if (/^(?:shannon-study|aether-document|notion-page|voyager-task|calendar-item|shannon-folder|shannon-skill):\/\//u.test(id)) return id;
    return receipt.name.startsWith('aether') || receipt.name.startsWith('ownerDocs.')
      ? `aether-document://${encodeURIComponent(id)}` : 'fca-unresolved://unknown-receipt';
  });
  return { readSourceIds: [...new Set(ids)] };
}
