import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { TaskMemory } from '../mind/memory/taskMemoryPorts.js';
import type { FcaConversationPort } from '../mind/action/fca/fcaConversationPorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import { toolFailure } from '../mind/tools/toolRegistryPorts.js';

/** The same registry/gate serves explicit memory reads in foreground and admitted background tasks. */
export function connectFcaMemoryTools(parts: {
  tools: ShannonToolRunner; memory: TaskMemory; conversation: FcaConversationPort;
  ownerScope: string; ownerAlone(): boolean;
}): void {
  parts.tools.useMemory({
    available: (scope, context) => scope === parts.ownerScope && parts.ownerAlone()
      && (Boolean(context?.observeMemory) || parts.conversation.taskToolsAvailable(scope)),
    async execute(name, input, context, signal) {
      if (!parts.ownerAlone() || context.scopeKey !== parts.ownerScope || !input || typeof input !== 'object' || Array.isArray(input)) {
        return toolFailure('refused', 'いま参照できる記憶はありません。', { retryable: false });
      }
      const observe = context.observeMemory ?? (ids => parts.conversation.observeSources(context.scopeKey, { recalledMemoryIds: ids }));
      const result = await parts.memory.execute(name, input as Record<string, unknown>, {
        scopeKey: context.scopeKey, present: OWNER_AUDIENCE, observe: ids => parts.ownerAlone() && observe(ids),
      }, signal);
      signal?.throwIfAborted();
      if (!parts.ownerAlone() || result.status === 'withheld' || result.status === 'cancelled') {
        return toolFailure('refused', 'この記憶は今の状況では参照できません。', { retryable: false });
      }
      return { ok: true, retryable: false, text: JSON.stringify(result) };
    },
  });
}
