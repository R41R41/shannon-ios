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
  /** When this feeling was last expressed; carry-over decays from here. Absent in older snapshots. */
  updatedAt?: string;
  overrideReason?: ShannonEmotionOverrideReason;
}

/** Who was present when something was said to Shannon. The owner is always part of it. */
export type MemoryAudience =
  | { kind: 'owner' }
  /** The owner plus these remembered people; `unknownGuest` marks someone present whose name was never established. */
  | { kind: 'people'; personIds: readonly string[]; unknownGuest?: boolean }
  /** One platform conversation (a channel or group) as a unit. */
  | { kind: 'group'; groupKey: string };

export type MemorySensitivity = 'sensitive' | 'ordinary';

export const MEMORY_SENSITIVITY_CATEGORIES = [
  'secret', 'health', 'mental', 'money', 'contact', 'romance_family', 'work', 'legal', 'schedule',
  'third_party', 'unknown_audience',
] as const;
export type MemorySensitivityCategory = typeof MEMORY_SENSITIVITY_CATEGORIES[number];

/**
 * The audience and sensitivity recorded when an item is stored. An item without one is
 * owner-only and sensitive; see `disclosure.ts` for the rule that reads it.
 */
export interface MemoryDisclosure {
  audience?: MemoryAudience;
  sensitivity?: MemorySensitivity;
  category?: MemorySensitivityCategory;
  /** Why the rule decided so, for example the matched word. Shown to the owner. */
  reason?: string;
  decidedBy?: 'rule' | 'owner';
  /** Who spoke the user side of a turn. Absent: the owner when the audience is owner-only, otherwise unknown. */
  speaker?: 'owner' | 'unknown';
}

export interface UserFact {
  id: string;
  statement: string;
  confidence: number;
  observedAt: string;
  evidence?: string;
  sourceExperienceId?: string;
  disclosure?: MemoryDisclosure;
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
  disclosure?: MemoryDisclosure;
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
  disclosure?: MemoryDisclosure;
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
  /** When the item last stopped being usable; replies up to this instant may have used it. */
  contextInvalidatedAt?: string;
  /** The item's text when it stopped being usable. Only its key terms are used, to find replies that restated it. */
  withheldText?: string;
  /** The item whose forget or reject created this control; restoring that item lifts this one too. */
  causedBy?: string;
  /** A promise's status before a forget or reject dismissed it, so restore can put it back. */
  commitmentStatusBefore?: ProspectiveMemory['status'];
  /** The owner's own choice of 機微／ふつう for this item. It wins over the stored rule decision. */
  sensitivity?: MemorySensitivity;
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
  /**
   * Owner-local days (YYYY-MM-DD) on which the owner and Shannon talked, kept
   * for the last 30 days. Evidence for the slow traits; absent in older snapshots.
   */
  sharedDays?: readonly string[];
}

export type CompanionStateEvent =
  | { type: 'memory-transaction'; events: readonly CompanionStateEvent[] }
  | { type: 'emotion-adjusted'; delta: Partial<ShannonEmotion> }
  | { type: 'expressive-emotion-updated'; emotion: ShannonExpressiveEmotion }
  /** An owner turn was recorded on these owner-local days; `today` anchors the 30-day window. */
  | { type: 'shared-time-observed'; days: readonly string[]; today: string }
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
