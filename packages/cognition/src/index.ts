export {
  INITIAL_SHANNON_EMOTION,
  INITIAL_SHANNON_TEMPERAMENT,
  createInitialCompanionState,
  freezeSnapshot,
  reduceCompanionState,
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
  type ShannonMessageEmotion,
} from './expression.js';
export type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  CompanionStateStore,
  ShannonEmotion,
  ShannonTemperament,
  UserFact,
} from './types.js';
