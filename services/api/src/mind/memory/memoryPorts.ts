/**
 * The window of the memory part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`): what another part of the mind, or an
 * integration, may import of it. Stage 2, step 6: her skill memory and its pattern wiki (`skillMemory.ts`, `skillDocument.ts`),
 * which the sleep builder, her `skill.read` tool, tree recall and the Aether export reach through here. Stage 3 (S1): the rest of
 * what other parts use of memory (impressions, visibility under forgetting, promises, the day key, and the types of the
 * conversation store and its neighbours; a store itself is handed by wiring, rule `ports-types-only-from-stores`).
 */
export {
  SKILL_CAPACITY, SKILL_INDEX_HEADER, SKILL_LIFECYCLE, applyReplacements, injectionThreats, skillIndexHeader, skillLint, SKILL_LIMITS, SKILL_NAME, SKILL_SECTIONS, baselineRate, checked, encodeSkill, lineDiff, parseSkill, retiresForLowSuccess,
  skillHash, skillIndex, skillSections, trialVerdict,
  type SkillDocument, type SkillProblem, type SkillSection, type SkillStatus,
} from './skillDocument.js';
export {
  PATTERN_LIMITS, SKILL_MINIMUM_AGE_DAYS, SKILL_USE_NEXT_TURN_MINUTES, SkillMemory, type SkillBodyCheck, type SkillCreation, type SkillPatch, type SkillRejection,
} from './skillMemory.js';
export type { PatternLogEntry, SkillActor, SkillAuditEntry, SkillRevision, SkillUse, StoredPattern, StoredSkill } from './store/sqliteSkills.js';
export { SKILL_LINEAGE, chosenBase, parentBaseline, rankedNodes, scoredLineage, versionRevisionId, type LineageNode, type ScoredNode } from './skillLineage.js';
export { checkedSkillBody, checkedSkillText } from './skillMemoryParts.js';
export { copyDeleted, copyEdit, copyWritesRead, noteCopyWrite } from './skillCopies.js';
export { IMPRESSION_MEMORY_PREFIX, OWNER_PERSON_KEY, comparable, impressionConfidence, impressionConfig, impressionMemoryId, impressionsEnabled, type ImpressionPerson, type ImpressionSource, type PersonImpression } from './impressions.js';
export { localDayKey } from './memoryProjection.js';
export { type SleepChange, type SleepContradiction } from './memoryService.js';
export { MemoryWithholding, conversationStoreOf, isForgottenCommitmentEvidence, replaySummaryFor, replaySummaryRawRange, usableReplaySummary, visibleReplayMessages, type VisibleMessage } from './memoryVisibility.js';
export { type OwnerUpcoming } from './ownerUpcoming.js';
export { EXACT_TIME_DECLINED, extractPromiseCaptures, requestsExactTimeAlert } from './prospectiveMemory.js';
export { type ConversationStore, type ShannonExperience, type StoredConversationMessage, type TurnPersistenceContext } from './store/conversationStore.js';
export { type MemoryEmbeddingIndex, type StoredEmbeddingCandidate } from './store/sqliteMemoryEmbeddings.js';
export { type ShannonKnowledgeStore } from './store/sqliteShannonKnowledge.js';
export { MEMORY_OP_KINDS, MEMORY_OP_ORIGINS, memoryOpCodec, type MemoryOp, type MemoryOpDraft, type MemoryOpKind, type MemoryOpOrigin } from './memoryOpCodec.js';
export { MemoryCommands, MemoryWriter, type MemoryProposals } from './memoryWriter.js';
export { type MemoryTargets } from './memoryOps.js';
export { decayDryRun, decayedUsable, identityOf, identityPeople, nameCosine, ruleJudgement, type IdentityChooser, type PersonFactJudge } from './personFacts.js';
export { type IdentityCandidate, type PersonFactRow, type TurnSpeaker } from './store/personFactsStore.js';
export { type KnowledgeStore } from './store/knowledgeStore.js';
export { type PeopleMemoryStore, type PersonMemoryItem, type RememberedPerson } from './store/peopleMemoryStore.js';
export { type PersonIdentityStore } from './store/personIdentity.js';
export { type TurnCaptureRecord } from './store/turnCaptures.js';
