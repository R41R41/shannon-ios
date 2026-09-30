/** Where an experience entered Shannon's shared cognitive loop. */
export type ShannonExperienceChannel =
  | 'text'
  | 'voice'
  | 'discord'
  | 'vision'
  | 'platform'
  | 'system';

/** Bounded, present-tense context used to interpret one turn. */
export interface ShannonSituationSnapshot {
  occurredAt: string;
  channel: ShannonExperienceChannel;
  localTime?: string;
  locationLabels?: readonly string[];
  participants?: readonly string[];
  currentGoal?: string;
}

/** Retrieval query assembled from the current utterance and situation. */
export interface ShannonMemoryQuery {
  text: string;
  occurredAt: string;
  participants?: readonly string[];
  locationLabels?: readonly string[];
  goal?: string;
}

export type ShannonRecallReason = 'words' | 'related-terms' | 'participant' | 'location' | 'goal' | 'recent' | 'semantic';

/** A recall result carries an explanation so prompts and diagnostics stay auditable. */
export interface ContextualMemory {
  id: string;
  summary: string;
  observedAt: string;
  relevance: number;
  reasons: readonly ShannonRecallReason[];
}

export interface ShannonActionReceipt {
  id: string;
  capability: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'failed';
  summary: string;
  occurredAt: string;
}

export interface ShannonVerifiedWorkPlanItem {
  title: string;
  status: 'pending' | 'running' | 'completed';
}

/** A projection of durable Agent Host evidence linked to one owner objective. */
export interface ShannonVerifiedWork {
  taskId: string;
  title: string;
  status: 'queued' | 'starting' | 'running' | 'waiting_approval' | 'paused'
    | 'completed' | 'failed' | 'cancelled';
  summary: string;
  currentAction?: string;
  plan: readonly ShannonVerifiedWorkPlanItem[];
  completedPlanSteps: number;
  totalPlanSteps: number;
  testsPassed: number;
  testsFailed: number;
  updatedAt: string;
}

/** A durable, owner-visible objective. It is evidence, not a hidden chain of thought. */
export interface ShannonIntent {
  id: string;
  title: string;
  desiredOutcome: string;
  status: 'active' | 'paused' | 'completed' | 'dismissed';
  source: 'explicit-user-goal';
  sourceExperienceId?: string;
  threadId?: string;
  nextStep?: string;
  /** A bounded, owner-visible proposal. Steps are guidance, not action receipts. */
  planSteps?: readonly string[];
  /** Exact durable task linkage; never inferred from title similarity. */
  linkedTaskId?: string;
  /** Progress derived only from verified Agent Host events. */
  verifiedWork?: ShannonVerifiedWork;
  priority: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

/** Present-tense frame shared by text and voice before either one answers. */
export interface ShannonCognitiveFrame {
  situation: ShannonSituationSnapshot;
  primaryIntent?: ShannonIntent;
  supportingIntentIDs: readonly string[];
  recalledMemoryIDs: readonly string[];
  responseMode: 'answer' | 'clarify' | 'propose-action';
}

/** One provider-neutral frame that any avatar renderer can consume. */
export interface ShannonEmbodimentFrame {
  attention: 'user' | 'memory' | 'tool' | 'environment' | 'rest';
  expression: string;
  confidence: number;
  energy: number;
}
