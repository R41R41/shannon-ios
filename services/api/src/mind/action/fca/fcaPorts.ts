import type { ShannonToolDefinition, ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaActionExpectation, FcaAffectAppraisal, FcaAuxiliaryResult, FcaSharedContext } from './fcaEvidencePorts.js';
import type { TaskRecallPacket } from '../../recall/taskRecallPorts.js';
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
  sharedContext?: FcaSharedContext;
  recall?: TaskRecallPacket;
  body?: { revision: number; observation: BodyObservation | null };
  /** Compact source-checked skill metadata, dynamic so the stable cache prefix and signed replay remain unchanged. */
  skillIndex?: string;
  progress?: FcaProgress;
  observations?: readonly { revision: number; observation: FcaObservation | null }[];
}
/** Task-owned short control may interrupt body work while ordinary inference is awaiting a response. */
export interface FcaBodyLifecycle {
  start(signal: AbortSignal): void;
  revision(): number;
  context(): { revision: number; observation: BodyObservation | null };
  /** Drain active reflex work and refuse a decision made against an older physical generation. Unknown throws. */
  guard(revision: number): Promise<boolean>;
  toolSignal(name: string, parent: AbortSignal): AbortSignal;
  noteCall?(call: FcaToolCall, operationId: string): void;
  noteResult?(call: FcaToolCall, result: ToolResult): void;
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
  /** Existing source/audience/action gates still apply. Uncertain failures throw and must never become retryable results. */
  execute(request: { scopeKey: string; taskId: string; operationId: string; name: string; input: unknown; signal: AbortSignal }): Promise<ToolResult>;
}
