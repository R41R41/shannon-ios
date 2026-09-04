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
    const source = sources[0]!;
    expect(store.recordSuccess(source, [{ externalId: 'same', title: '記事', url: 'https://example.com/a' }], now)).toBe(1);
    expect(store.recordSuccess(source, [{ externalId: 'same', title: '記事', url: 'https://example.com/a' }], now)).toBe(0);
    expect(store.latestItems()).toEqual([
      expect.objectContaining({ title: '記事', sourceTitle: source.title }),
    ]);
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
