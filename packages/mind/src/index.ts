/**
 * `@shannon/mind`: the pure parts of Syzygy ADR-0008 stage 3 (知覚・注意・共有の場・記憶の書き手・人の事実). Core: response path
 * (files listed by name in `autonomyCore.ts` keep the area that lists them).
 *
 * Like `@shannon/cognition` and `@shannon/learning` it holds no database, no network, no environment and no timer: the services
 * hand it events, rows and the time, and store what it returns. The contract is `docs/mind-workspace-contract.md`.
 */
export {
  MIND_SWITCH_NAMES,
  mindSwitches,
  switchedOn,
  switchedOnExplicitly,
  type MindSwitches,
  type SwitchValues,
} from './switches.js';
export {
  MIND_EVENT_KINDS, MIND_EVENT_LIMITS, MIND_EVENT_SCHEMA, MIND_SPEAKER_KINDS, MIND_SURFACES, MIND_TRUST, checkedMindEvent, mindEvent, withoutText,
  type MindContent, type MindEvent, type MindEventDraft, type MindEventKind, type MindPresence, type MindProvenance, type MindSpeaker,
  type MindSpeakerKind, type MindSurface, type MindTrust,
} from './envelope.js';
export {
  SALIENCE_V1, admit, currentSalience, decayedSalience, novelty, orderedItems, persistenceOf, salience, salienceTerms,
  type Admission, type AttentionItem, type SalienceInputs, type SaliencePersistence, type SalienceTerm,
} from './salience.js';
export {
  MINHASH_V1, characterGrams, decodeSignature, encodeSignature, gramText, jaccard, minHashSignature, signatureSimilarity, textSimilarity,
  type MinHashSignature,
} from './minhash.js';
export {
  PROACTIVE_GATE_V1, PROACTIVE_HOLD_CODES, PROACTIVE_REASONS, intentExpiresAt, ownerActiveHoldMilliseconds, proactiveVerdict, topicDecay, topicReuse,
  type ProactiveHistory, type ProactiveHoldCode, type ProactiveIntent, type ProactiveReason, type ProactiveVerdict,
} from './proactiveGate.js';
export {
  EVIDENCE_DECAY_V1, EVIDENCE_KINDS, belowZeroSince, decayTransitions, evidenceNet, evidenceState, evidenceSums, evidenceUsable,
  type DecayDryRunItem, type DecayTransition, type Evidence, type EvidenceKind, type EvidenceState, type EvidenceStatus,
} from './evidenceDecay.js';
export {
  IDENTITY_TIERS_V1, NEW_PERSON, bitsPerCharacter, entropyGate, identify, identityChoice, identityMenu, identityNameKey, joinsAutomatically,
  type IdentityChoice, type IdentityMenuItem, type IdentityObservation, type IdentityOutcome, type IdentityPerson,
} from './identityTiers.js';
export {
  TEMPORAL_FACTS_V1, backfilledFact, contradiction, duplicateOf, factCurrent, joinedEpisodes, resolvedFact,
  type FactJudgement, type FactResolution, type TemporalFact,
} from './temporalFacts.js';
export {
  COMPACTION_BODY_ITEM_CHARACTERS,
  COMPACTION_SECTIONS, COMPACTION_V1, checkedTemplate, compactionItem, emptyTemplate, mergedTemplate, renderedCompaction, summaryInput,
  type CompactionMessage, type CompactionSection, type CompactionTemplate,
} from './compaction.js';
export {
  TRUST_KINDS, TRUST_PARAMETERS, trustFold, trustSettlements, validTrustParameters,
  type TrustEntry, type TrustKind, type TrustParameters, type TrustSettlement,
} from './trustFold.js';
export * from './actions.js';
export * from './taskTree.js';
export * from './planTree.js';
export * from './tasks.js';
export * from './taskMachine.js';
export * from './capabilities.js';
export * from './goals.js';
export * from './deliberation.js';
export * from './workingEvents.js';
export * from './workingArbiter.js';
export * from './workAgenda.js';
export * from './procedureRun.js';
export * from './liveCommentary.js';
export * from './liveGovernor.js';
