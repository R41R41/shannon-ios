import type { ActiveMemory } from './types.js';
import type { ContextualMemory, ShannonMemoryQuery, ShannonRecallReason } from './runtime.js';

export interface RecallCandidate {
  id: string;
  summary: string;
  observedAt: string;
}

function normalizedPieces(value: string): Set<string> {
  const text = value.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 1_000);
  const pieces = new Set<string>();
  for (const word of text.match(/[a-z0-9]{2,}|[ぁ-んァ-ヶ一-龠]{2,}/gu) ?? []) {
    pieces.add(word);
  }
  const compact = text.replace(/[\s\p{P}\p{S}]/gu, '');
  for (let index = 0; index < compact.length - 1; index += 1) {
    pieces.add(compact.slice(index, index + 2));
  }
  return pieces;
}

export function scoreMemoryRelevance(query: string, summary: string, recency: number): number {
  const queryPieces = normalizedPieces(query);
  const memoryPieces = normalizedPieces(summary);
  if (!queryPieces.size || !memoryPieces.size) return 0;
  let overlap = 0;
  for (const piece of queryPieces) if (memoryPieces.has(piece)) overlap += 1;
  const containment = overlap / Math.max(1, Math.min(queryPieces.size, memoryPieces.size));
  const boundedRecency = Math.max(0, Math.min(1, recency));
  return Math.min(1, containment * 0.88 + boundedRecency * 0.12);
}

export function selectActiveMemories(
  query: string,
  candidates: readonly RecallCandidate[],
  maximum = 3,
): ActiveMemory[] {
  if (maximum < 1) return [];
  const total = Math.max(1, candidates.length);
  return candidates
    .map((candidate, index) => ({
      id: candidate.id,
      summary: candidate.summary,
      observedAt: candidate.observedAt,
      relevance: scoreMemoryRelevance(query, candidate.summary, (index + 1) / total),
    }))
    .filter(memory => memory.relevance >= 0.18)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maximum);
}

function overlapRatio(left: string, right: string): number {
  const leftPieces = normalizedPieces(left);
  const rightPieces = normalizedPieces(right);
  if (!leftPieces.size || !rightPieces.size) return 0;
  let overlap = 0;
  for (const piece of leftPieces) if (rightPieces.has(piece)) overlap += 1;
  return overlap / Math.max(1, Math.min(leftPieces.size, rightPieces.size));
}

function matchingContext(values: readonly string[] | undefined, summary: string): number {
  return Math.max(0, ...(values ?? []).map(value => overlapRatio(value, summary)));
}

/** Small, auditable vocabulary normalization; not an embedding/semantic model. */
function relatedTerms(value: string): string {
  return value.normalize('NFKC')
    .replace(/画像|フォト/gu, '写真')
    .replace(/整頓|片付け|片づけ/gu, '整理')
    .replace(/友達|友だち/gu, '友人')
    .replace(/乗り換え|乗換え|乗換/gu, '乗換')
    .replace(/todo|to-do|やること/giu, 'タスク');
}

/**
 * Selects memories for the turn that is about to be answered. Unlike the
 * legacy active-memory projection this accepts situation cues and explains
 * why every memory surfaced. It is pure and does not mutate shared state.
 */
export function selectContextualMemories(
  query: ShannonMemoryQuery,
  candidates: readonly RecallCandidate[],
  maximum = 5,
): ContextualMemory[] {
  if (maximum < 1) return [];
  const now = Date.parse(query.occurredAt);
  return candidates
    .map((candidate): ContextualMemory => {
      const age = now - Date.parse(candidate.observedAt);
      const recency = Number.isFinite(age) && age >= 0 ? Math.exp(-age / (30 * 86_400_000)) : 0;
      const exactWords = overlapRatio(query.text, candidate.summary);
      const expandedWords = overlapRatio(relatedTerms(query.text), relatedTerms(candidate.summary)) * 0.85;
      const words = Math.max(exactWords, expandedWords);
      const participant = matchingContext(query.participants, candidate.summary);
      const location = matchingContext(query.locationLabels, candidate.summary);
      const goal = query.goal ? overlapRatio(query.goal, candidate.summary) : 0;
      const reasons: ShannonRecallReason[] = [];
      if (words >= 0.08) reasons.push('words');
      if (expandedWords > exactWords + 0.1) reasons.push('related-terms');
      if (participant >= 0.16) reasons.push('participant');
      if (location >= 0.16) reasons.push('location');
      if (goal >= 0.12) reasons.push('goal');
      if (recency >= 0.8) reasons.push('recent');
      const contextual = Math.max(participant, location, goal);
      const relevance = Math.min(1, words * 0.68 + contextual * 0.22 + recency * 0.10);
      return Object.freeze({
        id: candidate.id,
        summary: candidate.summary,
        observedAt: candidate.observedAt,
        relevance,
        reasons: Object.freeze(reasons),
      });
    })
    .filter(memory => memory.relevance >= 0.16 && memory.reasons.some(reason => reason !== 'recent'))
    .sort((left, right) => right.relevance - left.relevance || right.observedAt.localeCompare(left.observedAt))
    .slice(0, maximum);
}

const INTEREST_STOP_WORDS = new Set(['これ', 'それ', 'あれ', '今日', '昨日', '明日', '続き', 'こと', 'もの', '感じ', '気持ち']);

/** A topic becomes Shannon's interest only when the current input resonates with recalled experience. */
export function deriveResonantInterest(
  query: string,
  recalledMemories: readonly Pick<ActiveMemory, 'summary'>[],
): string | null {
  if (!recalledMemories.length) return null;
  const remembered = recalledMemories.map(memory => memory.summary.toLowerCase()).join('\n');
  const candidates = query
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .split(/[のをにはがでともへや]|\s+/u)
    .map(value => value.trim())
    .filter(value => value.length >= 2 && value.length <= 24 && !INTEREST_STOP_WORDS.has(value));
  return candidates
    .filter(candidate => remembered.includes(candidate))
    .sort((a, b) => b.length - a.length)[0] ?? null;
}
