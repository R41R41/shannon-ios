import type { ShannonCognitiveFrame, ShannonIntent } from '@shannon/cognition';
import type { CognitiveIntentStore } from './cognitiveIntent.js';

export function recordCompletedCognitiveCycle(
  store: CognitiveIntentStore,
  scopeKey: string,
  frame: ShannonCognitiveFrame,
  provisionalIntent: ShannonIntent | null,
  sourceExperienceID: string | undefined,
  receipt: {
    threadId: string;
    channel: 'text' | 'voice';
    action: 'respond' | 'command' | 'delegate';
    summary: string;
    occurredAt: string;
  },
): void {
  const savedIntent = provisionalIntent
    ? store.capture(scopeKey, provisionalIntent, sourceExperienceID)
    : null;
  const finalFrame = savedIntent && frame.primaryIntent?.id === provisionalIntent?.id
    ? Object.freeze({ ...frame, primaryIntent: savedIntent })
    : frame;
  store.recordCycle(scopeKey, finalFrame, {
    ...receipt,
    recalledMemoryIDs: finalFrame.recalledMemoryIDs,
    outcome: 'completed',
  });
}
