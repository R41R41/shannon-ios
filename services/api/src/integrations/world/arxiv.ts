import { parseSyndicationFeed } from './syndicationFeed.js';
import type { WorldItemInput } from './store/worldStore.js';

const MODERN_ID = /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v[1-9]\d*)?$/u;
const LEGACY_ID = /^[a-z.-]+\/\d{7}(?:v\d+)?$/iu;

export function prepareArxivQuery(sourceURL: string, query: string): URL {
  const url = new URL(sourceURL);
  url.searchParams.set('search_query', query);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', '10');
  url.searchParams.set('sortBy', 'submittedDate');
  url.searchParams.set('sortOrder', 'descending');
  return url;
}

export function parseArxivFeed(xml: string, queryURL: URL): readonly WorldItemInput[] {
  return Object.freeze(parseSyndicationFeed(xml, queryURL).flatMap(item => {
    const id = arxivId(item.externalId);
    if (!id || !item.publishedAt || item.title.toLowerCase() === 'error') return [];
    return [{
      ...item,
      externalId: id,
      url: `https://arxiv.org/abs/${id}`,
    }];
  }).slice(0, 10));
}

function arxivId(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase()) || !url.pathname.startsWith('/abs/')) return null;
    const id = decodeURIComponent(url.pathname.slice('/abs/'.length));
    return MODERN_ID.test(id) || LEGACY_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}
