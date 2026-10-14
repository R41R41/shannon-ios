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
  SHANNON_TEMPERAMENT,
  mentionsSuiteProduct,
  shannonPersonaPrompt,
  shannonTemperament,
  shannonSuitePrompt,
  suiteProductPattern,
  type ShannonAudience,
  type ShannonPersonaOptions,
  type ShannonSuiteProductId,
} from './persona.js';
export {
  SHANNON_AETHER_ACCESS_CAPABILITY,
  SHANNON_CAPABILITIES,
  SHANNON_CONDITIONAL_CAPABILITIES,
  SHANNON_FCA_TASK_CAPABILITY,
  SHANNON_FCA_SHARED_CAPABILITY,
  SHANNON_FCA_PROGRESS_CAPABILITY,
  SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY,
  SHANNON_DEVICE_ACTIONS_CAPABILITY,
  withDeviceActionsCapability,
  deviceActionsLimitationRewrites,
  DEVICE_REMINDER_BOUNDARY,
  NO_TIMER_BOUNDARY,
  PROMISE_SLOT_BOUNDARY,
  withDeviceReminderBoundary,
  SHANNON_LIMITATIONS,
  SHANNON_MINECRAFT_BODY_CAPABILITY,
  SHANNON_MEMO_PLACE_RULE,
  SHANNON_ROOM_LOOK_RULES,
  shannonCapabilityPrompt,
  withAetherAccessCapability,
  withReadToolsCapability,
  withToolWebSearchLine,
  SHANNON_READ_TOOLS_CAPABILITY,
  withSkillsCapability,
  SHANNON_SKILLS_CAPABILITY,
  withMinecraftBodyCapability,
  SHANNON_STAGE5_CAPABILITIES,
  withStage5Capabilities,
  type ShannonStage5Capabilities,
  type ShannonCapability,
  type ShannonCapabilityId,
} from './capabilities.js';
export {
  SHANNON_AUTONOMY_DAILY_BUDGET_YEN,
  SHANNON_AUTONOMY_DOMAINS,
  SHANNON_AUTONOMY_SYSTEM_DOMAIN,
  SHANNON_CONVERSATION_ACTION_DOMAIN,
  SHANNON_CORE_AREA_LABELS,
  autonomyDomain,
  autonomyDomainLabel,
  shannonAutonomyRuleLines,
  withAutonomyRunning,
  type ShannonAutonomyDomain,
  type ShannonAutonomyDomainId,
  type ShannonAutonomyRule,
  type ShannonCoreAreaId,
} from './autonomy.js';
export {
  SHANNON_PURSUIT_LIMITS,
  SHANNON_SEED_PURSUITS,
  SHANNON_SEEN_LIMITS,
  buildShannonOwnWorkPrompt,
  buildShannonPursuitsPrompt,
  buildShannonSeenPrompt,
  guardedShannonSeenPrompt,
  isSeedPursuitId,
  pursuitKindLabel,
  seedPursuits,
  withoutUnshownTitles,
  type ShannonOwnWork,
  type ShannonPursuit,
  type ShannonPursuitKind,
  type ShannonPursuitLink,
  type ShannonPursuitOrigin,
  type ShannonPursuitStatus,
  type ShannonSeenNote,
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
  messageEmotionForOthers,
  messageEmotionKind,
  SINGLE_FACE_FEELINGS,
  isSingleFaceFeeling,
  singleFace,
  type SingleFaceFeeling,
  type ShannonExpression,
  type ShannonFace,
  type ShannonFeeling,
  type ShannonMessageEmotion,
} from './expression.js';
export {
  presentShannonMood,
  resolveReplyEmotion,
  resolveWrittenReplyEmotion,
  type ReplyEmotion,
  type ReplyEmotionInput,
  type ShannonPresentMood,
} from './replyEmotion.js';
export { supportOverrideFor } from './emotionOverrides.js';
export { SHANNON_MOOD_BASELINE, deriveEmotionDelta, projectEmotionReaction, soothingIn } from './affect.js';
export {
  SHANNON_EMOTION_CONTINUITY,
  SHANNON_EMOTION_TIME,
  advanceEmotionClock,
  awakeTimeAt,
  remainingShare,
  type ShannonEmotionClockMode,
  type ShannonEmotionTiming,
} from './emotionTime.js';
export {
  lingeringFeelingLine,
  lingeringMeaning,
  lingeringStrength,
  livingLingering,
  moodBaseline,
  presentShannonFeeling,
  type ShannonFeelingState,
} from './emotionContinuity.js';
export {
  INITIAL_SHANNON_EXPRESSIVE_EMOTION,
  SHANNON_EMOTION_CARRY_THRESHOLD,
  SHANNON_EMOTION_CUE_STRENGTH,
  buildExpressiveEmotionPrompt,
  carriedShannonEmotion,
  currentShannonEmotion,
  holdsShannonFeeling,
  normalizeShannonExpressiveEmotion,
  isMoodLikeEmotion,
  isReactionEmotion,
  isShannonEmotionKind,
  resolveShannonEmotionState,
  shannonEmotionSign,
  type ResolveShannonEmotionInput,
} from './emotionState.js';
export {
  SHANNON_TOUCH_FEELINGS,
  SHANNON_TOUCH_MOOD_RATE,
  SHANNON_TOUCH_MOOD_STEP,
  SHANNON_TOUCH_REFLEX,
  feelTouch,
  holdsFeelingThroughTouch,
  isReflexTouch,
  isShannonTouchKind,
  isTouchFeeling,
  keepsFeelingThroughTouch,
  touchCause,
  touchFeeling,
  touchTarget,
  type ShannonTouchFeeling,
  type ShannonTouchFeelingStep,
} from './touchEmotion.js';
// Syzygy ADR-0006 stage 1 (影): the prediction layer and the new dynamics, computed beside the current ones and read by nothing that acts.
export {
  SHANNON_PREDICTION_COEFFICIENTS,
  SHANNON_PREDICTION_DOMAINS,
  createPredictionModel,
  isPredictionDomain,
  observeOutcome,
  predictOutcome,
  relativeUncertainty,
  scaleVariance,
  unexpectedness,
  transformedOutcome,
  type Prediction,
  type PredictionDomain,
  type PredictionDomainSpec,
  type PredictionFamily,
  type PredictionModel,
  type PredictionObservation,
  type PredictionQuery,
  type PredictionUpdate,
} from './prediction.js';
// Syzygy ADR-0008 stage 1: the value table estimates the noise and volatility of a cell as a key here does.
export { keyNoiseVolatility, noteInnovation, type Cause, type KeyState } from './predictionDomains.js';
export {
  SHANNON_AFFECT_COEFFICIENTS,
  SHANNON_AFFECT_DYNAMICS,
  SHANNON_AFFECT_STEP,
  advanceAffect,
  boundedAffectStep,
  createAffectDynamics,
  deterministicNormal,
  episodeBoundaryMs,
  impulseAffect,
  isStableMoodTilt,
  learnEpisodeGap,
  moodLoopGain,
  perceivedOutcome,
  projectAffect,
  reconsolidateTrace,
  stationaryBand,
  traceStrength,
  withinEpisodeProbability,
  type AffectCoefficient,
  type AffectDynamicsState,
  type AffectOutcome,
  type AffectProjection,
  type EmotionalTrace,
  type EpisodeBoundaryModel,
} from './affectDynamics.js';
// Syzygy ADR-0006 stage 2: a touch's startle and her stance's prediction error move her feeling (`SHANNON_PREDICTION`).
export {
  SHANNON_STANCE_OUTCOME,
  appraiseChoice,
  appraiseTouch,
  isFeltStartle,
  startleArousal,
  touchImpact,
  type ShannonTouchAppraisal,
  type ShannonTouchOutcome,
  type ShannonTouchStance,
} from './touchAppraisal.js';
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
  looksSecret,
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
export { SHANNON_EMOTION_KINDS, SHANNON_TOUCH_KINDS } from './types.js';
export type { ShannonTouch, ShannonTouchKind } from './types.js';
export type { ShannonEmotionClock, ShannonLingeringFeeling, ShannonLingeringSpan } from './types.js';
export {
  OWNER_AUDIENCE,
  SENSITIVITY_CATEGORY_LABELS,
  UNKNOWN_GUEST_PRESENCE,
  UNLABELLED_DISCLOSURE_MARKER,
  disclosureDecision,
  disclosureMarker,
  type DisclosureDecision,
  audienceCovers,
  classifySensitivity,
  describeAudience,
  disclosureFor,
  discloseSnapshot,
  groupAudience,
  isOwnerOnly,
  mayDisclose,
  normalizeAudience,
  normalizeDisclosure,
  ownerSpoke,
  peopleAudience,
  resolveDisclosure,
  widenAudience,
  type SensitivityDecision,
} from './disclosure.js';
export { MEMORY_SENSITIVITY_CATEGORIES } from './types.js';
export type { MemoryAudience, MemoryDisclosure, MemorySensitivity, MemorySensitivityCategory } from './types.js';
export { memoryIdentifier, visibleMemoryText, memoryControlFor, isMemoryEvidenceVisible, isOwnerMemoryEvidence } from './memory.js';
export { memoryEvidenceCacheSize, memoryEvidenceCounters, resetMemoryEvidenceCache, withoutMemoryEvidenceCache } from './memoryEvidence.js';
export { memoryKeyTerms, memoryWithholdingRules, restatesWithheldMemory, ruleWithholdsText, type MemoryWithholdingRule } from './withholding.js';
export { ownerDay } from './ownerDay.js';
export { SELF_INTEREST_LIMITS, selfInterestTopicKey, selfInterestWeight, selfInterestActive, selfInterestLine,
  selfInterestIndexUsed, selfInterestNightKey, selfInterestProjection,
  type SelfInterest, type SelfInterestAction, type SelfInterestProposal, type SelfInterestOwnerCommand,
  type SelfInterestChange, type SelfInterestSnapshot, type SelfInterestDetail, type SelfInterestEvidenceView, type SelfInterestVisible } from './selfInterests.js';
// Syzygy ADR-0012 stage 1: her character core and her inner note (pure parts; `SHANNON_INNER_NOTE`).
export {
  CHARACTER_CORE, CHARACTER_CORE_SPEECH, SHANNON_ONE_LINE_VOICE_INNER, characterCoreBlock, characterCoreHashInput, shannonOneLineVoice, type CharacterCore,
} from './characterCore.js';
export { INNER_NOTE_UNPLEASANT_LINE } from './emotionContinuity.js';
export {
  INNER_NOTE_DAY_REASONS, INNER_NOTE_INTENTS, INNER_NOTE_LIMITS, INNER_NOTE_SCALES, INNER_NOTE_SHOWN_KINDS, INNER_NOTE_TELLS, INNER_NOTE_TRIGGERS,
  asciiRouteSummary, boundedUntil, clippedNoteText, gatedIntent, innerNoteActive, innerNoteCurrent, innerNoteDay, innerNoteExpired,
  innerNoteEventLine, innerNoteFace, ordinaryCapOf, sulkingIntent, innerNoteRouteSummary, innerNoteTextLines, innerNoteTouchBlock,
  innerNoteTurnBlock, isInnerNoteDayReason, isInnerNoteIntent, isInnerNoteScale, isInnerNoteTell, isInnerNoteTrigger, localClock,
  settleInnerNote, shownKind, withoutOwnApology, zonedParts,
  type InnerNote, type InnerNoteDayEnd, type InnerNoteDayReason, type InnerNoteDraft, type InnerNoteEvent, type InnerNoteFlags,
  type InnerNoteHooks, type InnerNoteIntent, type InnerNoteScale, type InnerNoteTell, type InnerNoteText, type InnerNoteTrigger,
  type SettleInnerNoteInput,
} from './innerNote.js';
export {
  ADDRESS_WHEN_NATURAL, FALSEHOOD_LINE, INNER_NOTE_ADDRESS_LINE, INNER_NOTE_EXPRESSIVE_LINE, INNER_NOTE_HONESTY_LINE, LIGHT_SULKING_LINE,
  apologyIn, goodnightIn, innerNoteExpressiveEmotionPrompt, teasingIn, touchConsentIn, type TouchConsent,
} from './innerNoteWords.js';
export {
  INNER_NOTE_REFLECTION_SCHEMA, innerNoteReflectionInput, innerNoteReflectionInstructions, parsedInnerNoteReflection,
  innerNoteReflectionSchema, endorsedBoundaries, type InnerNoteReflectionFacts,
} from './innerNotePrompt.js';
// Syzygy ADR-0013 stage 1: feeling events, the episode ledger, the repetition watch, the comeback drawer, the feeling turn and the one face.
export * from './feelingEvent.js';
export * from './episodeLedger.js';
export * from './repetitionWatch.js';
export * from './comebackDrawer.js';
export * from './feelingTurn.js';
export * from './presentation.js';
// Syzygy ADR-0013 stage 2: appraisal, core affect and mood, the composure reserve, and their fold.
export * from './appraisal.js';
export * from './coreAffect.js';
export * from './composure.js';
export * from './feelingDynamics.js';
export * from './replyCheck.js';
export * from './textRegister.js';
export * from './feelingSentence.js';
export * from './relationshipLedger.js';
export * from './feelingDays.js';
export * from './episodeMemory.js';
export * from './boundaryMemory.js';
export * from './streamFeeling.js';
