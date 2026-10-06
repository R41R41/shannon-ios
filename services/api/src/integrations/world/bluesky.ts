import type { WorldItemInput } from './store/worldStore.js';

const POST_URI = /^at:\/\/([^/?#]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/u;
const DID = /^did:[a-z0-9]+:[a-z0-9._:%-]+$/iu;

export function parseBlueskyPosts(value: unknown): readonly WorldItemInput[] {
  const posts = object(value)?.posts;
  if (!Array.isArray(posts)) return [];
  const seen = new Set<string>();
  return Object.freeze(posts.flatMap(value => {
    const row = object(value);
    const uri = string(row?.uri);
    const match = uri ? POST_URI.exec(uri) : null;
    const record = object(row?.record);
    const body = string(record?.text)?.trim();
    const author = object(row?.author);
    const did = string(author?.did);
    const handle = string(author?.handle)?.toLowerCase();
    if (!uri || !match || !DID.test(match[1]!) || !body || did !== match[1] || !handle || !validHandle(handle)
      || restrictedLabels(row?.labels) || restrictedLabels(author?.labels) || restrictedSelfLabels(record?.labels)
      || seen.has(uri)) return [];
    seen.add(uri);
    const collapsed = body.replace(/\s+/gu, ' ');
    const title = [...collapsed].slice(0, 120).join('');
    const displayName = string(author?.displayName)?.replace(/\s+/gu, ' ').trim();
    const publishedAt = isoDate(string(record?.createdAt)) ?? isoDate(string(row?.indexedAt));
    if (!publishedAt) return [];
    return [{
      externalId: uri,
      title,
      url: `https://bsky.app/profile/${did}/post/${encodeURIComponent(match[2]!)}`,
      summary: body.slice(0, 4_000),
      author: displayName ? `${displayName} (@${handle})` : `@${handle}`,
      publishedAt,
    }];
  }).slice(0, 10));
}

function isoDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function validHandle(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every(label => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

function restrictedLabels(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const active = new Map<string, boolean>();
  for (const candidate of value) {
    const label = object(candidate);
    const name = string(label?.val)?.toLowerCase();
    if (name) active.set(name, label?.neg !== true);
  }
  return [...active].some(([name, enabled]) => enabled && name !== 'bot');
}

function restrictedSelfLabels(value: unknown): boolean {
  const values = object(value)?.values;
  return Array.isArray(values) && values.some(candidate => {
    const name = string(object(candidate)?.val)?.toLowerCase();
    return Boolean(name && name !== 'bot');
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
