import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateOrReservedAddress } from './ipSafety.js';

/**
 * The bounded reader of public pages for Shannon's own activity (domain `public_read`).
 *
 * It reads one page per call: http and https only, public addresses only (checked again
 * at every redirect), `robots.txt` respected, a size cap and a time limit. It sends no
 * cookie, credential, or form. What comes back is untrusted reference text: the loop
 * hands it to a model as quoted data and never as instructions.
 */
export interface PublicReading {
  /** The address the text finally came from. */
  url: string;
  title: string;
  text: string;
  /** A few links found on the page: places she could read next. */
  links: readonly { title: string; url: string }[];
}

export interface AutonomyPublicReader {
  read(url: string, signal?: AbortSignal): Promise<PublicReading>;
}

export interface PublicReaderOptions {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<readonly { address: string }[]>;
  userAgent?: string;
  maximumBytes?: number;
  timeoutMilliseconds?: number;
  maximumRedirects?: number;
  maximumTextCharacters?: number;
  now?: () => number;
}

export const AUTONOMY_READER_USER_AGENT = 'ShannonStudy/0.1 (personal research reader; respects robots.txt)';
const ROBOTS_AGENT_TOKEN = 'shannonstudy';
const ROBOTS_MAXIMUM_BYTES = 200_000;
const ROBOTS_CACHE_MILLISECONDS = 6 * 60 * 60_000;

export class BoundedPublicReader implements AutonomyPublicReader {
  private readonly fetcher: typeof fetch;
  private readonly lookup: NonNullable<PublicReaderOptions['lookup']>;
  private readonly userAgent: string;
  private readonly maximumBytes: number;
  private readonly timeoutMilliseconds: number;
  private readonly maximumRedirects: number;
  private readonly maximumTextCharacters: number;
  private readonly now: () => number;
  private readonly robots = new Map<string, { rules: RobotsRules | 'deny'; at: number }>();

  constructor(options: PublicReaderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.lookup = options.lookup ?? (hostname => dnsLookup(hostname, { all: true }));
    this.userAgent = options.userAgent ?? AUTONOMY_READER_USER_AGENT;
    this.maximumBytes = options.maximumBytes ?? 1_500_000;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.maximumRedirects = options.maximumRedirects ?? 3;
    this.maximumTextCharacters = options.maximumTextCharacters ?? 6_000;
    this.now = options.now ?? Date.now;
  }

  async read(rawUrl: string, signal?: AbortSignal): Promise<PublicReading> {
    let url = parsedUrl(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      if (!(await this.isPublic(url))) throw new Error('AUTONOMY_READ_NOT_PUBLIC');
      if (!(await this.robotsAllow(url, signal))) throw new Error('AUTONOMY_READ_ROBOTS_DISALLOWED');
      const response = await this.fetcher(url, {
        headers: { 'user-agent': this.userAgent, accept: 'text/html, text/plain;q=0.9' },
        redirect: 'manual', signal: this.signal(signal),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || redirects >= this.maximumRedirects) throw new Error('AUTONOMY_READ_REDIRECT_LIMIT');
        url = parsedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new Error(`AUTONOMY_READ_HTTP_${response.status}`);
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      const html = type.includes('text/html') || type.includes('application/xhtml');
      if (!html && !type.includes('text/plain')) throw new Error('AUTONOMY_READ_NOT_TEXT');
      const body = await boundedText(response, this.maximumBytes, 'AUTONOMY_READ_TOO_LARGE');
      const text = (html ? htmlToText(body) : body.replace(/\s+/gu, ' ').trim()).slice(0, this.maximumTextCharacters);
      if (!text) throw new Error('AUTONOMY_READ_EMPTY');
      return Object.freeze({
        url: url.href,
        title: (html ? htmlTitle(body) : '') || url.hostname,
        text,
        links: Object.freeze(html ? pageLinks(body, url) : []),
      });
    }
  }

  private async isPublic(url: URL): Promise<boolean> {
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    try {
      const addresses = isIP(hostname) ? [{ address: hostname }] : await this.lookup(hostname);
      return addresses.length > 0 && addresses.every(({ address }) => !isPrivateOrReservedAddress(address));
    } catch {
      return false;
    }
  }

  /** A missing robots.txt allows; one that cannot be fetched or read denies. */
  private async robotsAllow(url: URL, signal?: AbortSignal): Promise<boolean> {
    const cached = this.robots.get(url.origin);
    let rules = cached && this.now() - cached.at < ROBOTS_CACHE_MILLISECONDS ? cached.rules : undefined;
    if (rules === undefined) {
      rules = await this.fetchRobots(url, signal);
      if (this.robots.size > 200) this.robots.clear();
      this.robots.set(url.origin, { rules, at: this.now() });
    }
    return rules !== 'deny' && robotsAllows(rules, `${url.pathname}${url.search}`);
  }

  private async fetchRobots(url: URL, signal?: AbortSignal): Promise<RobotsRules | 'deny'> {
    try {
      const response = await this.fetcher(new URL('/robots.txt', url.origin), {
        headers: { 'user-agent': this.userAgent }, redirect: 'manual', signal: this.signal(signal),
      });
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        return parseRobots('');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return 'deny';
      }
      return parseRobots(await boundedText(response, ROBOTS_MAXIMUM_BYTES, 'AUTONOMY_READ_ROBOTS_TOO_LARGE'));
    } catch {
      return 'deny';
    }
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMilliseconds);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

export interface RobotsRules {
  /** Rules of the group that names this reader, or of `*` when none does. */
  rules: readonly { allow: boolean; path: string }[];
}

/** The group for this reader's token wins over `*`; within a group the longest matching path decides, allow on a tie. */
export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/u).slice(0, 5_000)) {
    const line = raw.replace(/#.*$/u, '').trim();
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (field !== 'allow' && field !== 'disallow')) continue;
    if (value) current.rules.push({ allow: field === 'allow', path: value });
  }
  const own = groups.filter(group => group.agents.some(agent => agent.length >= 3 && agent !== '*' && ROBOTS_AGENT_TOKEN.includes(agent)));
  const chosen = own.length ? own : groups.filter(group => group.agents.includes('*'));
  return { rules: chosen.flatMap(group => group.rules) };
}

export function robotsAllows(robots: RobotsRules, path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    if (!robotsPathMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best?.allow ?? true;
}

function robotsPathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
  try { return new RegExp(`^${body}${anchored ? '$' : ''}`, 'u').test(path); } catch { return true; }
}

function parsedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AUTONOMY_READ_URL_INVALID'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new Error('AUTONOMY_READ_URL_INVALID');
  url.hash = '';
  return url;
}

async function boundedText(response: Response, maximumBytes: number, errorCode: string): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(errorCode);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, (match, body: string) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? match;
    const code = body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function htmlToText(html: string): string {
  const main = /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/iu.exec(html)?.[1] ?? html;
  return decodeEntities(main
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|form|aside)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|blockquote)>|<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[ \t　]+/gu, ' ').replace(/ ?\n ?/gu, '\n').replace(/\n{2,}/gu, '\n').trim();
}

function htmlTitle(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? '';
  return decodeEntities(title.replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function pageLinks(html: string, base: URL): { title: string; url: string }[] {
  const links: { title: string; url: string }[] = [];
  const seen = new Set<string>([base.href]);
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    const title = decodeEntities((match[2] ?? '').replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim();
    if (title.length < 4 || title.length > 80) continue;
    let url: URL;
    try { url = new URL(decodeEntities(match[1] ?? ''), base); } catch { continue; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.href.length > 500) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ title, url: url.href });
    if (links.length >= 12) break;
  }
  return links;
}
