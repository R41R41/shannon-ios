import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';
import { discoverFeedLinks, SQLiteWorldStore, type WorldItemInput, type WorldSource } from './worldStore.js';
import { SQLiteInitiativeStore } from './initiativeStore.js';
import { nextInitiativeDelayMilliseconds } from './initiativeSchedule.js';
import { createConfiguredDailyMindModel, SQLiteDailyMindStore } from './dailyMind.js';
import {
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
  SQLitePushNotificationStore,
} from './pushNotifications.js';

const databasePath = configuredDatabasePath();
const nowISOString = () => new Date().toISOString();
const store = new SQLiteWorldStore(databasePath);
const initiativeStore = new SQLiteInitiativeStore(databasePath);
const stateStore = new SQLiteShannonStore({ path: databasePath, now: nowISOString });
const dailyMindStore = new SQLiteDailyMindStore(databasePath);
const dailyMindModel = createConfiguredDailyMindModel(process.env, stateStore);
const pushStore = new SQLitePushNotificationStore(databasePath);
const pushSender = createConfiguredPushNotificationSender(process.env);
const once = process.argv.includes('--once');
let stopping = false;
let nextInitiativeCheckAt = 0;
const shutdownController = new AbortController();
const requestStop = () => {
  stopping = true;
  shutdownController.abort();
};
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

console.log('Shannon world worker started');
try {
  do {
    const sources = store.dueSources();
    for (const source of sources) {
      if (stopping) break;
      try {
        const items = await fetchSource(source);
        store.recordSuccess(source, items);
        if (source.kind === 'hacker-news') await discoverOneTrialFeed(items, store);
      } catch (error) {
        if (stopping) break;
        store.recordFailure(source, safeCode(error));
      }
    }
    if (stopping) break;
    store.reviewExpiredTrials();
    store.prune();
    const now = Date.now();
    if (now >= nextInitiativeCheckAt) {
      const at = new Date(now).toISOString();
      const dailyFocuses = await dailyMindStore.ensureForKnownScopes(store.latestItems(40), dailyMindModel, at);
      const initiative = initiativeStore.runOnce(at, 'Asia/Tokyo', dailyFocuses);
      nextInitiativeCheckAt = now + nextInitiativeDelayMilliseconds(initiative, at);
      if (initiative.sent > 0) console.log(`Shannon initiative delivered: ${initiative.sent}`);
    }
    const push = await deliverPendingPushNotifications(pushStore, pushSender);
    if (push.attempted > 0) console.log(`Shannon push delivered: ${push.delivered}/${push.attempted}`);
    if (once) break;
    try {
      await delay(sources.length ? 5_000 : 60_000, undefined, { signal: shutdownController.signal });
    } catch (error) {
      if (!stopping) throw error;
    }
  } while (!stopping);
} finally {
  pushStore.close();
  dailyMindStore.close();
  stateStore.close();
  initiativeStore.close();
  store.close();
}

async function fetchSource(source: WorldSource): Promise<readonly WorldItemInput[]> {
  switch (source.kind) {
    case 'weather': return fetchJma(source);
    case 'hacker-news': return fetchHackerNews(source);
    case 'arxiv': return fetchArxiv(source);
    case 'pubmed': return fetchPubmed(source);
    case 'bluesky': return fetchBluesky(source);
    case 'github': return fetchGithub(source);
    case 'rss': return fetchRss(source);
  }
}

async function fetchJma(source: WorldSource): Promise<WorldItemInput[]> {
  const value = await json(source.url);
  if (!Array.isArray(value)) throw new Error('WORLD_JMA_INVALID');
  const first = object(value[0]);
  const publishing = string(first?.publishingOffice) ?? '気象庁';
  const report = string(first?.reportDatetime) ?? new Date().toISOString();
  return [{ externalId: report, title: `${publishing}の天気予報`, url: source.url, summary: JSON.stringify(value).slice(0, 4_000), publishedAt: report, author: publishing }];
}

async function fetchHackerNews(source: WorldSource): Promise<WorldItemInput[]> {
  const ids = await json(`${source.url}/topstories.json`);
  if (!Array.isArray(ids)) throw new Error('WORLD_HN_INVALID');
  const rows = await Promise.all(ids.slice(0, 10).map(id => json(`${source.url}/item/${String(id)}.json`)));
  return rows.flatMap(value => {
    const row = object(value); const id = number(row?.id); const title = string(row?.title);
    if (id === null || !title) return [];
    return [{ externalId: String(id), title, url: string(row?.url) ?? `https://news.ycombinator.com/item?id=${id}`, author: string(row?.by) ?? undefined }];
  });
}

async function fetchArxiv(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('search_query', source.query ?? 'all:AI'); url.searchParams.set('max_results', '10');
  return parseAtom(await text(url.href));
}

async function fetchPubmed(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('db', 'pubmed'); url.searchParams.set('retmode', 'json');
  url.searchParams.set('retmax', '10'); url.searchParams.set('sort', 'pub date'); url.searchParams.set('term', source.query ?? 'artificial intelligence');
  const value = object(await json(url.href)); const result = object(value?.esearchresult); const ids = result?.idlist;
  if (!Array.isArray(ids)) return [];
  return ids.map(id => ({ externalId: String(id), title: `PubMed ${String(id)}`, url: `https://pubmed.ncbi.nlm.nih.gov/${String(id)}/` }));
}

async function fetchBluesky(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('q', source.query ?? 'AI'); url.searchParams.set('limit', '10');
  const value = object(await json(url.href)); const posts = value?.posts;
  if (!Array.isArray(posts)) return [];
  return posts.flatMap(value => {
    const row = object(value); const uri = string(row?.uri); const record = object(row?.record); const body = string(record?.text);
    if (!uri || !body) return [];
    return [{ externalId: uri, title: body.slice(0, 120), url: `https://bsky.app/`, summary: body }];
  });
}

async function fetchGithub(source: WorldSource): Promise<WorldItemInput[]> {
  const value = await json(source.url, { 'user-agent': 'Shannon/0.1' });
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap(value => {
    const row = object(value); const id = number(row?.id); const title = string(row?.name) ?? string(row?.tag_name); const url = string(row?.html_url);
    return id !== null && title && url ? [{ externalId: String(id), title, url, summary: string(row?.body) ?? undefined, publishedAt: string(row?.published_at) ?? undefined }] : [];
  });
}

async function fetchRss(source: WorldSource): Promise<WorldItemInput[]> {
  return parseAtom(await text(source.url));
}

function parseAtom(xml: string): WorldItemInput[] {
  const blocks = [...xml.matchAll(/<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/giu)].slice(0, 15).map(match => match[0]);
  return blocks.flatMap(block => {
    const title = clean(tag(block, 'title')); const url = attribute(block, 'link', 'href') ?? clean(tag(block, 'link'));
    const id = clean(tag(block, 'id')) || clean(tag(block, 'guid')) || url; if (!title || !id || !url) return [];
    return [{ externalId: id, title, url, summary: clean(tag(block, 'summary')) || clean(tag(block, 'description')) || undefined, publishedAt: clean(tag(block, 'published')) || clean(tag(block, 'pubDate')) || undefined }];
  });
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: requestSignal(15_000) });
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`); return response.json();
}
async function text(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'Shannon/0.1' }, signal: requestSignal(15_000) });
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`); return response.text();
}
function tag(value: string, name: string): string { return value.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'iu'))?.[1] ?? ''; }
function attribute(value: string, name: string, attributeName: string): string | null { return value.match(new RegExp(`<${name}\\b[^>]*${attributeName}=["']([^"']+)["']`, 'iu'))?.[1] ?? null; }
function clean(value: string): string { return value.replace(/<!\[CDATA\[|\]\]>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ').trim(); }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function safeCode(error: unknown): string { return error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/giu, '_').slice(0, 120) : 'WORLD_UNKNOWN'; }

async function discoverOneTrialFeed(items: readonly WorldItemInput[], worldStore: SQLiteWorldStore): Promise<void> {
  for (const item of items.slice(0, 2)) {
    try {
      const pageURL = new URL(item.url);
      const html = await safeHtml(pageURL);
      const feed = discoverFeedLinks(html, pageURL)[0];
      if (!feed || !(await publicURL(feed))) continue;
      worldStore.proposeSubscription(feed.href, pageURL.hostname, `Hacker Newsの「${item.title.slice(0, 140)}」から見つけた`);
      return;
    } catch {
      // Exploration failures are intentionally isolated from the approved source fetch.
    }
  }
}

async function safeHtml(url: URL, redirectCount = 0): Promise<string> {
  if (!(await publicURL(url))) throw new Error('WORLD_PRIVATE_URL');
  const response = await fetch(url, {
    headers: { 'user-agent': 'Shannon/0.1' }, redirect: 'manual', signal: requestSignal(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= 3) throw new Error('WORLD_REDIRECT_LIMIT');
    const location = response.headers.get('location');
    if (!location) throw new Error('WORLD_REDIRECT_INVALID');
    return safeHtml(new URL(location, url), redirectCount + 1);
  }
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) throw new Error('WORLD_NOT_HTML');
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > 1_500_000) throw new Error('WORLD_PAGE_TOO_LARGE');
  const body = await response.text();
  if (body.length > 1_500_000) throw new Error('WORLD_PAGE_TOO_LARGE');
  return body;
}

function requestSignal(timeoutMilliseconds: number): AbortSignal {
  return AbortSignal.any([shutdownController.signal, AbortSignal.timeout(timeoutMilliseconds)]);
}

async function publicURL(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
  const directFamily = isIP(hostname);
  const addresses = directFamily ? [{ address: hostname, family: directFamily }] : await lookup(hostname, { all: true });
  return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
}

function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(item => !Number.isInteger(item))) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] ?? 0) >= 224;
}
