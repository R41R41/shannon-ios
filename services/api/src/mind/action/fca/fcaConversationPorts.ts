import type { ToolResult } from '../../tools/toolRegistryPorts.js';
import type { TaskSource, TaskSpec, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { ShannonModelToolSession } from '../../../infra/models/chatModelTools.js';
import type { TaskConversationDeliveryInput } from '../taskRuntime/taskConversationDeliveryPorts.js';
import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';

/** Only canonical identifiers emitted by trusted readers; never source text or model-supplied metadata. */
export interface FcaReadReceipt { name: string; ok: boolean; documents?: { read?: readonly string[]; sourceIds?: readonly string[]; informs?: true } }
export interface FcaObservedSources { recalledMemoryIds?: readonly string[]; readSourceIds?: readonly string[] }

/** The existing foreground text turn owns inference and its respond lease. This port only binds task tools to it. */
export interface FcaConversationPort {
  begin(input: {
    scopeKey: string; threadId: string; observedAt: string; recalledMemoryIds: readonly string[];
    readSourceIds?: readonly string[];
    delivery?: TaskConversationDeliveryInput;
    ownerAlone(): boolean;
  }): FcaConversationTurn | null;
  taskToolsAvailable(scopeKey: string): boolean;
  executeTaskTool(name: string, input: unknown, context: { scopeKey: string }): ToolResult;
  observeRead(scopeKey: string, receipt: FcaReadReceipt): boolean;
  observeSources(scopeKey: string, sources: FcaObservedSources): boolean;
}
export interface FcaConversationTurn {
  /** Owner observer linkage for the existing foreground generation; creates no execution or admission. */
  observe?<T>(work: () => Promise<T>): Promise<T>;
  /** Freshly guarded inbox data for this existing model call; only these messages are consumed at commit. */
  context(): string;
  /** Admit work under this exact foreground source; it stays ineligible until visible history binds. */
  delegate?(spec: TaskSpec, places?: import('../../../integrations/places/placeDiscovery.js').PlaceSearchContext): TaskView;
  selectTools?(tools: ShannonModelToolSession, input: { goal: string; state: string }): Promise<ShannonModelToolSession>;
  /** Called only after the ordinary conversation writer committed the source experience. */
  commit(experienceId: string): void;
  /** Voice generation finished. Keep descendants pending until the native client's canonical history write. */
  stageDelivery?(): void;
  /** No fallback model call; unbound descendants remain ineligible for execution. */
  abort(): void;
  /**
   * The research this turn admitted, once it completed with a report within `milliseconds` (polled; never waits longer, and
   * returns null when it failed, stopped, the signal aborted, or the owner is no longer alone).
   */
  awaitWork?(milliseconds: number, signal?: AbortSignal): Promise<{ taskId: string; title: string; report: NonNullable<TaskProgress['report']> } | null>;
  /** A turn that asks how the work is going and admitted none: follow the newest research still running (then `awaitWork` waits for it). */
  followWork?(accepts?: (task: TaskView) => boolean): TaskView | null;
  /** The report was said in this turn: its card stays in the Talk, and it is never said or announced again. */
  hearWork?(taskId: string, reportId: string, spoken: string): boolean;
}

/** Pending references may be shown only inside the exact foreground segment that just created them. */
export interface FcaSourceGuard {
  (scopeKey: string, taskId: string, pendingStepId?: string): boolean;
  sources(scopeKey: string, task: TaskView, sources: readonly TaskSource[], pendingStepId?: string): boolean;
  content?(scopeKey: string, taskId: string, text: string, observedAt: string): boolean;
  progress?(scopeKey: string, taskId: string): TaskProgress | null;
}

export { createFcaConversationBridge } from './fcaConversation.js';
export { createFcaSourceGuard, conversationFcaProvenance } from './fcaConversationSources.js';

/** Observation is optional and preserves the original model promise when the bridge is absent. */
export function observeFcaConversation<T>(turn: FcaConversationTurn | null | undefined, work: () => Promise<T>): Promise<T> {
  return turn?.observe ? turn.observe(work) : work();
}
