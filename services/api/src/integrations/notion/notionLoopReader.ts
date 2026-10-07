import type { AutonomyNotionReader } from '../../mind/action/ownTime/ownTimePorts.js';
import type { NotionSource } from './notionSource.js';

const READ_MILLISECONDS = 10_000;

/**
 * The Notion adapter of the activity loop: one search and one page per step, through the
 * read-only reader. The loop asks the gate (`notion_read`) before it calls this and writes
 * the activity-record entry afterwards, so this adapter neither authorizes nor records.
 * A source that is not connected yields no adapter, and the loop then never plans a
 * Notion step. Nothing here can write to Notion.
 */
export function notionLoopReader(source: NotionSource, clock: () => number = Date.now): AutonomyNotionReader | undefined {
  if (!source.connected) return undefined;
  return {
    async read({ query, signal }) {
      const deadline = clock() + READ_MILLISECONDS;
      const hits = await source.search(query, { deadline });
      // Databases are lists; a step reads one page of text.
      const page = hits.find(hit => hit.kind === 'page');
      if (!page || signal?.aborted) return null;
      const read = await source.readPage(page.id, { deadline });
      return { title: read.title, url: read.url ?? `notion://${read.id}`, text: read.text };
    },
  };
}
