import {
  mergeSemanticMemories,
  needsSemanticMemoryRecall,
  type CompanionStateSnapshot,
} from '@shannon/cognition';
import type { LlmUsageStore } from './llmUsage.js';
import { OpenAIMemoryModelGateway, type MemoryModelGateway } from './memoryModels.js';
import {
  configuredSemanticMemoryConfig,
  SemanticMemoryRecall,
  type SemanticRecallStatus,
} from './semanticMemoryRecall.js';
import type { MemoryEmbeddingIndex } from './sqliteMemoryEmbeddings.js';
import { withRecalledMemories, type TurnCognitiveContext } from './turnCognitiveContext.js';

export interface TurnMemoryRecallInput {
  scopeKey: string;
  message: string;
  snapshot: CompanionStateSnapshot;
  threadId?: string;
  /** Voice: Jev selected `conversation_memory`. Text: omitted, the text classifier decides. */
  memoryTurn?: boolean;
  signal?: AbortSignal;
}

export interface EnrichedTurnContext extends TurnCognitiveContext {
  memoryRecall: { status: SemanticRecallStatus; modelCalls: number; elapsedMilliseconds: number };
}

/** Stage after deterministic recall. Returning the input unchanged is always safe. */
export interface TurnMemoryRecall {
  /** Whether a turn will run the model-assisted stage (voice uses this to schedule a waiting phrase). */
  willSearch(input: Pick<TurnMemoryRecallInput, 'message' | 'memoryTurn'>): boolean;
  enrich(context: TurnCognitiveContext, input: TurnMemoryRecallInput): Promise<EnrichedTurnContext>;
}

const semanticGuidance = '[Semantic recall] Memories with cue "semantic" are search candidates, not confirmed facts. Use one only when its date and content fit the current message; if unsure, say so briefly or ask.';

export class ShannonTurnMemoryRecall implements TurnMemoryRecall {
  constructor(private readonly semantic: SemanticMemoryRecall) {}

  willSearch(input: Pick<TurnMemoryRecallInput, 'message' | 'memoryTurn'>): boolean {
    return this.semantic.available && (input.memoryTurn ?? needsSemanticMemoryRecall(input.message));
  }

  async enrich(context: TurnCognitiveContext, input: TurnMemoryRecallInput): Promise<EnrichedTurnContext> {
    if (!this.willSearch(input)) return { ...context, memoryRecall: { status: 'skipped', modelCalls: 0, elapsedMilliseconds: 0 } };
    const outcome = await this.semantic.recall({
      scopeKey: input.scopeKey, query: input.message, snapshot: input.snapshot,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      excludeIds: new Set(context.memories.map(memory => memory.id)),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const memories = mergeSemanticMemories(context.memories, outcome.hits);
    const enriched = memories.length === context.memories.length ? context
      : withRecalledMemories(context, input.snapshot, memories, semanticGuidance);
    return { ...enriched, memoryRecall: { status: outcome.status, modelCalls: outcome.modelCalls, elapsedMilliseconds: outcome.elapsedMilliseconds } };
  }
}

/** Voice: a turn with model-assisted memory search is classified as taking more than three seconds. */
export function withMemorySearchLatency<T extends { latencyClass: 'under_1s' | 'under_3s' | 'under_10s' | 'over_10s' }>(decision: T): T {
  return decision.latencyClass === 'under_1s' || decision.latencyClass === 'under_3s'
    ? { ...decision, latencyClass: 'under_10s' } : decision;
}

export function createConfiguredTurnMemoryRecall(
  index: MemoryEmbeddingIndex & LlmUsageStore,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  gateway: MemoryModelGateway | null = configuredMemoryModelGateway(environment, index),
): TurnMemoryRecall {
  return new ShannonTurnMemoryRecall(new SemanticMemoryRecall(gateway, index, configuredSemanticMemoryConfig(environment)));
}

export function configuredMemoryModelGateway(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore?: LlmUsageStore,
): MemoryModelGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const dimensions = Number(environment.SHANNON_MEMORY_EMBEDDING_DIMENSIONS);
  return new OpenAIMemoryModelGateway({
    apiKey,
    embeddingModel: environment.SHANNON_MEMORY_EMBEDDING_MODEL?.trim() || undefined,
    embeddingDimensions: Number.isInteger(dimensions) && dimensions >= 64 && dimensions <= 3_072 ? dimensions : undefined,
    reasoningModel: environment.SHANNON_MEMORY_MODEL?.trim() || undefined,
    usageStore,
  });
}
