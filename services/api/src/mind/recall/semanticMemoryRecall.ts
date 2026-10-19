import { visibleMemoryText, type CompanionStateSnapshot, type MemoryAudience, type SemanticRecallHit } from '@shannon/cognition';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import type { MemoryModelGateway } from './memoryModels.js';
import { conversationStoreOf, MemoryWithholding } from '../memory/memoryPorts.js';
import { type MemoryEmbeddingIndex, type StoredEmbeddingCandidate } from '../memory/memoryPorts.js';
import { cosineSimilarity } from '../memory/embeddingPorts.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

export interface SemanticMemoryConfig {
  enabled: boolean;
  /** Upper bound on model calls in one turn: rewrite, embed, rerank (at most 3 here) plus knowledge-tree navigation. */
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
  maximumModelCallsPerTurn: 4,
  timeoutMilliseconds: 4_000,
  // The candidates are held in memory while the index says nothing changed (`embeddingVersion`), so the bound no longer costs a read
  // of every vector at each search; 5,000 (the bound until 2026-10-19) would have left the oldest memories out once there were more.
  scanLimit: 50_000,
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
  /** Who can hear or read the reply. Candidates they may not hear are dropped before any model sees them. */
  present: MemoryAudience;
  threadId?: string;
  excludeIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Additional eligibility for derived sources such as Shannon knowledge. */
  isEligible?: (candidate: StoredEmbeddingCandidate) => boolean;
  /**
   * Embed the words as spoken, without the model's query rewrite: a voice turn cannot wait for a model call before its search
   * (2026-10-13: the rewrite was 1.5 s of a 4.2 s recall on a simple follow-up). The rerank still runs.
   */
  withoutRewrite?: boolean;
  /**
   * How long the rerank may take before the similarity order stands (a voice turn: `SHANNON_VOICE_RERANK_TIMEOUT_MS`, 1,200).
   * Owner's Windows call, 2026-10-14: a non-streaming rerank took 2,178 ms and her first sentence came at 4.47 s. Absent: no cap.
   */
  rerankTimeoutMilliseconds?: number;
}

type Shortlist = ReadonlyArray<{ candidate: StoredEmbeddingCandidate; similarity: number }>;

/**
 * Model-assisted recall. It reads only; every failure or timeout yields an
 * empty result so the caller answers from deterministic recall. Forgotten or
 * invalidated sources, replies that used them, and summaries built from them
 * are filtered before any text is sent to a model.
 */
export class SemanticMemoryRecall {
  constructor(
    private readonly gateway: MemoryModelGateway | null,
    private readonly index: MemoryEmbeddingIndex | null,
    private readonly config: SemanticMemoryConfig = DEFAULT_SEMANTIC_MEMORY_CONFIG,
    private readonly nowMilliseconds: () => number = () => performance.now(),
  ) {}

  get maximumModelCallsPerTurn(): number { return this.config.maximumModelCallsPerTurn; }
  get timeoutMilliseconds(): number { return this.config.timeoutMilliseconds; }
  get modelGateway(): MemoryModelGateway | null { return this.gateway; }

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
      const budget = Math.min(3, this.config.maximumModelCallsPerTurn);
      const rewrites = budget >= 3 && !input.withoutRewrite ? (modelCalls += 1, await gateway.rewriteQuery(input.scopeKey, input.query, signal)) : [];
      signal.throwIfAborted();
      const queries = [input.query, ...rewrites].slice(0, 4);
      modelCalls += 1;
      const queryVectors = await gateway.embed(input.scopeKey, queries, 'memory', signal);
      signal.throwIfAborted();
      const withholding = new MemoryWithholding(input.snapshot, conversationStoreOf(this.index), input.scopeKey);
      const shortlist: Array<{ candidate: StoredEmbeddingCandidate; similarity: number }> = [];
      // Withholding is decided lazily, in rank order, so only the candidates that could be used are examined.
      for (const row of this.eligibleCandidates(input, gateway.embeddingModel)
        .map(candidate => ({ candidate, similarity: Math.max(...queryVectors.map(vector => cosineSimilarity(vector, candidate.vector))) }))
        .filter(row => row.similarity >= this.config.minimumSimilarity)
        .sort((left, right) => right.similarity - left.similarity || right.candidate.observedAt.localeCompare(left.candidate.observedAt))) {
        if (shortlist.length >= this.config.rerankCandidates) break;
        const { candidate } = row;
        const withheld = candidate.kind === 'thread'
          ? withholding.withholdsThreadSummary(candidate.threadId ?? candidate.sourceId, candidate.summary, candidate.observedAt)
          : candidate.kind === 'experience' && withholding.withholdsExperience(candidate);
        if (!withheld) shortlist.push(row);
      }
      if (!shortlist.length) return finish('empty');
      let scores = new Map(shortlist.map(row => [row.candidate.id, row.similarity]));
      if (modelCalls < budget) {
        modelCalls += 1;
        const ranked = await cappedRerank(gateway, input, shortlist, signal);
        signal.throwIfAborted();
        // Past its cap the rerank is dropped and the similarities stand as the relevance (the beam order, same threshold).
        if (ranked) scores = new Map(ranked.filter(row => scores.has(row.id)).map(row => [row.id, row.relevance]));
      }
      const gate = new DisclosureGate(input.present, input.snapshot, conversationStoreOf(this.index), input.scopeKey);
      const hits = shortlist.flatMap(row => {
        const relevance = scores.get(row.candidate.id);
        return relevance === undefined ? [] : [{
          id: row.candidate.id, summary: `${gate.markerForRecallId(row.candidate.id)}${row.candidate.summary}`,
          observedAt: row.candidate.observedAt, relevance,
        }];
      });
      return finish(hits.length ? 'used' : 'empty', hits);
    } catch {
      return finish(signal.aborted ? 'timeout' : 'failed');
    }
  }

  /**
   * The memories nearest one text (a body task's goal, `bodyTaskRecall.ts`): one embedding call and the similarity to every eligible
   * candidate, no rewrite and no rerank. Withheld and forgotten ones are left out as in `recall`; ids and similarities only.
   */
  async nearest(input: Pick<SemanticRecallInput, 'scopeKey' | 'query' | 'snapshot' | 'present' | 'signal' | 'isEligible'> & { limit: number }):
    Promise<{ status: SemanticRecallStatus; hits: ReadonlyArray<{ id: string; similarity: number }>; elapsedMilliseconds: number }> {
    const startedAt = this.nowMilliseconds();
    const finish = (status: SemanticRecallStatus, hits: ReadonlyArray<{ id: string; similarity: number }> = []) =>
      ({ status, hits, elapsedMilliseconds: Math.max(0, Math.round(this.nowMilliseconds() - startedAt)) });
    if (!this.available) return finish('disabled');
    if (!input.query.trim()) return finish('skipped');
    const deadline = AbortSignal.timeout(this.config.timeoutMilliseconds);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    try {
      const [vector] = await this.gateway!.embed(input.scopeKey, [input.query], 'memory', signal);
      signal.throwIfAborted();
      if (!vector) return finish('empty');
      const withholding = new MemoryWithholding(input.snapshot, conversationStoreOf(this.index), input.scopeKey);
      const ranked = this.eligibleCandidates(input, this.gateway!.embeddingModel)
        .map(candidate => ({ candidate, similarity: cosineSimilarity(vector, candidate.vector) }))
        .filter(row => row.similarity >= this.config.minimumSimilarity)
        .sort((left, right) => right.similarity - left.similarity || right.candidate.observedAt.localeCompare(left.candidate.observedAt));
      const hits: Array<{ id: string; similarity: number }> = [];
      for (const { candidate, similarity } of ranked) {
        if (hits.length >= input.limit) break;
        const withheld = candidate.kind === 'thread'
          ? withholding.withholdsThreadSummary(candidate.threadId ?? candidate.sourceId, candidate.summary, candidate.observedAt)
          : candidate.kind === 'experience' && withholding.withholdsExperience(candidate);
        if (!withheld) hits.push({ id: candidate.id, similarity });
      }
      return finish(hits.length ? 'used' : 'empty', hits);
    } catch {
      return finish(signal.aborted ? 'timeout' : 'failed');
    }
  }

  /** The index's candidates, held while its version is the same (no vector is read again then); read every time without one. */
  private stored(scopeKey: string, model: string): readonly StoredEmbeddingCandidate[] {
    const index = this.index!, version = index.embeddingVersion?.(scopeKey, model);
    if (version === undefined) return index.embeddingCandidates(scopeKey, model, this.config.scanLimit);
    const key = `${scopeKey}\u0000${model}`, held = this.held.get(key);
    if (held?.version === version) return held.rows;
    const rows = index.embeddingCandidates(scopeKey, model, this.config.scanLimit);
    this.held.set(key, { version, rows });
    // One set a scope and model (the owner's, at most a second): each holds every vector of its scope (about 2 KB each at 512 dimensions).
    if (this.held.size > 2) this.held.delete(this.held.keys().next().value!);
    return rows;
  }
  private readonly held = new Map<string, { version: string; rows: readonly StoredEmbeddingCandidate[] }>();

  private eligibleCandidates(input: Pick<SemanticRecallInput, 'scopeKey' | 'snapshot' | 'present' | 'excludeIds' | 'threadId' | 'isEligible'>,
    model: string): StoredEmbeddingCandidate[] {
    const gate = new DisclosureGate(input.present, input.snapshot, conversationStoreOf(this.index), input.scopeKey);
    return this.stored(input.scopeKey, model).filter(candidate => {
      if (input.excludeIds?.has(candidate.id)) return false;
      if (!gate.allowsRecallId(candidate.id)) return false;
      if (candidate.kind === 'thread' && candidate.threadId === input.threadId) return false;
      if (candidate.kind === 'knowledge' && !input.isEligible) return false;
      if (input.isEligible && !input.isEligible(candidate)) return false;
      return visibleMemoryText(input.snapshot, candidate.id, candidate.summary) !== null;
    });
  }
}

/** The rerank, or null when it passed `rerankTimeoutMilliseconds` (its request is then aborted and a late answer dropped). */
async function cappedRerank(gateway: MemoryModelGateway, input: SemanticRecallInput, shortlist: Shortlist, signal: AbortSignal):
  Promise<readonly { id: string; relevance: number }[] | null> {
  const candidates = shortlist.map(row => ({ id: row.candidate.id, text: row.candidate.summary }));
  const cap = input.rerankTimeoutMilliseconds;
  if (cap === undefined) return gateway.rerank(input.scopeKey, input.query, candidates, signal);
  const capped = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      capped.abort();
      resolve(null);
    }, cap);
  });
  try {
    const work = gateway.rerank(input.scopeKey, input.query, candidates, AbortSignal.any([signal, capped.signal]));
    work.catch(() => {});
    return await Promise.race([work, late]);
  } catch (error) {
    if (capped.signal.aborted && !signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function configuredSemanticMemoryConfig(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): SemanticMemoryConfig {
  const integer = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(value);
    return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  };
  return Object.freeze({
    ...DEFAULT_SEMANTIC_MEMORY_CONFIG,
    enabled: environment.SHANNON_MEMORY_SEMANTIC_ENABLED?.trim() !== 'false',
    maximumModelCallsPerTurn: integer(environment.SHANNON_MEMORY_MAX_MODEL_CALLS_PER_TURN, 4, 0, 4),
    timeoutMilliseconds: integer(environment.SHANNON_MEMORY_SEMANTIC_TIMEOUT_MS, 4_000, 200, 15_000),
    scanLimit: integer(environment.SHANNON_MEMORY_SEMANTIC_SCAN_LIMIT, 50_000, 50, 50_000),
  });
}
