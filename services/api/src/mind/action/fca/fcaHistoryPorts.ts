import type { CompactionMessage, CompactionTemplate } from '@shannon/mind';
import type { TaskHistoryCommit, TaskHistoryRound, TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';

/** Provider validates complete native rounds and projects only public content, never thinking/signatures. */
export interface FcaHistoryCodec {
  project(round: TaskHistoryRound): readonly CompactionMessage[] | null;
  /** Fresh provider messages for the immutable public bootstrap; old signed blocks never cross this boundary. */
  bootstrap(text: string): readonly unknown[];
}
export interface FcaHistorySummaryInput {
  previous: CompactionTemplate | null;
  rounds: readonly { sequence: number; stepId: string; messages: readonly CompactionMessage[] }[];
}
export interface FcaHistorySummarizer {
  summarize(input: FcaHistorySummaryInput, signal: AbortSignal): Promise<unknown>;
}
export interface FcaHistoryPolicy {
  maximumNativeCharacters: number; maximumRounds: number; recentRounds: number;
  maximumSummaryCharacters: number; maximumBatches: number;
}
export interface FcaHistoryReplay { history: readonly unknown[]; summary: CompactionTemplate | null; summaryText: string }
export type FcaHistoryPlan =
  | { kind: 'ready'; replay: FcaHistoryReplay }
  | { kind: 'compact'; input: FcaHistorySummaryInput; request: Omit<TaskHistoryCommit, 'template'> };
export interface FcaHistoryPorts {
  runtime: TaskRuntime; codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer;
  permit(): Promise<boolean>;
  /** Fresh canonical memory controls over the admitted round's pinned source IDs. */
  sourcesVisible(): boolean;
}
