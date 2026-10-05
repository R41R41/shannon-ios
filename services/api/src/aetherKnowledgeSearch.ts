import type { AetherDecisionReference } from '@shannon/cognition';

/**
 * Consumer adapter for Syzygy contract `syzygy.aether-knowledge-search.v1`
 * (Syzygy hub `contracts/knowledge/`). Read-only, section-level, versioned.
 * Her tool `aether.search` sends this envelope through `aetherAccess.ts` (Syzygy
 * `syzygy.aether-shannon-access.v1`), with the optional `scope` and the optional
 * placement of each hit (`inShannonFolder`, `inStudy`) added on 2026-10-06.
 */
export const AETHER_KNOWLEDGE_SEARCH_CONTRACT = 'syzygy.aether-knowledge-search.v1';

export interface AetherKnowledgeSearchRequest {
  contract: typeof AETHER_KNOWLEDGE_SEARCH_CONTRACT;
  kind: 'request';
  access: 'read-only';
  query: string;
  limit: number;
  documentIds?: readonly string[];
  resourceTypes?: readonly ('document' | 'decision')[];
  /** Optional (2026-10-06): `shannonFolder` limits hits to シャノン用フォルダ, `study` to her stories in it. Default `all`. */
  scope?: AetherSearchScope;
}

export type AetherSearchScope = 'all' | 'shannonFolder' | 'study';

export interface AetherSectionHit {
  documentId: string;
  version: number;
  sectionId: string;
  headingPath: readonly string[];
  excerpt: string;
  updatedAt: string;
  href: string;
  resourceType?: 'document' | 'decision';
  decisionId?: string;
  title?: string;
  score?: number;
  /** Optional (2026-10-06): the document is in シャノン用フォルダ. Absent counts as outside it. */
  inShannonFolder?: boolean;
  /** Optional (2026-10-06): the document is in シャノンの書斎 (tag 書斎 inside シャノン用フォルダ). */
  inStudy?: boolean;
}

export interface AetherKnowledgeSearch {
  search(query: string, limit?: number): Promise<readonly AetherSectionHit[]>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HIT_KEYS = new Set(['documentId', 'version', 'sectionId', 'headingPath', 'excerpt', 'updatedAt', 'href', 'resourceType', 'decisionId', 'title', 'score', 'inShannonFolder', 'inStudy']);

export function aetherKnowledgeSearchRequest(query: string, limit = 5, scope?: AetherSearchScope): AetherKnowledgeSearchRequest {
  return Object.freeze({
    contract: AETHER_KNOWLEDGE_SEARCH_CONTRACT, kind: 'request', access: 'read-only',
    query: query.trim().slice(0, 500), limit: Math.max(1, Math.min(20, Math.floor(limit))),
    ...(scope && scope !== 'all' ? { scope } : {}),
  });
}

/** Fails closed: any contract violation rejects the whole response. */
export function parseAetherKnowledgeSearchResponse(value: unknown): readonly AetherSectionHit[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.contract !== AETHER_KNOWLEDGE_SEARCH_CONTRACT || body.kind !== 'response' || body.access !== 'read-only'
    || typeof body.generatedAt !== 'string' || !Array.isArray(body.results) || body.results.length > 20
    || Object.keys(body).some(key => !['contract', 'kind', 'access', 'generatedAt', 'results'].includes(key))) return null;
  const hits: AetherSectionHit[] = [];
  for (const raw of body.results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const hit = raw as Record<string, unknown>;
    if (Object.keys(hit).some(key => !HIT_KEYS.has(key))) return null;
    if (typeof hit.documentId !== 'string' || !IDENTIFIER.test(hit.documentId)
      || typeof hit.sectionId !== 'string' || !IDENTIFIER.test(hit.sectionId)
      || !Number.isSafeInteger(hit.version) || (hit.version as number) < 1
      || !Array.isArray(hit.headingPath) || hit.headingPath.length < 1 || hit.headingPath.length > 8
      || !hit.headingPath.every(item => typeof item === 'string' && item.length >= 1 && item.length <= 200)
      || typeof hit.excerpt !== 'string' || hit.excerpt.length < 1 || hit.excerpt.length > 1_200
      || typeof hit.updatedAt !== 'string' || typeof hit.href !== 'string' || !hit.href.startsWith('aether://')
      || (hit.inShannonFolder !== undefined && typeof hit.inShannonFolder !== 'boolean')
      || (hit.inStudy !== undefined && typeof hit.inStudy !== 'boolean')) return null;
    hits.push(Object.freeze({ ...hit, headingPath: Object.freeze([...hit.headingPath as string[]]) }) as unknown as AetherSectionHit);
  }
  return Object.freeze(hits);
}

/**
 * The only thing Shannon may persist from a hit: identity and version.
 * The excerpt is usable for the current turn only.
 */
export function aetherReferenceFromHit(hit: AetherSectionHit): AetherDecisionReference {
  return Object.freeze({
    documentId: hit.documentId, version: hit.version, sectionId: hit.sectionId,
    ...(hit.decisionId ? { decisionId: hit.decisionId } : {}),
  });
}

/** Fake provider backed by a contract fixture. It never performs network I/O. */
export class FixtureAetherKnowledgeSearch implements AetherKnowledgeSearch {
  readonly requests: AetherKnowledgeSearchRequest[] = [];

  constructor(private readonly response: unknown) {}

  async search(query: string, limit = 5): Promise<readonly AetherSectionHit[]> {
    this.requests.push(aetherKnowledgeSearchRequest(query, limit));
    return (parseAetherKnowledgeSearchResponse(this.response) ?? []).slice(0, limit);
  }
}

export class DisabledAetherKnowledgeSearch implements AetherKnowledgeSearch {
  async search(): Promise<readonly AetherSectionHit[]> { return []; }
}
