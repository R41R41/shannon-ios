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
  /**
   * Whether the provider renders (and bills) this native entry in a replay: false for a turn-scoped system message that a later message
   * follows (`anthropicFcaTransient.ts`), which is stored and replayed byte for byte but counts toward no budget. Absent: every entry does.
   */
  rendered?(entry: unknown): boolean;
  /** A conservative estimate of the provider's input tokens for these replayed entries (`maximumReplayTokens`). Absent: not bounded. */
  tokens?(entries: readonly unknown[]): number;
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
  /** The codec's token estimate of the whole replay (`FcaHistoryCodec.tokens`), below the provider's long-prompt price step. */
  maximumReplayTokens: number;
  /**
   * Only when set (a body task, `FCA_BODY_HISTORY_POLICY`): the token estimate of the replay without its rebuildable tool
   * definitions, past which the history is compacted. Absent: no such bound.
   */
  maximumConversationTokens?: number;
  /**
   * With `maximumConversationTokens`: the token estimate a compaction brings the public bootstrap down to (the summary and the
   * newest rounds kept whole, fewer rounds when they would not fit, down to the newest one).
   */
  compactedConversationTokens?: number;
}
export interface FcaHistoryReplay {
  history: readonly unknown[]; summary: CompactionTemplate | null; summaryText: string;
  /** Messages of a lone round too long by itself, shortened with a marker in a public replay built for this step only. */
  clippedMessages?: number;
}
export type FcaHistoryPlan =
  | { kind: 'ready'; replay: FcaHistoryReplay }
  | { kind: 'compact'; input: FcaHistorySummaryInput; request: Omit<TaskHistoryCommit, 'template'> };
/**
 * A summary made beside the steps (mb-llmc r3; Minecraft run 27, 2026-10-22: eight summaries were waited for before their decisions,
 * 169 s in all, up to 36 s, and each new epoch was written to the cache twice): asked when the history passes its policy, while the step
 * goes on with the whole replay; installed at the first step after it is ready (no model call then). Kept per task, in memory.
 */
export interface FcaHistoryPrepared {
  /** The summary revision and the oldest rounds it covers; `tail`: the newest round when it was asked. */
  revision: number; sequences: readonly number[]; tail: number;
  state: 'pending' | 'ready' | 'failed';
  template?: unknown;
  /** Settles when the summary call ends, however it ends. */
  done: Promise<void>;
}
export interface FcaHistoryAhead {
  get(taskId: string): FcaHistoryPrepared | undefined;
  set(taskId: string, prepared: FcaHistoryPrepared): void;
  clear(taskId: string): void;
}
export interface FcaHistoryAheadOptions {
  port: FcaHistoryAhead;
  /**
   * The bounds the replay may reach while a summary is made beside the steps: within them a step never waits for one. Past them a step
   * waits for the one asked (at most `waitMs`), else summarizes as before.
   */
  hard: Partial<FcaHistoryPolicy>;
  waitMs?: number;
  /** Runs the summary call apart from the step (its own signal and model bookkeeping), so that the step need not wait for it. */
  detach<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** An urgent step: the conversation may reach the whole replay's bound before it waits for anything. */
  urgent?: boolean;
  /** What happened (content-free): `started`, `installed`, `waited`. */
  note?(what: 'started' | 'installed' | 'waited'): void;
}
export interface FcaHistoryPorts {
  runtime: TaskRuntime; codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer;
  permit(): Promise<boolean>;
  /** Fresh canonical memory controls over the admitted round's pinned source IDs. */
  sourcesVisible(): boolean;
}
