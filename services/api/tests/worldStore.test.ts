import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverFeedLinks, SQLiteWorldStore } from '../src/worldStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('autonomous world store', () => {
  it('seeds only approved sources and stores fetched items idempotently', () => {
    const path = databasePath();
    const now = '2026-09-02T00:00:00.000Z';
    const store = new SQLiteWorldStore(path, () => now);
    const sources = store.dueSources(now);
    expect(sources.map(source => source.kind)).toEqual(expect.arrayContaining([
      'weather', 'hacker-news', 'arxiv', 'pubmed', 'rss',
    ]));
    expect(sources.map(source => source.kind)).not.toContain('mastodon');
    expect(sources).toContainEqual(expect.objectContaining({
      id: 'digital:news',
      title: 'デジタル庁・報道発表／政策',
      url: 'https://www.digital.go.jp/rss/news.xml',
      query: 'categories:報道発表|政策',
    }));
    const source = sources[0]!;
    expect(store.recordSuccess(source, [{ externalId: 'same', title: '記事', url: 'https://example.com/a' }], now)).toBe(1);
    expect(store.recordSuccess(source, [{ externalId: 'same', title: '記事', url: 'https://example.com/a' }], now)).toBe(0);
    expect(store.latestItems()).toEqual([
      expect.objectContaining({ title: '記事', sourceTitle: source.title }),
    ]);
    expect(store.sources()).toContainEqual(expect.objectContaining({
      id: source.id,
      enabled: true,
      lastRunAt: now,
      hasError: false,
      fetchedItemCount: 1,
      origin: 'built-in',
    }));
    const failedSource = sources.find(candidate => candidate.id !== source.id)!;
    store.recordFailure(failedSource, 'INTERNAL_UPSTREAM_DETAIL', now);
    const failedSummary = store.sources().find(candidate => candidate.id === failedSource.id)!;
    expect(failedSummary).toMatchObject({ hasError: true, lastRunAt: now });
    expect(JSON.stringify(failedSummary)).not.toContain('INTERNAL_UPSTREAM_DETAIL');
    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('SELECT COUNT(*) AS count FROM world_items').get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_events WHERE activity_type = 'world'").get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM observations').get()).toEqual({ count: 1 });
    database.close();
  });

  it('pauses an expired RSS trial that produced no useful items', () => {
    const path = databasePath();
    const store = new SQLiteWorldStore(path, () => '2026-09-02T00:00:00.000Z');
    store.addTrialSubscription('https://blog.example/feed.xml', 'Example', '自分で発見');
    expect(store.reviewExpiredTrials('2026-09-10T00:00:00.000Z')).toEqual({ activated: 0, paused: 1 });
    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('SELECT status FROM subscriptions WHERE feed_url = ?').get('https://blog.example/feed.xml')).toEqual({ status: 'paused' });
    expect(database.prepare("SELECT enabled FROM world_sources WHERE url = 'https://blog.example/feed.xml'").get()).toEqual({ enabled: 0 });
    database.close();
  });

  it('keeps a discovered feed disabled until the user approves its trial', () => {
    const path = databasePath();
    const discoveredAt = '2026-09-02T00:00:00.000Z';
    const approvedAt = '2026-09-03T00:00:00.000Z';
    const store = new SQLiteWorldStore(path, () => discoveredAt);

    expect(store.proposeSubscription(
      'https://blog.example/feed.xml',
      'Example',
      'Hacker Newsから見つけた',
    )).toBe(true);
    const proposal = store.subscriptions()[0]!;
    expect(proposal).toMatchObject({
      title: 'Example',
      status: 'paused',
      approval: 'pending',
      fetchedItemCount: 0,
    });
    expect(store.dueSources(discoveredAt).some(source => source.url === proposal.feedURL)).toBe(false);

    const approved = store.decideSubscription(proposal.id, 'approve', proposal.updatedAt, approvedAt);
    expect(approved).toMatchObject({ status: 'trial', approval: 'approved' });
    expect(store.dueSources(approvedAt).some(source => source.url === proposal.feedURL)).toBe(true);
    expect(store.sources()).toContainEqual(expect.objectContaining({
      id: `rss:${proposal.id}`,
      enabled: true,
      fetchedItemCount: 0,
      origin: 'approved-subscription',
    }));
    expect(() => store.decideSubscription(proposal.id, 'reject', proposal.updatedAt, approvedAt))
      .toThrow('WORLD_SUBSCRIPTION_ALREADY_DECIDED');
    store.close();
  });

  it('rejects a subscription proposal without creating an RSS source', () => {
    const now = '2026-09-02T00:00:00.000Z';
    const store = new SQLiteWorldStore(databasePath(), () => now);
    expect(store.proposeSubscription('https://no.example/feed', 'No', '発見')).toBe(true);
    const proposal = store.subscriptions()[0]!;
    const rejected = store.decideSubscription(proposal.id, 'reject', proposal.updatedAt);
    expect(rejected).toMatchObject({ status: 'rejected', approval: 'rejected' });
    expect(store.dueSources(now).some(source => source.url === proposal.feedURL)).toBe(false);
    store.close();
  });

  it('adds approval state to existing subscription databases without losing rows', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE subscriptions (
        subscription_id TEXT PRIMARY KEY,
        feed_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('trial','active','paused','rejected')),
        reason TEXT NOT NULL,
        trial_started_at TEXT NOT NULL,
        trial_expires_at TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO subscriptions VALUES (
        'existing', 'https://existing.example/feed', 'Existing', 'active', '以前に承認済み',
        '2026-08-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 1,
        '2026-08-08T00:00:00.000Z'
      );
    `);
    database.close();

    const store = new SQLiteWorldStore(path, () => '2026-09-02T00:00:00.000Z');
    expect(store.subscriptions()).toEqual([
      expect.objectContaining({ id: 'existing', approval: 'approved', status: 'active' }),
    ]);
    store.close();
  });

  it('limits self-discovered RSS trials to one per week and three at once', () => {
    const store = new SQLiteWorldStore(databasePath(), () => '2026-09-02T00:00:00.000Z');
    expect(store.addTrialSubscription('https://one.example/feed', 'One', '発見', '2026-09-01T00:00:00.000Z')).toBe(true);
    expect(store.addTrialSubscription('https://too-soon.example/feed', 'Too soon', '発見', '2026-09-02T00:00:00.000Z')).toBe(false);
    expect(store.addTrialSubscription('https://two.example/feed', 'Two', '発見', '2026-09-09T00:00:00.000Z')).toBe(true);
    expect(store.addTrialSubscription('https://three.example/feed', 'Three', '発見', '2026-09-17T00:00:00.000Z')).toBe(true);
    expect(store.addTrialSubscription('https://four.example/feed', 'Four', '発見', '2026-09-25T00:00:00.000Z')).toBe(false);
    store.close();
  });

  it('prunes world observations and items older than ninety days', () => {
    const path = databasePath();
    const store = new SQLiteWorldStore(path, () => '2026-09-02T00:00:00.000Z');
    const source = store.dueSources('2026-09-02T00:00:00.000Z')[0]!;
    store.recordSuccess(
      source,
      [{ externalId: 'old', title: '古い記事', url: 'https://example.com/old' }],
      '2026-05-01T00:00:00.000Z',
    );
    expect(store.prune('2026-09-02T00:00:00.000Z')).toMatchObject({ itemsRemoved: 1 });
    expect(store.latestItems()).toEqual([]);
    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('SELECT COUNT(*) AS count FROM observations').get()).toEqual({ count: 0 });
    database.close();
  });

  it('replaces only legacy PubMed and Bluesky placeholder items with richer metadata', () => {
    const path = databasePath();
    const now = '2026-09-02T00:00:00.000Z';
    const previousQuery = process.env.SHANNON_BLUESKY_QUERY;
    process.env.SHANNON_BLUESKY_QUERY = 'AI';
    const store = new SQLiteWorldStore(path, () => now);
    if (previousQuery === undefined) delete process.env.SHANNON_BLUESKY_QUERY;
    else process.env.SHANNON_BLUESKY_QUERY = previousQuery;
    const pubmed = store.dueSources(now).find(source => source.kind === 'pubmed')!;
    expect(store.recordSuccess(pubmed, [
      { externalId: '42', title: 'PubMed 42', url: 'https://pubmed.ncbi.nlm.nih.gov/42/' },
      { externalId: '43', title: 'PubMed 43', url: 'https://pubmed.ncbi.nlm.nih.gov/43/' },
    ], now)).toBe(2);
    expect(store.recordSuccess(pubmed, [{
      externalId: '42', title: 'Actual paper', url: 'https://pubmed.ncbi.nlm.nih.gov/42/',
      summary: 'Journal', author: 'Author A', publishedAt: '2026-09-01T00:00:00.000Z',
    }], now)).toBe(1);
    expect(store.latestItems()).toEqual([
      expect.objectContaining({ title: 'Actual paper', summary: 'Journal', author: 'Author A' }),
    ]);

    const bluesky = store.dueSources(now).find(source => source.kind === 'bluesky')!;
    expect(store.recordSuccess(bluesky, [
      { externalId: 'at://did:plc:test/app.bsky.feed.post/key', title: 'A post', url: 'https://bsky.app/' },
      { externalId: 'at://did:plc:test/app.bsky.feed.post/old', title: 'Old post', url: 'https://bsky.app/' },
    ], now)).toBe(2);
    expect(store.recordSuccess(bluesky, [{
      externalId: 'at://did:plc:test/app.bsky.feed.post/key', title: 'A post',
      url: 'https://bsky.app/profile/did:plc:test/post/key', author: '@test.example',
      publishedAt: '2026-09-01T01:00:00.000Z',
    }], now)).toBe(1);
    expect(store.latestItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Actual paper', summary: 'Journal', author: 'Author A' }),
      expect.objectContaining({ title: 'A post', author: '@test.example' }),
    ]));
    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('SELECT COUNT(*) AS count FROM world_items WHERE source_id = ?').get(pubmed.id)).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM world_items WHERE source_id = ?').get(bluesky.id)).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM observations').get()).toEqual({ count: 2 });
    database.close();
  });

  it('discovers RSS and Atom hints without accepting ordinary links', () => {
    const links = discoverFeedLinks(`
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://other.example/atom">
      <link rel="stylesheet" href="/style.css">
    `, new URL('https://example.com/article'));
    expect(links.map(link => link.href)).toEqual([
      'https://example.com/feed.xml', 'https://other.example/atom',
    ]);
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-world-test-'));
  directories.push(directory);
  return join(directory, 'world.sqlite');
}
