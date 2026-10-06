/**
 * Read-only transport for the official Notion REST API.
 *
 * The owner's decision (Syzygy ADR-0002): Shannon reads the pages the owner shared with
 * an internal integration and never writes to Notion. This file is the only place that
 * talks to Notion, and it can send nothing except the read requests listed in
 * `NOTION_READ_ENDPOINTS`; every other method or path is refused before any network use.
 * Diagnostics carry an operation name, a status class, and counts, never a title or text.
 */
export const NOTION_API_ORIGIN = 'https://api.notion.com';
/** Pinned so a Notion-side default change cannot alter what is read or how it is shaped. */
export const NOTION_API_VERSION = '2022-06-28';

const ID = '[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}';

/** Every request this build may send to Notion. `POST` appears only for the two read queries. */
export const NOTION_READ_ENDPOINTS = Object.freeze([
  { operation: 'search', method: 'POST', pattern: /^\/v1\/search$/u },
  { operation: 'page', method: 'GET', pattern: new RegExp(`^/v1/pages/${ID}$`, 'u') },
  { operation: 'block', method: 'GET', pattern: new RegExp(`^/v1/blocks/${ID}$`, 'u') },
  { operation: 'block_children', method: 'GET', pattern: new RegExp(`^/v1/blocks/${ID}/children$`, 'u') },
  { operation: 'database', method: 'GET', pattern: new RegExp(`^/v1/databases/${ID}$`, 'u') },
  { operation: 'database_query', method: 'POST', pattern: new RegExp(`^/v1/databases/${ID}/query$`, 'u') },
] as const);

export type NotionReadOperation = typeof NOTION_READ_ENDPOINTS[number]['operation'];

/** The allowlist decision: the operation a method and path belong to, or null when it is not a read. */
export function notionReadOperation(method: string, path: string): NotionReadOperation | null {
  return NOTION_READ_ENDPOINTS.find(item => item.method === method && item.pattern.test(path))?.operation ?? null;
}

export type NotionErrorCode =
  | 'not_connected' | 'endpoint_not_allowed' | 'invalid_id' | 'timeout' | 'rate_limited' | 'unauthorized'
  | 'not_found' | 'http_error' | 'too_large' | 'malformed' | 'network' | 'outside_roots' | 'request_budget';

export class NotionReadError extends Error {
  constructor(readonly code: NotionErrorCode) {
    super(`NOTION_${code.toUpperCase()}`);
    this.name = 'NotionReadError';
  }
}

/** Content-free record of one request: no id, title, query, or text. */
export interface NotionRequestDiagnostic {
  operation: NotionReadOperation;
  /** `2xx`, `4xx`, `429`, `5xx`, or the error code when no response was read. */
  status: string;
  attempts: number;
  milliseconds: number;
}

export interface NotionClientOptions {
  token: string;
  fetch?: typeof fetch;
  timeoutMilliseconds?: number;
  /** How many times a 429 is retried after waiting for `Retry-After`. */
  maximumRetries?: number;
  /** The longest single wait accepted from `Retry-After`; a longer one fails as `rate_limited`. */
  maximumRetryWaitMilliseconds?: number;
  maximumResponseBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRequest?: (diagnostic: NotionRequestDiagnostic) => void;
}

export interface NotionRequestOptions {
  /** Epoch milliseconds after which the request is not started or is aborted. */
  deadline?: number;
}

export interface NotionList { results: unknown[]; nextCursor: string | null }

const TOKEN = /^[\x21-\x7E]{20,400}$/u;

/** A token is usable when it is one printable word; anything else counts as not connected. */
export function usableNotionToken(value: string | undefined): string | null {
  const token = value?.trim() ?? '';
  return TOKEN.test(token) ? token : null;
}

/** Notion ids arrive with or without dashes; the canonical form here is 32 lowercase hex characters. */
export function normalizedNotionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().toLowerCase().replace(/-/gu, '');
  return /^[0-9a-f]{32}$/u.test(compact) ? compact : null;
}

export class NotionReadClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly maximumRetries: number;
  private readonly maximumRetryWaitMilliseconds: number;
  private readonly maximumResponseBytes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: NotionClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 4_000;
    this.maximumRetries = options.maximumRetries ?? 1;
    this.maximumRetryWaitMilliseconds = options.maximumRetryWaitMilliseconds ?? 2_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 1_000_000;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  async search(query: string, pageSize: number, request: NotionRequestOptions = {}): Promise<NotionList> {
    return this.list('POST', '/v1/search', {
      query: query.slice(0, 200), page_size: pageSize,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    }, undefined, request);
  }

  async page(id: string, request: NotionRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.read('GET', `/v1/pages/${requiredId(id)}`, undefined, undefined, request);
  }

  async block(id: string, request: NotionRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.read('GET', `/v1/blocks/${requiredId(id)}`, undefined, undefined, request);
  }

  async blockChildren(id: string, cursor: string | null, pageSize: number, request: NotionRequestOptions = {}): Promise<NotionList> {
    return this.list('GET', `/v1/blocks/${requiredId(id)}/children`, undefined,
      { page_size: String(pageSize), ...(cursor ? { start_cursor: cursor } : {}) }, request);
  }

  async database(id: string, request: NotionRequestOptions = {}): Promise<Record<string, unknown>> {
    return this.read('GET', `/v1/databases/${requiredId(id)}`, undefined, undefined, request);
  }

  async queryDatabase(id: string, cursor: string | null, pageSize: number, request: NotionRequestOptions = {}): Promise<NotionList> {
    return this.list('POST', `/v1/databases/${requiredId(id)}/query`,
      { page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) }, undefined, request);
  }

  private async list(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined,
    query: Record<string, string> | undefined, request: NotionRequestOptions): Promise<NotionList> {
    const value = await this.read(method, path, body, query, request);
    if (!Array.isArray(value.results)) throw new NotionReadError('malformed');
    return {
      results: value.results,
      nextCursor: value.has_more === true && typeof value.next_cursor === 'string' && value.next_cursor.length <= 200
        ? value.next_cursor : null,
    };
  }

  /** The single exit to the network. Anything outside the read allowlist is refused here. */
  async read(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>,
    request: NotionRequestOptions = {}): Promise<Record<string, unknown>> {
    const operation = notionReadOperation(method, path);
    if (!operation) throw new NotionReadError('endpoint_not_allowed');
    const url = new URL(path, NOTION_API_ORIGIN);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const startedAt = Date.now();
    let attempts = 0;
    const report = (status: string) => this.options.onRequest?.({ operation, status, attempts, milliseconds: Math.max(0, Date.now() - startedAt) });
    const fail = (code: NotionErrorCode, status: string = code): never => { report(status); throw new NotionReadError(code); };
    for (;;) {
      const remaining = request.deadline === undefined ? this.timeoutMilliseconds : Math.min(this.timeoutMilliseconds, request.deadline - Date.now());
      if (remaining <= 0) fail('timeout');
      attempts += 1;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), remaining);
      let response: Response;
      let text = '';
      try {
        response = await this.fetcher(url, {
          method, redirect: 'error', signal: abort.signal,
          headers: {
            Authorization: `Bearer ${this.options.token}`, 'Notion-Version': NOTION_API_VERSION, Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.ok) text = await boundedText(response, this.maximumResponseBytes);
      } catch (error) {
        if (error instanceof NotionReadError) fail(error.code);
        return fail(abort.signal.aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429) {
        const wait = retryAfterMilliseconds(response.headers.get('retry-after'));
        const withinDeadline = request.deadline === undefined || Date.now() + wait < request.deadline;
        if (attempts > this.maximumRetries || wait > this.maximumRetryWaitMilliseconds || !withinDeadline) fail('rate_limited', '429');
        await this.sleep(wait);
        continue;
      }
      if (!response.ok) {
        fail(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'http_error',
          response.status >= 500 ? '5xx' : '4xx');
      }
      let value: unknown;
      try { value = JSON.parse(text); } catch { fail('malformed'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed');
      report('2xx');
      return value as Record<string, unknown>;
    }
  }
}

function requiredId(value: string): string {
  const id = normalizedNotionId(value);
  if (!id) throw new NotionReadError('invalid_id');
  return id;
}

/** `Retry-After` in seconds; a missing or unreadable value waits one second. */
function retryAfterMilliseconds(header: string | null): number {
  const seconds = header?.trim() ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : 1_000;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new NotionReadError('too_large');
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) throw new NotionReadError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NotionReadError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
