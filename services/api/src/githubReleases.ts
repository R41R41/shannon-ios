import type { WorldItemInput } from './worldStore.js';

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;
const REPOSITORY = /^[a-z0-9._-]{1,100}$/iu;

export function configuredGithubRepositories(value: string): readonly string[] {
  const repositories = value.split(',').flatMap(candidate => {
    const normalized = normalizeGithubRepository(candidate);
    return normalized ? [normalized] : [];
  });
  return Object.freeze([...new Set(repositories)].slice(0, 10));
}

export function normalizeGithubRepository(value: string): string | null {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || !OWNER.test(parts[0]!) || !REPOSITORY.test(parts[1]!) || ['.', '..'].includes(parts[1]!)) return null;
  return `${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}

export function parseGithubReleases(value: unknown, repository: string): readonly WorldItemInput[] {
  const normalizedRepository = normalizeGithubRepository(repository);
  if (!normalizedRepository || !Array.isArray(value)) return [];
  const seen = new Set<number>();
  return Object.freeze(value.flatMap(candidate => {
    const row = object(candidate);
    const id = positiveInteger(row?.id);
    const tag = clean(row?.tag_name, 200);
    const title = clean(row?.name, 500) ?? tag;
    const publishedAt = isoDate(row?.published_at);
    const htmlURL = githubReleaseURL(row?.html_url, normalizedRepository);
    const author = clean(object(row?.author)?.login, 100);
    if (!row || id === null || seen.has(id) || row.draft !== false || !tag || !title || !publishedAt || !htmlURL) return [];
    if (!author) return [];
    seen.add(id);
    const body = clean(row.body, 4_000);
    const summary = [row.prerelease === true ? 'プレリリース' : null, body].filter(Boolean).join('\n');
    return [{
      externalId: String(id), title, url: htmlURL,
      ...(summary ? { summary } : {}),
      author,
      publishedAt,
    }];
  }).slice(0, 10));
}

function githubReleaseURL(value: unknown, repository: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const prefix = `/${repository}/releases/`;
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password
      || !url.pathname.toLowerCase().startsWith(prefix) || url.pathname.length <= prefix.length) return null;
    url.hash = '';
    return url.href.length <= 2_000 ? url.href : null;
  } catch {
    return null;
  }
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function clean(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\r\n?/gu, '\n').trim();
  return result ? [...result].slice(0, maximum).join('') : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
