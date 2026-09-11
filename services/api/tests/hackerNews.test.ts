import { describe, expect, it } from 'vitest';
import { parseHackerNewsItems, parseHackerNewsTopIds } from '../src/hackerNews.js';

describe('Hacker News source adapter', () => {
  it('keeps only distinct positive integer top story ids', () => {
    expect(parseHackerNewsTopIds([42, 42, -1, 2.5, '43', 43])).toEqual([42, 43]);
    expect(parseHackerNewsTopIds({ ids: [42] })).toEqual([]);
  });

  it('keeps valid live stories in requested order with response context', () => {
    const items = parseHackerNewsItems([
      { id: 43, type: 'story', title: 'Second', by: 'bob', time: 1_700_000_001, score: 12, descendants: 3, url: 'https://example.com/b#part' },
      { id: 42, type: 'story', title: 'A &amp; <b>safe</b> title', by: 'alice', time: 1_700_000_000, score: 120, descendants: 45, url: 'https://example.com/a' },
    ], [42, 43]);

    expect(items).toEqual([
      {
        externalId: '42', title: 'A & safe title', url: 'https://example.com/a',
        summary: '120 points・45 comments', author: 'alice', publishedAt: '2023-11-14T22:13:20.000Z',
      },
      expect.objectContaining({ externalId: '43', url: 'https://example.com/b' }),
    ]);
  });

  it('fails closed for deleted, dead, non-story, mismatched, or undated items', () => {
    const rows = [
      { id: 1, type: 'story', title: 'Deleted', time: 1_700_000_000, deleted: true },
      { id: 2, type: 'story', title: 'Dead', time: 1_700_000_000, dead: true },
      { id: 3, type: 'job', title: 'Job', time: 1_700_000_000 },
      { id: 4, type: 'story', title: 'No date' },
      { id: 99, type: 'story', title: 'Wrong response', time: 1_700_000_000 },
    ];
    expect(parseHackerNewsItems(rows, [1, 2, 3, 4, 5])).toEqual([]);
  });

  it('falls back to the canonical discussion for an unsafe article URL', () => {
    expect(parseHackerNewsItems([{
      id: 42, type: 'story', title: 'Internal link', time: 1_700_000_000, url: 'http://127.0.0.1/admin',
    }], [42])).toEqual([expect.objectContaining({ url: 'https://news.ycombinator.com/item?id=42' })]);
  });
});
