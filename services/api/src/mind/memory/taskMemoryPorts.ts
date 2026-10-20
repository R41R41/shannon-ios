import type { MemorySearchOptions } from './store/sqliteMemorySearch.js';
import type { CompanionStateSnapshot, MemoryAudience } from '@shannon/cognition';
import type { MemoryWithholding } from './memoryVisibility.js';
import type { ShannonExperience } from './conversationContract.js';
export interface TaskMemoryItem {
  id: string; summary: string; observedAt: string; evidence: string; applicability: string;
  /** Canonical provenance, rechecked by the same disclosure/forgetting gate on each read. */
  provenance?: { kind: 'experience' | 'thread' | 'knowledge' | 'state'; sourceIds: readonly string[]; readSourceIds: readonly string[] };
  confidence: number | null; conflicts: readonly string[]; detailRef: string;
}
export interface TaskMemoryContext { scopeKey: string; present: MemoryAudience; observe(ids: readonly string[]): boolean }
export interface TaskMemoryResult { status: 'ready' | 'no_match' | 'withheld' | 'cancelled'; items: readonly TaskMemoryItem[]; sourceIds: readonly string[]; search?: { coverage: 'bounded_candidates'; candidateLimit: number; offset: number; limit: number } }
/** One synchronous check's state and withholding; `walk`: that read's own token, so a reader's per-walk memo ends with the read. */
export interface TaskMemoryReadSnapshot {
  state: CompanionStateSnapshot; withholding: MemoryWithholding; walk?: object;
  /**
   * The source rows' mark (`ConversationStore.provenanceMark`) the withholding's remembered turns were read under, when its maker knows
   * it (the FCA source guard's moment): a reader's answers are then shared with every withholding made from the same rows.
   */
  rows?: string;
  /** The remembered turns as of this snapshot's database (`TaskMemory.readSnapshot` only); absent, each read asks the store. */
  experience?(id: string): ShannonExperience | null;
}
export interface TaskMemory {
  available(scopeKey: string, present: MemoryAudience): boolean;
  search(scopeKey: string, query: string, present: MemoryAudience, limit?: number, options?: MemorySearchOptions,
    shared?: TaskMemoryReadSnapshot): TaskMemoryItem[];
  /**
   * A state and withholding for reads that belong together (one FCA step's recall: its context, `memory.search` and the packet),
   * the same objects while the database is unchanged. Pass it to `read`/`search` inside one `withholding.withReadSnapshot`.
   */
  readSnapshot?(scopeKey: string): TaskMemoryReadSnapshot;
  sources(scopeKey: string, ids: readonly string[], shared?: TaskMemoryReadSnapshot): string[];
  /**
   * `shared`: the caller's own snapshot and withholding of one synchronous check (the FCA source guard), so that a check of many
   * sources walks the recall graph once instead of once per chunk. Absent, the read takes its own, as before.
   */
  read(scopeKey: string, ids: readonly string[], present: MemoryAudience, shared?: TaskMemoryReadSnapshot,
    /**
     * provenance: false: the items come without their provenance (each one's whole lineage of sources is not walked to list it). A caller
     * that only asks which ids are readable (the FCA source guard's walk, everySourceVisible) has no use for it.
     */
    options?: { provenance?: boolean }): TaskMemoryItem[];
  execute(name: string, input: Record<string, unknown>, context: TaskMemoryContext, signal?: AbortSignal): Promise<TaskMemoryResult>;
}
export { createTaskMemory } from './taskMemory.js';
export { taskExperienceDraft, taskExperienceId, type TaskExperienceOutcome, type TaskExperienceRecord } from './taskExperience.js';
