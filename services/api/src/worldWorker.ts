import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';
import { discoverFeedLinks, SQLiteWorldStore, type WorldItemInput, type WorldSource } from './worldStore.js';
import { summarizeJmaForecast } from './jmaForecast.js';
import { parseSyndicationFeed } from './syndicationFeed.js';
import { parsePubmedSearchIds, parsePubmedSummaries, pubmedSummaryURL } from './pubmed.js';
import { parseBlueskyPosts } from './bluesky.js';
import { parseHackerNewsItems, parseHackerNewsTopIds } from './hackerNews.js';
import { parseArxivFeed, prepareArxivQuery } from './arxiv.js';
import { parseGithubReleases } from './githubReleases.js';
import { isPrivateOrReservedAddress } from './ipSafety.js';
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
    pushStore.prune();
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
  const forecast = summarizeJmaForecast(await json(source.url));
  return [{
    externalId: forecast.reportDatetime,
    title: forecast.title,
    url: source.url,
    summary: forecast.summary,
    publishedAt: forecast.reportDatetime,
    author: forecast.publishingOffice,
  }];
}

async function fetchHackerNews(source: WorldSource): Promise<WorldItemInput[]> {
  const ids = parseHackerNewsTopIds(await json(`${source.url}/topstories.json`));
  if (!ids.length) throw new Error('WORLD_HN_INVALID');
  const rows = await Promise.all(ids.map(id => json(`${source.url}/item/${id}.json`)));
  return [...parseHackerNewsItems(rows, ids)];
}

async function fetchArxiv(source: WorldSource): Promise<WorldItemInput[]> {
  const url = prepareArxivQuery(source.url, source.query ?? 'all:AI');
  return [...parseArxivFeed(await text(url.href), url)];
}

async function fetchPubmed(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('db', 'pubmed'); url.searchParams.set('retmode', 'json');
  url.searchParams.set('retmax', '10'); url.searchParams.set('sort', 'pub date'); url.searchParams.set('term', source.query ?? 'artificial intelligence');
  const ids = parsePubmedSearchIds(await json(url.href));
  if (!ids.length) return [];
  return [...parsePubmedSummaries(await json(pubmedSummaryURL(url, ids).href), ids)];
}

async function fetchBluesky(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('q', source.query ?? 'AI'); url.searchParams.set('limit', '10'); url.searchParams.set('sort', 'latest');
  return [...parseBlueskyPosts(await json(url.href))];
}

async function fetchGithub(source: WorldSource): Promise<WorldItemInput[]> {
  const url = new URL(source.url); url.searchParams.set('per_page', '10'); url.searchParams.set('page', '1');
  return [...parseGithubReleases(await json(url.href, {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10',
    'user-agent': 'Shannon/0.1',
  }), source.query ?? '')];
}

async function fetchRss(source: WorldSource): Promise<WorldItemInput[]> {
  const allowedCategories = source.query?.startsWith('categories:')
    ? source.query.slice('categories:'.length).split('|').map(item => item.trim()).filter(Boolean)
    : undefined;
  const sourceURL = new URL(source.url);
  const feed = await safeFeed(sourceURL);
  return parseSyndicationFeed(feed.body, feed.url, { allowedCategories });
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: requestSignal(15_000) });
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`);
  const body = await boundedResponseText(response, 2_000_000, 'WORLD_JSON_TOO_LARGE');
  try { return JSON.parse(body) as unknown; } catch { throw new Error('WORLD_JSON_INVALID'); }
}
async function text(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'Shannon/0.1' }, signal: requestSignal(15_000) });
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`);
  return boundedResponseText(response, 2_000_000, 'WORLD_FEED_TOO_LARGE');
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
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
  return boundedResponseText(response, 1_500_000, 'WORLD_PAGE_TOO_LARGE');
}

async function safeFeed(url: URL, redirectCount = 0): Promise<{ readonly body: string; readonly url: URL }> {
  if (!(await publicURL(url))) throw new Error('WORLD_PRIVATE_URL');
  const response = await fetch(url, {
    headers: { 'user-agent': 'Shannon/0.1' }, redirect: 'manual', signal: requestSignal(15_000),
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= 3) throw new Error('WORLD_REDIRECT_LIMIT');
    const location = response.headers.get('location');
    if (!location) throw new Error('WORLD_REDIRECT_INVALID');
    return safeFeed(new URL(location, url), redirectCount + 1);
  }
  if (!response.ok) throw new Error(`WORLD_HTTP_${response.status}`);
  const body = await boundedResponseText(response, 2_000_000, 'WORLD_FEED_TOO_LARGE');
  return { body, url };
}

async function boundedResponseText(response: Response, maximumBytes: number, errorCode: string): Promise<string> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > maximumBytes) throw new Error(errorCode);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

function requestSignal(timeoutMilliseconds: number): AbortSignal {
  return AbortSignal.any([shutdownController.signal, AbortSignal.timeout(timeoutMilliseconds)]);
}

async function publicURL(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  const directFamily = isIP(hostname);
  const addresses = directFamily ? [{ address: hostname, family: directFamily }] : await lookup(hostname, { all: true });
  return addresses.length > 0 && addresses.every(({ address }) => !isPrivateOrReservedAddress(address));
}
