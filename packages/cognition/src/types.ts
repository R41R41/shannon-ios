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

export interface UserFact {
  id: string;
  statement: string;
  confidence: number;
  observedAt: string;
  evidence?: string;
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
}

export interface CompanionStateSnapshot {
  scopeKey: string;
  version: number;
  updatedAt: string;
  temperament: ShannonTemperament;
  emotion: ShannonEmotion;
  interests: readonly string[];
  userFacts: readonly UserFact[];
  activeMemories: readonly ActiveMemory[];
  relationships: readonly RelationshipInsight[];
  memoryControls: readonly MemoryControl[];
}

export type CompanionStateEvent =
  | { type: 'emotion-adjusted'; delta: Partial<ShannonEmotion> }
  | { type: 'interest-observed'; interest: string; source?: MemoryLearningSource }
  | { type: 'user-fact-upserted'; fact: UserFact; source?: MemoryLearningSource }
  | { type: 'relationship-upserted'; relationship: RelationshipInsight; source?: MemoryLearningSource }
  | { type: 'memory-control-upserted'; control: MemoryControl }
  | { type: 'memory-activated'; memory: ActiveMemory }
  | { type: 'memory-deactivated'; memoryId: string };

export interface CompanionStateStore {
  snapshot(scopeKey: string): CompanionStateSnapshot;
  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot;
}
