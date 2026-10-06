import { describe, expect, it } from 'vitest';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { coreAreaForRepositoryPath } from '../src/autonomyCore.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { readNotionForActivity } from '../src/notionAutonomousRead.js';
import { configuredNotionSource } from '../src/notionSource.js';
import { NOTION_FIXTURE_IDS as ids, fixtureNotionSource } from './notionFixture.js';
import { apiSourcePath } from './support/sources.js';

const scope = 'owner';

function harness(environment: Record<string, string> = {}, notionOptions: Parameters<typeof fixtureNotionSource>[0] = {}) {
  const lines: string[] = [];
  const autonomy = new ShannonAutonomyService({
    store: new SQLiteAutonomyStore(':memory:'),
    config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true', ...environment }),
    now: () => '2026-10-02T01:00:00.000Z',
  });
  const { source, fake } = fixtureNotionSource({ ...notionOptions, log: line => lines.push(line) });
  const entries = () => autonomy.activityDays(scope, 2).flatMap(day => day.entries);
  return { autonomy, notion: source, fake, entries, lines };
}

describe('Notion for autonomous activity', () => {
  it('asks the gate, reads, and records the page title for the owner while the log stays content-free', async () => {
    const { autonomy, notion, entries, lines } = harness();
    const outcome = await readNotionForActivity({ autonomy, notion }, scope, { kind: 'page', pageId: ids.scenario });
    expect(outcome.decision).toMatchObject({ decision: 'allow', reason: 'free_domain', domain: 'notion_read' });
    expect(outcome.result).toMatchObject({ kind: 'page', page: { title: 'シナリオ草稿（合成）' } });
    const [action, decision] = entries();
    expect(decision).toMatchObject({
      kind: 'decision', domain: 'notion_read', domainLabel: '共有されたNotionを読む', tool: 'notion', outcome: 'allowed',
      summary: '共有されたNotionのページを読みます。',
    });
    expect(action).toMatchObject({
      kind: 'action', actor: 'shannon', domain: 'notion_read', tool: 'notion', outcome: 'done', costYen: 0, relatedId: decision!.id,
      summary: 'Notionのページ「シナリオ草稿（合成）」を読みました（一部）。', link: `https://www.notion.so/synthetic-${ids.scenario}`,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/シナリオ|第一幕|synthetic-|4{32}/u);
  });

  it('records a search and a database read with their titles', async () => {
    const { autonomy, notion, entries } = harness();
    const search = await readNotionForActivity({ autonomy, notion }, scope, { kind: 'search', query: '' });
    expect(search.result).toMatchObject({ kind: 'search' });
    expect(search.activity!.summary).toBe('Notionを検索して7件見つけました（「シナリオ草稿（合成）」「キャラクターDB（合成）」「伏線メモ（合成）」ほか）。');
    const database = await readNotionForActivity({ autonomy, notion }, scope, { kind: 'database', databaseId: ids.characterDatabase });
    expect(database.activity).toMatchObject({ summary: 'Notionのデータベース「キャラクターDB（合成）」の2行を読みました。', outcome: 'done' });
    const nothing = await readNotionForActivity({ autonomy, notion }, scope, { kind: 'search', query: '存在しない題名' });
    expect(nothing.activity!.summary).toBe('Notionを検索しましたが、共有された範囲には見つかりませんでした。');
    expect(entries().filter(item => item.kind === 'decision')).toHaveLength(3);
  });

  it('does not read when the gate refuses: switched off, paused, or over the daily limit', async () => {
    const off = harness({ SHANNON_AUTONOMY_ENABLED: 'false' });
    const refused = await readNotionForActivity(off, scope, { kind: 'page', pageId: ids.scenario });
    expect(refused.decision).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(refused.result).toBeUndefined();
    expect(off.fake.calls).toEqual([]);
    expect(off.entries()).toHaveLength(1);

    const paused = harness();
    paused.autonomy.setPaused(scope, true);
    expect((await readNotionForActivity(paused, scope, { kind: 'search', query: '' })).decision.reason).toBe('paused');
    expect(paused.fake.calls).toEqual([]);

    const limited = harness({ SHANNON_AUTONOMY_MAX_NOTION_READS: '2' });
    for (let index = 0; index < 2; index += 1) {
      expect((await readNotionForActivity(limited, scope, { kind: 'search', query: '' })).decision.decision).toBe('allow');
    }
    const over = await readNotionForActivity(limited, scope, { kind: 'page', pageId: ids.scenario });
    expect(over.decision).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(limited.fake.calls.filter(call => call.path !== '/v1/search')).toEqual([]);
    expect(configuredAutonomy({}).maximumNotionReadsPerDay).toBe(100);
  });

  it('records a failed read with a code, including a page outside the roots and a missing token', async () => {
    const restricted = harness({}, { roots: ids.characterDatabase });
    const outside = await readNotionForActivity(restricted, scope, { kind: 'page', pageId: ids.outside });
    expect(outside).toMatchObject({ failure: 'outside_roots', activity: { outcome: 'failed', summary: 'Notionを読めませんでした（outside_roots）。' } });
    expect(outside.result).toBeUndefined();
    expect(JSON.stringify(restricted.entries())).not.toContain('家計メモ');

    const { autonomy, entries } = harness();
    const disconnected = await readNotionForActivity({ autonomy, notion: configuredNotionSource({}) }, scope, { kind: 'search', query: '' });
    expect(disconnected).toMatchObject({ failure: 'not_connected', activity: { outcome: 'failed', summary: 'Notionはまだつながっていないため、読めませんでした。' } });
    expect(entries().map(item => item.kind)).toEqual(['action', 'decision']);
  });

  it('keeps the policy in core and the reader outside it', () => {
    expect(coreAreaForRepositoryPath(apiSourcePath('autonomyPolicy.ts'))?.area).toBe('approval_and_budget');
    expect(coreAreaForRepositoryPath('packages/cognition/src/autonomy.ts')?.area).toBe('persona');
    for (const name of ['notionClient.ts', 'notionSource.ts', 'notionText.ts', 'notionConversation.ts', 'notionAutonomousRead.ts']) {
      expect(coreAreaForRepositoryPath(apiSourcePath(name)), name).toBeNull();
    }
  });
});
