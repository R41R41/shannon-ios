import type { ContextualMemory } from './runtime.js';

/**
 * Text-turn classifier equivalent to the voice `conversation_memory`
 * capability floor. It decides whether a turn may add the model-assisted
 * semantic recall stage; deterministic recall always runs regardless.
 * Keep `apps/ios/Tests/.../memory-recall-cues.json` in sync (shared fixture).
 */
const MEMORY_RECALL_CUE = /(?:覚えて|おぼえて|忘れて|前に|以前|この前|前回|あの時|あのとき|約束|好み|私の|僕の|ボクの|過去の会話|思い出|目標|目的|続き|踏まえて|今まで|何だっけ|なんだっけ|だったっけ|どうしたっけ|いつだった|どう決めた|なぜ決めた|何を決めた|理由は|経緯|について何を|知ってる[?？]?$|っけ[?？。]?$)/iu;

export function needsSemanticMemoryRecall(text: string): boolean {
  const normalized = text.normalize('NFKC').trim();
  return normalized.length >= 2 && MEMORY_RECALL_CUE.test(normalized);
}

export interface SemanticRecallHit {
  id: string;
  summary: string;
  observedAt: string;
  /** Model-assigned relevance after reranking, 0..1. */
  relevance: number;
}

/**
 * Deterministic results keep their order and are never displaced. Semantic
 * hits are appended as additional, explicitly labelled candidates. A failed or
 * timed-out semantic stage passes an empty list and yields the deterministic
 * result unchanged.
 */
export function mergeSemanticMemories(
  deterministic: readonly ContextualMemory[],
  semantic: readonly SemanticRecallHit[],
  maximumAdditional = 3,
  minimumRelevance = 0.5,
): readonly ContextualMemory[] {
  const known = new Set(deterministic.map(memory => memory.id));
  const additional = semantic
    .filter(hit => !known.has(hit.id) && Number.isFinite(hit.relevance) && hit.relevance >= minimumRelevance)
    .filter((hit, index, rows) => rows.findIndex(row => row.id === hit.id) === index)
    .sort((left, right) => right.relevance - left.relevance || right.observedAt.localeCompare(left.observedAt))
    .slice(0, Math.max(0, maximumAdditional))
    .map((hit): ContextualMemory => Object.freeze({
      id: hit.id,
      summary: hit.summary,
      observedAt: hit.observedAt,
      relevance: Math.min(1, Math.max(0, hit.relevance)),
      reasons: Object.freeze(['semantic'] as const),
    }));
  return Object.freeze([...deterministic, ...additional]);
}
