import type Anthropic from '@anthropic-ai/sdk';
import type { ShannonWebSource } from './chatModelContract.js';
import { serverEnvironment } from '../config/serverEnvironment.js';
import { ownerTimeZone } from '../time/localDate.js';

type Environment = Readonly<Record<string, string | undefined>>;
import { webSearchFailure, type WebSearchResult } from './webSearch.js';

/**
 * Deep research (2026-10-13): the optional narrowing of one native web search and the full-page read of one URL with the native
 * web fetch tool. Both are bounded external reads; their output is lower-trust data. A passage is a short span the provider cited
 * from a page it actually returned, with that page's URL: never a span the model wrote.
 */
export type WebRecency = 'day' | 'week' | 'month' | 'year';
/**
 * `home`: the owner's home area (`SHANNON_OWNER_HOME_LOCATION`, approximate, for local results; `japan` while it is unset);
 * `japan`: country only; `none`: no location.
 */
export type WebLocality = 'home' | 'japan' | 'none';
export const WEB_LOCALITIES: readonly WebLocality[] = Object.freeze(['home', 'japan', 'none']);

export interface WebSearchFilters {
  /** At most eight plain hostnames; results only from these. Never together with `blockedDomains`. */
  allowedDomains?: readonly string[];
  /** At most eight plain hostnames; results never from these. */
  blockedDomains?: readonly string[];
  locality?: WebLocality;
  /** A hint to prefer recent pages (the native tool has no date filter): written into the query, never enforced. */
  recency?: WebRecency;
}

export interface WebPassage { url: string; title: string; quote: string }

export interface WebReadInput { scopeKey: string; url: string; focus?: string; signal?: AbortSignal; milliseconds?: number }
export type WebReadOperation = (input: WebReadInput) => Promise<WebSearchResult>;

export const WEB_PASSAGE_QUOTE_CHARACTERS = 300;
export const WEB_PASSAGES_MAXIMUM = 8;
/** Approximate cap of page text the fetch tool puts in context (web pages; PDFs are not capped by the provider). */
export const WEB_READ_CONTENT_TOKENS = 12_000;

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/u;

/** A plain hostname the server tools accept: lowercase, at least one dot, no IP literal, no scheme, path or port. */
export function webDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/^\*\./u, '');
  if (!HOST.test(host) || /^[0-9.]+$/u.test(host) || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  return host;
}

/** A URL a page read may fetch: http(s), no credentials, a public-looking hostname, at most 2,048 characters. */
export function webReadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !webDomain(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

/** The approximate location the native search tool takes for `locality`. */
export function webUserLocation(locality: WebLocality | undefined, environment: Environment = serverEnvironment()): Anthropic.UserLocation | null {
  const timezone = ownerTimeZone(environment);
  if (locality === 'home') return homeUserLocation(environment) ?? { type: 'approximate', country: 'JP', timezone };
  if (locality === 'japan') return { type: 'approximate', country: 'JP', timezone };
  return null;
}

const PREFECTURE = /^(東京都|北海道|(?:京都|大阪)府|[^\s都道府県]{2,3}県)(.+)$/u;

/**
 * The owner's home as the search tool's approximate location: `SHANNON_OWNER_HOME_LOCATION` is `lat,lon,label` (shared with the
 * weather reads); the label is the city (`西東京市`), or prefecture and city (`東京都西東京市`). `SHANNON_OWNER_HOME_REGION`
 * (`東京都`) names the region when the label does not. Null when no home is configured.
 */
export function homeUserLocation(environment: Environment): Anthropic.UserLocation | null {
  const parts = environment.SHANNON_OWNER_HOME_LOCATION?.split(',').map(part => part.trim()) ?? [];
  if (parts.length < 2 || !parts.slice(0, 2).every(part => /^-?\d{1,3}(?:\.\d+)?$/u.test(part))) return null;
  const label = parts.slice(2).join(',').trim().slice(0, 60), split = label.match(PREFECTURE);
  const city = split?.[2] ?? label, region = split?.[1] ?? environment.SHANNON_OWNER_HOME_REGION?.trim().slice(0, 60);
  return { type: 'approximate', ...(city ? { city } : {}), ...(region ? { region } : {}), country: 'JP', timezone: ownerTimeZone(environment) };
}

const RECENCY_HINT: Readonly<Record<WebRecency, string>> = Object.freeze({
  day: '直近24時間以内', week: '直近1週間以内', month: '直近1か月以内', year: '直近1年以内',
});

/** The recency hint as a line after the query. */
export function webRecencyLine(recency: WebRecency | undefined): string {
  return recency ? `\n（できるだけ${RECENCY_HINT[recency]}の情報を優先し、ページの日付を確かめる）` : '';
}

/** A passage list: unique (url, quote), bounded, quotes clipped. */
export function boundedPassages(passages: readonly WebPassage[]): WebPassage[] {
  const seen = new Set<string>();
  const kept: WebPassage[] = [];
  for (const passage of passages) {
    const quote = passage.quote.replace(/\s+/gu, ' ').trim().slice(0, WEB_PASSAGE_QUOTE_CHARACTERS);
    const key = `${passage.url}\n${quote}`;
    if (!quote || seen.has(key)) continue;
    seen.add(key);
    kept.push({ url: passage.url, title: passage.title.slice(0, 200), quote });
    if (kept.length === WEB_PASSAGES_MAXIMUM) break;
  }
  return kept;
}

/**
 * Several reads of one reply or one task step as one result: results if any read found something (their sources and passages
 * together), else the first failure that is not `unknown`, else unknown. Text is each read's text, separated.
 */
export function mergedWebResults(results: readonly WebSearchResult[]): WebSearchResult | null {
  if (!results.length) return null;
  const found = results.filter(result => result.status === 'results');
  if (!found.length) return results.find(result => result.status !== 'unknown') ?? webSearchFailure('unknown');
  if (found.length === 1) return found[0]!;
  const sources: ShannonWebSource[] = [];
  for (const source of found.flatMap(result => result.sources)) if (!sources.some(kept => kept.url === source.url)) sources.push(source);
  const passages = boundedPassages(found.flatMap(result => result.passages ?? []));
  return { status: 'results', text: found.map(result => result.text).join('\n\n---\n\n').slice(0, 16_000), sources: sources.slice(0, 16),
    ...(passages.length ? { passages } : {}) };
}
