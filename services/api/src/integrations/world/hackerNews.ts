import { isIP } from 'node:net';
import { isPrivateOrReservedAddress } from './ipSafety.js';
import type { WorldItemInput } from './store/worldStore.js';

const HN_EPOCH_SECONDS = 1_167_609_600;
const MAX_UNIX_SECONDS = 4_102_444_800;

export function parseHackerNewsTopIds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze([...new Set(value.filter(id => Number.isSafeInteger(id) && Number(id) > 0) as number[])].slice(0, 10));
}

export function parseHackerNewsItems(
  rows: readonly unknown[],
  requestedIds: readonly number[],
): readonly WorldItemInput[] {
  const byId = new Map<number, Record<string, unknown>>();
  for (const value of rows) {
    const row = object(value);
    const id = integer(row?.id);
    if (id !== null && !byId.has(id)) byId.set(id, row!);
  }
  return Object.freeze(requestedIds.flatMap(requestedId => {
    const row = byId.get(requestedId);
    const title = cleanText(row?.title, 500);
    const time = integer(row?.time);
    if (!row || row.type !== 'story' || row.deleted === true || row.dead === true || !title
      || time === null || time < HN_EPOCH_SECONDS || time > MAX_UNIX_SECONDS) return [];
    const externalURL = safePublicWebURL(string(row.url));
    const score = nonnegativeInteger(row.score);
    const comments = nonnegativeInteger(row.descendants);
    const summary = [
      score === null ? null : `${score} points`,
      comments === null ? null : `${comments} comments`,
    ].filter(Boolean).join('・') || 'Hacker Newsのトップストーリー';
    const author = cleanText(row.by, 80);
    return [{
      externalId: String(requestedId),
      title,
      url: externalURL ?? `https://news.ycombinator.com/item?id=${requestedId}`,
      summary,
      ...(author ? { author } : {}),
      publishedAt: new Date(time * 1_000).toISOString(),
    }];
  }));
}

function safePublicWebURL(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || (isIP(hostname) && isPrivateOrReservedAddress(hostname))) return null;
    url.hash = '';
    return url.href.length <= 2_000 ? url.href : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.slice(0, maximum * 4).replace(/<[^>]*>/gu, ' ')
    .replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"').replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_, digits: string) => scalar(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) => scalar(Number.parseInt(digits, 16)))
    .replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned ? [...cleaned].slice(0, maximum).join('') : null;
}

function scalar(value: number): string {
  return Number.isInteger(value) && value >= 0x20 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : '';
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
function integer(value: unknown): number | null { return Number.isSafeInteger(value) ? Number(value) : null; }
function nonnegativeInteger(value: unknown): number | null {
  const result = integer(value);
  return result !== null && result >= 0 ? result : null;
}
