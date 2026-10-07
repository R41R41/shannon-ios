import type { CompletedTurn } from './backgroundUpdates.js';
import type { TurnPersistenceContext } from '../memory/memoryPorts.js';

/** Closed persistence metadata shared across surfaces; no background service is instantiated. */
export function turnPersistenceContext(turn: CompletedTurn): TurnPersistenceContext {
  return {
    messageEmotion: turn.messageEmotion,
    capturedStateVersion: turn.capturedState.version,
    ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
    ...(turn.threadTitle ? { threadTitle: turn.threadTitle } : {}),
    ...(turn.threadSummary ? { threadSummary: turn.threadSummary } : {}),
    ...(turn.taskDecision ? { taskDecision: turn.taskDecision } : {}),
    ...(turn.artifacts?.length ? { artifacts: turn.artifacts } : {}),
    ...(turn.recalledMemoryIds ? { recalledMemoryIds: turn.recalledMemoryIds } : {}),
    ...(turn.summaryContinuesChain ? { summaryContinuesChain: true } : {}),
    ...(turn.audience ? { audience: turn.audience } : {}),
    ...(turn.speaker ? { speaker: turn.speaker } : {}),
  };
}
