import type { ToolResult } from '../../tools/toolRegistryPorts.js';
import type { TaskSource, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { ShannonModelToolSession } from '../../../infra/models/chatModelTools.js';

/** Only canonical identifiers emitted by trusted readers; never source text or model-supplied metadata. */
export interface FcaReadReceipt { name: string; ok: boolean; documents?: { read?: readonly string[]; sourceIds?: readonly string[]; informs?: true } }
export interface FcaObservedSources { recalledMemoryIds?: readonly string[]; readSourceIds?: readonly string[] }

/** The existing foreground text turn owns inference and its respond lease. This port only binds task tools to it. */
export interface FcaConversationPort {
  begin(input: {
    scopeKey: string; threadId: string; observedAt: string; recalledMemoryIds: readonly string[];
    readSourceIds?: readonly string[];
    ownerAlone(): boolean;
  }): FcaConversationTurn | null;
  taskToolsAvailable(scopeKey: string): boolean;
  executeTaskTool(name: string, input: unknown, context: { scopeKey: string }): ToolResult;
  observeRead(scopeKey: string, receipt: FcaReadReceipt): boolean;
  observeSources(scopeKey: string, sources: FcaObservedSources): boolean;
}
export interface FcaConversationTurn {
  /** Freshly guarded inbox data for this existing model call; only these messages are consumed at commit. */
  context(): string;
  selectTools?(tools: ShannonModelToolSession, input: { goal: string; state: string }): Promise<ShannonModelToolSession>;
  /** Called only after the ordinary conversation writer committed the source experience. */
  commit(experienceId: string): void;
  /** No fallback model call; unbound descendants remain ineligible for execution. */
  abort(): void;
}

/** Pending references may be shown only inside the exact foreground segment that just created them. */
export interface FcaSourceGuard {
  (scopeKey: string, taskId: string, pendingStepId?: string): boolean;
  sources(scopeKey: string, task: TaskView, sources: readonly TaskSource[], pendingStepId?: string): boolean;
}

export { createFcaConversationBridge } from './fcaConversation.js';
export { createFcaSourceGuard, conversationFcaProvenance } from './fcaConversationSources.js';
