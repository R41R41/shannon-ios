import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIDailyMindModel, SQLiteDailyMindStore, type DailyMindModel } from '../src/dailyMind.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import type { WorldItem } from '../src/worldStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('daily Shannon mind', () => {
  it('creates one bounded focus per local day and reuses it without another model call', async () => {
    const path = databasePath();
    const at = '2026-09-05T02:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    state.apply('owner', { type: 'interest-observed', interest: 'AIエージェントの記憶' });
    const daily = new SQLiteDailyMindStore(path, () => at);
    const model = new FakeDailyMindModel();
    const world = [worldItem('memory', 'AI agent memory architecture')];

    const first = await daily.ensureForKnownScopes(world, model);
    const second = await daily.ensureForKnownScopes(world, model);

    expect(model.calls).toBe(1);
    expect(first.get('owner')).toMatchObject({
      dayKey: '2026-09-05', topic: '記憶が育つ条件', sourceItemId: 'memory', openingLine: 'これ、昨日の話と少しつながっていた。',
    });
    expect(second.get('owner')).toEqual(first.get('owner'));
    expect(daily.promptFor('owner')).toContain('topic: 記憶が育つ条件');

    daily.close();
    state.close();
  });

  it('falls back locally and does not invent an absent user fact', async () => {
    const path = databasePath();
    const at = '2026-09-05T02:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const daily = new SQLiteDailyMindStore(path, () => at);
    const result = await daily.ensureForKnownScopes([worldItem('weather', '東京の天気')], { generate: async () => null });
    const focus = result.get('owner');
    expect(focus?.topic).toBe('東京の天気');
    expect(focus?.reason).toContain('見つけて');
    expect(focus?.openingLine).toBeUndefined();
    daily.close();
    state.close();
  });

  it('does not turn a stale world item into today\'s focus', async () => {
    const path = databasePath();
    const at = '2026-09-05T02:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const daily = new SQLiteDailyMindStore(path, () => at);
    const oldItem = {
      ...worldItem('old-news', '先月のニュース'),
      discoveredAt: '2026-09-05T01:00:00.000Z',
      publishedAt: '2026-08-01T00:00:00.000Z',
    };

    const result = await daily.ensureForKnownScopes([oldItem], { generate: async () => null });

    expect(result.get('owner')).toMatchObject({
      topic: '今日は静かに周りを見る',
      reason: '急いで話題を作らず、今日の出来事を静かに見ていたいから。',
    });
    expect(result.get('owner')?.sourceItemId).toBeUndefined();
    daily.close();
    state.close();
  });

  it('records a bounded model call and stops at the shared background budget', async () => {
    const events: unknown[] = [];
    let spent = 0;
    let calls = 0;
    const model = new OpenAIDailyMindModel({
      apiKey: 'test-key',
      now: () => '2026-09-05T02:00:00.000Z',
      backgroundBudgetUsd: 0.5,
      usageStore: {
        backgroundLlmCostUsd: () => spent,
        recordLlmUsage: event => { events.push(event); },
      },
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            topic: '言葉になる前の記憶', reason: '会話と記事が重なったから。', openingLine: '少しだけ気になったことがある。',
          }),
          usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        }), { status: 200 });
      },
    });

    await expect(model.generate({ scopeKey: 'owner', recentInterests: ['記憶'], candidate: null }))
      .resolves.toMatchObject({ topic: '言葉になる前の記憶' });
    expect(calls).toBe(1);
    expect(events).toEqual([expect.objectContaining({ scopeKey: 'owner', lane: 'sleep', totalTokens: 70 })]);

    spent = 0.5;
    await expect(model.generate({ scopeKey: 'owner', recentInterests: ['記憶'], candidate: null })).resolves.toBeNull();
    expect(calls).toBe(1);
  });
});

class FakeDailyMindModel implements DailyMindModel {
  calls = 0;
  async generate() {
    this.calls += 1;
    return { topic: '記憶が育つ条件', reason: '昨日の会話と記事が重なったから。', openingLine: 'これ、昨日の話と少しつながっていた。' };
  }
}

function worldItem(id: string, title: string): WorldItem {
  return { id, sourceId: 'test', sourceTitle: 'Test Feed', title, url: `https://example.com/${id}`, discoveredAt: '2026-09-05T01:00:00.000Z' };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-daily-mind-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}
