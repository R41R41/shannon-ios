import { switchOn } from '@shannon/switches';
import { configuredResponseModel, replacementModel } from '../../infra/models/anthropic/haikuConfig.js';
import {
  UNLABELLED_DISCLOSURE_MARKER,
  isMemoryInquiry,
  isOwnerOnly,
  mergeSemanticMemories,
  needsSemanticMemoryRecall,
  type CompanionStateSnapshot,
  type ContextualMemory,
  type ShannonKnowledgeDocument,
} from '@shannon/cognition';
import type { LlmUsageStore } from '../../infra/models/llmUsage.js';
import { OpenAIMemoryModelGateway, type MemoryModelGateway } from './memoryModels.js';
import {
  configuredSemanticMemoryConfig,
  SemanticMemoryRecall,
  type SemanticRecallOutcome,
  type SemanticRecallStatus,
} from './semanticMemoryRecall.js';
import type { MemoryEmbeddingIndex } from '../memory/memoryPorts.js';
import type { ShannonKnowledgeStore } from '../memory/memoryPorts.js';
import { recallShannonKnowledge, usableKnowledgeFor } from './turnKnowledgeRecall.js';
import type { TreeKnowledgeRecall } from './treeRecall.js';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import { conversationStoreOf } from '../memory/memoryPorts.js';
import { withRecalledMemories, type TurnCognitiveContext } from '../workspace/contextPorts.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { temporalKnowledgePrompt } from './temporalKnowledgeRecall.js';

export interface TurnMemoryRecallInput {
  scopeKey: string;
  message: string;
  snapshot: CompanionStateSnapshot;
  threadId?: string;
  /** Voice: Jev selected `conversation_memory`. Text: omitted, the text classifier decides. */
  memoryTurn?: boolean;
  /** Voice `skill_complex`: knowledge documents may be navigated by heading. */
  complexTurn?: boolean;
  /** Voice: the router's conversation class (tree recall walks a voice turn only in a `skill_*` class, one level). Absent: text. */
  voiceClass?: string;
  signal?: AbortSignal;
}

export interface EnrichedTurnContext extends TurnCognitiveContext {
  memoryRecall: { status: SemanticRecallStatus; modelCalls: number; elapsedMilliseconds: number };
  /** Shannon private knowledge for this turn (already included in `prompt`). */
  knowledgePrompt: string;
}

/** Stage after deterministic recall. Returning the input unchanged is always safe. */
export interface TurnMemoryRecall {
  /** Whether a turn will run the model-assisted stage (voice uses this to schedule a waiting phrase). */
  willSearch(input: Pick<TurnMemoryRecallInput, 'message' | 'memoryTurn'>): boolean;
  enrich(context: TurnCognitiveContext, input: TurnMemoryRecallInput): Promise<EnrichedTurnContext>;
  /** Owner-directed forgetting of Shannon knowledge cited in an inquiry answer; returns retired IDs. */
  retireKnowledge(scopeKey: string, ids: readonly string[], reason: string, at: string): readonly string[];
  /** Syzygy ADR-0008 stage 2, step 8: whether a voice turn of this class walks the tree (absent or false: as before). */
  walksTree?(conversationClass: string | undefined): boolean;
  /** Step 8: what the server knows of others present, which tree recall checks before and after each Jev call. */
  watchAudience?(watch: { othersKnown(scopeKey: string): boolean }): void;
  /** The memories nearest one text by embedding (`SemanticMemoryRecall.nearest`): a body task's candidates (`bodyTaskRecall.ts`). */
  nearest?: SemanticMemoryRecall['nearest'];
}

/** A voice turn's rerank cap when `SHANNON_VOICE_RERANK_TIMEOUT_MS` is unset or invalid. */
export const VOICE_RERANK_MILLISECONDS = 1_200;

const semanticGuidance = '[Semantic recall] Memories with cue "semantic" are search candidates, not confirmed facts. Use one only when its date and content fit the current message; if unsure, say so briefly or ask.';

export class ShannonTurnMemoryRecall implements TurnMemoryRecall {
  private audienceWatch: { othersKnown(scopeKey: string): boolean } | null = null;
  constructor(
    private readonly semantic: SemanticMemoryRecall,
    private readonly knowledge: ShannonKnowledgeStore | null = null,
    /** Syzygy ADR-0008 stage 2, step 8 (`SHANNON_TREE_RECALL`): absent, recall is what it was. */
    private readonly tree: TreeKnowledgeRecall | null = null,
    /** `voiceRerankMilliseconds`: the cap of a voice turn's rerank (`SHANNON_VOICE_RERANK_TIMEOUT_MS`); absent, 1,200. */
    private readonly options: { temporalKnowledge?: boolean; voiceRerankMilliseconds?: number } = {},
  ) {}

  walksTree(conversationClass: string | undefined): boolean { return this.tree?.walksTree(conversationClass) ?? false; }
  nearest(input: Parameters<SemanticMemoryRecall['nearest']>[0]): ReturnType<SemanticMemoryRecall['nearest']> { return this.semantic.nearest(input); }

  watchAudience(watch: { othersKnown(scopeKey: string): boolean }): void { this.audienceWatch = watch; this.tree?.watchAudience(watch); }

  willSearch(input: Pick<TurnMemoryRecallInput, 'message' | 'memoryTurn'>): boolean {
    return this.semantic.available && (input.memoryTurn ?? needsSemanticMemoryRecall(input.message));
  }

  async enrich(context: TurnCognitiveContext, input: TurnMemoryRecallInput): Promise<EnrichedTurnContext> {
    const ownerOnly = isOwnerOnly(context.present);
    // A note built from a turn that must not reach the model with these people present is left out with it.
    const gate = new DisclosureGate(context.present, input.snapshot, conversationStoreOf(this.knowledge), input.scopeKey);
    // Her notes carry no label of their own, so a turn that may show only open items gets none of them.
    const usable = (this.knowledge && !context.openOnly ? usableKnowledgeFor(this.knowledge, input.scopeKey, input.snapshot) : [])
      .filter(document => document.sourceExperienceIds.every(id => gate.allowsExperience(id)));
    const usableIds = new Set(usable.map(document => document.id));
    const outcome: SemanticRecallOutcome = this.willSearch(input) ? await this.semantic.recall({
      scopeKey: input.scopeKey, query: input.message, snapshot: input.snapshot, present: context.present,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      excludeIds: new Set(context.memories.map(memory => memory.id)),
      isEligible: candidate => candidate.kind !== 'knowledge' || usableIds.has(candidate.sourceId),
      ...(input.signal ? { signal: input.signal } : {}),
      // With the stage-2 recall (tree recall wired), a turn searches with the owner's own words: no rewrite call before the search
      // (voice since stage 2; text since the 2026-10-13 daily evals, where a memory question waited for rewrite, embedding and
      // rerank one after another before the model started). Without it, the recall requests stay those of ca7cf519
      // (`stage2SwitchedOffRecall.test.ts`).
      ...(this.tree ? { withoutRewrite: true } : {}),
      // A voice turn waits for its rerank at most this long; then the similarity order stands.
      ...(input.voiceClass !== undefined ? { rerankTimeoutMilliseconds: this.options.voiceRerankMilliseconds ?? VOICE_RERANK_MILLISECONDS } : {}),
    }) : { status: 'skipped', hits: [], modelCalls: 0, elapsedMilliseconds: 0 };
    // A hit with others present carries its marker at its start; with only open items allowed a marked one is left out whole.
    const experienceHits = outcome.hits.filter(hit => !hit.id.startsWith('knowledge:') && !(context.openOnly && hit.summary.includes('【機微:')));
    const memories = mergeSemanticMemories(context.memories, experienceHits);
    // Step 8: tree recall walks a text turn, and a voice turn of a `skill_*` class; with the owner alone also her skills and folder.
    const tree = this.tree && (input.voiceClass === undefined || this.tree.walksTree(input.voiceClass))
      ? { recall: this.tree, ownerAlone: ownerOnly && !context.openOnly, surface: input.voiceClass === undefined ? 'text' as const : 'voice' as const, usable } : undefined;
    const knowledge = this.knowledge && (usable.length || tree?.ownerAlone) ? await recallShannonKnowledge({
      // With tree recall configured luna never navigates a note: the beam does, or the deterministic sections stand.
      store: this.knowledge, gateway: this.tree ? null : this.semantic.modelGateway, scopeKey: input.scopeKey, message: input.message,
      snapshot: input.snapshot, semanticHits: outcome.hits, complexTurn: input.complexTurn === true,
      remainingModelCalls: Math.max(0, this.semantic.maximumModelCallsPerTurn - outcome.modelCalls),
      timeoutMilliseconds: this.semantic.timeoutMilliseconds,
      ...(input.signal ? { signal: input.signal } : {}), ...(tree ? { tree } : {}),
    }) : { ids: [], prompt: '', modelCalls: 0, documents: [] };
    // Shannon's notes are built from one-to-one talk and have no label of their own.
    if (!ownerOnly && knowledge.prompt) knowledge.prompt = `${UNLABELLED_DISCLOSURE_MARKER}\n${knowledge.prompt}`;
    // The inquiry frame says the owner is asking what she remembers: not for a turn someone else wrote (`openOnly`).
    const inquiry = isMemoryInquiry(input.message) && !context.openOnly ? inquiryPrompt(memories, knowledge.documents) : '';
    let temporalSourceIds: readonly string[] = [];
    const temporal = this.options.temporalKnowledge && this.knowledge ? temporalKnowledgePrompt({
      store: this.knowledge, scopeKey: input.scopeKey, message: input.message, present: context.present,
      ...(context.openOnly ? { openOnly: true } : {}), documents: knowledge.documents,
      ownerStillAlone: () => this.audienceWatch?.othersKnown(input.scopeKey) === false,
      observeSources: ids => { temporalSourceIds = ids; },
    }) : '';
    const supplemental = [memories.length > context.memories.length ? semanticGuidance : '', knowledge.prompt, inquiry, temporal]
      .filter(Boolean).join('\n\n');
    const enriched = supplemental || knowledge.ids.length
      ? withRecalledMemories(context, input.snapshot, memories, supplemental, [...new Set([...knowledge.ids, ...temporalSourceIds])]) : context;
    return {
      ...enriched,
      knowledgePrompt: knowledge.prompt,
      memoryRecall: {
        status: outcome.status, modelCalls: outcome.modelCalls + knowledge.modelCalls,
        elapsedMilliseconds: outcome.elapsedMilliseconds,
      },
    };
  }

  retireKnowledge(scopeKey: string, ids: readonly string[], reason: string, at: string): readonly string[] {
    if (!this.knowledge) return [];
    return ids.flatMap(id => this.knowledge!.retireShannonKnowledge(scopeKey, id.replace(/^knowledge:/u, ''), reason, at) ? [id] : []);
  }
}

/** 「〇〇について何を覚えてる？」: answer with provenance and say how to forget. */
function inquiryPrompt(memories: readonly ContextualMemory[], knowledge: readonly ShannonKnowledgeDocument[]): string {
  const lines = [
    ...memories.map(memory => `- ${memory.id.startsWith('thread:') ? '別の会話の要約' : '会話'} (${memory.observedAt.slice(0, 10)}): ${memory.summary.slice(0, 160)}`),
    ...knowledge.map(document => `- シャノン自身の${document.status === 'confirmed' ? '手順・教訓' : '仮説'}「${document.title}」`),
  ];
  return [
    '[Memory inquiry] The owner asks what Shannon remembers. Answer only from the items below and the recalled memories above, and cite each item\'s source (date and whether it is a conversation, another conversation\'s summary, or Shannon\'s own note or hypothesis). Do not add unremembered details.',
    lines.length ? lines.join('\n') : '- (該当する記憶なし) Say plainly that nothing relevant is remembered.',
    'Close by mentioning that saying 「それは忘れて」 will stop Shannon from using exactly these items.',
  ].join('\n');
}

/** Voice: a turn with model-assisted memory search is classified as taking more than three seconds. */
export function withMemorySearchLatency<T extends { latencyClass: 'under_1s' | 'under_3s' | 'under_10s' | 'over_10s' }>(decision: T): T {
  return decision.latencyClass === 'under_1s' || decision.latencyClass === 'under_3s'
    ? { ...decision, latencyClass: 'under_10s' } : decision;
}

export function createConfiguredTurnMemoryRecall(
  index: MemoryEmbeddingIndex & LlmUsageStore & ShannonKnowledgeStore,
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  gateway: MemoryModelGateway | null = configuredMemoryModelGateway(environment, index),
  /** Syzygy ADR-0008 stage 2, step 8: tree recall (`wiring/treeRecallWiring.ts`); null with `SHANNON_TREE_RECALL` off. */
  tree: TreeKnowledgeRecall | null = null,
): TurnMemoryRecall {
  const rerank = Number(environment.SHANNON_VOICE_RERANK_TIMEOUT_MS);
  const voiceRerankMilliseconds = Number.isInteger(rerank) && rerank >= 200 && rerank <= 15_000 ? rerank : VOICE_RERANK_MILLISECONDS;
  return new ShannonTurnMemoryRecall(new SemanticMemoryRecall(gateway, index, configuredSemanticMemoryConfig(environment)), index, tree,
    { temporalKnowledge: switchOn(environment, 'SHANNON_TEMPORAL_KNOWLEDGE_RECALL'), voiceRerankMilliseconds });
}

export function configuredMemoryModelGateway(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore?: LlmUsageStore,
): MemoryModelGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const reasoning = configuredResponseModel(environment, 'SHANNON_MEMORY_MODEL');
  const dimensions = Number(environment.SHANNON_MEMORY_EMBEDDING_DIMENSIONS);
  return new OpenAIMemoryModelGateway({
    apiKey,
    embeddingModel: environment.SHANNON_MEMORY_EMBEDDING_MODEL?.trim() || undefined,
    embeddingDimensions: Number.isInteger(dimensions) && dimensions >= 64 && dimensions <= 3_072 ? dimensions : undefined,
    reasoningModel: reasoning?.model ?? replacementModel(environment.SHANNON_MEMORY_MODEL),
    reasoningApiKey: reasoning?.apiKey ?? null,
    usageStore,
  });
}
