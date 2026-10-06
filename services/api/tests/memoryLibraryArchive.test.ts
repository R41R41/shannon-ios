import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';

describe('memory management archive reachability', () => {
  it.each([3, 1000])('keeps forgotten evidence reachable beyond the visible history window (%s)', maximumExperiences => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-library-'));
    const at = '2026-09-25T01:00:00.000Z';
    const store = new SQLiteShannonStore({ path: join(directory, 'fixture.sqlite'), now: () => at, maximumExperiences });
    try {
      const thread = store.createThread('owner');
      const source = store.appendTurn('owner', thread, '昔の会話の合成サンプル', '返答', at);
      const service = new ShannonMemoryService(store, store, () => at);
      service.mutate('owner', { memoryId: source.id, action: 'forget' });
      for (let index = 0; index < 85; index += 1) store.appendTurn('owner', thread, `後の会話${index}`, '返答', at);
      expect(service.dashboard('owner').items.find(item => item.id === source.id))
        .toMatchObject({ status: 'forgotten', text: expect.stringContaining('昔の会話') });
      expect(service.mutate('owner', { memoryId: source.id, action: 'restore' }).items.find(item => item.id === source.id)?.status)
        .toBe('active');
      expect(service.dashboard('other-owner').items).toEqual([]);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
