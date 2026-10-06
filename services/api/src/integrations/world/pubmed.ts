import type { WorldItemInput } from './store/worldStore.js';

const PUBMED_ID = /^\d{1,20}$/u;

export function parsePubmedSearchIds(value: unknown): readonly string[] {
  const result = object(object(value)?.esearchresult);
  const ids = result?.idlist;
  if (!Array.isArray(ids)) return [];
  return Object.freeze([...new Set(ids.flatMap(id => {
    const normalized = scalar(id);
    return normalized && PUBMED_ID.test(normalized) ? [normalized] : [];
  }))].slice(0, 10));
}

export function pubmedSummaryURL(searchURL: URL, ids: readonly string[]): URL {
  const url = new URL('esummary.fcgi', searchURL);
  url.search = '';
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('retmode', 'json');
  url.searchParams.set('version', '2.0');
  url.searchParams.set('id', ids.filter(id => PUBMED_ID.test(id)).slice(0, 10).join(','));
  return url;
}

export function parsePubmedSummaries(value: unknown, requestedIds: readonly string[]): readonly WorldItemInput[] {
  const result = object(object(value)?.result);
  if (!result) return [];
  const seen = new Set<string>();
  return Object.freeze(requestedIds.flatMap(requestedId => {
    if (!PUBMED_ID.test(requestedId) || seen.has(requestedId)) return [];
    seen.add(requestedId);
    const row = object(result[requestedId]);
    if (!row || scalar(row.uid) !== requestedId) return [];
    const title = cleanText(row.title);
    if (!title) return [];
    const authors = Array.isArray(row.authors)
      ? row.authors.flatMap(value => {
        const name = cleanText(object(value)?.name);
        return name ? [name] : [];
      })
      : [];
    const author = authors.length > 3
      ? `${authors.slice(0, 3).join(', ')} ほか`
      : authors.join(', ');
    const journal = cleanText(row.fulljournalname) ?? cleanText(row.source);
    const publishedAt = pubmedDate(row.epubdate) ?? pubmedDate(row.sortpubdate) ?? pubmedDate(row.pubdate);
    if (!publishedAt) return [];
    return [{
      externalId: requestedId,
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${requestedId}/`,
      ...(journal ? { summary: journal } : {}),
      ...(author ? { author } : {}),
      publishedAt,
    }];
  }));
}

function pubmedDate(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const numeric = /^(\d{4})(?:[/-](\d{1,2})(?:[/-](\d{1,2}))?)?(?:\s+(\d{1,2}):(\d{2}))?$/u.exec(raw);
  if (numeric) {
    return checkedUTCDate(
      Number(numeric[1]), Number(numeric[2] ?? 1), Number(numeric[3] ?? 1),
      Number(numeric[4] ?? 0), Number(numeric[5] ?? 0),
    );
  }
  const named = /^(\d{4})\s+([A-Za-z]{3})(?:\s+(\d{1,2}))?$/u.exec(raw);
  if (!named) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .findIndex(candidate => candidate.toLowerCase() === named[2]!.toLowerCase()) + 1;
  return month > 0 ? checkedUTCDate(Number(named[1]), month, Number(named[3] ?? 1), 0, 0) : null;
}

function checkedUTCDate(year: number, month: number, day: number, hour: number, minute: number): string | null {
  if (year < 1800 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const raw = value;
  const cleaned = raw.slice(0, 8_000)
    .replace(/<[^>]*>/gu, '')
    .replace(/&#(\d+);/gu, (_, digits: string) => entity(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) => entity(Number.parseInt(digits, 16)))
    .replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"').replace(/&apos;/giu, "'").replace(/&nbsp;/giu, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ').trim();
  return cleaned || null;
}

function entity(codePoint: number): string {
  const validScalar = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0x10ffff);
  return Number.isInteger(codePoint) && validScalar
    ? String.fromCodePoint(codePoint)
    : '';
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
