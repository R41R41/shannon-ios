export {
  INITIAL_SHANNON_EMOTION,
  INITIAL_SHANNON_TEMPERAMENT,
  createInitialCompanionState,
  freezeSnapshot,
  reduceCompanionState,
} from './state.js';
export { restoreCompanionState } from './stateRestore.js';
export {
  SHARED_DAY_WINDOW,
  calibrateTemperament,
  explainTemperament,
  temperamentEvidence,
  type ShannonTemperamentEvidence,
  type ShannonTemperamentReasons,
} from './temperament.js';
export { InMemoryCompanionStateStore, type CompanionClock } from './store.js';
export {
  SHANNON_CURRENT_GOAL,
  SHANNON_FIRST_PERSON,
  SHANNON_MOTIVE,
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
  SHANNON_AUTONOMY_DAILY_BUDGET_YEN,
  SHANNON_AUTONOMY_DOMAINS,
  SHANNON_AUTONOMY_SYSTEM_DOMAIN,
  SHANNON_CORE_AREA_LABELS,
  autonomyDomain,
  autonomyDomainLabel,
  shannonAutonomyRuleLines,
  type ShannonAutonomyDomain,
  type ShannonAutonomyDomainId,
  type ShannonAutonomyRule,
  type ShannonCoreAreaId,
} from './autonomy.js';
export {
  SHANNON_PURSUIT_LIMITS,
  SHANNON_SEED_PURSUITS,
  buildShannonPursuitsPrompt,
  isSeedPursuitId,
  pursuitKindLabel,
  seedPursuits,
  type ShannonPursuit,
  type ShannonPursuitKind,
  type ShannonPursuitLink,
  type ShannonPursuitOrigin,
  type ShannonPursuitStatus,
} from './pursuits.js';
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
  deriveShannonFace,
  faceForEmotionKind,
  faceForMood,
  type ShannonExpression,
  type ShannonFace,
  type ShannonFeeling,
  type ShannonMessageEmotion,
} from './expression.js';
export {
  presentShannonMood,
  resolveReplyEmotion,
  type ReplyEmotion,
  type ReplyEmotionInput,
  type ShannonPresentMood,
} from './replyEmotion.js';
export { supportOverrideFor } from './emotionOverrides.js';
export { deriveEmotionDelta, projectEmotionReaction } from './affect.js';
export {
  INITIAL_SHANNON_EXPRESSIVE_EMOTION,
  SHANNON_EMOTION_CARRY_THRESHOLD,
  buildExpressiveEmotionPrompt,
  carriedShannonEmotion,
  currentShannonEmotion,
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
export { memoryKeyTerms, memoryWithholdingRules, restatesWithheldMemory, ruleWithholdsText, type MemoryWithholdingRule } from './withholding.js';
