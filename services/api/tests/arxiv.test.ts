import { describe, expect, it } from 'vitest';
import { parseArxivFeed, prepareArxivQuery } from '../src/integrations/world/arxiv.js';

describe('arXiv source adapter', () => {
  it('asks the official API for the newest submissions in a bounded page', () => {
    const url = prepareArxivQuery('https://export.arxiv.org/api/query', 'all:AI agents');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search_query: 'all:AI agents', start: '0', max_results: '10',
      sortBy: 'submittedDate', sortOrder: 'descending',
    });
  });

  it('keeps canonical papers, abstracts, and a bounded author list', () => {
    const items = parseArxivFeed(`
      <feed><entry>
        <id>http://arxiv.org/abs/2609.01234v2</id>
        <published>2026-09-10T12:00:00Z</published><updated>2026-09-11T12:00:00Z</updated>
        <title>Reliable agents</title><summary>Research abstract.</summary>
        <author><name>Alice</name></author><author><name>Bob</name></author>
        <author><name>Carol</name></author><author><name>Dave</name></author>
        <link rel="alternate" href="http://arxiv.org/abs/2609.01234v2" />
      </entry></feed>
    `, new URL('https://export.arxiv.org/api/query'));

    expect(items).toEqual([{
      externalId: '2609.01234v2', title: 'Reliable agents', url: 'https://arxiv.org/abs/2609.01234v2',
      summary: 'Research abstract.', author: 'Alice, Bob, Carol ほか', publishedAt: '2026-09-10T12:00:00.000Z',
    }]);
  });

  it('rejects API error entries, foreign identifiers, and missing publication time', () => {
    const items = parseArxivFeed(`
      <feed>
        <entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title><updated>2026-09-11T00:00:00Z</updated><link href="http://arxiv.org/api/errors#bad" /></entry>
        <entry><id>https://example.com/abs/2609.01234</id><title>Foreign</title><published>2026-09-11T00:00:00Z</published><link href="https://example.com/abs/2609.01234" /></entry>
        <entry><id>http://arxiv.org/abs/2609.01235</id><title>Undated</title><link href="http://arxiv.org/abs/2609.01235" /></entry>
        <entry><id>http://arxiv.org/abs/2699.01236</id><title>Bad month</title><published>2026-09-11T00:00:00Z</published><link href="http://arxiv.org/abs/2699.01236" /></entry>
      </feed>
    `, new URL('https://export.arxiv.org/api/query'));
    expect(items).toEqual([]);
  });
});
