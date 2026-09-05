export {
  INITIAL_SHANNON_EMOTION,
  INITIAL_SHANNON_TEMPERAMENT,
  createInitialCompanionState,
  freezeSnapshot,
  reduceCompanionState,
  restoreCompanionState,
} from './state.js';
export { InMemoryCompanionStateStore, type CompanionClock } from './store.js';
export {
  SHANNON_CORE_PROMPT,
  assembleShannonSystemPrompt,
  buildCompanionStatePrompt,
  type CompanionPromptOptions,
} from './prompt.js';
export {
  createShannonMessageEmotion,
  deriveShannonExpression,
  type ShannonExpression,
  type ShannonExpressionContext,
  type ShannonMessageEmotion,
} from './expression.js';
export { deriveEmotionDelta, projectEmotionReaction } from './affect.js';
export {
  deriveResonantInterest,
  scoreMemoryRelevance,
  selectActiveMemories,
  type RecallCandidate,
} from './recall.js';
export type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  CompanionStateStore,
  MemoryControl,
  MemoryKind,
  MemoryLearningSource,
  MemoryStatus,
  RelationshipInsight,
  ShannonEmotion,
  ShannonTemperament,
  UserFact,
} from './types.js';
export { memoryIdentifier, visibleMemoryText, memoryControlFor } from './memory.js';
