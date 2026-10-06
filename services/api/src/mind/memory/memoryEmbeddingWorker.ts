import { visibleMemoryText, type CompanionStateStore } from '@shannon/cognition';
import { configuredBackgroundBudgetUsd, utcMonthKey } from '../../llmUsage.js';
import type { MemoryModelGateway } from '../recall/memoryModels.js';
import type { MemoryEmbeddingIndex, PendingEmbeddingSource } from './store/sqliteMemoryEmbeddings.js';
import { conversationStoreOf, MemoryWithholding } from './memoryVisibility.js';

export type MemoryEmbeddingRunResult = 'disabled' | 'idle' | 'budget' | 'worked' | 'failed';

export interface MemoryEmbeddingWorkerOptions {
  batchSize?: number;
  backgroundBudgetUsd?: number;
  now?: () => string;
  /** Extra eligibility for derived sources (Shannon knowledge). Default: eligible. */
  isSourceEligible?: (scopeKey: string, source: PendingEmbeddingSource) => boolean;
}

/**
 * Background embedding of experience summaries, thread summaries and Shannon
 * knowledge. It never runs on the response path, stays inside the monthly
 * background budget, and never sends a forgotten/hidden source to the model,
 * nor a reply that used one or a summary built from one: such a source is
 * recorded as withheld and re-evaluated after state changes.
 */
export class MemoryEmbeddingWorker {
  private readonly batchSize: number;
  private readonly budgetUsd: number;
  private readonly now: () => string;

  constructor(
    private readonly index: MemoryEmbeddingIndex,
    private readonly stateStore: CompanionStateStore,
    private readonly gateway: MemoryModelGateway | null,
    private readonly usage: { backgroundLlmCostUsd(monthKey: string): number },
    private readonly options: MemoryEmbeddingWorkerOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.min(96, options.batchSize ?? 32));
    this.budgetUsd = options.backgroundBudgetUsd ?? configuredBackgroundBudgetUsd();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(): Promise<MemoryEmbeddingRunResult> {
    if (!this.gateway) return 'disabled';
    const model = this.gateway.embeddingModel;
    let worked = false;
    for (const scopeKey of this.index.embeddingScopes()) {
      const snapshot = this.stateStore.snapshot(scopeKey);
      const pending = this.index.pendingEmbeddingSources(scopeKey, model, snapshot.version, this.batchSize);
      if (!pending.length) continue;
      const updatedAt = this.now();
      const withholding = new MemoryWithholding(snapshot, conversationStoreOf(this.index), scopeKey);
      const visible = pending.filter(source => {
        const recallId = source.kind === 'thread' ? `thread:${source.sourceId}` : source.kind === 'knowledge' ? `knowledge:${source.sourceId}` : source.sourceId;
        const allowed = visibleMemoryText(snapshot, recallId, source.text) !== null
          && !(source.kind === 'thread' && withholding.withholdsThreadSummary(source.sourceId, source.text))
          && !(source.kind === 'experience' && withholding.withholdsExperience({ id: source.sourceId, summary: source.text }))
          && (this.options.isSourceEligible?.(scopeKey, source) ?? true);
        if (!allowed) this.index.withholdEmbedding(source, model, snapshot.version, updatedAt);
        return allowed;
      });
      worked ||= visible.length < pending.length;
      if (!visible.length) continue;
      if (this.usage.backgroundLlmCostUsd(utcMonthKey(new Date(updatedAt))) >= this.budgetUsd) return 'budget';
      try {
        const vectors = await this.gateway.embed(scopeKey, visible.map(source => source.text), 'memory_background');
        visible.forEach((source, position) => this.index.storeEmbedding(source, model, vectors[position]!, snapshot.version, updatedAt));
        worked = true;
      } catch {
        return 'failed';
      }
    }
    return worked ? 'worked' : 'idle';
  }
}
