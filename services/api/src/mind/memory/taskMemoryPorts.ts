import type { MemorySearchOptions } from './store/sqliteMemorySearch.js';
import type { MemoryAudience } from '@shannon/cognition';
export interface TaskMemoryItem {
  id: string; summary: string; observedAt: string; evidence: string; applicability: string;
  /** Canonical provenance, rechecked by the same disclosure/forgetting gate on each read. */
  provenance?: { kind: 'experience' | 'thread' | 'knowledge' | 'state'; sourceIds: readonly string[]; readSourceIds: readonly string[] };
  confidence: number | null; conflicts: readonly string[]; detailRef: string;
}
export interface TaskMemoryContext { scopeKey: string; present: MemoryAudience; observe(ids: readonly string[]): boolean }
export interface TaskMemoryResult { status: 'ready' | 'no_match' | 'withheld' | 'cancelled'; items: readonly TaskMemoryItem[]; sourceIds: readonly string[]; search?: { coverage: 'bounded_candidates'; candidateLimit: number; offset: number; limit: number } }
export interface TaskMemory {
  available(scopeKey: string, present: MemoryAudience): boolean;
  search(scopeKey: string, query: string, present: MemoryAudience, limit?: number, options?: MemorySearchOptions): TaskMemoryItem[];
  sources(scopeKey: string, ids: readonly string[]): string[];
  read(scopeKey: string, ids: readonly string[], present: MemoryAudience): TaskMemoryItem[];
  execute(name: string, input: Record<string, unknown>, context: TaskMemoryContext, signal?: AbortSignal): Promise<TaskMemoryResult>;
}
export { createTaskMemory } from './taskMemory.js';
export { taskExperienceDraft, taskExperienceId, type TaskExperienceOutcome, type TaskExperienceRecord } from './taskExperience.js';
