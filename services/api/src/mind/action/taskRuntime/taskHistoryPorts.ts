import type { CompactionMessage, CompactionTemplate } from '@shannon/mind';
import type { TaskSource, TaskStatus } from './taskRuntimePorts.js';

/** One committed native round; its original provider entries are immutable. */
export interface TaskHistoryRound {
  sequence: number; stepId: string; committedAt: string; entries: readonly unknown[];
  status: TaskStatus | 'unknown'; sources: readonly TaskSource[];
}
export interface TaskHistorySummary {
  revision: number; fromSequence: number; throughSequence: number; resetThroughSequence: number;
  template: CompactionTemplate; sources: readonly TaskSource[]; bootstrapText: string;
}
export interface TaskHistoryPublicRound { sequence: number; stepId: string; messages: readonly CompactionMessage[] }
export interface TaskHistoryWindow {
  revision: number; sourceRevision: string; tailSequence: number;
  summary: TaskHistorySummary | null; rounds: readonly TaskHistoryRound[];
}
export interface TaskHistoryCommit {
  baseRevision: number; sourceRevision: string; tailSequence: number;
  /** Exact oldest uncovered round sequence, in order; no skipped or partially covered round. */
  sequences: readonly number[];
  /** Complete public projection of every retained round through tailSequence, establishing a fresh provider replay epoch. */
  retained: readonly TaskHistoryPublicRound[];
  template: unknown;
}
