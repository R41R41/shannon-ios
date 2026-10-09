import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { conversationSecrets } from '../mind/inhibition/disclosurePorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import { toolSessionMemory } from '../mind/tools/shannonToolTypes.js';
import { webReadResult } from '../mind/tools/shannonReadTools.js';
import { MEMORY_TOOLS } from '../mind/tools/memoryToolDefinitions.js';
import type { FcaExternalTools } from '../mind/action/fca/fcaPorts.js';

/** Public web research reuses the existing registry, gate, native search provider and usage accounting. */
export function fcaResearchTools(parts: {
  tools: ShannonToolRunner; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  scopeKey: string; ownerAlone(): boolean; sourcesVisible?(): boolean;
  observeMemory?(ids: readonly string[]): boolean;
}): FcaExternalTools {
  const memory = toolSessionMemory();
  return {
    definitions: [...parts.tools.offered('text', 'owner_alone', parts.scopeKey).filter(tool => tool.name === 'web.search'), ...(parts.observeMemory ? MEMORY_TOOLS : [])],
    async execute(call) {
      if (call.name !== 'web.search' && !(parts.observeMemory && MEMORY_TOOLS.some(tool => tool.name === call.name))) throw new Error('FCA_TOOL_NOT_OFFERED');
      if (call.scopeKey !== parts.scopeKey || !parts.ownerAlone()) throw new Error('FCA_SOURCE_WITHHELD');
      call.signal.throwIfAborted();
      const secrets = conversationSecrets(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey);
      const beforeExecution = () => {
        call.signal.throwIfAborted();
        if (!parts.ownerAlone() || parts.sourcesVisible?.() === false) throw new Error('FCA_SOURCE_WITHHELD');
        const query = call.input && typeof call.input === 'object' ? (call.input as { query?: unknown }).query : undefined;
        if (call.name === 'web.search' && (typeof query !== 'string' || conversationSecrets(parts.state.snapshot(parts.scopeKey), parts.conversations, parts.scopeKey).carries(query))) throw new Error('FCA_SOURCE_WITHHELD');
      };
      const result = await parts.tools.call(call.name, call.input, { scopeKey: parts.scopeKey,
        surface: 'text', audience: 'owner_alone', memory, secrets, beforeExecution, ...(parts.observeMemory ? { observeMemory: parts.observeMemory } : {}), timeMilliseconds: 45_000, acknowledgementOwner: 'fca' }, call.signal);
      call.signal.throwIfAborted();
      // The shared runner returns failures to normal chat, but an unknown outside request must hold this original segment.
      if (webReadResult(memory)?.status === 'unknown') throw new Error('FCA_RESEARCH_RESULT_UNKNOWN');
      if (!parts.ownerAlone() || parts.sourcesVisible?.() === false) throw new Error('FCA_SOURCE_WITHHELD');
      return result;
    },
  };
}
