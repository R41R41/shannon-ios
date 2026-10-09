import type { MemoryAudience } from '@shannon/cognition';
import type { TaskMemoryItem } from '../memory/taskMemoryPorts.js';
export interface TaskRecallInput {
  scopeKey: string; taskId: string; contextVersion: string; cue: string; present: MemoryAudience; signal?: AbortSignal;
}
export interface TaskRecallPacket {
  contextVersion: string; observedAt: string;
  status: 'searching' | 'ready' | 'no_match' | 'failed' | 'cancelled' | 'withheld';
  items: readonly TaskMemoryItem[]; sourceIds: readonly string[];
}
export interface TaskRecall {
  /** Starts semantic enrichment now, alongside selection. Reusing a context version never repeats its model call. */
  start(input: TaskRecallInput): void;
  /** A frozen decision boundary. Late answers are visible only to the next call. */
  packet(input: TaskRecallInput, options?: { waitMilliseconds?: number }): Promise<TaskRecallPacket>;
  /** Abort pending enrichment and await its unwind before releasing the current action lease; retain obtained IDs. */
  finishSegment(scopeKey: string, taskId: string): Promise<void>;
  cancelAll(): Promise<void>;
  cancel(scopeKey: string, taskId: string): void;
}
export { createTaskRecall } from './taskRecall.js';
