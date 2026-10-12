import { stringInput, type ToolInput } from './shannonToolInput.js';
import { clip, type PreparedToolCall, type ToolExecutionContext, type ToolExecutor, type ToolSessionMemory } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ToolResult } from './shannonTools.js';
import { webSearchContext, webSearchFailure, type WebSearchOperation, type WebSearchResult } from '../../infra/models/webSearch.js';
import {
  WEB_LOCALITIES, mergedWebResults, webDomain, webReadUrl, type WebLocality, type WebReadOperation, type WebRecency, type WebSearchFilters,
} from '../../infra/models/webResearch.js';
import { WEB_READ_PER_REPLY, WEB_READ_PER_TASK_STEP, WEB_SEARCH_PER_REPLY, WEB_SEARCH_PER_TASK_STEP } from './webResearchToolDefinitions.js';

/**
 * The executors of `web.search` and `web.read` (deep research, 2026-10-13). Each call is one bounded paid read through the
 * chat model's transport (usage booked there). A reply may search up to three times and read up to two pages; one step of a
 * common research task (FCA) six and four. Every read of the reply or step is kept here, by the session memory, so the reply's
 * sources and an FCA step's unknown outcome are known: a slot is reserved before the await and stays `unknown` if it never ends.
 */
interface WebLedger { searches: number; reads: number; results: WebSearchResult[] }
const LEDGERS = new WeakMap<ToolSessionMemory, WebLedger>();

function ledgerOf(memory: ToolSessionMemory): WebLedger {
  let ledger = LEDGERS.get(memory);
  if (!ledger) LEDGERS.set(memory, ledger = { searches: 0, reads: 0, results: [] });
  return ledger;
}

/** Every web read of this reply or task step, as one result (results if any found something); null before the first. */
export function webReadResult(memory: ToolSessionMemory): WebSearchResult | null {
  return mergedWebResults(LEDGERS.get(memory)?.results ?? []);
}

/** A read of this reply or step is still in flight or ended without a known outcome (never replayed automatically). */
export function webReadUnknown(memory: ToolSessionMemory): boolean {
  return LEDGERS.get(memory)?.results.some(result => result.status === 'unknown') ?? false;
}

const LIMIT_TEXT = 'この返事で使える回数に達しました。自動で繰り返さず、確認できた結果だけを使います。';
const missing = () => toolFailure('not_offered', 'この道具は、いまのサーバーにはない。', { retryable: false });
const SECRET_REFUSAL = '非公開の情報を検索先へ渡さないため、この検索は実行していません。';

function listOfDomains(input: ToolInput, key: string): string[] {
  return (stringInput(input, key) ?? '').split(/[,\s、]+/u).map(webDomain).filter((host): host is string => host !== null).slice(0, 8);
}

/** The optional narrowing the model asked for; undefined when none, so the native request stays what it was. */
export function searchFilters(input: ToolInput): WebSearchFilters | undefined {
  const allowedDomains = listOfDomains(input, 'domains'), blockedDomains = listOfDomains(input, 'excludeDomains');
  const locality = stringInput(input, 'locality') as WebLocality | undefined, recency = stringInput(input, 'recency') as WebRecency | undefined;
  const filters: WebSearchFilters = { ...(allowedDomains.length ? { allowedDomains } : {}), ...(blockedDomains.length ? { blockedDomains } : {}),
    ...(locality && WEB_LOCALITIES.includes(locality) ? { locality } : {}),
    ...(recency && ['day', 'week', 'month', 'year'].includes(recency) ? { recency } : {}) };
  return Object.keys(filters).length ? filters : undefined;
}

function refusedWords(context: ToolExecutionContext, words: readonly string[]): ToolResult | null {
  const carried = context.secrets === null || words.some(word => word && context.secrets?.carries(word));
  return carried ? toolFailure('refused', SECRET_REFUSAL, { retryable: false }) : null;
}

/** A reserved slot, the read, and its outcome in the slot; an abort leaves the slot unknown. */
async function ledgered(context: ToolExecutionContext, kind: 'searches' | 'reads', read: () => Promise<WebSearchResult>): Promise<WebSearchResult | null> {
  const ledger = ledgerOf(context.memory), fca = context.acknowledgementOwner === 'fca';
  const limit = kind === 'searches' ? fca ? WEB_SEARCH_PER_TASK_STEP : WEB_SEARCH_PER_REPLY : fca ? WEB_READ_PER_TASK_STEP : WEB_READ_PER_REPLY;
  if (ledger[kind] >= limit) return null;
  ledger[kind] += 1;
  const slot = ledger.results.push(webSearchFailure('unknown')) - 1;
  const result = await read();
  ledger.results[slot] = result;
  return result;
}

function outcome(read: WebSearchResult | null, summary: string, failed: string, header?: string) {
  if (!read) return { result: toolFailure('limit', LIMIT_TEXT, { retryable: false }), record: { summary, outcome: 'failed' as const, reasonCode: 'limit' } };
  if (read.status !== 'results') {
    return { result: toolFailure(read.status === 'empty' ? 'not_found' : 'unavailable', read.text, { retryable: false }),
      record: { summary: failed, outcome: 'failed' as const, reasonCode: read.status } };
  }
  const text = header ? webSearchContext(read).replace('[Web search result', header) : webSearchContext(read);
  return { result: { ...toolOk(text), readReceipt: { text: read.text, sources: read.sources } }, record: { summary, outcome: 'done' as const } };
}

function searchCall(web: WebSearchOperation, input: ToolInput, context: ToolExecutionContext): PreparedToolCall | ToolResult {
  const query = clip(stringInput(input, 'query') ?? '', 500);
  if (!query) return toolFailure('invalid_input', '検索する内容が空です。', { retryable: false });
  const filters = searchFilters(input);
  const refused = refusedWords(context, [query, ...filters?.allowedDomains ?? [], ...filters?.blockedDomains ?? []]);
  if (refused) return refused;
  const summary = '会話の中でWebを検索しました。';
  return { summary, run: async signal => {
    signal?.throwIfAborted();
    const read = await ledgered(context, 'searches', () => web({ scopeKey: context.scopeKey, query, signal, milliseconds: context.timeMilliseconds,
      maxUses: 3, ...(filters ? { filters } : {}) }));
    signal?.throwIfAborted();
    return outcome(read, summary, '会話のWeb検索では情報を確認できませんでした。');
  } };
}

function readCall(webRead: WebReadOperation, input: ToolInput, context: ToolExecutionContext): PreparedToolCall | ToolResult {
  const url = webReadUrl(stringInput(input, 'url') ?? '');
  if (!url) return toolFailure('invalid_input', '公開ページのURL（https://…）を書く。', { retryable: false });
  const focus = clip(stringInput(input, 'focus') ?? '', 300);
  const refused = refusedWords(context, [url, focus]);
  if (refused) return refused;
  const summary = '会話の中でWebのページを読みました。';
  return { summary, run: async signal => {
    signal?.throwIfAborted();
    const read = await ledgered(context, 'reads', () => webRead({ scopeKey: context.scopeKey, url, focus, signal, milliseconds: context.timeMilliseconds }));
    signal?.throwIfAborted();
    return outcome(read, summary, '会話の中でWebのページを読めませんでした。', '[Web page read');
  } };
}

export function webResearchExecutors(ports: { web?: WebSearchOperation; webRead?: WebReadOperation }): Readonly<Record<string, ToolExecutor>> {
  return Object.freeze({
    'web.search': (input, context) => ports.web ? searchCall(ports.web, input, context) : missing(),
    'web.read': (input, context) => ports.webRead ? readCall(ports.webRead, input, context) : missing(),
  });
}
