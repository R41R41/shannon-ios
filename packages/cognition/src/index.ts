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
  SHANNON_FIRST_PERSON,
  SHANNON_ONE_LINE_VOICE,
  SHANNON_OWNER_NAME,
  SHANNON_SUITE_PRODUCTS,
  mentionsSuiteProduct,
  shannonPersonaPrompt,
  shannonSuitePrompt,
  suiteProductPattern,
  type ShannonAudience,
  type ShannonSuiteProductId,
} from './persona.js';
export {
  SHANNON_CAPABILITIES,
  SHANNON_LIMITATIONS,
  shannonCapabilityPrompt,
  type ShannonCapability,
  type ShannonCapabilityId,
} from './capabilities.js';
export {
  SHANNON_CORE_PROMPT,
  shannonIdentityPrompt,
  assembleShannonSystemPrompt,
  buildCompanionStatePrompt,
  buildIntentPrompt,
  buildTurnCognitivePrompt,
  selectPrimaryIntent,
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
  INITIAL_SHANNON_EXPRESSIVE_EMOTION,
  buildExpressiveEmotionPrompt,
  isShannonEmotionKind,
  resolveShannonEmotionState,
  type ResolveShannonEmotionInput,
} from './emotionState.js';
export { isMeaningfulInterest, filterMeaningfulInterests } from './interests.js';
export {
  deriveResonantInterest,
  scoreMemoryRelevance,
  selectActiveMemories,
  selectContextualMemories,
  type RecallCandidate,
} from './recall.js';
export {
  MAXIMUM_MEMORY_SEARCH_TERMS,
  buildMemorySearchPlan,
  isEmptyMemorySearchPlan,
  memorySearchMatchExpression,
  scoreMemorySearchText,
  searchMemoryDocuments,
  type MemorySearchDocument,
  type MemorySearchPlan,
} from './memorySearch.js';
export {
  mergeSemanticMemories,
  needsSemanticMemoryRecall,
  type SemanticRecallHit,
} from './semanticRecall.js';
export {
  SHANNON_KNOWLEDGE_LIMITS,
  buildShannonKnowledgePrompt,
  flattenKnowledgeHeadings,
  isForgetCitedMemoriesCommand,
  isMemoryInquiry,
  knowledgeExcerpt,
  normalizeKnowledgeDraft,
  parseKnowledgeHeadingTree,
  selectKnowledgeSections,
  selectRelevantKnowledge,
  usableShannonKnowledge,
  type AetherDecisionReference,
  type KnowledgeDraft,
  type KnowledgeDraftRejection,
  type KnowledgeHeadingNode,
  type KnowledgePromptItem,
  type ShannonKnowledgeDocument,
  type ShannonKnowledgeStatus,
} from './shannonKnowledge.js';
export type {
  ContextualMemory,
  ShannonActionReceipt,
  ShannonCognitiveFrame,
  ShannonEmbodimentFrame,
  ShannonExperienceChannel,
  ShannonMemoryQuery,
  ShannonRecallReason,
  ShannonSituationSnapshot,
  ShannonIntent,
  ShannonVerifiedWork,
  ShannonVerifiedWorkPlanItem,
} from './runtime.js';
export type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  CompanionStateStore,
  MemoryControl,
  MemoryKind,
  MemoryLearningSource,
  MemoryStatus,
  ProspectiveMemory,
  RelationshipInsight,
  ShannonEmotion,
  ShannonEmotionKind,
  ShannonEmotionOverrideReason,
  ShannonEmotionVisibility,
  ShannonExpressiveEmotion,
  ShannonTemperament,
  UserFact,
} from './types.js';
export { SHANNON_EMOTION_KINDS } from './types.js';
export { memoryIdentifier, visibleMemoryText, memoryControlFor, isMemoryEvidenceVisible, isOwnerMemoryEvidence } from './memory.js';
