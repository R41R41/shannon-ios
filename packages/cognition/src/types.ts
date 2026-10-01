export interface ShannonTemperament {
  curiosity: number;
  initiative: number;
  closeness: number;
  calmness: number;
  needForContinuity: number;
  confidenceAboutUser: number;
}

export interface ShannonEmotion {
  /** unpleasant (-1) to pleasant (1) */
  valence: number;
  /** quiet (0) to activated (1) */
  arousal: number;
  /** guarded (0) to open (1) */
  openness: number;
}

export const SHANNON_EMOTION_KINDS = [
  'neutral', 'bright', 'playful', 'serious',
  'happy', 'fun', 'excited', 'ecstatic', 'relief', 'pride', 'gratitude', 'hope', 'curiosity', 'affectionate',
  'giggle', 'teasing', 'mischievous', 'plotting', 'smug', 'deadpan', 'harmlessFalsehood', 'selfDeprecating', 'dramaticLament',
  'shy', 'blushing', 'bashful', 'flustered', 'hidingHappiness',
  'cuteAngry', 'seriousAnger', 'annoyed', 'indignant', 'frustrated', 'competitive', 'protectiveAnger',
  'jealous', 'sulky', 'leftOut', 'lonely', 'attentionSeeking', 'lightPossessive', 'reassurance',
  'sad', 'disappointed', 'hurt', 'anxious', 'regret', 'helpless', 'lamenting', 'caring', 'protective',
  'surprised', 'shocked', 'stunned', 'speechless', 'confused', 'panic', 'scream',
  'focused', 'determined', 'cautious', 'urgent', 'blocked', 'retrying', 'triumphant', 'tired', 'sleepy',
  'gentle', 'relaxed', 'content', 'quietCompanion', 'tender', 'apologetic',
] as const;

export type ShannonEmotionKind = typeof SHANNON_EMOTION_KINDS[number];
export type ShannonEmotionVisibility = 'hidden' | 'subtle' | 'expressed';
export type ShannonEmotionOverrideReason = 'safety' | 'grief' | 'emergency' | 'correction' | 'topic-change';

/**
 * The explainable, conversational emotion carried between turns. The existing
 * continuous `emotion` vector remains the compact mood projection used by old
 * clients and the memory UI.
 */
export interface ShannonExpressiveEmotion {
  primary: ShannonEmotionKind;
  secondary: readonly ShannonEmotionKind[];
  intensity: number;
  target: string;
  cause: string;
  arousal: number;
  valence: number;
  visibility: ShannonEmotionVisibility;
  startedAt: string;
  decay: number;
  carryover: number;
  overrideReason?: ShannonEmotionOverrideReason;
}

export interface UserFact {
  id: string;
  statement: string;
  confidence: number;
  observedAt: string;
  evidence?: string;
  sourceExperienceId?: string;
}

export interface ActiveMemory {
  id: string;
  summary: string;
  relevance: number;
  observedAt: string;
}

export interface RelationshipInsight {
  id: string;
  statement: string;
  confidence: number;
  observedAt: string;
  evidence?: string;
  sourceExperienceId?: string;
}

export interface ProspectiveMemory {
  id: string;
  summary: string;
  status: 'pending' | 'completed' | 'dismissed';
  createdAt: string;
  updatedAt: string;
  dueHint?: string;
  dueAt?: string;
  dueDate?: string;
  timeZone?: string;
  sourceExperienceId?: string;
  evidence?: string;
  /** Set when the owner answers a reminder with 「あとで」: no further reminder before this instant. */
  remindAfter?: string;
}

export type MemoryKind = 'user-fact' | 'interest' | 'experience' | 'relationship';
export type MemoryStatus = 'active' | 'forgotten' | 'rejected';
export type MemoryLearningSource = 'conversation' | 'sleep';

/** A durable boundary or correction explicitly supplied by the user. */
export interface MemoryControl {
  memoryId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  pinned: boolean;
  updatedAt: string;
  changeReason: string;
  overrideText?: string;
  /** Original evidence for exclusion, not a new fact or a replacement value. */
  sourceEvidence?: string;
  /** Old assistant paraphrases remain invalid after restore/pin as well. */
  contextInvalidatedAt?: string;
}

export interface CompanionStateSnapshot {
  scopeKey: string;
  version: number;
  updatedAt: string;
  temperament: ShannonTemperament;
  emotion: ShannonEmotion;
  /** Optional for compatibility with snapshots created before the v2 emotion engine. */
  expressiveEmotion?: ShannonExpressiveEmotion;
  interests: readonly string[];
  userFacts: readonly UserFact[];
  activeMemories: readonly ActiveMemory[];
  relationships: readonly RelationshipInsight[];
  prospectiveMemories: readonly ProspectiveMemory[];
  memoryControls: readonly MemoryControl[];
}

export type CompanionStateEvent =
  | { type: 'memory-transaction'; events: readonly CompanionStateEvent[] }
  | { type: 'emotion-adjusted'; delta: Partial<ShannonEmotion> }
  | { type: 'expressive-emotion-updated'; emotion: ShannonExpressiveEmotion }
  | { type: 'interest-observed'; interest: string; source?: MemoryLearningSource }
  | { type: 'user-fact-upserted'; fact: UserFact; source?: MemoryLearningSource }
  | { type: 'relationship-upserted'; relationship: RelationshipInsight; source?: MemoryLearningSource }
  | { type: 'prospective-memory-upserted'; memory: ProspectiveMemory; replace?: boolean }
  | { type: 'prospective-memory-status-changed'; memoryId: string; status: ProspectiveMemory['status'] }
  | { type: 'memory-control-upserted'; control: MemoryControl }
  | { type: 'memory-activated'; memory: ActiveMemory }
  | { type: 'active-memories-replaced'; memories: readonly ActiveMemory[] }
  | { type: 'memory-deactivated'; memoryId: string };

export interface CompanionStateStore {
  snapshot(scopeKey: string): CompanionStateSnapshot;
  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot;
}
