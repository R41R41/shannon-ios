import { visibleMemoryText, type CompanionStateSnapshot, type SemanticRecallHit } from '@shannon/cognition';
import type { MemoryModelGateway } from './memoryModels.js';
import { mayUseThreadSummary } from './memoryVisibility.js';
import { cosineSimilarity, type MemoryEmbeddingIndex, type StoredEmbeddingCandidate } from './sqliteMemoryEmbeddings.js';

export interface SemanticMemoryConfig {
  enabled: boolean;
  /** Upper bound on rewrite + embed + rerank calls in one turn. */
  maximumModelCallsPerTurn: number;
  timeoutMilliseconds: number;
  scanLimit: number;
  rerankCandidates: number;
  maximumAdditional: number;
  minimumRelevance: number;
  minimumSimilarity: number;
}

export const DEFAULT_SEMANTIC_MEMORY_CONFIG: SemanticMemoryConfig = Object.freeze({
  enabled: true,
  maximumModelCallsPerTurn: 3,
  timeoutMilliseconds: 4_000,
  scanLimit: 5_000,
  rerankCandidates: 12,
  maximumAdditional: 3,
  minimumRelevance: 0.5,
  minimumSimilarity: 0.2,
});

export type SemanticRecallStatus = 'used' | 'empty' | 'skipped' | 'disabled' | 'failed' | 'timeout';

export interface SemanticRecallOutcome {
  status: SemanticRecallStatus;
  hits: readonly SemanticRecallHit[];
  modelCalls: number;
  elapsedMilliseconds: number;
}

export interface SemanticRecallInput {
  scopeKey: string;
  query: string;
  snapshot: CompanionStateSnapshot;
  threadId?: string;
  excludeIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Additional eligibility for derived sources such as Shannon knowledge. */
  isEligible?: (candidate: StoredEmbeddingCandidate) => boolean;
}

/**
 * Model-assisted recall. It reads only; every failure or timeout yields an
 * empty result so the caller answers from deterministic recall. Forgotten or
 * invalidated sources are filtered before any text is sent to a model.
 */
export class SemanticMemoryRecall {
  constructor(
    private readonly gateway: MemoryModelGateway | null,
    private readonly index: MemoryEmbeddingIndex | null,
    private readonly config: SemanticMemoryConfig = DEFAULT_SEMANTIC_MEMORY_CONFIG,
    private readonly nowMilliseconds: () => number = () => performance.now(),
  ) {}

  get available(): boolean {
    return this.config.enabled && Boolean(this.gateway && this.index) && this.config.maximumModelCallsPerTurn >= 1;
  }

  async recall(input: SemanticRecallInput): Promise<SemanticRecallOutcome> {
    const startedAt = this.nowMilliseconds();
    let modelCalls = 0;
    const finish = (status: SemanticRecallStatus, hits: readonly SemanticRecallHit[] = []): SemanticRecallOutcome =>
      Object.freeze({ status, hits: Object.freeze([...hits]), modelCalls, elapsedMilliseconds: Math.max(0, Math.round(this.nowMilliseconds() - startedAt)) });
    if (!this.config.enabled || !this.gateway || !this.index) return finish('disabled');
    if (this.config.maximumModelCallsPerTurn < 1 || !input.query.trim()) return finish('skipped');
    const deadline = AbortSignal.timeout(this.config.timeoutMilliseconds);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const gateway = this.gateway;
    try {
      const budget = this.config.maximumModelCallsPerTurn;
      const rewrites = budget >= 3 ? (modelCalls += 1, await gateway.rewriteQuery(input.scopeKey, input.query, signal)) : [];
      signal.throwIfAborted();
      const queries = [input.query, ...rewrites].slice(0, 4);
      modelCalls += 1;
      const queryVectors = await gateway.embed(input.scopeKey, queries, 'memory', signal);
      signal.throwIfAborted();
      const shortlist = this.eligibleCandidates(input, gateway.embeddingModel)
        .map(candidate => ({ candidate, similarity: Math.max(...queryVectors.map(vector => cosineSimilarity(vector, candidate.vector))) }))
        .filter(row => row.similarity >= this.config.minimumSimilarity)
        .sort((left, right) => right.similarity - left.similarity || right.candidate.observedAt.localeCompare(left.candidate.observedAt))
        .slice(0, this.config.rerankCandidates);
      if (!shortlist.length) return finish('empty');
      let scores = new Map(shortlist.map(row => [row.candidate.id, row.similarity]));
      if (modelCalls < budget) {
        modelCalls += 1;
        const ranked = await gateway.rerank(input.scopeKey, input.query,
          shortlist.map(row => ({ id: row.candidate.id, text: row.candidate.summary })), signal);
        signal.throwIfAborted();
        scores = new Map(ranked.filter(row => scores.has(row.id)).map(row => [row.id, row.relevance]));
      }
      const hits = shortlist.flatMap(row => {
        const relevance = scores.get(row.candidate.id);
        return relevance === undefined ? [] : [{
          id: row.candidate.id, summary: row.candidate.summary, observedAt: row.candidate.observedAt, relevance,
        }];
      });
      return finish(hits.length ? 'used' : 'empty', hits);
    } catch {
      return finish(signal.aborted ? 'timeout' : 'failed');
    }
  }

  private eligibleCandidates(input: SemanticRecallInput, model: string): StoredEmbeddingCandidate[] {
    const threadSummariesAllowed = mayUseThreadSummary(input.snapshot);
    return this.index!.embeddingCandidates(input.scopeKey, model, this.config.scanLimit).filter(candidate => {
      if (input.excludeIds?.has(candidate.id)) return false;
      if (candidate.kind === 'thread' && (!threadSummariesAllowed || candidate.threadId === input.threadId)) return false;
      if (candidate.kind === 'knowledge' && !input.isEligible) return false;
      if (input.isEligible && !input.isEligible(candidate)) return false;
      return visibleMemoryText(input.snapshot, candidate.id, candidate.summary) !== null;
    });
  }
}

export function configuredSemanticMemoryConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SemanticMemoryConfig {
  const integer = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(value);
    return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  };
  return Object.freeze({
    ...DEFAULT_SEMANTIC_MEMORY_CONFIG,
    enabled: environment.SHANNON_MEMORY_SEMANTIC_ENABLED?.trim() !== 'false',
    maximumModelCallsPerTurn: integer(environment.SHANNON_MEMORY_MAX_MODEL_CALLS_PER_TURN, 3, 0, 3),
    timeoutMilliseconds: integer(environment.SHANNON_MEMORY_SEMANTIC_TIMEOUT_MS, 4_000, 200, 15_000),
    scanLimit: integer(environment.SHANNON_MEMORY_SEMANTIC_SCAN_LIMIT, 5_000, 50, 50_000),
  });
}
