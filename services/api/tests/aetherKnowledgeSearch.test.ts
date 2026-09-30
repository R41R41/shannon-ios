import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aetherKnowledgeSearchRequest,
  aetherReferenceFromHit,
  FixtureAetherKnowledgeSearch,
  parseAetherKnowledgeSearchResponse,
} from '../src/aetherKnowledgeSearch.js';

const directory = new URL('./fixtures/aether-knowledge-search-v1/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as Record<string, unknown>;

describe('Aether knowledge search v1 consumer (Syzygy contract fixtures)', () => {
  it('accepts every valid response fixture and rejects every invalid response fixture', () => {
    const names = readdirSync(directory);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const payload = fixture(name);
      if (payload.kind !== 'response') continue;
      expect(parseAetherKnowledgeSearchResponse(payload) !== null, name).toBe(name.endsWith('.valid.json'));
    }
  });

  it('builds only read-only requests that match the valid request shape', () => {
    const valid = fixture('aether-knowledge-search.v1.request.valid.json');
    const request = aetherKnowledgeSearchRequest('音声待機文の方針', 5);
    expect(request).toMatchObject({ contract: valid.contract, kind: 'request', access: 'read-only', limit: 5 });
    expect(aetherKnowledgeSearchRequest('x', 99).limit).toBe(20);
    for (const name of ['aether-knowledge-search.v1.request.write-access.invalid.json', 'aether-knowledge-search.v1.stale-version.invalid.json']) {
      const invalid = fixture(name);
      expect(invalid.access === 'read-only' && invalid.contract === request.contract, name).toBe(false);
    }
  });

  it('keeps only document identity and version when Shannon references a hit', async () => {
    const search = new FixtureAetherKnowledgeSearch(fixture('aether-knowledge-search.v1.response.valid.json'));
    const [hit] = await search.search('音声待機文の方針');
    expect(hit?.excerpt).toBeTruthy();
    const reference = aetherReferenceFromHit(hit!);
    expect(reference).toEqual({ documentId: 'doc-fixture-voice-policy', version: 3, sectionId: 'sec-waiting-phrase', decisionId: 'dec-fixture-001' });
    expect(JSON.stringify(reference)).not.toContain(hit!.excerpt);
    expect(search.requests[0]).toMatchObject({ access: 'read-only' });
  });

  it('fails closed on an invalid provider response', async () => {
    const search = new FixtureAetherKnowledgeSearch(fixture('aether-knowledge-search.v1.response.whole-document.invalid.json'));
    expect(await search.search('音声')).toEqual([]);
  });
});
