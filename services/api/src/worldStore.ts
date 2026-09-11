import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MAX_TRIAL_SUBSCRIPTIONS = 3;
const MAX_ACTIVE_SUBSCRIPTIONS = 10;
const MAX_NEW_TRIALS_PER_SEVEN_DAYS = 1;
const WORLD_RETENTION_DAYS = 90;
const MAX_WORLD_ITEMS = 1_000;

export type WorldSourceKind = 'rss' | 'weather' | 'hacker-news' | 'arxiv' | 'pubmed' | 'bluesky' | 'github';

export interface WorldSource {
  id: string;
  kind: WorldSourceKind;
  title: string;
  url: string;
  query: string | null;
  intervalMinutes: number;
  nextRunAt: string;
}

export interface WorldItemInput {
  externalId: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string;
  author?: string;
}

export interface WorldItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  url: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  discoveredAt: string;
}

export interface WorldReader {
  latestItems(limit?: number): readonly WorldItem[];
}

export type WorldSubscriptionApproval = 'pending' | 'approved' | 'rejected';
export type WorldSubscriptionStatus = 'trial' | 'active' | 'paused' | 'rejected';

export interface WorldSubscription {
  id: string;
  feedURL: string;
  title: string;
  status: WorldSubscriptionStatus;
  approval: WorldSubscriptionApproval;
  reason: string;
  discoveredAt: string;
  trialExpiresAt: string;
  fetchedItemCount: number;
  updatedAt: string;
}

export interface WorldSubscriptionReader {
  subscriptions(): readonly WorldSubscription[];
  decideSubscription(
    id: string,
    decision: 'approve' | 'reject',
    expectedUpdatedAt: string,
    decidedAt?: string,
  ): WorldSubscription;
}

export class SQLiteWorldStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.prepareSchema();
    this.seedConfiguredSources();
    this.secureFiles();
  }

  dueSources(at = this.now()): readonly WorldSource[] {
    return Object.freeze((this.database.prepare(`
      SELECT source_id, kind, title, url, query, interval_minutes, next_run_at
      FROM world_sources
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT 8
    `).all(at) as unknown as Array<Record<string, unknown>>).map(row => Object.freeze({
      id: String(row.source_id),
      kind: String(row.kind) as WorldSourceKind,
      title: String(row.title),
      url: String(row.url),
      query: row.query === null ? null : String(row.query),
      intervalMinutes: Number(row.interval_minutes),
      nextRunAt: String(row.next_run_at),
    })));
  }

  recordSuccess(source: WorldSource, items: readonly WorldItemInput[], completedAt = this.now()): number {
    let inserted = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insertItem = this.database.prepare(`
        INSERT OR IGNORE INTO world_items
          (item_id, source_id, external_id, title, url, summary, author, published_at, discovered_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservation = this.database.prepare(`
        INSERT INTO observations
          (observation_id, item_id, scope_key, note, relevance, created_at)
        VALUES (?, ?, 'owner', ?, ?, ?)
      `);
      for (const item of items.slice(0, 30)) {
        const itemId = randomUUID();
        const hash = createHash('sha256').update(`${item.title}\n${item.summary ?? ''}\n${item.url}`).digest('hex');
        const result = insertItem.run(
          itemId, source.id, item.externalId.slice(0, 300), item.title.slice(0, 500), item.url.slice(0, 2_000),
          item.summary?.slice(0, 4_000) ?? null, item.author?.slice(0, 200) ?? null,
          item.publishedAt ?? null, completedAt, hash,
        );
        inserted += Number(result.changes);
        if (Number(result.changes) > 0) {
          insertObservation.run(
            randomUUID(), itemId, `${source.title}で「${item.title.slice(0, 180)}」を見つけた`,
            source.kind === 'weather' ? 0.8 : 0.55, completedAt,
          );
        }
      }
      const next = new Date(Date.parse(completedAt) + source.intervalMinutes * 60_000).toISOString();
      this.database.prepare(`
        UPDATE world_sources SET last_run_at = ?, next_run_at = ?, last_error = NULL WHERE source_id = ?
      `).run(completedAt, next, source.id);
      if (inserted > 0) {
        this.database.prepare(`
          INSERT INTO activity_events
            (activity_id, scope_key, activity_type, title, detail, occurred_at, metadata_json)
          VALUES (?, 'owner', 'world', ?, ?, ?, ?)
        `).run(randomUUID(), `${source.title}を見に行った`, `${inserted}件を持ち帰った`, completedAt, JSON.stringify({ sourceId: source.id }));
      }
      this.database.exec('COMMIT');
      this.secureFiles();
      return inserted;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordFailure(source: WorldSource, code: string, failedAt = this.now()): void {
    const retryAt = new Date(Date.parse(failedAt) + Math.min(source.intervalMinutes, 30) * 60_000).toISOString();
    this.database.prepare(`
      UPDATE world_sources SET last_run_at = ?, next_run_at = ?, last_error = ? WHERE source_id = ?
    `).run(failedAt, retryAt, code.slice(0, 160), source.id);
  }

  proposeSubscription(feedURL: string, title: string, reason: string, discoveredAt = this.now()): boolean {
    const existing = this.database.prepare(`SELECT 1 AS found FROM subscriptions WHERE feed_url = ?`).get(feedURL);
    if (existing) return false;
    const statuses = this.database.prepare(`
      SELECT status, approval_status, COUNT(*) AS count FROM subscriptions
      WHERE status IN ('trial', 'active') OR approval_status = 'pending'
      GROUP BY status, approval_status
    `).all() as unknown as Array<{ status: string; approval_status: string; count: number }>;
    const trials = Number(statuses.find(row => row.status === 'trial')?.count ?? 0);
    const active = Number(statuses.find(row => row.status === 'active')?.count ?? 0);
    const pending = statuses
      .filter(row => row.approval_status === 'pending')
      .reduce((sum, row) => sum + Number(row.count), 0);
    if (pending + trials >= MAX_TRIAL_SUBSCRIPTIONS || active >= MAX_ACTIVE_SUBSCRIPTIONS) return false;
    const weekStart = new Date(Date.parse(discoveredAt) - 7 * 86_400_000).toISOString();
    const recent = this.database.prepare(`
      SELECT COUNT(*) AS count FROM subscriptions WHERE trial_started_at >= ?
    `).get(weekStart) as unknown as { count: number };
    if (Number(recent.count) >= MAX_NEW_TRIALS_PER_SEVEN_DAYS) return false;
    const id = createHash('sha256').update(feedURL).digest('hex').slice(0, 24);
    const expiresAt = new Date(Date.parse(discoveredAt) + 7 * 86_400_000).toISOString();
    this.database.prepare(`
      INSERT INTO subscriptions
        (subscription_id, feed_url, title, status, approval_status, reason,
         trial_started_at, trial_expires_at, score, updated_at)
      VALUES (?, ?, ?, 'paused', 'pending', ?, ?, ?, 0, ?)
      ON CONFLICT(feed_url) DO NOTHING
    `).run(id, feedURL, title.slice(0, 200), reason.slice(0, 500), discoveredAt, expiresAt, discoveredAt);
    return true;
  }

  /** Explicit/internal compatibility helper. New self-discovery must use proposeSubscription. */
  addTrialSubscription(feedURL: string, title: string, reason: string, discoveredAt = this.now()): boolean {
    if (!this.proposeSubscription(feedURL, title, reason, discoveredAt)) return false;
    const id = createHash('sha256').update(feedURL).digest('hex').slice(0, 24);
    this.decideSubscription(id, 'approve', discoveredAt, discoveredAt);
    return true;
  }

  subscriptions(): readonly WorldSubscription[] {
    const rows = this.database.prepare(`
      SELECT s.subscription_id, s.feed_url, s.title, s.status, s.approval_status, s.reason,
        s.trial_started_at, s.trial_expires_at, s.updated_at,
        COUNT(wi.item_id) AS fetched_item_count
      FROM subscriptions s
      LEFT JOIN world_items wi ON wi.source_id = 'rss:' || s.subscription_id
      GROUP BY s.subscription_id
      ORDER BY CASE s.approval_status WHEN 'pending' THEN 0 ELSE 1 END, s.updated_at DESC
      LIMIT 50
    `).all() as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(row => this.subscriptionFromRow(row)));
  }

  decideSubscription(
    id: string,
    decision: 'approve' | 'reject',
    expectedUpdatedAt: string,
    decidedAt = this.now(),
  ): WorldSubscription {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`
        SELECT subscription_id, feed_url, title, status, approval_status, reason,
          trial_started_at, trial_expires_at, updated_at
        FROM subscriptions WHERE subscription_id = ?
      `).get(id) as unknown as Record<string, unknown> | undefined;
      if (!row) throw new Error('WORLD_SUBSCRIPTION_NOT_FOUND');
      if (String(row.approval_status) !== 'pending') throw new Error('WORLD_SUBSCRIPTION_ALREADY_DECIDED');
      if (String(row.updated_at) !== expectedUpdatedAt) throw new Error('WORLD_SUBSCRIPTION_STALE');

      if (decision === 'reject') {
        this.database.prepare(`
          UPDATE subscriptions
          SET status = 'rejected', approval_status = 'rejected', updated_at = ?
          WHERE subscription_id = ?
        `).run(decidedAt, id);
      } else {
        const trials = this.database.prepare(`
          SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'trial'
        `).get() as unknown as { count: number };
        const active = this.database.prepare(`
          SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'
        `).get() as unknown as { count: number };
        if (Number(trials.count) >= MAX_TRIAL_SUBSCRIPTIONS || Number(active.count) >= MAX_ACTIVE_SUBSCRIPTIONS) {
          throw new Error('WORLD_SUBSCRIPTION_LIMIT');
        }
        const expiresAt = new Date(Date.parse(decidedAt) + 7 * 86_400_000).toISOString();
        this.database.prepare(`
          UPDATE subscriptions SET status = 'trial', approval_status = 'approved',
            trial_started_at = ?, trial_expires_at = ?, updated_at = ?
          WHERE subscription_id = ?
        `).run(decidedAt, expiresAt, decidedAt, id);
        this.upsertSource({
          id: `rss:${id}`,
          kind: 'rss',
          title: String(row.title),
          url: String(row.feed_url),
          query: null,
          intervalMinutes: 720,
          nextRunAt: decidedAt,
        });
        this.database.prepare(`UPDATE world_sources SET enabled = 1 WHERE source_id = ?`).run(`rss:${id}`);
      }
      this.database.exec('COMMIT');
      return this.subscription(id);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reviewExpiredTrials(at = this.now()): { activated: number; paused: number } {
    const rows = this.database.prepare(`
      SELECT subscription_id, feed_url
      FROM subscriptions
      WHERE status = 'trial' AND trial_expires_at <= ?
    `).all(at) as unknown as Array<{ subscription_id: string; feed_url: string }>;
    let activated = 0;
    let paused = 0;
    for (const row of rows) {
      const sourceId = `rss:${row.subscription_id}`;
      const count = this.database.prepare(`
        SELECT COUNT(*) AS count FROM world_items WHERE source_id = ?
      `).get(sourceId) as unknown as { count: number };
      const activeCount = this.database.prepare(`
        SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'
      `).get() as unknown as { count: number };
      if (Number(count.count) >= 2 && Number(activeCount.count) < MAX_ACTIVE_SUBSCRIPTIONS) {
        this.database.prepare(`UPDATE subscriptions SET status = 'active', updated_at = ? WHERE subscription_id = ?`)
          .run(at, row.subscription_id);
        activated += 1;
      } else {
        this.database.prepare(`UPDATE subscriptions SET status = 'paused', updated_at = ? WHERE subscription_id = ?`)
          .run(at, row.subscription_id);
        this.database.prepare(`UPDATE world_sources SET enabled = 0 WHERE source_id = ?`).run(sourceId);
        paused += 1;
      }
    }
    return { activated, paused };
  }

  prune(at = this.now()): { itemsRemoved: number; activitiesRemoved: number } {
    const cutoff = new Date(Date.parse(at) - WORLD_RETENTION_DAYS * 86_400_000).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const oldObservations = this.database.prepare(`
        DELETE FROM observations WHERE item_id IN (
          SELECT item_id FROM world_items WHERE discovered_at < ?
        )
      `).run(cutoff);
      void oldObservations;
      const oldItems = this.database.prepare(`DELETE FROM world_items WHERE discovered_at < ?`).run(cutoff);
      const overflowObservations = this.database.prepare(`
        DELETE FROM observations WHERE item_id IN (
          SELECT item_id FROM world_items ORDER BY discovered_at DESC LIMIT -1 OFFSET ?
        )
      `).run(MAX_WORLD_ITEMS);
      void overflowObservations;
      const overflowItems = this.database.prepare(`
        DELETE FROM world_items WHERE item_id IN (
          SELECT item_id FROM world_items ORDER BY discovered_at DESC LIMIT -1 OFFSET ?
        )
      `).run(MAX_WORLD_ITEMS);
      const activities = this.database.prepare(`
        DELETE FROM activity_events WHERE activity_type = 'world' AND occurred_at < ?
      `).run(cutoff);
      this.database.exec('COMMIT');
      return {
        itemsRemoved: Number(oldItems.changes) + Number(overflowItems.changes),
        activitiesRemoved: Number(activities.changes),
      };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  latestItems(limit = 40): readonly WorldItem[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT wi.item_id, wi.source_id, ws.title AS source_title, wi.title, wi.url,
        wi.summary, wi.author, wi.published_at, wi.discovered_at
      FROM world_items wi
      JOIN world_sources ws ON ws.source_id = wi.source_id
      ORDER BY COALESCE(wi.published_at, wi.discovered_at) DESC
      LIMIT ?
    `).all(safeLimit) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: String(row.item_id),
      sourceId: String(row.source_id),
      sourceTitle: String(row.source_title),
      title: String(row.title),
      url: String(row.url),
      ...(row.summary === null ? {} : { summary: String(row.summary) }),
      ...(row.author === null ? {} : { author: String(row.author) }),
      ...(row.published_at === null ? {} : { publishedAt: String(row.published_at) }),
      discoveredAt: String(row.discovered_at),
    })));
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private prepareSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS world_sources (
        source_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('rss','weather','hacker-news','arxiv','pubmed','bluesky','github')),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        query TEXT,
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 5),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        last_run_at TEXT,
        next_run_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
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
      CREATE TABLE IF NOT EXISTS world_items (
        item_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        summary TEXT,
        author TEXT,
        published_at TEXT,
        discovered_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE (source_id, external_id),
        UNIQUE (content_hash)
      );
      CREATE INDEX IF NOT EXISTS world_items_discovered ON world_items (discovered_at DESC);
      CREATE TABLE IF NOT EXISTS observations (
        observation_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        note TEXT NOT NULL,
        relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        activity_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    this.ensureSubscriptionApprovalColumn();
  }

  private seedConfiguredSources(): void {
    const now = this.now();
    const sources: WorldSource[] = [
      { id: 'jma:tokyo', kind: 'weather', title: '気象庁・東京', url: 'https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json', query: null, intervalMinutes: 180, nextRunAt: now },
      { id: 'hn:top', kind: 'hacker-news', title: 'Hacker News', url: 'https://hacker-news.firebaseio.com/v0', query: null, intervalMinutes: 360, nextRunAt: now },
      { id: 'arxiv:agents', kind: 'arxiv', title: 'arXiv・AI agents', url: 'https://export.arxiv.org/api/query', query: 'all:AI agents', intervalMinutes: 1440, nextRunAt: now },
      { id: 'pubmed:ai', kind: 'pubmed', title: 'PubMed・AI', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', query: 'artificial intelligence', intervalMinutes: 1440, nextRunAt: now },
      { id: 'zenn:all', kind: 'rss', title: 'Zenn', url: 'https://zenn.dev/feed', query: null, intervalMinutes: 360, nextRunAt: now },
      { id: 'cao:news', kind: 'rss', title: '内閣府', url: 'https://www.cao.go.jp/rss/news.rdf', query: null, intervalMinutes: 1440, nextRunAt: now },
    ];
    const blueskyQuery = process.env.SHANNON_BLUESKY_QUERY?.trim();
    if (blueskyQuery) sources.push({
      id: 'bluesky:interest', kind: 'bluesky', title: 'Bluesky', url: 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts',
      query: blueskyQuery, intervalMinutes: 360, nextRunAt: now,
    });
    for (const repo of (process.env.SHANNON_GITHUB_REPOS ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
      sources.push({
        id: `github:${repo}`, kind: 'github', title: `GitHub・${repo}`, url: `https://api.github.com/repos/${repo}/releases`,
        query: repo, intervalMinutes: 720, nextRunAt: now,
      });
    }
    for (const source of sources) this.upsertSource(source);
    this.database.prepare(`
      UPDATE world_sources SET interval_minutes = 720 WHERE source_id LIKE 'rss:%'
    `).run();
  }

  private upsertSource(source: WorldSource): void {
    this.database.prepare(`
      INSERT INTO world_sources (source_id, kind, title, url, query, interval_minutes, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        title = excluded.title, url = excluded.url, query = excluded.query, interval_minutes = excluded.interval_minutes
    `).run(source.id, source.kind, source.title, source.url, source.query, source.intervalMinutes, source.nextRunAt);
  }

  private subscription(id: string): WorldSubscription {
    const row = this.database.prepare(`
      SELECT s.subscription_id, s.feed_url, s.title, s.status, s.approval_status, s.reason,
        s.trial_started_at, s.trial_expires_at, s.updated_at,
        COUNT(wi.item_id) AS fetched_item_count
      FROM subscriptions s
      LEFT JOIN world_items wi ON wi.source_id = 'rss:' || s.subscription_id
      WHERE s.subscription_id = ?
      GROUP BY s.subscription_id
    `).get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new Error('WORLD_SUBSCRIPTION_NOT_FOUND');
    return this.subscriptionFromRow(row);
  }

  private subscriptionFromRow(row: Record<string, unknown>): WorldSubscription {
    return Object.freeze({
      id: String(row.subscription_id),
      feedURL: String(row.feed_url),
      title: String(row.title),
      status: String(row.status) as WorldSubscriptionStatus,
      approval: String(row.approval_status) as WorldSubscriptionApproval,
      reason: String(row.reason),
      discoveredAt: String(row.trial_started_at),
      trialExpiresAt: String(row.trial_expires_at),
      fetchedItemCount: Number(row.fetched_item_count ?? 0),
      updatedAt: String(row.updated_at),
    });
  }

  private ensureSubscriptionApprovalColumn(): void {
    const columns = this.database.prepare(`PRAGMA table_info(subscriptions)`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'approval_status')) {
      this.database.exec(`
        ALTER TABLE subscriptions
        ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'
          CHECK (approval_status IN ('pending','approved','rejected'))
      `);
    }
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}

export function discoverFeedLinks(html: string, pageURL: URL): readonly URL[] {
  const links: URL[] = [];
  const pattern = /<link\b[^>]*>/giu;
  for (const [tag] of html.matchAll(pattern)) {
    if (!/rel\s*=\s*["'][^"']*alternate/iu.test(tag) || !/type\s*=\s*["']application\/(?:rss|atom)\+xml/iu.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!href) continue;
    try { links.push(new URL(href, pageURL)); } catch { /* Ignore malformed page hints. */ }
  }
  return Object.freeze([...new Map(links.map(url => [url.href, url])).values()]);
}
