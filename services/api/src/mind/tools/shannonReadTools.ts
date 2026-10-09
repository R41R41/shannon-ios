import { stringInput } from './shannonToolInput.js';
import { clip, type PreparedToolCall, type ToolExecutor } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ReadToolDomain } from './shannonTools.js';
import { webSearchContext, webSearchFailure, type WebSearchOperation, type WebSearchResult } from '../../infra/models/webSearch.js';
import type { ToolSessionMemory } from './shannonToolTypes.js';

const WEB_READS = new WeakMap<ToolSessionMemory, WebSearchResult>();
export function webReadResult(memory: ToolSessionMemory): WebSearchResult | null { return WEB_READS.get(memory) ?? null; }

/**
 * The executors of her read tools (Syzygy ADR-0008 stage 2, step 3; `docs/skill-and-routing-contract.md`). Core: approval and
 * budget (her tools). Each runs the same bounded read the conversation's projection makes (`conversationCapabilities.ts`, the
 * Notion projection, `OwnerUpcoming.promptFor`, the place skill), handed in as functions by the wiring, so the read is the same
 * read and only who decides when to make it changes. What they read reaches the model as the tool's result and nowhere else:
 * nothing is stored, and the activity record names the tool, never what was asked or read.
 *
 * The gate decides who may use them (`authorizeToolCall`: the owner alone, text and voice); an executor checks nothing of it.
 */
export interface ReadToolPorts {
  web?: WebSearchOperation;
  /** The Notion projection for one search word: its text, and the pages it showed. */
  notion?: (query: string) => Promise<{ text: string; sources: readonly { title: string; url: string }[]; sourceIds?: readonly string[] }>;
  /** The Voyager task read for one search phrase (empty: bounded open-task list). */
  voyagerTasks?: (query: string) => Promise<ReadToolText>;
  /** The owner's upcoming items as the conversation's projection gives them to him alone. */
  upcoming?: (scopeKey: string, range: 'day' | 'week') => ReadToolText;
  upcomingSearch?: (scopeKey: string, input: Record<string, unknown>) => ReadToolText;
  /** The place skill for a query in an area; `spoken` for a voice turn. */
  places?: (scopeKey: string, query: string, spoken: boolean, context?: import('../../integrations/places/placeDiscovery.js').PlaceSearchContext) => Promise<string | { prompt: string; places: import('../../integrations/places/placeDiscovery.js').ShannonPlace[]; webSources: WebSearchResult['sources'] }>;
}
/** Optional closed receipts accompany the identical text from an existing projection. */
export type ReadToolText = string | { text: string; sourceIds: readonly string[] };

/** Which port a read domain needs. */
export const READ_TOOL_PORT: Readonly<Record<ReadToolDomain, keyof ReadToolPorts>> = Object.freeze({
  notion_read: 'notion', voyager_read: 'voyagerTasks', schedule_read: 'upcoming', places_search: 'places', web_search: 'web',
});

const UNAVAILABLE = toolFailure('unavailable', 'いまは読めなかった。', { retryable: true, refusal: { why: '読む先に届かなかった', wouldWork: '少しあとでもう一度' } });

function prepared(summary: string, read: () => Promise<ReadToolText> | ReadToolText): PreparedToolCall {
  return {
    summary,
    run: async () => {
      try {
        const readResult = await read(), text = typeof readResult === 'string' ? readResult : readResult.text;
        return { result: toolOk(text.trim() ? text : '（何も見つからなかった）'), record: { summary, outcome: 'done' },
          ...(typeof readResult === 'string' ? {} : { documents: { sourceIds: readResult.sourceIds } }) };
      } catch (error) {
        if (error instanceof Error && /^(?:SEARCH|SCHEDULE)_/u.test(error.message)) return { result: toolFailure('invalid_input', '検索条件の日時・範囲・語数を確認して呼び直す。', { retryable: false }), record: { summary, outcome: 'failed' } };
        return { result: UNAVAILABLE, record: { summary: `${summary}（読めませんでした）`, outcome: 'failed', reasonCode: 'unavailable' } };
      }
    },
  };
}

export function readToolExecutors(ports: ReadToolPorts | null): Readonly<Record<string, ToolExecutor>> {
  if (!ports) return Object.freeze({});
  const missing = toolFailure('not_offered', 'この道具は、いまのサーバーにはない。', { retryable: false });
  return Object.freeze({
    'web.search': (input, context) => {
      if (!ports.web) return missing;
      const query = clip(stringInput(input, 'query') ?? '', 500);
      if (!query) return toolFailure('invalid_input', '検索する内容が空です。', { retryable: false });
      if (context.secrets === null || context.secrets?.carries(query)) return toolFailure('refused', '非公開の情報を検索先へ渡さないため、この検索は実行していません。', { retryable: false });
      const summary = '会話の中でWebを検索しました。';
      return { summary, run: async signal => {
        signal?.throwIfAborted();
        if (WEB_READS.has(context.memory)) return { result: toolFailure('limit', 'この返事の検索はすでに依頼しています。自動で繰り返さず、確認できた結果だけを使います。', { retryable: false }), record: { summary, outcome: 'failed' as const, reasonCode: 'limit' } };
        WEB_READS.set(context.memory, webSearchFailure('unknown')); // Reserve before awaiting: concurrent calls share the turn's one search operation.
        const read = await ports.web!({ scopeKey: context.scopeKey, query, signal, milliseconds: context.timeMilliseconds, maxUses: 3 });
        signal?.throwIfAborted();
        WEB_READS.set(context.memory, read);
        return { result: read.status === 'results' ? { ...toolOk(webSearchContext(read)), readReceipt: { text: read.text, sources: read.sources } } : toolFailure(read.status === 'empty' ? 'not_found' : 'unavailable', read.text, { retryable: false }),
          record: { summary: read.status === 'results' ? summary : '会話のWeb検索では情報を確認できませんでした。', outcome: read.status === 'results' ? 'done' as const : 'failed' as const, ...(read.status === 'results' ? {} : { reasonCode: read.status }) } };
      } };
    },
    'notion.read': input => {
      const query = clip(stringInput(input, 'query') ?? '', 80);
      if (!ports.notion) return missing;
      if (!query) return toolFailure('invalid_input', '探す言葉（query）が空だった。', { retryable: false });
      return prepared('会話の中でNotionの共有ページを読みました。', async () => {
        const read = await ports.notion!(query);
        return { text: [read.text, ...read.sources.map(source => `- ${clip(source.title, 80)}: ${source.url}`)].join('\n'),
          sourceIds: read.sourceIds ?? read.sources.map(source => {
            const id = source.url.match(/(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?=[/?#]|$)/iu)?.[0];
            return id ? `notion-page://${id.replaceAll('-', '').toLowerCase()}` : 'fca-unresolved://notion-page';
          }) };
      });
    },
    'voyager.tasks': input => {
      if (!ports.voyagerTasks) return missing;
      const query = clip(stringInput(input, 'query') ?? '', 160);
      return prepared(query ? '会話の中でVoyagerのタスクを検索しました。' : '会話の中でVoyagerの未完了タスクを読みました。', () => ports.voyagerTasks!(query));
    },
    'schedule.upcoming': (input, context) => {
      if (!ports.upcoming) return missing;
      const range = stringInput(input, 'range') === 'week' ? 'week' as const : 'day' as const;
      if (Object.keys(input).some(key => key !== 'range')) {
        if (!ports.upcomingSearch) return { summary: '予定を検索します。', run: async () => ({ result: toolFailure('unavailable', 'この接続は詳しい予定検索に対応していない。', { retryable: false }), record: { summary: '予定検索は未対応でした。', outcome: 'failed' } }) };
        return prepared('ライ氏の予定を条件で検索しました。', () => ports.upcomingSearch!(context.scopeKey, input));
      }
      return prepared('会話の中でライ氏のこれからの予定を見ました。', () => ports.upcoming!(context.scopeKey, range));
    },
    'places.search': (input, context) => {
      if (!ports.places) return missing;
      const query = clip(stringInput(input, 'query') ?? '', 120);
      const area = clip(stringInput(input, 'area') ?? '', 80);
      if (!query) return toolFailure('invalid_input', '何を探すか（query）が空だった。', { retryable: false });
      return { summary: '場所の候補を探します。', run: async signal => {
        signal?.throwIfAborted();
        try { const read = await ports.places!(context.scopeKey, area ? `${area}の${query}` : query, context.surface === 'voice', area ? undefined : context.placeSearch);
        signal?.throwIfAborted();
        return { result: typeof read === 'string' ? toolOk(read) : { ...toolOk(read.prompt), readReceipt: { text: read.prompt, sources: read.webSources, places: read.places } }, record: { summary: '会話の中で場所の候補を探しました。', outcome: 'done' as const } };
        } catch (error) { signal?.throwIfAborted(); return { result: UNAVAILABLE, record: { summary: '場所を確認できませんでした。', outcome: 'failed' as const, reasonCode: 'unavailable' } }; }
      } };
    },
  });
}
