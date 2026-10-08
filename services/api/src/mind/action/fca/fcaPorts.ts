import type { ShannonToolDefinition } from '../../tools/toolRegistryPorts.js';

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
}
export interface FcaModelOutput {
  decision: FcaDecision;
  /** Complete native user/assistant blocks appended by this one model call. */
  history: readonly unknown[];
}
export interface FcaModel {
  decide(input: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput>;
  toolResults(results: readonly { id: string; text: string; ok: boolean }[]): unknown;
}
