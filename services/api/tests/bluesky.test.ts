import { describe, expect, it } from 'vitest';
import { parseBlueskyPosts } from '../src/bluesky.js';

describe('Bluesky response boundary', () => {
  it('creates a post permalink with author and creation time', () => {
    expect(parseBlueskyPosts({ posts: [{
      uri: 'at://did:plc:alice/app.bsky.feed.post/3abc',
      author: { did: 'did:plc:alice', handle: 'Alice.Example', displayName: ' Alice  Example ' },
      record: { text: 'A useful post\nwith context', createdAt: '2026-09-11T01:02:03Z' },
      indexedAt: '2026-09-11T01:03:00Z',
    }] })).toEqual([{
      externalId: 'at://did:plc:alice/app.bsky.feed.post/3abc',
      title: 'A useful post with context',
      url: 'https://bsky.app/profile/did:plc:alice/post/3abc',
      summary: 'A useful post\nwith context',
      author: 'Alice Example (@alice.example)',
      publishedAt: '2026-09-11T01:02:03.000Z',
    }]);
  });

  it('uses indexed time only when the record time is invalid', () => {
    expect(parseBlueskyPosts({ posts: [{
      uri: 'at://did:plc:bob/app.bsky.feed.post/key',
      author: { did: 'did:plc:bob', handle: 'bob.example' },
      record: { text: 'Post', createdAt: 'invalid' },
      indexedAt: '2026-09-10T10:00:00+09:00',
    }] })[0]).toMatchObject({ author: '@bob.example', publishedAt: '2026-09-10T01:00:00.000Z' });
  });

  it('rejects malformed, mismatched, labeled, empty, and duplicate posts', () => {
    const valid = {
      uri: 'at://did:plc:good/app.bsky.feed.post/one',
      author: { did: 'did:plc:good', handle: 'good.example' },
      record: { text: 'Good post', createdAt: '2026-09-11T00:00:00Z' },
    };
    expect(parseBlueskyPosts({ posts: [
      valid,
      valid,
      { ...valid, uri: 'https://example.com/post' },
      { ...valid, author: { did: 'did:plc:other', handle: 'good.example' } },
      { ...valid, author: { did: 'did:plc:good', handle: 'not a handle' } },
      { ...valid, labels: [{ val: 'graphic-media' }] },
      { ...valid, author: { ...valid.author, labels: [{ val: 'sexual' }] } },
      { ...valid, record: { ...valid.record, labels: { values: [{ val: 'nudity' }] } } },
      { ...valid, record: { text: 'Undated post', createdAt: 'invalid' }, indexedAt: 'invalid' },
      { ...valid, record: { text: '   ' } },
    ] })).toEqual([expect.objectContaining({ externalId: valid.uri })]);
  });

  it('allows bot labels and respects an explicit label negation', () => {
    const base = {
      author: { did: 'did:plc:safe', handle: 'safe.example' },
      record: { text: 'Safe post', createdAt: '2026-09-11T00:00:00Z' },
    };
    expect(parseBlueskyPosts({ posts: [
      { ...base, uri: 'at://did:plc:safe/app.bsky.feed.post/bot', labels: [{ val: 'bot' }] },
      { ...base, uri: 'at://did:plc:safe/app.bsky.feed.post/negated', labels: [{ val: 'sexual' }, { val: 'sexual', neg: true }] },
    ] })).toHaveLength(2);
  });

  it('truncates titles by Unicode code point rather than splitting characters', () => {
    const body = `${'😀'.repeat(120)}tail`;
    const item = parseBlueskyPosts({ posts: [{
      uri: 'at://did:plc:emoji/app.bsky.feed.post/key',
      author: { did: 'did:plc:emoji', handle: 'emoji.example' },
      record: { text: body, createdAt: '2026-09-11T00:00:00Z' },
    }] })[0]!;
    expect([...item.title]).toHaveLength(120);
    expect(item.title).toBe('😀'.repeat(120));
  });
});
