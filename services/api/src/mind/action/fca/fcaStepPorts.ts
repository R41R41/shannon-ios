import type { TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import type { BodyTaskRecall, TaskRecall } from '../../recall/taskRecallPorts.js';
import type { FcaEvidence } from './fcaEvidencePorts.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaModel } from './fcaPorts.js';
import { type FcaObsMode } from './fcaCoreTools.js';
import { type FcaCompletionMistake } from './fcaCompletionMistake.js';
import type { FcaObservationLifecycle } from './fcaObservation.js';
import { type FcaPlanPort } from './fcaPlanTools.js';
import type { FcaHistoryAheadOptions, FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummarizer } from './fcaHistoryPorts.js';

export interface FcaStepPorts {
  runtime: TaskRuntime;
  model: FcaModel;
  ownerAlone(): boolean;
  /** The real audience or a verified game-only task; private reads still use ownerAlone. */
  audienceAllowed?(): boolean;
  /** Trusted policy for internal maintenance; never changes disclosure or tool audience. */
  executionAllowed?(): boolean;
  taskTools?: boolean;
  /** Code-owned phase state, committed with history under the same action lease. */
  checkpoint?(): Readonly<Record<string, unknown>>;
  /** Existing lease/resource gate, rechecked before each model or tool operation. */
  permit(): Promise<boolean>;
  selector?: FcaToolSelector;
  /** This task acts through a body (bound, or made from a body request): a reselection never leaves out all its body tools. */
  keepBodyTools?(): boolean;
  /** `SHANNON_FCA_OBS_MODE` (`fcaCoreTools.ts`); a body task takes it only when it starts, never after. Absent: legacy. */
  obsMode?: FcaObsMode;
  recall?: TaskRecall;
  /** A body task's recall (`bodyTaskRecall.ts`); the task recall above is never started for a body task. */
  bodyRecall?: BodyTaskRecall;
  evidence?: FcaEvidence;
  observeMemory?(ids: readonly string[]): boolean | Promise<boolean>;
  tools?: FcaExternalTools;
  history?: {
    codec: FcaHistoryCodec;
    summarizer?: FcaHistorySummarizer;
    policy?: Partial<FcaHistoryPolicy>;
    /** mb-llmc r3: the summary is made beside the steps (`prepareFcaHistory`); absent: it is made in the step that needs it. */
    ahead?: Pick<FcaHistoryAheadOptions, 'port' | 'hard' | 'waitMs'>;
  };
  /** Rechecks only the sources pinned to this admitted step, never newly pending inbox input. */
  sourcesVisible?(): boolean;
  /** Disclosure for another task's list/get/send projection. */
  taskVisible?(taskId: string): boolean;
  /** Persist source lineage before another task's successful projection enters this round. */
  observeTasks?(taskIds: readonly string[]): boolean;
  /** Actual remote-body acknowledgement, independently of local promises having unwound. */
  safeToAcknowledgeStop?(): boolean;
  /** Preserve the owning surface while this step still holds its lease; publish its hold only after the last result is durably
   * committed. Never runs a model. */
  prepareStop?(reason: string): Promise<{ committed(): Promise<void> }>;
  body?: FcaBodyLifecycle;
  observations?: readonly FcaObservationLifecycle[];
  /**
   * Whether whoever handed this task over can send it a message (`fcaWaitGate.ts`). False only where the wiring knows nobody can
   * (an operator's hand-over); absent means a wait is never questioned.
   */
  waitCounterpart?(): boolean;
  /**
   * The wait before a decision that carried no answer is asked again (`fcaProviderRetry.ts`): the suggested
   * exponential, jittered wait,
   * which already honours the provider's `retry-after`, when absent (tests: 0, or a spy on `suggestedMs`).
   */
  decisionRetryDelayMs?(suggestedMs: number, failed: number): number;
  /** False once the task's budget has no room for another request that may be charged: the decision's retries end there. */
  retryAllowed?(): boolean;
  /** The task's plan tree (`fcaPlanTools.ts`): read into each decision, its flat copy committed with the step. Absent: no plan. */
  plan?: FcaPlanPort;
  /** Design mb-llm-centric 2.3: how long one lease grant serves every check of the step (`permitDue`, `fcaPlanTools.ts`). */
  permitWindowMs?: number;
  completionMistake?: FcaCompletionMistake; // mb-llmc r5: a turned-back completion, told in one line, counted only in a row
  /** What the parts this step stands on say of their versions (the body's connection and catalog), for the decision
   * records. Absent: none. */
  versions?(): Readonly<Record<string, unknown>>;
}
