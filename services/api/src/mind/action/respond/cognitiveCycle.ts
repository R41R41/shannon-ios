import type { ShannonCognitiveFrame, ShannonIntent } from '@shannon/cognition';
import type { CognitiveIntentPlan, CognitiveIntentStore } from './cognitiveIntent.js';

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
  plan?: CognitiveIntentPlan,
): ShannonIntent | null {
  const savedIntent = provisionalIntent
    ? store.capture(scopeKey, provisionalIntent, sourceExperienceID)
    : null;
  const plannedIntent = savedIntent && plan
    ? store.updatePlan(scopeKey, savedIntent.id, plan, receipt.occurredAt) ?? savedIntent
    : savedIntent;
  const finalFrame = plannedIntent && frame.primaryIntent?.id === provisionalIntent?.id
    ? Object.freeze({ ...frame, primaryIntent: plannedIntent })
    : frame;
  store.recordCycle(scopeKey, finalFrame, {
    ...receipt,
    recalledMemoryIDs: finalFrame.recalledMemoryIDs,
    outcome: 'completed',
  });
  return plannedIntent ?? frame.primaryIntent ?? null;
}
