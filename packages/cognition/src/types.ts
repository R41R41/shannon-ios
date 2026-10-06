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
  // 気持ち悪い・いや (Syzygy ADR-0005, owner answer 2 of 2026-10-05): a kind she may choose, never one that is set for her.
  'uncomfortable',
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
  /** Her awake clock (ms) when this feeling was last expressed; it fades from here. Stamped by the reducer; absent in older snapshots. */
  awakeAt?: number;
  /** Only on a reading by `presentShannonFeeling`: the feeling as it stands at this instant on her awake clock. Never stored. */
  presentAt?: string;
  /**
   * Only on a resolver result, never stored. `true`: the present feeling goes on and nothing new was felt, so committing it
   * stores nothing. `false`: the same kind of feeling again from a stimulus that is itself stronger than what she felt.
   * Absent on a feeling of the same kind as the present one, the reducer stores nothing: raising a feeling needs the explicit `false`.
   */
  continued?: boolean;
  /** Only on a reading whose feeling is what she owes the owner (concern, apology, an override): the strongest feeling it is covering. Never stored. */
  underneath?: { primary: ShannonEmotionKind; intensity: number };
  /** Only on a reading of a feeling the owner eased a moment ago: the height it had before. A stimulus of the same kind that is not above it is that feeling going on. Never stored. */
  easedPeak?: number;
  /**
   * Only on a reading, never stored: for the kind of the reading and for every kind alive underneath, the strength it was
   * stored at (the reaction's, or its entry's when that is higher), before it faded. An unpleasant mood toward the owner
   * expressed again is a new, stronger feeling only above the height of its kind; up to it, it is that feeling going on.
   */
  heights?: Partial<Record<ShannonEmotionKind, number>>;
  /** Only on a reading, never stored: for the same kinds, what is left of each at this instant. An unpleasant mood expressed again up to its height shows at this strength. */
  strengths?: Partial<Record<ShannonEmotionKind, number>>;
  /** Only on a reading, never stored: when every place underneath is held by an unpleasant mood, the strength a further unpleasant mood must exceed to take one. */
  placeAbove?: number;
  /** Only on a resolver result, never stored: the strength was decided for this reply (a voice turn, a touch), not read from a cue in her own words. Only such a feeling renews one that is already underneath. */
  decided?: boolean;
}

/** Her awake time: it advances while she is in a conversation or an activity session of her own, and stands still otherwise. */
export interface ShannonEmotionClock {
  /** Accumulated awake milliseconds. */
  awakeMs: number;
  /** The wall-clock instant of the last event that advanced it. */
  at: string;
}

/** `mood`: lasts a few awake hours. `lingering`: one to two awake days. */
export type ShannonLingeringSpan = 'mood' | 'lingering';

/** A feeling toward the owner that stays underneath the reaction of the moment (`emotionContinuity.ts`). */
export interface ShannonLingeringFeeling {
  kind: ShannonEmotionKind;
  target: string;
  /** Why, in the words of the feeling that left it. Never conversation text. */
  cause: string;
  span: ShannonLingeringSpan;
  /** Its strength at `awakeAt`; the present strength fades from there by the span's half-life. */
  strength: number;
  awakeAt: number;
  /** When it began, on her awake clock and on the wall clock (the latter is a fact for wording, never used for fading). */
  startedAwakeAt: number;
  startedAt: string;
  /** Set when it was eased (his apology, a kind word, a strong opposite feeling): the height it had before, and her awake clock then. */
  peak?: number;
  easedAwakeAt?: number;
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

/** What can happen to her body by touch: the closed vocabulary of `docs/body-contract.md`. */
export const SHANNON_TOUCH_KINDS = ['pet', 'tickle', 'poke', 'carry', 'holdHand'] as const;
export type ShannonTouchKind = typeof SHANNON_TOUCH_KINDS[number];

/** One touch as her feeling receives it (`touchEmotion.ts`). Facts and numbers only. */
export interface ShannonTouch {
  kind: ShannonTouchKind;
  durationMs?: number;
  /** 0 (light) to 1 (firm). */
  strength?: number;
  /** Touches of this kind in the current sitting, this one included. */
  countInWindow: number;
  /** False when someone other than the owner may have been the one touching. Absent: the owner. */
  ownerAlone?: boolean;
  /**
   * Syzygy ADR-0005 stage 1b: the touch landed on a part where her body flinches first (neck, chest, waist, legs, skirt;
   * owner answer 1), given as the word of the part (首). The table is not read for it: only the reflex moves her
   * (`SHANNON_TOUCH_REFLEX`), and how she takes the touch is her own judgement. Absent: the table, as before. Under stage 2
   * (`appraisal` present) it names any part the body named, for the words of the cause only (頭をなでられた).
   */
  reflexPart?: string;
  /** The touch stayed without moving (touch vocabulary 2 `gesture: rest`). Read only to word a touch on such a part (胸に触れられた). */
  resting?: boolean;
  /**
   * Syzygy ADR-0006 stage 2 (`SHANNON_PREDICTION`, on by default): what the prediction layer says of this touch. Present,
   * the table is read for no part: the startle moves arousal, and a known stance moves her by its prediction error
   * (`touchAppraisal.ts`). Absent: stage 1b exactly (the table, or the reflex on a part where her body flinches first).
   */
  appraisal?: ShannonTouchAppraisal;
}

/** What the prediction layer says of one touch (stage 2): the startle before it, and the error once her stance is known. */
export interface ShannonTouchAppraisal {
  /** Relative uncertainty before the touch, 0–1: how unsure she was of what such a touch is for her. */
  startle: number;
  /** Present when her stance for this touch is known now (the one she took earlier in the same episode). */
  outcome?: ShannonTouchOutcome;
}

export interface ShannonTouchOutcome {
  /** Her stance as an outcome − what she expected, on the valence scale. */
  error: number;
  /** How improbable the stance was under her prediction, 0–1. */
  unexpected: number;
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
  /** Her awake clock. Absent until the first event after the awake clock was introduced. */
  emotionClock?: ShannonEmotionClock;
  /** What she still feels underneath, strongest first. Absent in older snapshots. */
  lingering?: readonly ShannonLingeringFeeling[];
}

export type CompanionStateEvent =
  | { type: 'memory-transaction'; events: readonly CompanionStateEvent[] }
  | { type: 'emotion-adjusted'; delta: Partial<ShannonEmotion> }
  | { type: 'expressive-emotion-updated'; emotion: ShannonExpressiveEmotion }
  /** Her body was touched: moves the continuous mood and the conversational feeling by the one table in `touchEmotion.ts`. */
  | { type: 'body-touched'; touch: ShannonTouch }
  /** Stage 2: her stance on a touch became known (she decided it): its prediction error moves valence and arousal. */
  | { type: 'touch-appraised'; outcome: ShannonTouchOutcome }
  /** She was awake at this moment and nothing else happened: advances her awake clock. Carries no content. */
  | { type: 'awake-observed' }
  /** The owner apologised or said something kind: what she holds against him underneath eases. */
  | { type: 'feeling-eased'; by: 'apology' | 'kindness' }
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
