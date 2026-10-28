import type { FcaWaitFact } from './fcaWaitGate.js';
import type { ShannonToolDefinition, ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaActionExpectation, FcaAffectAppraisal, FcaAuxiliaryResult, FcaSharedContext } from './fcaEvidencePorts.js';
import type { BodyRecallCues, TaskRecallPacket } from '../../recall/taskRecallPorts.js';
import type { FcaObservation } from './fcaObservation.js';
import type { FcaProgress, FcaProgressHooks } from './fcaProgressPorts.js';
import type { BodyObservation } from '../../../contracts/bodyControlContract.js';

/** Public decisions only. Native history is opaque to the runtime and is never an Observer payload. */
export interface FcaToolCall { id: string; name: string; input: unknown }
/** Validated adapter schemas can describe nested body arguments without changing ordinary registry schemas. */
export interface FcaToolDefinition extends ShannonToolDefinition { nativeInputSchema?: Readonly<Record<string, unknown>> }
export type FcaDecision =
  | { kind: 'tools'; calls: readonly FcaToolCall[] }
  | { kind: 'wait'; summary: string }
  | { kind: 'complete'; summary: string };
export interface FcaModelInput {
  task: { id: string; title: string; goal: string; completionCriteria: string };
  messages: readonly { id: string; text: string; sourceTaskId: string }[];
  children?: readonly { id: string; title: string; phase: string; summary: string }[];
  history: readonly unknown[];
  tools: readonly FcaToolDefinition[];
  /** Selection mode: every currently allowed tool's metadata; tools contains only selected/opened schemas. */
  catalog?: readonly { name: string; description: string }[];
  /**
   * Transient mode (`fcaCoreTools.ts`): the epoch's pinned core definitions, a part of `tools`. They are declared at the top level and
   * stay byte-identical for the epoch; every other tool of `tools` is only appended. Absent: the legacy menu.
   */
  coreTools?: readonly FcaToolDefinition[];
  /**
   * Transient mode: the most estimated tokens the epoch's replay may hold (`fcaTransientHistory`: the replay bound less the core). The
   * stored state of this step joins the replay, so a state that would leave no room for another step is shortened (a summary every
   * step is what an oversized first state of an epoch costs); `anthropicFcaTransientRequest.ts`.
   */
  replayTokenLimit?: number;
  /**
   * Transient mode (`anthropicFcaTransient.ts`): the body's live state for this decision only (observation, pace, phase facts, jobs, skill
   * pointers, notices), from `FcaBodyLifecycle.transient`. It goes into a turn-scoped system message and is never stored.
   */
  transient?: Readonly<Record<string, unknown>>;
  sharedContext?: FcaSharedContext;
  recall?: TaskRecallPacket;
  body?: { revision: number; observation: BodyObservation | null };
  /** Compact source-checked skill metadata, dynamic so the stable cache prefix and signed replay remain unchanged. */
  skillIndex?: string;
  progress?: FcaProgress;
  observations?: readonly { revision: number; observation: FcaObservation | null }[];
  /** Present only when nobody can answer this task: a wait is turned away (`fcaWaitGate.ts`). Closed values only. */
  waiting?: FcaWaitFact;
  /**
   * The task's plan tree as a decision reads it (`fcaPlanTools.ts`): the path to the current node, it, the next few and the blocked ones.
   * A transient task reads it in the live state, never stored. Absent: the task keeps no plan.
   */
  plan?: Readonly<Record<string, unknown>>;
}
/** Task-owned short control may interrupt body work while ordinary inference is awaiting a response. */
/** What a body's investigation did (`FcaBodyLifecycle.investigate`): closed codes and counts only, for the metrics line. */
export interface FcaBodyInvestigation { surprises: readonly string[]; probes: number; answered: number; ms: number }
/** Why a step that has items open decides again, or ends (`FcaBodyQueue.ready`). */
export type FcaQueueWake =
  /** Nothing is open: the step ends (the next step decides from the start). */
  | 'empty'
  /** No item waits and the running one has `T` seconds or less left (T: the median of the last decisions): decide now. */
  | 'remaining'
  /** An item ended badly and the ones behind it are dropped: the step ends once they are settled. */
  | 'dropped'
  /** The body saw a surprise: decide now, with items still open (the decision may replace them). */
  | 'alert'
  /** A message came for the task: what waits is dropped, the running item is let finish, the step ends. */
  | 'message'
  /** A reflex hit its cap (continue contract 4; the life's and the live state's owners say so through `LlmcQueue.noteReflexCapped`): decide now, with items still open. */
  | 'reflex_capped';
/** The result of an item that ended, for the decision that reads it. `ran`: the body ran it; `dropped`: it never started (its text says why). */
export interface FcaQueueNews { kind: 'ran' | 'dropped'; item: string; call: FcaToolCall; operationId: string; result: ToolResult; ms: number; label: string }
export interface FcaBodyQueue {
  /** The command ids of the items still open (the lifecycle's `safe` does not count them as unsettled). */
  openIds(): ReadonlySet<string>;
  open(): boolean;
  /** Waits, with no model call, until the step should decide again or end. `drain`: only until nothing is open. Throws what an item's receipt threw. */
  ready(options: { signal: AbortSignal; drain: boolean; messages?(): boolean; alert?(): boolean }): Promise<FcaQueueWake>;
  /** The items that ended since the last take, oldest first. */
  take(): FcaQueueNews[];
  /** Changes with every drop (an item that ended badly, a replaced or expired one): a decision asked before it is thrown away. */
  version(): number;
  /** How long the model took for a decision (the median of the last ten is when `ready` says `remaining`). */
  noteDecision(milliseconds: number): void;
  /** Takes the items that wait off the queue (the running one goes on); returns how many. */
  dropWaiting(): number;
  /** Takes everything off, the running item stopped: the step is being stopped. */
  cancelAll(): void;
}
export interface FcaBodyLifecycle {
  start(signal: AbortSignal): void;
  revision(): number;
  context(): { revision: number; observation: BodyObservation | null };
  /** Drain active reflex work and refuse a decision made against an older physical generation. Unknown throws. */
  guard(revision: number): Promise<boolean>;
  /**
   * `guard` for one call of the decision: a call of the kind the body owns for the task (a fight she chose) may go on when the body
   * was touched only by its own reflexes since the decision (mb-r21, run 21: three fights dropped as stale one after the other while
   * the reflexes touched the body every few seconds). Absent: `guard` for every call.
   */
  guardFor?(revision: number, call: FcaToolCall): Promise<boolean>;
  toolSignal(name: string, parent: AbortSignal): AbortSignal;
  noteCall?(call: FcaToolCall, operationId: string): void;
  /** `durationMilliseconds`: how long the call took (the transient pace's breakdown by kind of call). */
  noteResult?(call: FcaToolCall, result: ToolResult, durationMilliseconds?: number): void;
  /** A transient task's body state for this decision (after `context()`); see `FcaModelInput.transient`. Absent: none. */
  transient?(): Record<string, unknown>;
  /** What a transient task stores of one of this body's tool results (the cut text of a long one). Absent: the text as it is. */
  storedResult?(call: FcaToolCall, text: string): string;
  /** What a body task's recall looks for now (`bodyTaskRecall.ts`), from the state `context()` last read. Absent: the goal alone. */
  recallCues?(): BodyRecallCues;
  /**
   * Whether something happened since the last decision that a recall may help with (a failure, a reflex, a death, another dimension):
   * a body that says false is not recalled for (design mb-llm-centric 2.3, recall only on an event). Absent: recalled every step.
   */
  recallWanted?(): boolean;
  /** True while the body is in its first frames after a login or respawn: heavy local work (the recall) waits for the decision. */
  settling?(): boolean;
  /**
   * An urgent step (mb-llmc r3; run 27: a creeper stopped her act at 3.9 m and the next decision came 12.8 s later, after the blast): a
   * hostile close, low health beside one, or the last act cut by a reflex or a hostile. The step then asks the model at once: no history
   * summary while the replay still fits (`prepareFcaHistory`), no recall. Absent: never urgent.
   */
  urgent?(): boolean;
  /**
   * mb-llmc r4 (owner 2026-10-22): before the decision, the body's own check for a surprise since the last one (health, a fall, the same
   * stop twice…) and its fixed probes, bounded in time; what they found goes into this decision's live state (`transient`). Null: no surprise. Absent: never.
   */
  investigate?(signal: AbortSignal): Promise<FcaBodyInvestigation | null>;
  /**
   * mb-llmc r8 (run 32: a hostile came in sight while the decision was awaited; the answer took 10.3 s and reached the body after her
   * death): polled while the model's decision is awaited. A line (the hostile) when one she must act on has come since the request was
   * built, once a decision: the decision is thrown away and asked again at once on a short urgent state (`fcaUrgentDecision.ts`).
   * Absent: never.
   */
  interrupt?(): string | null;
  /** r8: the request is built again for a decision asked after an `interrupt`: the next `context()` is the same decision's. */
  rebuilding?(): void;
  /** r8: a decision made on an urgent state has come: how long the model took on it, whether an earlier request was thrown away, and how long that had run. */
  decided?(info: { ms: number; aborted: boolean; thrownMs: number }): void;
  /**
   * The task queue (design minebot-task-queue, 2026-10-26): the body's items this step put in and still waits for. A step that has items open
   * goes on instead of committing: it decides again when `queue.ready` says so, with items running, and commits only when none is open.
   */
  queue?: FcaBodyQueue;
  /**
   * A surprise (`investigate`'s detection) the body saw while items run: true makes `queue.ready` say `alert`, and the next `investigate` has it
   * (probes and all). Never throws. Absent: none.
   */
  alert?(): boolean;
  /**
   * The words of items that ended during a round that has no tool result to carry them (the decision after them was a completion): shown to the
   * next decision once, with the results the history keeps short. Never throws. Absent: dropped.
   */
  noteNews?(text: string): void;
  /** Stop monitoring, cancel held inputs and await every in-flight callback before the segment receipt is committed. */
  close(): Promise<void>;
}
export interface FcaModelOutput {
  decision: FcaDecision;
  /** Complete native messages appended by this call, including provider-supported schema changes. */
  history: readonly unknown[];
  expectations?: readonly FcaActionExpectation[];
  appraisals?: readonly FcaAffectAppraisal[];
  auxiliaryResults?: readonly FcaAuxiliaryResult[];
  /**
   * Transient mode: the stored state had to be cut to fit (`anthropicFcaStateCut.ts`), a new epoch could state it whole (with its
   * bootstrap and a typical live state), and the next step could not state it whole in this epoch (beside the replay): kept in the
   * checkpoint, and the next epoch may start sooner. False when the cut is inherent (not even a new epoch's first state fits whole), or
   * when the next step can restate it in place (a live spike passes by itself).
   */
  stateCut?: boolean;
}
export interface FcaModel {
  decide(input: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput>;
  toolResults(results: readonly { id: string; text: string; ok: boolean }[]): unknown;
}

export interface FcaExternalTools {
  progress?: FcaProgressHooks;
  definitions: readonly FcaToolDefinition[];
  /** Build and pin use-time metadata only when skill.read is offered. */
  skillIndex?(): string;
  /** A stop cannot acknowledge a partial outside effect whose native round has not committed. */
  safeToAcknowledgeStop?(): boolean;
  /** Closed executor state committed atomically with the original segment's native history. */
  checkpoint?(): Readonly<Record<string, unknown>>;
  /**
   * The tool asks the action lease itself (with its own resource) right before its outside effect: the runner does not ask it again
   * just before (Minecraft run 18: every body tool asked twice, about 0.12 s each).
   */
  permitsItself?(name: string): boolean;
  /** Existing source/audience/action gates still apply. Uncertain failures throw and must never become retryable results. */
  /** `last`: the decision's last call (a body's executor may take a detour after it, never between calls chosen together). */
  execute(request: { scopeKey: string; taskId: string; operationId: string; name: string; input: unknown; signal: AbortSignal;
    last?: boolean }): Promise<ToolResult>;
}
