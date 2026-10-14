import type { CompactionMessage, CompactionTemplate } from '@shannon/mind';
import type { TaskHistoryCommit, TaskHistoryRound, TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';

/** Provider validates complete native rounds and projects only public content, never thinking/signatures. */
export interface FcaHistoryCodec {
  project(round: TaskHistoryRound): readonly CompactionMessage[] | null;
  /** Fresh provider messages for the immutable public bootstrap; old signed blocks never cross this boundary. */
  bootstrap(text: string): readonly unknown[];
  /**
   * Whether a native entry only restates tool definitions the runtime can rebuild from the current catalog (inline tool
   * additions/removals). Such entries are still replayed byte for byte; they are measured against their own bound
   * (`maximumToolDefinitionCharacters`), not against the conversational history budget.
   */
  reproducible?(entry: unknown): boolean;
  /**
   * A native entry as the native history budget measures it: a decision message without the parts each decision restates (the
   * catalog, recall and fixed instructions), whose size the whole replay's bound still counts. The entry itself is replayed
   * unchanged. Absent: the entry as it is.
   */
  measured?(entry: unknown): unknown;
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
  /** Replayed inline tool definitions (`FcaHistoryCodec.reproducible`), measured apart from the native history budget. */
  maximumToolDefinitionCharacters: number;
  /** The replayed history and its tool definitions together: past it the history is compacted like any other. */
  maximumReplayCharacters: number;
}
export interface FcaHistoryReplay {
  history: readonly unknown[]; summary: CompactionTemplate | null; summaryText: string;
  /** Messages of a lone round too long by itself, shortened with a marker in a public replay built for this step only. */
  clippedMessages?: number;
}
export type FcaHistoryPlan =
  | { kind: 'ready'; replay: FcaHistoryReplay }
  | { kind: 'compact'; input: FcaHistorySummaryInput; request: Omit<TaskHistoryCommit, 'template'> };
export interface FcaHistoryPorts {
  runtime: TaskRuntime; codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer;
  permit(): Promise<boolean>;
  /** Fresh canonical memory controls over the admitted round's pinned source IDs. */
  sourcesVisible(): boolean;
}
