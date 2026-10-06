import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTION_API_VERSION, NOTION_READ_ENDPOINTS, NotionReadClient, NotionReadError, normalizedNotionId, notionReadOperation,
  usableNotionToken, type NotionRequestDiagnostic,
} from '../src/integrations/notion/notionClient.js';
import { apiSourceFilesNamed, readApiSource } from './support/sources.js';
import { FIXTURE_TOKEN, NOTION_FIXTURE_IDS, fakeNotion, notionJson } from './notionFixture.js';

const id = NOTION_FIXTURE_IDS.scenario;
const dashed = '44444444-4444-4444-4444-444444444444';

function client(options: { timeoutMilliseconds?: number; maximumResponseBytes?: number; fetch?: typeof fetch } = {}) {
  const fake = fakeNotion();
  const diagnostics: NotionRequestDiagnostic[] = [];
  const waits: number[] = [];
  const notion = new NotionReadClient({
    token: FIXTURE_TOKEN, fetch: options.fetch ?? fake.fetch, sleep: async milliseconds => { waits.push(milliseconds); },
    onRequest: diagnostic => diagnostics.push(diagnostic), ...options,
  });
  return { notion, fake, diagnostics, waits };
}

const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', error => (error instanceof NotionReadError ? error.code : `unexpected:${String(error)}`));

describe('Notion read allowlist', () => {
  it('names exactly the six read requests', () => {
    expect(NOTION_READ_ENDPOINTS.map(item => `${item.method} ${item.operation}`)).toEqual([
      'POST search', 'GET page', 'GET block', 'GET block_children', 'GET database', 'POST database_query',
    ]);
  });

  it.each([
    ['POST', '/v1/search', 'search'],
    ['GET', `/v1/pages/${id}`, 'page'],
    ['GET', `/v1/pages/${dashed}`, 'page'],
    ['GET', `/v1/blocks/${id}`, 'block'],
    ['GET', `/v1/blocks/${id}/children`, 'block_children'],
    ['GET', `/v1/databases/${id}`, 'database'],
    ['POST', `/v1/databases/${id}/query`, 'database_query'],
  ])('allows %s %s', (method, path, operation) => {
    expect(notionReadOperation(method, path)).toBe(operation);
  });

  it.each([
    ['POST', '/v1/pages'],
    ['PATCH', `/v1/pages/${id}`],
    ['POST', `/v1/pages/${id}`],
    ['DELETE', `/v1/blocks/${id}`],
    ['PATCH', `/v1/blocks/${id}`],
    ['PATCH', `/v1/blocks/${id}/children`],
    ['POST', `/v1/blocks/${id}/children`],
    ['POST', '/v1/databases'],
    ['PATCH', `/v1/databases/${id}`],
    ['POST', '/v1/comments'],
    ['GET', '/v1/comments'],
    ['GET', '/v1/users'],
    ['POST', '/v1/file_uploads'],
    ['POST', '/v1/oauth/token'],
    ['GET', `/v1/pages/${id}/properties/title`],
    ['GET', `/v1/pages/${id}/../../comments`],
    ['GET', '/v1/pages/not-an-id'],
    ['get', `/v1/pages/${id}`],
    ['POST', `/v1/databases/${id}/query/`],
    ['POST', '/v1/search?x=1'],
  ])('refuses %s %s', (method, path) => {
    expect(notionReadOperation(method, path)).toBeNull();
  });

  it('refuses a request outside the allowlist before any network use', async () => {
    const { notion, fake, diagnostics } = client();
    for (const [method, path] of [['PATCH', `/v1/pages/${id}`], ['POST', '/v1/pages'], ['DELETE', `/v1/blocks/${id}`], ['PATCH', `/v1/blocks/${id}/children`]] as const) {
      expect(await code(notion.read(method, path, { archived: true }))).toBe('endpoint_not_allowed');
    }
    expect(fake.calls).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('keeps every Notion source free of write methods and of a second network exit', () => {
    const files = apiSourceFilesNamed(/^notion.*\.ts$/u);
    const sources = files.map(path => basename(path));
    expect(sources.sort()).toEqual(['notionAutonomousRead.ts', 'notionClient.ts', 'notionConversation.ts', 'notionLoopReader.ts', 'notionSource.ts', 'notionText.ts']);
    for (const path of files) {
      const name = basename(path);
      const text = readFileSync(path, 'utf8');
      expect(text, name).not.toMatch(/['"`](?:PATCH|PUT|DELETE)['"`]/u);
      if (name !== 'notionClient.ts') {
        expect(text, name).not.toMatch(/\bfetch\s*\(|api\.notion\.com|node:https?|\.fetcher\b/u);
        // Only the typed read methods are used outside the client.
        expect(text, name).not.toMatch(/\.read\(/u);
      }
    }
    const transport = readApiSource('notionClient.ts');
    expect(transport.match(/this\.fetcher\(/gu)).toHaveLength(1);
  });
});

describe('Notion read client', () => {
  it('sends the token, the pinned version, and only the bounded read body', async () => {
    const { notion, fake } = client();
    await notion.search('シナリオ', 20);
    await notion.blockChildren(dashed, 'cursor-2', 100);
    await notion.queryDatabase(NOTION_FIXTURE_IDS.characterDatabase, null, 50);
    expect(NOTION_API_VERSION).toBe('2022-06-28');
    expect(fake.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/search', `GET /v1/blocks/${id}/children`, `POST /v1/databases/${NOTION_FIXTURE_IDS.characterDatabase}/query`,
    ]);
    for (const call of fake.calls) {
      expect(call.headers.Authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
      expect(call.headers['Notion-Version']).toBe('2022-06-28');
    }
    expect(fake.calls[0]!.body).toEqual({ query: 'シナリオ', page_size: 20, sort: { direction: 'descending', timestamp: 'last_edited_time' } });
    expect(fake.calls[1]!.query).toEqual({ page_size: '100', start_cursor: 'cursor-2' });
    expect(fake.calls[2]!.body).toEqual({ page_size: 50 });
  });

  it('refuses an id that is not a Notion id', async () => {
    const { notion, fake } = client();
    expect(await code(notion.page('../comments'))).toBe('invalid_id');
    expect(await code(notion.blockChildren('abc', null, 10))).toBe('invalid_id');
    expect(fake.calls).toEqual([]);
    expect(normalizedNotionId(dashed.toUpperCase())).toBe(id);
    expect(normalizedNotionId(`${id}0`)).toBeNull();
  });

  it('waits for Retry-After once, then gives up', async () => {
    const { notion, fake, waits, diagnostics } = client();
    fake.queue.push(notionJson({}, 429, { 'retry-after': '1' }));
    await expect(notion.page(id)).resolves.toMatchObject({ object: 'page' });
    expect(waits).toEqual([1_000]);
    expect(diagnostics).toEqual([{ operation: 'page', status: '2xx', attempts: 2, milliseconds: expect.any(Number) }]);

    fake.queue.push(notionJson({}, 429, { 'retry-after': '1' }), notionJson({}, 429, { 'retry-after': '1' }));
    expect(await code(notion.page(id))).toBe('rate_limited');
    expect(waits).toEqual([1_000, 1_000]);

    // A long Retry-After is not waited for.
    fake.queue.push(notionJson({}, 429, { 'retry-after': '120' }));
    expect(await code(notion.page(id))).toBe('rate_limited');
    expect(waits).toEqual([1_000, 1_000]);
    expect(diagnostics.at(-1)).toMatchObject({ status: '429', attempts: 1 });
  });

  it('maps failures to codes without reading the error body', async () => {
    const { notion, fake, diagnostics } = client();
    fake.queue.push(notionJson({ message: 'secret detail' }, 401), notionJson({}, 403), notionJson({}, 404), notionJson({}, 500),
      new Response('not json', { status: 200 }), notionJson([1], 200));
    expect(await code(notion.page(id))).toBe('unauthorized');
    expect(await code(notion.page(id))).toBe('unauthorized');
    expect(await code(notion.page(id))).toBe('not_found');
    expect(await code(notion.page(id))).toBe('http_error');
    expect(await code(notion.page(id))).toBe('malformed');
    expect(await code(notion.page(id))).toBe('malformed');
    expect(diagnostics.map(item => item.status)).toEqual(['4xx', '4xx', '4xx', '5xx', 'malformed', 'malformed']);
  });

  it('stops at the size cap, the timeout, and a passed deadline', async () => {
    const big = client({ maximumResponseBytes: 200 });
    expect(await code(big.notion.page(id))).toBe('too_large');

    const hanging = client({
      timeoutMilliseconds: 20,
      fetch: ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch,
    });
    expect(await code(hanging.notion.page(id))).toBe('timeout');

    const late = client();
    expect(await code(late.notion.page(id, { deadline: Date.now() - 1 }))).toBe('timeout');
    expect(late.fake.calls).toEqual([]);

    const broken = client({ fetch: (async () => { throw new Error('socket'); }) as typeof fetch });
    expect(await code(broken.notion.page(id))).toBe('network');
  });

  it('reports diagnostics with no id, title, query, or token', async () => {
    const { notion, diagnostics } = client();
    await notion.search('月野アオイ', 20);
    await notion.page(id);
    const text = JSON.stringify(diagnostics);
    expect(Object.keys(diagnostics[0]!).sort()).toEqual(['attempts', 'milliseconds', 'operation', 'status']);
    expect(text).not.toContain(id);
    expect(text).not.toContain('月野');
    expect(text).not.toContain(FIXTURE_TOKEN);
  });

  it('treats a missing or malformed token as not connected', () => {
    expect(usableNotionToken(undefined)).toBeNull();
    expect(usableNotionToken('  ')).toBeNull();
    expect(usableNotionToken('short')).toBeNull();
    expect(usableNotionToken('has a space inside the token value')).toBeNull();
    expect(usableNotionToken(`${FIXTURE_TOKEN}\r\nX-Injected: 1`)).toBeNull();
    expect(usableNotionToken(` ${FIXTURE_TOKEN} `)).toBe(FIXTURE_TOKEN);
  });
});
