import { filterMeaningfulInterests } from '@shannon/cognition';
import { topicMatchesSource } from '../../../integrations/world/worldInterestRelevance.js';
import {
  isRepeatedWorldSignal,
  recentSignalCutoff,
  sourceDiversityAdjustment,
  type RecentWorldSignal,
} from '../../../integrations/world/worldSignalQuality.js';
export { isRepeatedWorldSignal, recentSignalCutoff } from '../../../integrations/world/worldSignalQuality.js';
export type { RecentWorldSignal } from '../../../integrations/world/worldSignalQuality.js';

const CANDIDATE_MAX_AGE_MILLISECONDS = 48 * 60 * 60_000;

export interface CompanionStateShape {
  version?: number;
  interests?: unknown;
  temperament?: { initiative?: unknown };
  emotion?: { valence?: unknown; arousal?: unknown; openness?: unknown };
}

export interface CandidateRow {
  item_id: string;
  source_id: string;
  source_title: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
  discovered_at: string;
}

/**
 * The initiative loop is deliberately code-only. It decides whether Shannon
 * should speak, persists the result in the conversation, and never invokes an
 * LLM. This keeps browsing and spontaneous behavior outside the chat budget.
 */

export function selectCandidate(
  candidates: readonly CandidateRow[],
  recentSignals: readonly RecentWorldSignal[],
  interest: string | null,
  initiative: number,
  at: string,
  /** eff of each candidate's topic against her recent messages (Syzygy ADR-0008 stage 3's gate): its score × (1 − eff). Absent: 0. */
  topicReuse?: (candidate: CandidateRow) => number,
): (CandidateRow & { score: number }) | null {
  const ranked = candidates.map(candidate => {
    const base = candidateScore(candidate, interest, initiative, at) + sourceDiversityAdjustment(signalCandidate(candidate), recentSignals);
    const reuse = topicReuse ? Math.min(1, Math.max(0, topicReuse(candidate) || 0)) : 0;
    return { ...candidate, score: round(reuse ? base * (1 - reuse) : base) };
  }).sort((left, right) => right.score - left.score || right.discovered_at.localeCompare(left.discovered_at));
  return (ranked[0]?.score ?? 0) >= 0.56 ? ranked[0]! : null;
}

export function candidateScore(candidate: CandidateRow, interest: string | null, initiative: number, at: string): number {
  const discoveredAt = Date.parse(candidate.discovered_at);
  const publishedAt = candidate.published_at ? Date.parse(candidate.published_at) : discoveredAt;
  // A newly discovered old feed entry is eligible near the 48-hour boundary,
  // but it must not receive the freshness of its later ingestion time.
  const effectiveAt = Number.isFinite(publishedAt) ? Math.min(discoveredAt, publishedAt) : discoveredAt;
  const age = Math.max(0, Date.parse(at) - effectiveAt);
  const freshness = Math.max(0, 1 - age / CANDIDATE_MAX_AGE_MILLISECONDS);
  const interestScore = topicMatchesSource(interest, candidate.title, candidate.summary ?? '') ? 1 : 0;
  const contextScore = (candidate.summary?.trim().length ?? 0) >= 80 ? 0.12
    : (candidate.summary?.trim().length ?? 0) >= 24 ? 0.09 : 0.05;
  return round(0.34 + freshness * 0.12 + contextScore + Math.min(1, Math.max(0, initiative)) * 0.08 + interestScore * 0.46);
}

export function signalCandidate(candidate: CandidateRow) {
  return {
    sourceId: candidate.source_id,
    sourceTitle: candidate.source_title,
    title: candidate.title,
    url: candidate.url,
  };
}

export function firstInterest(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = filterMeaningfulInterests(value)[0];
  return typeof first === 'string' ? first.trim().slice(0, 80) : null;
}

export function interestTokens(value: string | null): string[] {
  if (!value) return [];
  const normalized = normalize(value);
  const split = normalized.split(/[\s、,・/]+/u).filter(token => token.length >= 2);
  return [...new Set([normalized, ...split])].slice(0, 8);
}

export function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

export function parseState(value: string): CompanionStateShape {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CompanionStateShape : {};
  } catch {
    return {};
  }
}

export function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

export function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function truncate(value: string, maximum: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}
