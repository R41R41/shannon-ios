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

export interface CompanionStateSnapshot {
  scopeKey: string;
  version: number;
  updatedAt: string;
  temperament: ShannonTemperament;
  emotion: ShannonEmotion;
  interests: readonly string[];
  userFacts: readonly UserFact[];
  activeMemories: readonly ActiveMemory[];
}

export type CompanionStateEvent =
  | { type: 'emotion-adjusted'; delta: Partial<ShannonEmotion> }
  | { type: 'interest-observed'; interest: string }
  | { type: 'user-fact-upserted'; fact: UserFact }
  | { type: 'memory-activated'; memory: ActiveMemory }
  | { type: 'memory-deactivated'; memoryId: string };

export interface CompanionStateStore {
  snapshot(scopeKey: string): CompanionStateSnapshot;
  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot;
}

