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

export type ShannonRecallReason = 'words' | 'related-terms' | 'participant' | 'location' | 'goal' | 'recent';

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

/** One provider-neutral frame that any avatar renderer can consume. */
export interface ShannonEmbodimentFrame {
  attention: 'user' | 'memory' | 'tool' | 'environment' | 'rest';
  expression: string;
  confidence: number;
  energy: number;
}
