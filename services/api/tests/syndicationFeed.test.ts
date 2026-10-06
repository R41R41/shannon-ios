import { describe, expect, it } from 'vitest';
import { parseSyndicationFeed } from '../src/integrations/world/syndicationFeed.js';

describe('syndication feed parsing', () => {
  it('normalizes official Japanese RSS metadata and relative links', () => {
    const items = parseSyndicationFeed(`
      <rss><channel><item>
        <title>政策 &amp; 更新</title>
        <link>/news/update#detail</link>
        <description><![CDATA[<p>暮らしに関わる更新です。</p>]]></description>
        <dc:creator>デジタル庁</dc:creator>
        <dc:date>2026-09-11T11:45:36+09:00</dc:date>
        <guid>item-1</guid>
      </item></channel></rss>
    `, new URL('https://www.digital.go.jp/rss/news.xml'));

    expect(items).toEqual([{
      externalId: 'item-1',
      title: '政策 & 更新',
      url: 'https://www.digital.go.jp/news/update',
      summary: '暮らしに関わる更新です。',
      author: 'デジタル庁',
      publishedAt: '2026-09-11T02:45:36.000Z',
    }]);
  });

  it('keeps Atom support and rejects unsafe item destinations', () => {
    const items = parseSyndicationFeed(`
      <feed>
        <entry><id>safe</id><title>Safe</title><link rel="self" href="https://example.com/feed.xml"/><link rel="alternate" href="https://example.com/a"/><updated>2026-09-10T00:00:00Z</updated></entry>
        <entry><id>unsafe</id><title>Unsafe</title><link href="javascript:alert(1)"/></entry>
        <entry><id>credential</id><title>Credential</title><link href="https://user:secret@example.com/a"/></entry>
        <entry><id>private</id><title>Private</title><link href="http://127.0.0.1/admin"/></entry>
        <entry><id>mapped</id><title>Mapped private</title><link href="http://[::ffff:7f00:1]/admin"/></entry>
        <entry><id>local-dot</id><title>Local trailing dot</title><link href="http://localhost./admin"/></entry>
      </feed>
    `, new URL('https://example.com/feed.xml'));

    expect(items).toEqual([expect.objectContaining({
      externalId: 'safe', url: 'https://example.com/a', publishedAt: '2026-09-10T00:00:00.000Z',
    })]);
  });

  it('can keep a configured official feed focused on useful categories', () => {
    const unrelated = Array.from({ length: 16 }, (_, index) => `
      <item><guid>bid-${index}</guid><title>一般競争入札 ${index}</title><link>/procurement/${index}</link><category>調達情報</category></item>
    `).join('');
    const items = parseSyndicationFeed(`
      <rss><channel>
        ${unrelated}
        <item><guid>policy</guid><title>制度の更新</title><link>/news/policy</link><category term="政策"/></item>
      </channel></rss>
    `, new URL('https://www.digital.go.jp/rss/news.xml'), {
      allowedCategories: ['報道発表', '政策'],
    });

    expect(items.map(item => item.externalId)).toEqual(['policy']);
  });
});
