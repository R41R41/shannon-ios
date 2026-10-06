import { isIP } from 'node:net';
import { isPrivateOrReservedAddress } from './ipSafety.js';
import type { WorldItemInput } from './store/worldStore.js';

export interface SyndicationFeedOptions {
  readonly allowedCategories?: readonly string[];
}

export function parseSyndicationFeed(
  xml: string,
  baseURL: URL,
  options: SyndicationFeedOptions = {},
): WorldItemInput[] {
  const allowedCategories = new Set(options.allowedCategories?.map(category => category.trim()).filter(Boolean) ?? []);
  const blocks = [...xml.matchAll(/<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/giu)]
    // Scan beyond the return limit so a focused source is not starved when
    // unrelated categories happen to occupy the top of a mixed feed.
    .slice(0, 60)
    .map(match => match[0]);
  return blocks.flatMap(block => {
    const categories = [
      ...tags(block, 'category').map(clean),
      ...attributes(block, 'category', 'term').map(clean),
    ].filter(Boolean);
    if (allowedCategories.size > 0 && !categories.some(category => allowedCategories.has(category))) return [];
    const title = bounded(clean(tag(block, 'title')), 500);
    const rawURL = preferredLink(block) ?? clean(tag(block, 'link'));
    const url = safeWebURL(rawURL, baseURL);
    if (!title || !url) return [];
    const externalId = bounded(clean(tag(block, 'id')) || clean(tag(block, 'guid')) || url, 1_000);
    if (!externalId) return [];
    const summary = bounded(clean(tag(block, 'summary')) || clean(tag(block, 'description')), 4_000);
    const publishedAt = validTimestamp(
      clean(tag(block, 'published'))
      || clean(tag(block, 'pubDate'))
      || clean(tag(block, 'dc:date'))
      || clean(tag(block, 'updated')),
    );
    const atomAuthors = tags(block, 'name').map(clean).filter(Boolean);
    const author = bounded(clean(tag(block, 'dc:creator')) || (
      atomAuthors.length > 3 ? `${atomAuthors.slice(0, 3).join(', ')} ほか` : atomAuthors.join(', ')
    ), 200);
    return [{
      externalId,
      title,
      url,
      ...(summary ? { summary } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(author ? { author } : {}),
    }];
  }).slice(0, 15);
}

function safeWebURL(value: string, baseURL: URL): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(decodeEntities(value), baseURL);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return null;
    if (isIP(hostname) && isPrivateOrReservedAddress(hostname)) return null;
    url.hash = '';
    return url.href.length <= 2_000 ? url.href : null;
  } catch {
    return null;
  }
}

function validTimestamp(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function tag(value: string, name: string): string {
  return value.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'iu'))?.[1] ?? '';
}

function tags(value: string, name: string): string[] {
  return [...value.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'giu'))]
    .map(match => match[1] ?? '');
}

function attribute(value: string, name: string, attributeName: string): string | null {
  return value.match(new RegExp(`<${name}\\b[^>]*?\\s${attributeName}\\s*=["']([^"']+)["']`, 'iu'))?.[1] ?? null;
}

function attributes(value: string, name: string, attributeName: string): string[] {
  return [...value.matchAll(new RegExp(`<${name}\\b[^>]*?\\s${attributeName}\\s*=["']([^"']+)["'][^>]*>`, 'giu'))]
    .map(match => match[1] ?? '');
}

function preferredLink(value: string): string | null {
  const elements = [...value.matchAll(/<link\b[^>]*>/giu)].map(match => match[0]);
  const preferred = elements.find(element => {
    const relation = attribute(element, 'link', 'rel')?.trim().toLowerCase();
    return !relation || relation === 'alternate';
  });
  return preferred ? attribute(preferred, 'link', 'href') : null;
}

function clean(value: string): string {
  return decodeEntities(value.replace(/<!\[CDATA\[|\]\]>/gu, ''))
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&nbsp;/giu, ' ')
    .replace(/&#(\d+);/gu, (_, digits: string) => scalar(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) => scalar(Number.parseInt(digits, 16)));
}

function scalar(value: number): string {
  try {
    const validXmlScalar = value === 0x9 || value === 0xa || value === 0xd
      || (value >= 0x20 && value <= 0xd7ff)
      || (value >= 0xe000 && value <= 0x10ffff);
    return Number.isInteger(value) && validXmlScalar ? String.fromCodePoint(value) : '';
  } catch {
    return '';
  }
}

function bounded(value: string, maximum: number): string | null {
  return value ? value.slice(0, maximum) : null;
}
