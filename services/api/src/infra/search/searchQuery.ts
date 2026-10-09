/** Optional controls shared by local searches. Queries are literal text, never SQL or regular expressions. */
export interface SearchOptions {
  match?: 'phrase' | 'all' | 'any';
  after?: string;
  before?: string;
  offset?: number;
  order?: 'relevance' | 'newest' | 'oldest';
}
export function searchOptions(input: Record<string, unknown>): SearchOptions {
  const options: SearchOptions = {};
  if (input.match !== undefined) {
    if (!['phrase', 'all', 'any'].includes(String(input.match))) throw new Error('SEARCH_MATCH_INVALID');
    options.match = input.match as SearchOptions['match'];
  }
  if (input.order !== undefined) {
    if (!['relevance', 'newest', 'oldest'].includes(String(input.order))) throw new Error('SEARCH_ORDER_INVALID');
    options.order = input.order as SearchOptions['order'];
  }
  for (const key of ['after', 'before'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('SEARCH_DATE_INVALID');
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new Error('SEARCH_DATE_INVALID');
    options[key] = new Date(value).toISOString();
  }
  if (options.after && options.before && options.after >= options.before) throw new Error('SEARCH_RANGE_INVALID');
  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 1000) throw new Error('SEARCH_OFFSET_INVALID');
    options.offset = Number(input.offset);
  }
  return options;
}
export function searchTerms(query: string, match: SearchOptions['match'] = 'phrase'): string[] {
  const terms = match === 'phrase' ? [query.trim()] : [...new Set(query.trim().split(/\s+/u))];
  if (terms.length > 16) throw new Error('SEARCH_TERMS_LIMIT');
  return terms;
}
export function matchesSearch(text: string, query: string, options: SearchOptions): boolean {
  const body = text.toLocaleLowerCase(), terms = searchTerms(query, options.match).map(term => term.toLocaleLowerCase());
  return options.match === 'any' ? terms.some(term => body.includes(term)) : terms.every(term => body.includes(term));
}
export function withinSearchRange(at: string, options: SearchOptions): boolean {
  const time = Date.parse(at);
  return (!options.after || time >= Date.parse(options.after)) && (!options.before || time < Date.parse(options.before));
}
export function literalSearchPattern(text: string): string { return `%${text.replace(/[\\%_]/gu, '\\$&')}%`; }
