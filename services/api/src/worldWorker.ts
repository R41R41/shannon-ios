import { setTimeout as delay } from 'node:timers/promises';
import { observeAsync, observeSync, observerHandoff, withObserverRun } from './infra/observer/observerContext.js';
import { startObserverPublisher } from './infra/observer/store/observerStore.js';
import { configuredOwnerScope } from './infra/config/ownerScope.js';
import { mindSwitches } from '@shannon/mind';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { configuredDatabasePath, SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';
import { discoverFeedLinks, SQLiteWorldStore, type WorldItemInput, type WorldSource } from './integrations/world/store/worldStore.js';
import { summarizeJmaForecast } from './integrations/world/jmaForecast.js';
import { parseSyndicationFeed } from './integrations/world/syndicationFeed.js';
import { parsePubmedSearchIds, parsePubmedSummaries, pubmedSummaryURL } from './integrations/world/pubmed.js';
import { parseBlueskyPosts } from './integrations/world/bluesky.js';
import { parseHackerNewsItems, parseHackerNewsTopIds } from './integrations/world/hackerNews.js';
import { parseArxivFeed, prepareArxivQuery } from './integrations/world/arxiv.js';
import { parseGithubReleases } from './integrations/world/githubReleases.js';
import { isPrivateOrReservedAddress } from './integrations/world/ipSafety.js';
import { SQLiteInitiativeStore } from './surfaces/outreach/store/initiativeStore.js';
import { configuredMindInbox } from './wiring/mindInboxWiring.js';
import { configuredProactiveGate } from './wiring/proactiveGateWiring.js';
import { configuredMorningBrief } from './wiring/dailyReadWiring.js';
import { configuredWithheldActions } from './wiring/withheldStoreWiring.js';
import { nextInitiativeDelayMilliseconds } from './surfaces/outreach/initiativeSchedule.js';
import { createConfiguredDailyMindModel, SQLiteDailyMindStore } from './mind/action/respond/dailyMind.js';
import { configuredCommitmentLineWriter } from './mind/action/respond/commitmentLineModel.js';
import { switchOn } from '@shannon/switches';
import { OWNER_CALL_LIMITS } from './mind/perception/ownerCallElsewhere.js';
import { commitmentLinePreparer } from './wiring/commitmentLinesWiring.js';
import { SQLiteInitiativeSources } from './surfaces/outreach/store/initiativeSources.js';
import { SQLiteBodyStore } from './surfaces/body/store/bodyStore.js';
import { BODY_LIMITS } from './contracts/bodyContract.js';
import {
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
  SQLitePushNotificationStore,
} from './surfaces/outreach/pushNotifications.js';

const databasePath = configuredDatabasePath();
const observation=startObserverPublisher(databasePath);
const observationScope=configuredOwnerScope(process.env);
const nowISOString = () => new Date().toISOString();
const store = new SQLiteWorldStore(databasePath);
// Syzygy ADR-0008 stage 3 (owner answer 2): the proactive gate her initiative passes where it is written; a hold is a withheld action and a
// notice for the conversation. SHANNON_PROACTIVE_GATE=off (or SHANNON_ADR8_STAGE3=off): none of it, and the initiative is as it was.
// Its withheld actions are only the gate's holds: opened with the gate alone (stage 3 review L1), never with stage 2 alone.
const withheldActions = mindSwitches(process.env).proactiveGate
  ? configuredWithheldActions(process.env, { databasePath, createsSchema: false, log: line => console.log(line) }) : null;
const mindInbox = configuredMindInbox(process.env, { databasePath, log: line => console.log(line) });
const proactiveGate = configuredProactiveGate(process.env, {
  databasePath, source: 'worker', withheld: withheldActions?.withheld.sink ?? null, emit: mindInbox?.emit ?? null, log: line => console.log(line),
});
// SHANNON_PROMISE_ON_TIME (default on): a due promise is told at its time by its own pass below, apart from the topic loop's day
// slot, its 90-minute conversation cooldown and its 15-minute recheck (2026-10-14: a 09:20 promise was told at 10:07). Off, as before.
const promisesOnTime = switchOn(process.env, 'SHANNON_PROMISE_ON_TIME');
const initiativeStore = new SQLiteInitiativeStore(databasePath, undefined, proactiveGate?.gate ?? null, { promisesOnTime });
const stateStore = new SQLiteShannonStore({ path: databasePath, now: nowISOString });
const dailyMindStore = new SQLiteDailyMindStore(databasePath);
const dailyMindDelegate = createConfiguredDailyMindModel(process.env, stateStore);
const dailyMindModel:typeof dailyMindDelegate={generate:input=>withObserverRun({scopeKey:input.scopeKey,surface:'world-focus'},()=>observeAsync('context',{operation:'daily-focus',candidate:input.candidate!==null,interestCount:input.recentInterests.length},()=>dailyMindDelegate.generate(input),value=>({selected:value!==null})))};
// A promise's notice in her own words (owner decision 2026-10-14): written at the moment it is due, from its facts; the neutral
// factual line when it cannot be written or trusted. With anyone else at her body (a stream included), the private-safe wording.
const initiativeSources = new SQLiteInitiativeSources(databasePath);
const bodyStore = new SQLiteBodyStore(databasePath);
const commitmentLines = commitmentLinePreparer({
  writer: configuredCommitmentLineWriter(process.env, stateStore, undefined, line => console.log(line)),
  scopeKey: configuredOwnerScope(process.env), timeZone: 'Asia/Tokyo',
  snapshot: scopeKey => stateStore.snapshot(scopeKey), delivered: (scopeKey, itemId) => initiativeSources.delivered(scopeKey, itemId),
  others: (scopeKey, at) => bodyStore.othersPresent(scopeKey, at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds),
  log: line => console.log(line),
});
/** A call with her under way: the newest call event of his devices within a call's longest reach started one. */
const inCallWithHer = (scopeKey: string, at: string) => bodyStore.latestOfTypes(scopeKey, ['callStarted', 'callEnded'],
  new Date(Date.parse(at) - OWNER_CALL_LIMITS.reportedCallMaximumMilliseconds).toISOString(), at)?.type === 'callStarted';
const pushStore = new SQLitePushNotificationStore(databasePath);
// SHANNON_MORNING_BRIEF (default off): today's weather, schedule and a few of the world's headlines as the morning's initiative.
const morningBrief = configuredMorningBrief(process.env, { databasePath, now: nowISOString, log: line => console.log(line),
  headlines: () => store.latestItems(12).filter(item => !/jma\.go\.jp/u.test(item.url)).slice(0, 3).map(item => ({ title: item.title, url: item.url })) });
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
    if (promisesOnTime) {
      // First on every pass (at most a minute apart), before any source is fetched: a promise does not wait for the world.
      try {
        const at = nowISOString();
        const lines = await commitmentLines(at, shutdownController.signal).catch(() => new Map<string, string>());
        // Never over him: while one of his devices reports a call with her, a promise is text only (`promiseNotices.ts`).
        const told = initiativeStore.deliverDuePromises(at, 'Asia/Tokyo', lines, inCallWithHer);
        if (told.sent > 0) console.log(`Shannon promise delivered: ${told.sent}`);
      } catch (error) {
        if (stopping) break;
        console.log(`Shannon promise pass failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    const sources = store.dueSources();
    for (const source of sources) {
      if (stopping) break;
      try {
        const items = await withObserverRun({scopeKey:observationScope,surface:'world-source'},async()=>{
          const found=await observeAsync('perception',{sourceKind:source.kind},()=>fetchSource(source),value=>({itemCount:value.length}));
          observerHandoff('perception','store',{itemCount:found.length});
          observeSync('store',{operation:'world-source'},()=>store.recordSuccess(source,found),()=>({itemCount:found.length}));
          return found;
        });
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
      const promises = promisesOnTime ? new Map<string, string>() : await commitmentLines(at, shutdownController.signal).catch(() => new Map<string, string>());
      const initiative = initiativeStore.runOnce(at, 'Asia/Tokyo', dailyFocuses, morningBrief ? await morningBrief.candidates(at) : undefined, promises);
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
  observation?.close();
  pushStore.close();
  morningBrief?.close();
  dailyMindStore.close();
  initiativeSources.close();
  bodyStore.close();
  stateStore.close();
  initiativeStore.close();
  proactiveGate?.close(); mindInbox?.close(); withheldActions?.close();
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
