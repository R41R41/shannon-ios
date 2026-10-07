import type { AutonomyActivityEntry } from '../../mind/inhibition/inhibitionPorts.js';
import type { RecordedDecision, ShannonAutonomyService } from '../../mind/action/ownTime/ownTimePorts.js';
import {
  notionFailureCode, type NotionDatabaseRows, type NotionObjectSummary, type NotionPageText, type NotionSource,
} from './notionSource.js';
import type { NotionErrorCode } from './notionClient.js';

/**
 * Notion for Shannon's own activity (Syzygy ADR-0002). The future activity loop reads
 * through this function only: it asks the policy gate first (`notion_read`, a free read
 * domain with a daily count), reads through the read-only reader, and appends what was
 * read to the activity record. The record is the owner's view and names the page; the
 * diagnostics of the reader carry no title. Nothing here can write to Notion.
 */
export type NotionActivityRequest =
  | { kind: 'search'; query: string }
  | { kind: 'page'; pageId: string }
  | { kind: 'database'; databaseId: string };

export type NotionActivityResult =
  | { kind: 'search'; hits: readonly NotionObjectSummary[] }
  | { kind: 'page'; page: NotionPageText }
  | { kind: 'database'; database: NotionDatabaseRows };

export interface NotionActivityOutcome {
  decision: RecordedDecision;
  /** Present when the gate allowed the read and it succeeded. */
  result?: NotionActivityResult;
  /** Present when the gate allowed the read and it failed. */
  failure?: NotionErrorCode;
  /** The activity-record entry of the read itself. */
  activity?: AutonomyActivityEntry;
}

export interface NotionActivityDependencies {
  autonomy: Pick<ShannonAutonomyService, 'authorize' | 'recordAction'>;
  notion: NotionSource;
}

const TOOL = 'notion';
const INTENT: Readonly<Record<NotionActivityRequest['kind'], string>> = {
  search: '共有されたNotionの中を検索します。',
  page: '共有されたNotionのページを読みます。',
  database: '共有されたNotionのデータベースを読みます。',
};

export async function readNotionForActivity(
  dependencies: NotionActivityDependencies, scopeKey: string, request: NotionActivityRequest,
): Promise<NotionActivityOutcome> {
  const decision = dependencies.autonomy.authorize(scopeKey, { domain: 'notion_read', summary: INTENT[request.kind], tool: TOOL });
  if (decision.decision !== 'allow') return { decision };
  let result: NotionActivityResult;
  try {
    result = request.kind === 'search' ? { kind: 'search', hits: await dependencies.notion.search(request.query) }
      : request.kind === 'page' ? { kind: 'page', page: await dependencies.notion.readPage(request.pageId) }
        : { kind: 'database', database: await dependencies.notion.queryDatabase(request.databaseId) };
  } catch (error) {
    const failure = notionFailureCode(error);
    const activity = dependencies.autonomy.recordAction(scopeKey, {
      decisionId: decision.activityId, outcome: 'failed', tool: TOOL,
      summary: failure === 'not_connected' ? 'Notionはまだつながっていないため、読めませんでした。' : `Notionを読めませんでした（${failure}）。`,
    });
    return { decision, failure, activity };
  }
  const activity = dependencies.autonomy.recordAction(scopeKey, {
    decisionId: decision.activityId, outcome: 'done', tool: TOOL, summary: doneSummary(result), ...link(result),
  });
  return { decision, result, activity };
}

function doneSummary(result: NotionActivityResult): string {
  if (result.kind === 'search') {
    const titles = result.hits.slice(0, 3).map(hit => `「${clip(hit.title)}」`).join('');
    return result.hits.length
      ? `Notionを検索して${result.hits.length}件見つけました（${titles}${result.hits.length > 3 ? 'ほか' : ''}）。`
      : 'Notionを検索しましたが、共有された範囲には見つかりませんでした。';
  }
  if (result.kind === 'page') return `Notionのページ「${clip(result.page.title)}」を読みました${result.page.truncated ? '（一部）' : ''}。`;
  return `Notionのデータベース「${clip(result.database.title)}」の${result.database.rows.length}行を読みました${result.database.truncated ? '（一部）' : ''}。`;
}

function link(result: NotionActivityResult): { link?: string } {
  const url = result.kind === 'page' ? result.page.url : result.kind === 'database' ? result.database.url : null;
  return url ? { link: url } : {};
}

function clip(title: string): string {
  const characters = [...title];
  return characters.length > 40 ? `${characters.slice(0, 39).join('')}…` : title;
}
