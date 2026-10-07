/**
 * The window of the memory part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`): what another part of the mind, or an
 * integration, may import of it. Stage 2, step 6: her skill memory and its pattern wiki (`skillMemory.ts`, `skillDocument.ts`),
 * which the sleep builder, her `skill.read` tool, tree recall and the Aether export reach through here.
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
export { versionRevisionId } from './store/sqliteSkills.js';
export { SKILL_LINEAGE, chosenBase, parentBaseline, rankedNodes, scoredLineage, type LineageNode, type ScoredNode } from './skillLineage.js';
export { checkedSkillBody, checkedSkillText } from './skillMemoryParts.js';
export { copyDeleted, copyEdit, copyWritesRead, noteCopyWrite } from './skillCopies.js';
