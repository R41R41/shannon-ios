import type { FcaModel, FcaExternalTools } from '../action/fca/fcaPorts.js';
import type { FcaHistoryCodec, FcaHistorySummarizer } from '../action/fca/fcaHistoryPorts.js';

/** Server-bound nightly identity; never authored by a model or attributed to an owner request. */
export interface SleepFcaJob { id: string; scopeKey: string; dayKey: string; startAt: string; endAt: string }
export type SleepFcaPhase = 'memory' | 'knowledge' | 'skills' | 'people' | 'export' | 'done';
export interface SleepFcaCheckpoint {
  schemaVersion: 1; jobId: string; phase: SleepFcaPhase;
  /** Code-authored progress only: IDs, versions and counters, never copied source/model text. */
  state: unknown | null;
}
export interface SleepFcaPhaseInput { job: SleepFcaJob; state: unknown | null; signal: AbortSignal }
export interface SleepFcaPhaseHandler {
  /** At most ONE configured model call. No memory mutation; budget/usage remain with that model's existing lane. */
  decide(input: SleepFcaPhaseInput): Promise<unknown>;
  /** No model calls. Revalidate sources and use the existing memory/proposal writer; unknown effects throw. */
  apply(answer: unknown, input: SleepFcaPhaseInput & { operationId: string }): Promise<{
    done: boolean; state?: unknown; summary: string;
  }>;
}
export interface SleepFcaStepOptions {
  job: SleepFcaJob;
  checkpoint?: unknown;
  /** A missing optional phase is skipped without a call. Memory is mandatory. */
  handlers: Partial<Record<Exclude<SleepFcaPhase, 'done'>, SleepFcaPhaseHandler>> & { memory: SleepFcaPhaseHandler };
  /** Fresh nightly lease, task generation, stop and source checks. False throws, never becomes a successful result. */
  assertCurrent(): boolean;
}
export interface SleepFcaStep {
  model: FcaModel; tools: FcaExternalTools;
  checkpoint(): Readonly<Record<string, unknown>>;
  history: { codec: FcaHistoryCodec; summarizer: FcaHistorySummarizer };
}
