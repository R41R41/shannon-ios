/**
 * `@shannon/learning`: the pure parts of Syzygy ADR-0008 stage 1 (答え合わせ・報酬系・価値表) and stage 2 (the switches, and
 * the difficulty policy, whose core area is the response path: `difficultyPolicy.ts`). Core: emotion.
 *
 * Like `@shannon/cognition` it holds no database, no network, no environment and no timer: the services hand it rows
 * and values and store what it returns. The contract is `docs/cognition-ledger-contract.md`.
 */
export {
  cognitionLedgerSwitches,
  skillRoutingSwitches,
  switchedOn,
  switchedOnExplicitly,
  type CognitionLedgerSwitches,
  type SkillRoutingSwitches,
  type SwitchValues,
} from './switches.js';
export {
  CALL_ANSWER_OUTCOME,
  INTERVAL_80_Z,
  LEDGER_DOMAINS,
  LEDGER_DOMAIN_RULES,
  STORY_REACTION_OUTCOME,
  createLedgerMind,
  foldSettled,
  isLedgerDomain,
  ledgerOutcome,
  ledgerPrediction,
  recomputeLedger,
  roundedDerived,
  sameDerived,
  settledInOrder,
  type LedgerDerived,
  type LedgerDomain,
  type LedgerDomainRule,
  type LedgerMind,
  type LedgerRow,
  type LedgerStatus,
} from './predictionLedger.js';
export {
  RELIABILITY_BINS,
  calibration,
  reliabilityBins,
  type CalibrationReport,
  type CalibrationRow,
  type DomainCalibration,
  type ReliabilityBin,
} from './calibration.js';
export {
  MOOD_INELIGIBLE_CODES,
  REWARD_FORMULA,
  ROOT_VALUE,
  moodEligible,
  choiceFamily,
  growthScore,
  predictionSkill,
  rewardOf,
  serveRule,
  serveScore,
  settle,
  worldScore,
  type LinkedPrediction,
  type RewardFormula,
  type RewardParts,
  type ServeRule,
  type Settlement,
  type ValueRead,
} from './reward.js';
export {
  VALUE_LEVELS,
  VALUE_SCALE_VARIANCE,
  createValueTable,
  foldValues,
  learnValue,
  valueCells,
  valueOf,
  valuePath,
  type ValueCell,
  type ValueEvidence,
  type ValueLevel,
  type ValueTable,
} from './valueTable.js';
export {
  NIGHTLY_VERSION_RETENTION_DAYS,
  nightlyDecision,
  rollbackTarget,
  versionsToPrune,
  type NightlyDecision,
  type ValueVersionMaker,
  type ValueVersionRecord,
} from './versions.js';
export {
  VALUE_FACTS_HEADER,
  VALUE_FACTS_MAXIMUM_LINES,
  VALUE_FACT_CHOICES,
  VALUE_FACT_KINDS,
  VALUE_FACT_SPREAD_FLOOR,
  valueFactCell,
  valueFactLine,
  valueFactsSection,
} from './valueFacts.js';
export {
  REWARD_MOOD_WARMUP_N,
  REWARD_MOOD_WINDOW_MS,
  warmedUp,
  choiceAppraisalOutcome,
  choiceMoodStep,
  rewardMoodCap,
  rewardMoodDecision,
  type AppraisableChoice,
  type RewardMoodCode,
} from './choiceAppraisal.js';
