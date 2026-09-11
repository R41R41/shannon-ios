const RECENT_SIGNAL_WINDOW_MILLISECONDS = 7 * 24 * 60 * 60_000;

export interface WorldSignalCandidate {
  sourceId: string;
  sourceTitle: string;
  title: string;
  url: string;
}

export interface RecentWorldSignal extends WorldSignalCandidate {
  createdAt: string;
}

export function recentSignalCutoff(at: string): string {
  return new Date(Date.parse(at) - RECENT_SIGNAL_WINDOW_MILLISECONDS).toISOString();
}

export function isRepeatedWorldSignal(
  candidate: WorldSignalCandidate,
  recent: readonly RecentWorldSignal[],
): boolean {
  const urlKey = canonicalURLKey(candidate.url);
  return recent.some(previous => (
    (urlKey !== null && urlKey === canonicalURLKey(previous.url))
    || titlesDescribeSameTopic(candidate.title, previous.title)
  ));
}

export function sourceDiversityAdjustment(
  candidate: WorldSignalCandidate,
  recent: readonly RecentWorldSignal[],
): number {
  const latest = recent[0];
  if (!latest) return 0;
  if (candidate.sourceId === latest.sourceId) return -0.12;
  const candidateHost = publicHostname(candidate.url);
  const previousHost = publicHostname(latest.url);
  return candidateHost && candidateHost === previousHost ? -0.06 : 0;
}

function canonicalURLKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, '');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/gu, '/').replace(/\/$/u, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function publicHostname(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.hostname.toLowerCase().replace(/^www\./u, '')
      : null;
  } catch {
    return null;
  }
}

function titlesDescribeSameTopic(left: string, right: string): boolean {
  const leftKey = comparableTitle(left);
  const rightKey = comparableTitle(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  if (Math.min(leftKey.length, rightKey.length) < 12) return false;
  const leftBigrams = bigrams(leftKey);
  const rightBigrams = bigrams(rightKey);
  let shared = 0;
  for (const value of leftBigrams) if (rightBigrams.has(value)) shared += 1;
  const dice = (2 * shared) / (leftBigrams.size + rightBigrams.size);
  return shared >= 8 && dice >= 0.78;
}

function comparableTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\p{P}\p{S}\s]+/gu, '');
}

function bigrams(value: string): Set<string> {
  const characters = [...value];
  const result = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}
