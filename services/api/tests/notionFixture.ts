import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredNotionSource, type NotionSource } from '../src/integrations/notion/notionSource.js';

/**
 * A fake Notion API over the synthetic workspace in `fixtures/notion/workspace.json`.
 * No network is used and no real workspace content is present.
 */
interface Workspace {
  objects: Record<string, Record<string, any>>;
  children: Record<string, Array<{ results: unknown[]; has_more: boolean; next_cursor: string | null }>>;
  blocks: Record<string, Record<string, unknown>>;
  searchOrder: string[];
  databaseRows: Record<string, string[]>;
}

export const NOTION_FIXTURE_IDS = {
  root: '11111111111111111111111111111111',
  characterDatabase: '22222222222222222222222222222222',
  characterRow: '33333333333333333333333333333301',
  scenario: '44444444444444444444444444444444',
  foreshadowing: '55555555555555555555555555555555',
  outside: '77777777777777777777777777777777',
} as const;

/** Not a real credential: a placeholder with the shape the reader accepts. */
export const FIXTURE_TOKEN = 'fixture-token-not-a-real-credential';

export interface RecordedNotionCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeNotion {
  fetch: typeof fetch;
  calls: RecordedNotionCall[];
  /** Responses returned before the fixture is consulted, in order. */
  queue: Response[];
  /** Extra objects, such as a long chain of nested pages. */
  objects: Record<string, Record<string, any>>;
}

const compact = (id: string) => id.replace(/-/gu, '');
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export function notionWorkspace(): Workspace {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/notion/workspace.json'), 'utf8')) as Workspace;
}

export function fakeNotion(): FakeNotion {
  const workspace = notionWorkspace();
  const fake: FakeNotion = { calls: [], queue: [], objects: { ...workspace.objects }, fetch: null as never };
  fake.fetch = (async (input: URL | string | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    fake.calls.push({
      method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string> ?? {})),
    });
    if (url.origin !== 'https://api.notion.com') return json({ object: 'error' }, 500);
    const queued = fake.queue.shift();
    if (queued) return queued;
    const notFound = () => json({ object: 'error', status: 404, code: 'object_not_found' }, 404);
    const segments = url.pathname.split('/').filter(Boolean);
    if (method === 'POST' && url.pathname === '/v1/search') {
      const query = String(body?.query ?? '');
      const results = workspace.searchOrder.map(id => fake.objects[id]!).filter(object => {
        const title = object.object === 'database' ? object.title[0].plain_text : object.properties['名前'].title[0].plain_text;
        return !query || String(title).includes(query);
      });
      return json({ object: 'list', results, has_more: false, next_cursor: null });
    }
    const id = compact(segments[2] ?? '');
    if (method === 'GET' && segments[1] === 'pages' && segments.length === 3) {
      const object = fake.objects[id];
      return object?.object === 'page' ? json(object) : notFound();
    }
    if (method === 'GET' && segments[1] === 'databases' && segments.length === 3) {
      const object = fake.objects[id];
      return object?.object === 'database' ? json(object) : notFound();
    }
    if (method === 'POST' && segments[1] === 'databases' && segments[3] === 'query') {
      const rows = workspace.databaseRows[id];
      return rows ? json({ object: 'list', results: rows.map(row => fake.objects[row]), has_more: false, next_cursor: null }) : notFound();
    }
    if (method === 'GET' && segments[1] === 'blocks' && segments[3] === 'children') {
      // A page with no content answers with an empty list, as the real API does.
      const pages = workspace.children[id] ?? (fake.objects[id] ? [{ results: [], has_more: false, next_cursor: null }] : undefined);
      if (!pages) return notFound();
      const index = url.searchParams.get('start_cursor') === 'cursor-2' ? 1 : 0;
      return json({ object: 'list', ...pages[index]! });
    }
    if (method === 'GET' && segments[1] === 'blocks' && segments.length === 3) {
      return workspace.blocks[id] ? json(workspace.blocks[id]) : notFound();
    }
    return json({ object: 'error', status: 400 }, 400);
  }) as typeof fetch;
  return fake;
}

export function fixtureNotionSource(options: { roots?: string; now?: () => number; fake?: FakeNotion; log?: (line: string) => void } = {}):
  { source: NotionSource; fake: FakeNotion } {
  const fake = options.fake ?? fakeNotion();
  const source = configuredNotionSource({
    SHANNON_NOTION_TOKEN: FIXTURE_TOKEN,
    ...(options.roots === undefined ? {} : { SHANNON_NOTION_ROOT_PAGE_IDS: options.roots }),
  }, { fetch: fake.fetch, sleep: async () => undefined, ...(options.now ? { now: options.now } : {}), ...(options.log ? { log: options.log } : {}) });
  return { source, fake };
}

export const notionJson = json;
