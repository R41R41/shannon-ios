import { OWNER_AUDIENCE, type CompanionStateStore } from '@shannon/cognition';
import { BODY_LOOK_LIMITS } from '../../contracts/bodyLookContract.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import { visibleReplayMessages } from '../../mind/memory/memoryVisibility.js';
import type { RoomLookContextLine } from './bodyLookVision.js';

/**
 * What the model that sees a frame is told of the Talk (Syzygy ADR-0011 §3.2 and §11 item 6: the audience and forgetting are
 * applied again when the frame is used, not when the look was opened). The lines pass the same filter as any replay, so what the
 * owner asked her to forget is never re-fed; and while anyone else may be present now, no line of the Talk is given at all
 * (`shannon-information-inputs.md`: `shannonBody.ts:125,128`, `bodyLook.ts:415-418`, `appLook.ts:295-300`).
 */
export function lookContextReader(parts: {
  stateStore: Pick<CompanionStateStore, 'snapshot'>;
  conversationStore: ConversationStore;
  /** Whether the owner alone can see or hear her now (the API's own audience). */
  alone(scopeKey: string): boolean;
}): (scopeKey: string, threadId: string) => readonly RoomLookContextLine[] {
  return (scopeKey, threadId) => {
    if (!parts.alone(scopeKey)) return [];
    try {
      const snapshot = parts.stateStore.snapshot(scopeKey);
      const visible = visibleReplayMessages(snapshot, parts.conversationStore, scopeKey, threadId, OWNER_AUDIENCE, BODY_LOOK_LIMITS.contextMessages);
      return visible.messages.map(entry => ({ role: entry.item.role === 'user' ? 'user' as const : 'assistant' as const, content: entry.item.content }));
    } catch {
      return [];
    }
  };
}
