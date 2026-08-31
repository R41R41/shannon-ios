import type { ActiveMemory } from './types.js';

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
