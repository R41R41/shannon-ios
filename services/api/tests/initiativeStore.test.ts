import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteWorldStore } from '../src/integrations/world/store/worldStore.js';
import { SQLiteCognitiveIntentStore, extractExplicitUserIntent } from '../src/cognitiveIntent.js';
import { SQLiteAgentTaskStore } from '../src/agentTaskStore.js';
import type { DailyMindFocus } from '../src/dailyMind.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Shannon initiative loop', () => {
  it('brings an exact linked-task approval back to the originating conversation', () => {
    const path = databasePath();
    const createdAt = '2026-09-23T00:00:00.000Z';
    const at = '2026-09-25T03:00:00.000Z'; // 12:00 in Tokyo
    const state = new SQLiteShannonStore({ path, now: () => createdAt });
    state.snapshot('owner');
    state.threadId('owner', 'thread-goal');
    state.renameThread('owner', 'thread-goal', '目的の会話');
    const intents = new SQLiteCognitiveIntentStore(path);
    const intent = intents.capture('owner', extractExplicitUserIntent(
      'シャノンの人格表現を改善したい', 'thread-goal', createdAt,
    )!);
    const tasks = new SQLiteAgentTaskStore(path);
    const { task } = tasks.create('owner', {
      idempotencyKey: 'linked-task', conversationThreadID: 'thread-goal', cognitiveIntentID: intent.id,
      title: '人格の改善', goal: '人格表現を改善して検証する', summary: '作業を開始する。',
    }, createdAt);
    intents.linkTask('owner', intent.id, task.id, createdAt);
    tasks.claim('mac-a', '2026-09-23T00:00:01.000Z');
    tasks.recordHostEvents('mac-a', [{
      eventId: 'approval', taskId: task.id, type: 'approval_requested', title: '確認待ち',
      occurredAt: '2026-09-23T00:00:02.000Z', payload: { approval: {
        externalRequestID: 'approval-1', kind: 'permission', title: '実機へ配布',
        reason: '署名済みビルドを端末へ入れるため',
      } },
    }], '2026-09-23T00:00:02.000Z');

    const initiatives = new SQLiteInitiativeStore(path, () => at);
    expect(initiatives.runOnce()).toMatchObject({ sent: 1, stopped: null });
    expect(initiatives.unreadMessages('owner')).toEqual([
      expect.objectContaining({
        threadId: 'thread-goal', sourceTitle: '継続中の目的', sourceURL: '',
        content: expect.stringContaining('実機へ配布'),
      }),
    ]);
    const initiativeTurn = state.conversationHistory('owner', 'thread-goal').at(-1);
    expect(initiativeTurn).toMatchObject({ role: 'assistant' });
    expect(initiativeTurn).not.toHaveProperty('sourceAttribution');
    expect(initiatives.runOnce()).toMatchObject({ sent: 0, stopped: 'today-is-enough' });

    initiatives.close();
    tasks.close();
    intents.close();
    state.close();
  });

  it('delivers at most one relevant message per local day and keeps it unread until acknowledged', () => {
    const path = databasePath();
    const at = '2026-09-03T03:00:00.000Z'; // 12:00 in Tokyo
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
    const threadId = state.createThread('owner', 'いつものトーク');
    expect(state.listThreads('owner').map(item => item.threadId)).toContain(threadId);
    const world = new SQLiteWorldStore(path, () => at);
    const source = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(source, [{
      externalId: 'agent-story',
      title: 'AI agents that learn from daily work',
      url: 'https://example.com/agents',
    }], '2026-09-03T02:00:00.000Z');

    const initiatives = new SQLiteInitiativeStore(path, () => at);
    expect(initiatives.runOnce()).toMatchObject({ sent: 1, stopped: null });
    expect(initiatives.runOnce()).toMatchObject({ sent: 0, stopped: 'today-is-enough' });
    expect(initiatives.initiativeEvaluation()).toMatchObject({
      runs: 2, eligibleRuns: 2, delivered: 1, deliveryRate: 0.5,
      repeatedCandidatesSuppressed: 0,
      deliveredBySource: [{ sourceTitle: 'Hacker News', count: 1 }],
      stopped: { 'today-is-enough': 1 },
    });
    expect(initiatives.unreadMessages('owner')).toEqual([
      expect.objectContaining({ threadId, expression: expect.any(String), sourceURL: 'https://example.com/agents' }),
    ]);
    expect(state.conversationHistory('owner', threadId)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('AI agents'),
        sourceAttribution: {
          title: 'Hacker News',
          url: 'https://example.com/agents',
          reason: '今日の関心「AI agents」と近いからです。',
        },
      }),
    ]);
    expect(initiatives.markRead('owner')).toBe(1);
    expect(initiatives.unreadMessages('owner')).toEqual([]);

    initiatives.close();
    world.close();
    state.close();
  });

  it('does not speak during quiet hours', () => {
    const path = databasePath();
    const state = new SQLiteShannonStore({ path, now: () => '2026-09-02T18:00:00.000Z' }); // 03:00 Tokyo
    state.snapshot('owner');
    const initiatives = new SQLiteInitiativeStore(path);
    expect(initiatives.runOnce('2026-09-02T18:00:00.000Z')).toEqual({
      considered: 0, sent: 0, stopped: 'quiet-hours',
    });
    expect(initiatives.initiativeEvaluation(30, '2026-09-02T18:00:00.000Z')).toMatchObject({
      runs: 1, eligibleRuns: 0, delivered: 0, deliveryRate: 0,
      stopped: { 'quiet-hours': 1 },
    });
    initiatives.close();
    state.close();
  });

  it('uses the existing initiative loop to speak from today\'s focus', () => {
    const path = databasePath();
    const at = '2026-09-05T03:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const threadId = state.createThread('owner', 'いつものトーク');
    const world = new SQLiteWorldStore(path, () => at);
    const source = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(source, [{
      externalId: 'focus-story', title: 'A small agent learns to remember', url: 'https://example.com/focus',
    }], at);
    const item = world.latestItems(1)[0]!;
    const focus: DailyMindFocus = {
      scopeKey: 'owner', dayKey: '2026-09-05', topic: '記憶が育つ条件', reason: '昨日の話とつながったから。',
      sourceItemId: item.id, sourceTitle: item.sourceTitle, sourceURL: item.url,
      openingLine: '昨日の話と少しつながるものを見つけた。', createdAt: at, expiresAt: '2026-09-05T15:00:00.000Z',
    };
    const initiatives = new SQLiteInitiativeStore(path, () => at);

    expect(initiatives.runOnce(at, 'Asia/Tokyo', new Map([['owner', focus]]))).toMatchObject({ sent: 1 });
    expect(state.conversationHistory('owner', threadId).at(-1)?.content)
      .toContain('A small agent learns to remember');
    expect(state.conversationHistory('owner', threadId).at(-1)?.content).not.toContain('昨日の話');
    expect(state.conversationHistory('owner', threadId).at(-1)?.sourceAttribution)
      .toEqual({ title: 'Hacker News', url: 'https://example.com/focus', reason: 'ボクが気になったからです。' });

    initiatives.close();
    world.close();
    state.close();
  });

  it('stays quiet instead of sending a template when daily wording was not generated', () => {
    const path = databasePath();
    const at = '2026-09-05T04:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const initiatives = new SQLiteInitiativeStore(path, () => at);
    const focus: DailyMindFocus = {
      scopeKey: 'owner', dayKey: '2026-09-05', topic: '静かに考える', reason: '背景予算を使わないため。',
      createdAt: at, expiresAt: '2026-09-05T15:00:00.000Z',
    };

    expect(initiatives.runOnce(at, 'Asia/Tokyo', new Map([['owner', focus]])))
      .toEqual({ considered: 0, sent: 0, stopped: 'nothing-worth-saying' });
    expect(initiatives.unreadMessages('owner')).toEqual([]);

    initiatives.close();
    state.close();
  });

  it('does not attach a weather focus explanation to an unrelated news item', () => {
    const path = databasePath();
    const at = '2026-09-05T04:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    state.createThread('owner', 'いつものトーク');
    const world = new SQLiteWorldStore(path, () => at);
    const weather = world.dueSources(at).find(item => item.kind === 'weather')!;
    world.recordSuccess(weather, [{
      externalId: 'forecast', title: '東京地方: 今日 雨', url: weather.url,
      summary: '今日: 雨（降水確率 最大60%）',
    }], at);
    const news = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(news, [{
      externalId: 'unrelated', title: 'Unrelated software story', url: 'https://example.com/unrelated',
    }], at);
    const weatherItem = world.latestItems(10).find(item => item.sourceId === weather.id)!;
    const focus: DailyMindFocus = {
      scopeKey: 'owner', dayKey: '2026-09-05', topic: '東京の雨', reason: '今日は雨が続きそうだから。',
      sourceItemId: weatherItem.id, sourceTitle: weatherItem.sourceTitle, sourceURL: weatherItem.url,
      openingLine: '傘を持って出たほうがよさそう。', createdAt: at, expiresAt: '2026-09-05T15:00:00.000Z',
    };
    const initiatives = new SQLiteInitiativeStore(path, () => at);

    expect(initiatives.runOnce(at, 'Asia/Tokyo', new Map([['owner', focus]])))
      .toEqual({ considered: 1, sent: 0, stopped: 'nothing-worth-saying' });
    expect(initiatives.unreadMessages('owner')).toEqual([]);

    initiatives.close();
    world.close();
    state.close();
  });

  it('does not surface an old article as new when a feed is first discovered', () => {
    const path = databasePath();
    const at = '2026-09-05T04:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
    const world = new SQLiteWorldStore(path, () => at);
    const source = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(source, [{
      externalId: 'old-agent-story',
      title: 'AI agents from an old feed archive',
      url: 'https://example.com/old-agents',
      publishedAt: '2026-08-01T00:00:00.000Z',
    }], at);
    const initiatives = new SQLiteInitiativeStore(path, () => at);

    expect(initiatives.runOnce(at)).toEqual({
      considered: 0, sent: 0, stopped: 'nothing-worth-saying',
    });
    expect(initiatives.unreadMessages('owner')).toEqual([]);

    initiatives.close();
    world.close();
    state.close();
  });

  it.each(['not-a-date', '2099-01-01T00:00:00.000Z'])(
    'does not treat an invalid or implausibly future publication timestamp as fresh: %s',
    publishedAt => {
      const path = databasePath();
      const at = '2026-09-05T04:00:00.000Z';
      const state = new SQLiteShannonStore({ path, now: () => at });
      state.snapshot('owner');
      state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
      const world = new SQLiteWorldStore(path, () => at);
      const source = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
      world.recordSuccess(source, [{
        externalId: 'invalid-date-agent-story',
        title: 'AI agents with an invalid publication date',
        url: 'https://example.com/invalid-date-agents',
        publishedAt,
      }], at);
      const initiatives = new SQLiteInitiativeStore(path, () => at);

      expect(initiatives.runOnce(at)).toEqual({
        considered: 0, sent: 0, stopped: 'nothing-worth-saying',
      });

      initiatives.close();
      world.close();
      state.close();
    },
  );

  it('suppresses the same topic across sources and prefers a different source on the next day', () => {
    const path = databasePath();
    const firstDay = '2026-09-03T03:00:00.000Z';
    const secondDay = '2026-09-04T03:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => firstDay });
    state.snapshot('owner');
    state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
    state.createThread('owner', 'いつものトーク');
    const world = new SQLiteWorldStore(path, () => firstDay);
    const hackerNews = world.dueSources(firstDay).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(hackerNews, [{
      externalId: 'first-agent-memory',
      title: 'AI agents build durable memory from daily work',
      url: 'https://news.example.com/agent-memory?utm_source=hn',
      summary: 'A detailed report about agents learning durable memory from repeated daily work and feedback.',
    }], firstDay);
    const initiatives = new SQLiteInitiativeStore(path, () => firstDay);
    expect(initiatives.runOnce(firstDay)).toMatchObject({ sent: 1 });

    const arxiv = world.dueSources(firstDay).find(item => item.kind === 'arxiv')!;
    const pubmed = world.dueSources(firstDay).find(item => item.kind === 'pubmed')!;
    world.recordSuccess(arxiv, [{
      externalId: 'second-agent-memory',
      title: 'AI agents build durable memory from daily work — new study',
      url: 'https://papers.example.net/agent-memory',
      summary: 'A second publication describing the same durable-memory result for agents and daily work.',
    }], secondDay);
    world.recordSuccess(pubmed, [{
      externalId: 'agent-planning',
      title: 'AI agents plan safely under uncertainty',
      url: 'https://papers.example.net/agent-planning',
      summary: 'A substantive independent report about safe planning under uncertainty in autonomous agents.',
    }], secondDay);

    expect(initiatives.runOnce(secondDay)).toMatchObject({ sent: 1 });
    expect(initiatives.unreadMessages('owner').map(message => message.sourceURL)).toEqual([
      'https://news.example.com/agent-memory?utm_source=hn',
      'https://papers.example.net/agent-planning',
    ]);
    expect(initiatives.initiativeEvaluation(30, secondDay)).toMatchObject({
      repeatedCandidatesSuppressed: 1,
      deliveredBySource: [
        { sourceTitle: 'Hacker News', count: 1 },
        { sourceTitle: 'PubMed・AI', count: 1 },
      ],
    });

    initiatives.close();
    world.close();
    state.close();
  });

  it('rotates away from the immediately previous source when equally relevant alternatives exist', () => {
    const path = databasePath();
    const firstDay = '2026-09-03T03:00:00.000Z';
    const secondDay = '2026-09-04T03:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => firstDay });
    state.snapshot('owner');
    state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
    const world = new SQLiteWorldStore(path, () => firstDay);
    const hackerNews = world.dueSources(firstDay).find(item => item.kind === 'hacker-news')!;
    const arxiv = world.dueSources(firstDay).find(item => item.kind === 'arxiv')!;
    world.recordSuccess(hackerNews, [{
      externalId: 'day-one', title: 'AI agents learn memory', url: 'https://example.com/day-one',
      summary: 'A sufficiently detailed explanation of memory learning in autonomous AI agent systems.',
    }], firstDay);
    const initiatives = new SQLiteInitiativeStore(path, () => firstDay);
    expect(initiatives.runOnce(firstDay)).toMatchObject({ sent: 1 });
    world.recordSuccess(hackerNews, [{
      externalId: 'day-two-hn', title: 'AI agents coordinate tools', url: 'https://example.com/day-two-hn',
      summary: 'A sufficiently detailed explanation of tool coordination in autonomous AI agent systems.',
    }], secondDay);
    world.recordSuccess(arxiv, [{
      externalId: 'day-two-arxiv', title: 'AI agents verify plans', url: 'https://example.net/day-two-arxiv',
      summary: 'A sufficiently detailed explanation of plan verification in autonomous AI agent systems.',
    }], secondDay);

    expect(initiatives.runOnce(secondDay)).toMatchObject({ sent: 1 });
    expect(initiatives.unreadMessages('owner').at(-1)?.sourceTitle).toBe('arXiv・AI agents');

    initiatives.close();
    world.close();
    state.close();
  });

  it('does not surface a context-free item merely because its publisher is on a built-in list', () => {
    const path = databasePath();
    const at = '2026-09-03T03:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const world = new SQLiteWorldStore(path, () => at);
    const hackerNews = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(hackerNews, [{
      externalId: 'thin-story', title: 'New project', url: 'https://example.com/thin-story',
    }], at);
    const initiatives = new SQLiteInitiativeStore(path, () => at);

    expect(initiatives.runOnce(at)).toEqual({ considered: 1, sent: 0, stopped: 'nothing-worth-saying' });
    expect(initiatives.unreadMessages('owner')).toEqual([]);

    initiatives.close();
    world.close();
    state.close();
  });

  it('scores freshness from publication time rather than a late discovery time', () => {
    const path = databasePath();
    const at = '2026-09-03T03:00:00.000Z';
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    const world = new SQLiteWorldStore(path, () => at);
    const hackerNews = world.dueSources(at).find(item => item.kind === 'hacker-news')!;
    world.recordSuccess(hackerNews, [{
      externalId: 'late-discovery', title: 'A substantive but almost expired report',
      url: 'https://example.com/late-discovery',
      summary: 'This entry has enough context to pass the content check but was published almost two days ago.',
      publishedAt: '2026-09-01T04:00:00.000Z',
    }], at);
    const initiatives = new SQLiteInitiativeStore(path, () => at);

    expect(initiatives.runOnce(at)).toEqual({ considered: 1, sent: 0, stopped: 'nothing-worth-saying' });

    initiatives.close();
    world.close();
    state.close();
  });

  it('migrates evaluation databases created before repeat suppression was recorded', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE initiative_loop_runs (
        run_id TEXT PRIMARY KEY,
        considered INTEGER NOT NULL CHECK (considered >= 0),
        sent INTEGER NOT NULL CHECK (sent >= 0),
        stopped TEXT,
        occurred_at TEXT NOT NULL
      );
      INSERT INTO initiative_loop_runs (run_id, considered, sent, stopped, occurred_at)
      VALUES ('legacy-run', 3, 1, NULL, '2026-09-03T03:00:00.000Z');
    `);
    database.close();

    const initiatives = new SQLiteInitiativeStore(path, () => '2026-09-03T04:00:00.000Z');
    expect(initiatives.initiativeEvaluation()).toMatchObject({
      runs: 1,
      delivered: 1,
      repeatedCandidatesSuppressed: 0,
      deliveredBySource: [],
    });
    initiatives.close();
  });

  it('acknowledges only the initiative thread the user actually opened', () => {
    const path = databasePath();
    const initiatives = new SQLiteInitiativeStore(path, () => '2026-09-05T04:00:00.000Z');
    const database = new DatabaseSync(path);
    const insert = database.prepare(`
      INSERT INTO initiative_messages
        (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
         content, expression, day_key, created_at, read_at)
      VALUES (?, 'owner', ?, ?, 'Hacker News', 'https://example.com/story',
              '本文', 'curious', ?, ?, NULL)
    `);
    insert.run('initiative-a', 'thread-a', 'item-a', '2026-09-04', '2026-09-04T03:00:00.000Z');
    insert.run('initiative-b', 'thread-b', 'item-b', '2026-09-05', '2026-09-05T03:00:00.000Z');
    database.close();

    expect(initiatives.markRead('owner', 'thread-b')).toBe(1);
    expect(initiatives.unreadMessages('owner').map(message => message.threadId)).toEqual(['thread-a']);
    initiatives.close();
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-initiative-test-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}
