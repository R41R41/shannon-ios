import {
  NotionReadClient, NotionReadError, normalizedNotionId, usableNotionToken,
  type NotionErrorCode, type NotionRequestDiagnostic,
} from './notionClient.js';
import {
  notionArchived, notionParent, notionRecord, notionSimpleProperties, notionTitle, notionUrl, renderNotionBlocks,
  type NotionBlockNode, type NotionParent,
} from './notionText.js';

/**
 * Bounded, read-only view of the owner's Notion: what the integration was shared, and
 * inside that only the configured root subtrees. A page whose ancestry cannot be
 * confirmed within `maximumAncestryHops` is not readable. Results are cached in
 * memory for a short time and are never written to the database or to a log.
 */
export const NOTION_BOUNDS = Object.freeze({
  searchResults: 10,
  searchPageSize: 20,
  pageBlocks: 400,
  blockDepth: 3,
  pageCharacters: 12_000,
  databaseRows: 50,
  ancestryHops: 8,
  requestsPerOperation: 24,
  rootIds: 20,
  cacheEntries: 64,
  cacheMilliseconds: 5 * 60_000,
});

export interface NotionObjectSummary {
  id: string;
  kind: 'page' | 'database';
  title: string;
  url: string | null;
  lastEditedAt: string | null;
}

export interface NotionPageText extends NotionObjectSummary {
  text: string;
  /** Part of the page was not read: a size, depth, request, or time bound was reached. */
  truncated: boolean;
  skippedBlocks: number;
}

export interface NotionDatabaseRows extends NotionObjectSummary {
  rows: ReadonlyArray<{ id: string; title: string; url: string | null; properties: Readonly<Record<string, string>> }>;
  truncated: boolean;
}

export interface NotionReadOptions {
  /** Epoch milliseconds after which no further request is started. */
  deadline?: number;
}

/** Counts only. No id, title, query, or text. */
export interface NotionDiagnostics {
  connected: boolean;
  restrictedToRoots: boolean;
  requests: number;
  cacheHits: number;
  outsideRoots: number;
  skippedBlocks: number;
  statuses: Readonly<Record<string, number>>;
}

export interface NotionSource {
  readonly connected: boolean;
  search(query: string, options?: NotionReadOptions): Promise<readonly NotionObjectSummary[]>;
  readPage(id: string, options?: NotionReadOptions): Promise<NotionPageText>;
  queryDatabase(id: string, options?: NotionReadOptions): Promise<NotionDatabaseRows>;
  diagnostics(): NotionDiagnostics;
}

export interface NotionSourceOptions {
  client: NotionReadClient;
  /** Empty with `restricted` false means everything the integration was shared is readable. */
  rootIds?: readonly string[];
  restricted?: boolean;
  now?: () => number;
}

interface Operation { requests: number; deadline?: number; interrupted: boolean }

export class BoundedNotionSource implements NotionSource {
  readonly connected = true;
  private readonly roots: ReadonlySet<string>;
  private readonly restricted: boolean;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly parents = new Map<string, { expiresAt: number; parent: NotionParent | null }>();
  private readonly counts = { requests: 0, cacheHits: 0, outsideRoots: 0, skippedBlocks: 0, statuses: {} as Record<string, number> };

  constructor(private readonly options: NotionSourceOptions) {
    this.roots = new Set((options.rootIds ?? []).flatMap(id => normalizedNotionId(id) ?? []).slice(0, NOTION_BOUNDS.rootIds));
    this.restricted = options.restricted ?? this.roots.size > 0;
    this.now = options.now ?? Date.now;
  }

  /** Called by the client for every request; keeps counts and status classes only. */
  observe(diagnostic: NotionRequestDiagnostic): void {
    this.counts.requests += 1;
    this.counts.statuses[diagnostic.status] = (this.counts.statuses[diagnostic.status] ?? 0) + 1;
  }

  diagnostics(): NotionDiagnostics {
    return Object.freeze({
      connected: true, restrictedToRoots: this.restricted, requests: this.counts.requests, cacheHits: this.counts.cacheHits,
      outsideRoots: this.counts.outsideRoots, skippedBlocks: this.counts.skippedBlocks, statuses: Object.freeze({ ...this.counts.statuses }),
    });
  }

  async search(query: string, options: NotionReadOptions = {}): Promise<readonly NotionObjectSummary[]> {
    const phrase = query.replace(/\s+/gu, ' ').trim().slice(0, 200);
    return this.cached(`search:${phrase}`, async operation => {
      const list = await this.options.client.search(phrase, NOTION_BOUNDS.searchPageSize, this.spend(operation));
      const hits: NotionObjectSummary[] = [];
      for (const raw of list.results) {
        if (hits.length >= NOTION_BOUNDS.searchResults) break;
        const object = notionRecord(raw);
        const summary = object ? summarize(object) : null;
        if (!object || !summary || notionArchived(object)) continue;
        this.remember(summary.id, notionParent(object));
        if (await this.withinRoots(summary.id, operation)) hits.push(summary);
      }
      return Object.freeze(hits);
    }, options);
  }

  async readPage(id: string, options: NotionReadOptions = {}): Promise<NotionPageText> {
    const pageId = requiredId(id);
    return this.cached(`page:${pageId}`, async operation => {
      const page = await this.options.client.page(pageId, this.spend(operation));
      const summary = summarize(page);
      if (!summary || summary.kind !== 'page' || notionArchived(page)) throw new NotionReadError('not_found');
      this.remember(pageId, notionParent(page));
      if (!await this.withinRoots(pageId, operation)) throw new NotionReadError('outside_roots');
      const state = { blocks: 0, truncated: false };
      const tree = await this.blockTree(pageId, 0, state, operation);
      const rendered = renderNotionBlocks(tree, NOTION_BOUNDS.pageCharacters);
      this.counts.skippedBlocks += rendered.skippedBlocks;
      return Object.freeze({ ...summary, text: rendered.text, truncated: state.truncated || rendered.truncated, skippedBlocks: rendered.skippedBlocks });
    }, options);
  }

  async queryDatabase(id: string, options: NotionReadOptions = {}): Promise<NotionDatabaseRows> {
    const databaseId = requiredId(id);
    return this.cached(`database:${databaseId}`, async operation => {
      const database = await this.options.client.database(databaseId, this.spend(operation));
      const summary = summarize(database);
      if (!summary || summary.kind !== 'database' || notionArchived(database)) throw new NotionReadError('not_found');
      this.remember(databaseId, notionParent(database));
      if (!await this.withinRoots(databaseId, operation)) throw new NotionReadError('outside_roots');
      const list = await this.options.client.queryDatabase(databaseId, null, NOTION_BOUNDS.databaseRows, this.spend(operation));
      const rows = list.results.flatMap(raw => {
        const row = notionRecord(raw);
        const rowSummary = row && !notionArchived(row) ? summarize(row) : null;
        if (!row || !rowSummary) return [];
        // A row is a child of the database that was just confirmed.
        this.remember(rowSummary.id, { kind: 'database', id: databaseId });
        return [{ id: rowSummary.id, title: rowSummary.title, url: rowSummary.url, properties: Object.freeze(notionSimpleProperties(row)) }];
      }).slice(0, NOTION_BOUNDS.databaseRows);
      return Object.freeze({ ...summary, rows: Object.freeze(rows), truncated: list.nextCursor !== null });
    }, options);
  }

  private async blockTree(id: string, depth: number, state: { blocks: number; truncated: boolean }, operation: Operation): Promise<NotionBlockNode[]> {
    const nodes: Array<{ block: Record<string, unknown>; children: NotionBlockNode[] }> = [];
    let cursor: string | null = null;
    do {
      if (state.blocks >= NOTION_BOUNDS.pageBlocks) { state.truncated = true; break; }
      let list;
      try {
        list = await this.options.client.blockChildren(id, cursor, 100, this.spend(operation));
      } catch (error) {
        // The first request of a page decides whether it is readable at all; later ones only shorten it.
        if (depth === 0 && cursor === null) throw error;
        state.truncated = true;
        operation.interrupted = true;
        break;
      }
      for (const raw of list.results) {
        const block = notionRecord(raw);
        if (!block || notionArchived(block)) continue;
        if (state.blocks >= NOTION_BOUNDS.pageBlocks) { state.truncated = true; break; }
        state.blocks += 1;
        nodes.push({ block, children: [] });
      }
      cursor = list.nextCursor;
    } while (cursor);
    for (const node of nodes) {
      const type = node.block.type;
      const blockId = normalizedNotionId(node.block.id);
      // A child page or database is named as a reference; its content is a separate read.
      if (node.block.has_children !== true || type === 'child_page' || type === 'child_database' || !blockId) continue;
      if (depth + 1 > NOTION_BOUNDS.blockDepth) { state.truncated = true; continue; }
      node.children = await this.blockTree(blockId, depth + 1, state, operation);
    }
    return nodes;
  }

  /** Walks up the parents until a root is met. Anything unconfirmed is outside. */
  private async withinRoots(id: string, operation: Operation): Promise<boolean> {
    if (!this.restricted) return true;
    let current: { id: string; kind?: NotionParent['kind'] } = { id };
    for (let hop = 0; hop <= NOTION_BOUNDS.ancestryHops; hop += 1) {
      if (this.roots.has(current.id)) return true;
      const parent = await this.parentOf(current.id, current.kind, operation);
      if (!parent || parent.kind === 'workspace') break;
      current = parent;
    }
    this.counts.outsideRoots += 1;
    return false;
  }

  /** The parent reference of an object, from the short-lived link cache or one read. Null when it cannot be confirmed. */
  private async parentOf(id: string, kind: NotionParent['kind'] | undefined, operation: Operation): Promise<NotionParent | null> {
    const known = this.parents.get(id);
    if (known && known.expiresAt > this.now()) return known.parent;
    if (!kind || kind === 'workspace') return null;
    try {
      const client = this.options.client;
      const object = kind === 'page' ? await client.page(id, this.spend(operation))
        : kind === 'database' ? await client.database(id, this.spend(operation))
          : await client.block(id, this.spend(operation));
      const parent = notionParent(object);
      this.remember(id, parent);
      return parent;
    } catch {
      return null;
    }
  }

  private remember(id: string, parent: NotionParent | null): void {
    if (this.parents.size >= 2_000) this.parents.clear();
    this.parents.set(id, { expiresAt: this.now() + NOTION_BOUNDS.cacheMilliseconds, parent });
  }

  /** Counts one request against the operation and hands the client its deadline. */
  private spend(operation: Operation): NotionReadOptions {
    if (operation.requests >= NOTION_BOUNDS.requestsPerOperation) throw new NotionReadError('request_budget');
    operation.requests += 1;
    return operation.deadline === undefined ? {} : { deadline: operation.deadline };
  }

  private async cached<T>(key: string, read: (operation: Operation) => Promise<T>, options: NotionReadOptions): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.counts.cacheHits += 1;
      return hit.value as T;
    }
    this.cache.delete(key);
    const operation: Operation = { requests: 0, interrupted: false, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) };
    const value = await read(operation);
    // A result cut short by a failure or the clock is returned but not kept.
    if (!operation.interrupted) {
      while (this.cache.size >= NOTION_BOUNDS.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expiresAt: this.now() + NOTION_BOUNDS.cacheMilliseconds, value });
    }
    return value;
  }
}

/** No token: every read reports `not_connected`, and callers say so plainly. */
export class DisconnectedNotionSource implements NotionSource {
  readonly connected = false;
  search(): Promise<never> { return Promise.reject(new NotionReadError('not_connected')); }
  readPage(): Promise<never> { return Promise.reject(new NotionReadError('not_connected')); }
  queryDatabase(): Promise<never> { return Promise.reject(new NotionReadError('not_connected')); }
  diagnostics(): NotionDiagnostics {
    return Object.freeze({ connected: false, restrictedToRoots: false, requests: 0, cacheHits: 0, outsideRoots: 0, skippedBlocks: 0, statuses: Object.freeze({}) });
  }
}

/**
 * `SHANNON_NOTION_TOKEN` connects the reader; without it the feature is off.
 * `SHANNON_NOTION_ROOT_PAGE_IDS` (comma-separated page or database ids) narrows it to those subtrees.
 * A root list that is set but holds no valid id leaves nothing readable.
 */
export function configuredNotionSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  overrides: { fetch?: typeof fetch; now?: () => number; sleep?: (milliseconds: number) => Promise<void>; log?: (line: string) => void } = {},
): NotionSource {
  const token = usableNotionToken(environment.SHANNON_NOTION_TOKEN);
  if (!token) return new DisconnectedNotionSource();
  const rootText = environment.SHANNON_NOTION_ROOT_PAGE_IDS?.trim() ?? '';
  const holder: { source?: BoundedNotionSource } = {};
  const client = new NotionReadClient({
    token,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    onRequest: diagnostic => {
      holder.source?.observe(diagnostic);
      overrides.log?.(JSON.stringify({ event: 'notion_read', ...diagnostic }));
    },
  });
  holder.source = new BoundedNotionSource({
    client, rootIds: rootText.split(','), restricted: rootText.length > 0, ...(overrides.now ? { now: overrides.now } : {}),
  });
  return holder.source;
}

/** The reason a read failed, as a code that is safe to log and to show. */
export function notionFailureCode(error: unknown): NotionErrorCode {
  return error instanceof NotionReadError ? error.code : 'network';
}

function summarize(object: Record<string, unknown>): NotionObjectSummary | null {
  const id = normalizedNotionId(object.id);
  const kind = object.object === 'page' ? 'page' : object.object === 'database' ? 'database' : null;
  if (!id || !kind) return null;
  const edited = typeof object.last_edited_time === 'string' && Number.isFinite(Date.parse(object.last_edited_time))
    ? new Date(object.last_edited_time).toISOString() : null;
  return { id, kind, title: notionTitle(object) || '無題', url: notionUrl(object.url), lastEditedAt: edited };
}

function requiredId(value: string): string {
  const id = normalizedNotionId(value);
  if (!id) throw new NotionReadError('invalid_id');
  return id;
}
