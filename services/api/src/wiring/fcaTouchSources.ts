import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { MemoryWithholding } from '../mind/memory/memoryVisibilityPorts.js';
import type { TaskMemory } from '../mind/memory/taskMemoryPorts.js';

/**
 * Whether every source of one touch is still visible to the owner (`fcaTouchWiring.ts`), in one synchronous check: the reads
 * share one state snapshot and one withholding, as the FCA source guard does (`fcaConversationSources.ts`), where each source
 * used to re-read the state and re-judge every remembered turn (hotfix 2026-10-14). The same `TaskMemory.read` gates decide:
 * a source is visible exactly when its read returns it.
 */
export function touchSourcesVisible(parts: {
  memory: Pick<TaskMemory, 'available' | 'read'>; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  readSourceVisible?(scope: string, id: string, observedAt: string): boolean;
}) {
  return (scope: string, ids: readonly string[]): boolean => {
    if (!parts.memory.available(scope, { kind: 'owner' })) return false;
    const unique = [...new Set(ids)], state = parts.state.snapshot(scope);
    const withholding = new MemoryWithholding(state, parts.conversations, scope, undefined, parts.readSourceVisible);
    for (let offset = 0; offset < unique.length; offset += 40) {
      const chunk = unique.slice(offset, offset + 40);
      if (parts.memory.read(scope, chunk, { kind: 'owner' }, { state, withholding }).length !== chunk.length) return false;
    }
    return true;
  };
}
