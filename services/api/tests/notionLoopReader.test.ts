import { describe, expect, it } from 'vitest';
import { notionLoopReader } from '../src/notionLoopReader.js';
import type { NotionSource } from '../src/notionSource.js';

function source(overrides: Partial<NotionSource> = {}): NotionSource {
  return {
    connected: true,
    search: async () => [
      { id: 'db1', kind: 'database', title: 'キャラクターDB', url: null, lastEditedAt: null },
      { id: 'p1', kind: 'page', title: '第一幕', url: 'https://www.notion.so/p1', lastEditedAt: null },
    ],
    readPage: async id => ({ id, kind: 'page', title: '第一幕', url: 'https://www.notion.so/p1', lastEditedAt: null, text: '本文', truncated: false, skippedBlocks: 0 }),
    queryDatabase: async () => { throw new Error('not used'); },
    diagnostics: () => { throw new Error('not used'); },
    ...overrides,
  };
}

describe('Notion adapter of the activity loop', () => {
  it('gives no adapter while Notion is not connected', () => {
    expect(notionLoopReader(source({ connected: false }))).toBeUndefined();
  });

  it('reads the first page that matches, within one deadline', async () => {
    const deadlines: Array<number | undefined> = [];
    const reader = notionLoopReader(source({
      search: async (_query, options) => { deadlines.push(options?.deadline); return [{ id: 'p1', kind: 'page', title: '第一幕', url: null, lastEditedAt: null }]; },
      readPage: async (id, options) => { deadlines.push(options?.deadline); return { id, kind: 'page', title: '第一幕', url: null, lastEditedAt: null, text: '本文', truncated: false, skippedBlocks: 0 }; },
    }), () => 1_000)!;
    await expect(reader.read({ query: 'ウサカテ' })).resolves.toEqual({ title: '第一幕', url: 'notion://p1', text: '本文' });
    expect(deadlines).toEqual([11_000, 11_000]);
  });

  it('skips databases and returns null when no page matches', async () => {
    await expect(notionLoopReader(source())!.read({ query: 'x' })).resolves.toMatchObject({ title: '第一幕', url: 'https://www.notion.so/p1' });
    const none = notionLoopReader(source({ search: async () => [{ id: 'db1', kind: 'database', title: 'DB', url: null, lastEditedAt: null }] }))!;
    await expect(none.read({ query: 'x' })).resolves.toBeNull();
  });
});
