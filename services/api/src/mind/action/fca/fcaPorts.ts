import type { ShannonToolDefinition, ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaActionExpectation, FcaAffectAppraisal, FcaAuxiliaryResult, FcaSharedContext } from './fcaEvidencePorts.js';
import type { TaskRecallPacket } from '../../recall/taskRecallPorts.js';

/** Public decisions only. Native history is opaque to the runtime and is never an Observer payload. */
export interface FcaToolCall { id: string; name: string; input: unknown }
export type FcaDecision =
  | { kind: 'tools'; calls: readonly FcaToolCall[] }
  | { kind: 'wait'; summary: string }
  | { kind: 'complete'; summary: string };
export interface FcaModelInput {
  task: { id: string; title: string; goal: string; completionCriteria: string };
  messages: readonly { id: string; text: string; sourceTaskId: string }[];
  children?: readonly { id: string; title: string; phase: string; summary: string }[];
  history: readonly unknown[];
  tools: readonly ShannonToolDefinition[];
  /** Selection mode: every currently allowed tool's metadata; tools contains only selected/opened schemas. */
  catalog?: readonly { name: string; description: string }[];
  sharedContext?: FcaSharedContext;
  recall?: TaskRecallPacket;
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
  definitions: readonly ShannonToolDefinition[];
  /** Existing source/audience/action gates still apply. Uncertain failures throw and must never become retryable results. */
  execute(request: { scopeKey: string; taskId: string; operationId: string; name: string; input: unknown; signal: AbortSignal }): Promise<ToolResult>;
}
