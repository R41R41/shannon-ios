import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `返答${this.requests.length}` };
  }
}

describe('SQLite Shannon persistence', () => {
  it('persists automatic titles and manual protection, including the default wording, after reopen', () => {
    const path = databasePath();
    const now = sequenceClock();
    const first = new SQLiteShannonStore({ path, now });
    const automatic = first.createThread('owner');
    const manual = first.createThread('owner');
    const pending = first.createThread('owner');
    first.renameThread('owner', manual, '新しいトーク');
    first.appendTurn('owner', automatic, '旅行の相談', '京都を歩こう', now(), {
      capturedStateVersion: 0,
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' },
      threadTitle: '京都の散歩',
    });
    first.close();

    const reopened = new SQLiteShannonStore({ path, now });
    expect(reopened.needsAutomaticThreadTitle('owner', automatic)).toBe(false);
    expect(reopened.needsAutomaticThreadTitle('owner', manual)).toBe(false);
    expect(reopened.needsAutomaticThreadTitle('owner', pending)).toBe(true);
    reopened.appendTurn('owner', manual, 'タイトルを変えない', 'うん', now());
    expect(reopened.listThreads('owner')).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: automatic, title: '京都の散歩', messageCount: 2 }),
      expect.objectContaining({ threadId: manual, title: '新しいトーク', messageCount: 2 }),
    ]));
    reopened.close();
  });

  it('migrates v7 additively and repeatedly without guessing whether legacy default titles were manual', () => {
    const path = databasePath();
    const now = sequenceClock();
    const oldStore = new SQLiteShannonStore({ path, now });
    const defaultThread = oldStore.createThread('owner', '新しいトーク');
    const namedThread = oldStore.createThread('owner', '保存したタイトル');
    oldStore.appendTurn('owner', namedThread, '残す会話', 'シャノンの返事', now());
    oldStore.apply('owner', { type: 'interest-observed', interest: '旅行' });
    const snapshot = oldStore.snapshot('owner');
    const history = oldStore.conversationHistory('owner', namedThread);
    const events = oldStore.events('owner');
    const threads = oldStore.listThreads('owner');
    oldStore.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('ALTER TABLE conversation_threads DROP COLUMN title_origin; PRAGMA user_version = 7;');
    legacy.close();

    for (let restart = 0; restart < 2; restart += 1) {
      const migrated = new SQLiteShannonStore({ path, now });
      expect(migrated.listThreads('owner')).toEqual(threads);
      expect(migrated.conversationHistory('owner', namedThread)).toEqual(history);
      expect(migrated.events('owner')).toEqual(events);
      expect(migrated.snapshot('owner')).toEqual(snapshot);
      expect(migrated.needsAutomaticThreadTitle('owner', defaultThread)).toBe(false);
      migrated.close();
    }
  });

  it('rolls back a generated title if the assistant message cannot be persisted', () => {
    const path = databasePath();
    const now = sequenceClock();
    const store = new SQLiteShannonStore({ path, now });
    const threadId = store.createThread('owner');
    const database = new DatabaseSync(path);
    database.exec(`CREATE TRIGGER fail_assistant BEFORE INSERT ON conversation_messages
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
    expect(() => store.appendTurn('owner', threadId, 'ユーザーの発言', 'シャノンの返答', now())).toThrow('test write failure');
    expect(store.listThreads('owner')[0]).toMatchObject({ title: '新しいトーク', messageCount: 0 });
    expect(store.needsAutomaticThreadTitle('owner', threadId)).toBe(true);
    expect(store.events('owner')).toHaveLength(0);
    database.close();
    store.close();
  });

  it('restores shared state, conversation, message emotion, and experiences after reopen', () => {
    const path = databasePath();
    const now = sequenceClock();
    const first = new SQLiteShannonStore({ path, now });
    first.apply('owner-a', { type: 'emotion-adjusted', delta: { valence: 0.4, arousal: 0.2 } });
    const expected = first.apply('owner-a', { type: 'interest-observed', interest: '脳科学' });
    const threadId = first.createThread('owner-a', 'テスト');
    first.appendTurn('owner-a', threadId, '脳科学の続きを話そう', 'うん、続きを聞かせて。', now(), {
      capturedStateVersion: expected.version,
      messageEmotion: { valence: 0.4, arousal: 0.5, openness: 0.35, expression: 'curious' },
      taskDecision: { disposition: 'propose', reason: '明示的な改修依頼' },
      artifacts: [{
        name: 'plan.md', mimeType: 'text/markdown', content: '# Plan\n', summary: '実装計画',
      }],
    });
    expect(first.events('owner-a').map(event => event.type)).toEqual([
      'state.initialized',
      'state.emotion-adjusted',
      'state.interest-observed',
      'turn.completed',
    ]);
    first.close();

    const reopened = new SQLiteShannonStore({ path, now });
    expect(reopened.snapshot('owner-a')).toMatchObject({
      version: 2,
      emotion: { valence: 0.4, arousal: 0.5 },
      interests: ['脳科学'],
    });
    expect(reopened.history('owner-a')).toEqual([
      { role: 'user', content: '脳科学の続きを話そう' },
      { role: 'assistant', content: 'うん、続きを聞かせて。' },
    ]);
    expect(reopened.conversationHistory('owner-a')[1]).toMatchObject({
      role: 'assistant',
      messageEmotion: { expression: 'curious' },
      stateVersion: 2,
      taskDecision: { disposition: 'propose', reason: '明示的な改修依頼' },
      artifacts: [{
        name: 'plan.md', mimeType: 'text/markdown', content: '# Plan\n', summary: '実装計画',
      }],
    });
    expect(reopened.experienceCandidates('owner-a')).toEqual([
      expect.objectContaining({ summary: expect.stringContaining('脳科学の続きを話そう') }),
    ]);
    reopened.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps persisted scopes and event streams isolated', () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: sequenceClock() });
    store.apply('owner-a', { type: 'interest-observed', interest: '創作' });
    store.apply('owner-b', { type: 'interest-observed', interest: '料理' });

    expect(store.snapshot('owner-a').interests).toEqual(['創作']);
    expect(store.snapshot('owner-b').interests).toEqual(['料理']);
    expect(store.events('owner-a').every(event => event.scopeKey === 'owner-a')).toBe(true);
    expect(store.events('owner-b').every(event => event.scopeKey === 'owner-b')).toBe(true);
    store.close();
  });

  it('does not write an event or projection for a no-op shared-state update', () => {
    const path = databasePath();
    const now = sequenceClock();
    const store = new SQLiteShannonStore({ path, now });
    const first = store.apply('owner-a', { type: 'interest-observed', interest: '創作' });
    const eventsAfterFirst = store.events('owner-a');
    const projectionAfterFirst = store.promptProjection('owner-a');

    const duplicate = store.apply('owner-a', { type: 'interest-observed', interest: '創作' });

    expect(duplicate).toEqual(first);
    expect(store.events('owner-a')).toEqual(eventsAfterFirst);
    expect(store.promptProjection('owner-a')).toBe(projectionAfterFirst);
    store.close();
  });

  it('bounds structurally malformed persisted state instead of restoring unsafe values', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: () => '2026-09-05T00:00:00.000Z' });
    first.snapshot('owner-a');
    first.close();
    const database = new DatabaseSync(path);
    database.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run(JSON.stringify({
      scopeKey: 'owner-a',
      version: 8,
      updatedAt: 'invalid',
      temperament: { curiosity: 99 },
      emotion: { valence: -99 },
      interests: ['  創作  ', null],
      userFacts: [{ id: 'fact', statement: '  水色が好き ', confidence: 4, observedAt: 'invalid' }],
      activeMemories: [{ id: 'memory', summary: '  過去の会話 ', relevance: 7, observedAt: 'invalid' }],
    }), 'owner-a');
    database.close();

    const reopened = new SQLiteShannonStore({ path, now: () => '2026-09-05T01:00:00.000Z' });
    expect(reopened.snapshot('owner-a')).toMatchObject({
      version: 8,
      updatedAt: '2026-09-05T01:00:00.000Z',
      temperament: { curiosity: 1, calmness: 0.6 },
      emotion: { valence: -1, arousal: 0.3 },
      interests: ['創作'],
      userFacts: [{ id: 'fact', statement: '水色が好き', confidence: 1 }],
      activeMemories: [{ id: 'memory', summary: '過去の会話', relevance: 1 }],
      relationships: [],
      memoryControls: [],
    });
    reopened.close();
  });

  it('keeps histories isolated between threads while sharing the owner state', () => {
    const path = databasePath();
    const now = sequenceClock();
    const store = new SQLiteShannonStore({ path, now });
    const firstThread = store.createThread('owner-a', '創作');
    const secondThread = store.createThread('owner-a', '旅行');

    store.appendTurn('owner-a', firstThread, '小説の続きを考えたい', '続きを考えよう。', now());
    store.appendTurn('owner-a', secondThread, '京都へ行きたい', '季節も考えよう。', now());
    store.apply('owner-a', { type: 'interest-observed', interest: '散歩' });

    expect(store.conversationHistory('owner-a', firstThread).map(message => message.content)).toEqual([
      '小説の続きを考えたい', '続きを考えよう。',
    ]);
    expect(store.conversationHistory('owner-a', secondThread).map(message => message.content)).toEqual([
      '京都へ行きたい', '季節も考えよう。',
    ]);
    expect(store.listThreads('owner-a').map(thread => thread.threadId)).toEqual([secondThread, firstThread]);
    expect(store.snapshot('owner-a').interests).toEqual(['散歩']);
    store.close();
  });

  it('archives one thread without deleting its messages or selecting it again', () => {
    const path = databasePath();
    const now = sequenceClock();
    const store = new SQLiteShannonStore({ path, now });
    const firstThread = store.createThread('owner-a', '残す');
    const archivedThread = store.createThread('owner-a', 'しまう');
    store.appendTurn('owner-a', archivedThread, 'あとで読む', '保管しておくね。', now());

    expect(store.archiveThread('owner-a', archivedThread)).toBe(true);
    expect(store.listThreads('owner-a').map(item => item.threadId)).toEqual([firstThread]);
    expect(store.threadId('owner-a')).toBe(firstThread);
    store.close();
    const database = new DatabaseSync(path);
    const retained = database.prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE thread_id = ?').get(archivedThread) as { count: number };
    expect(Number(retained.count)).toBe(2);
    database.close();
  });

  it('persists a renamed thread across database reopen', () => {
    const path = databasePath();
    const now = sequenceClock();
    const first = new SQLiteShannonStore({ path, now });
    const threadId = first.createThread('owner-a', '仮のタイトル');

    expect(first.renameThread('owner-a', threadId, '保存したタイトル')).toBe(true);
    first.close();

    const reopened = new SQLiteShannonStore({ path, now });
    expect(reopened.listThreads('owner-a')).toEqual([
      expect.objectContaining({ threadId, title: '保存したタイトル' }),
    ]);
    reopened.close();
  });

  it('migrates a schema v2 conversation into one legacy thread without losing messages', () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE companion_states (
        scope_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE conversation_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        metadata_json TEXT
      );
      INSERT INTO conversation_messages
        (message_id, scope_key, turn_id, ordinal, role, content, observed_at, metadata_json)
      VALUES
        ('m1', 'owner-a', 'turn-1', 0, 'user', '消してはいけない会話', '2026-08-30T00:00:00.000Z', NULL),
        ('m2', 'owner-a', 'turn-1', 1, 'assistant', '覚えているよ', '2026-08-30T00:00:01.000Z', NULL);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new SQLiteShannonStore({ path, now: () => '2026-09-02T00:00:00.000Z' });
    const threads = migrated.listThreads('owner-a');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadId).toBe('legacy:owner-a');
    expect(migrated.conversationHistory('owner-a', threads[0]?.threadId).map(message => message.content)).toEqual([
      '消してはいけない会話', '覚えているよ',
    ]);
    migrated.close();
  });

  it('projects user facts into categorized QA knowledge with evidence and revisions', () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: sequenceClock() });
    store.apply('owner-a', {
      type: 'user-fact-upserted',
      source: 'conversation',
      fact: {
        id: 'favorite-food',
        statement: 'ユーザーの好きな食べ物は寿司',
        confidence: 0.95,
        observedAt: '2026-09-02T00:00:00.000Z',
        evidence: '好きな食べ物は寿司',
      },
    });
    expect(store.knowledgeAnswers('owner-a')).toEqual([
      expect.objectContaining({
        answerId: 'favorite-food',
        questionKey: 'preference.food',
        category: '趣味嗜好',
        question: '好きな食べ物は？',
        answer: 'ユーザーの好きな食べ物は寿司',
        source: 'conversation',
        confirmed: true,
        evidence: [expect.objectContaining({ quote: '好きな食べ物は寿司' })],
      }),
    ]);

    store.apply('owner-a', {
      type: 'user-fact-upserted',
      source: 'sleep',
      fact: {
        id: 'favorite-food',
        statement: 'ユーザーの好きな食べ物はカレー',
        confidence: 0.8,
        observedAt: '2026-09-03T00:00:00.000Z',
        evidence: '最近はカレーが好き',
      },
    });
    expect(store.knowledgeRevisions('owner-a', 'favorite-food')).toEqual([
      expect.objectContaining({
        previousAnswer: 'ユーザーの好きな食べ物は寿司',
        nextAnswer: 'ユーザーの好きな食べ物はカレー',
      }),
    ]);
    expect(store.promptProjection('owner-a')).toContain('ユーザーの好きな食べ物はカレー');

    store.correctKnowledge('owner-a', 'favorite-food', 'ユーザーの好きな食べ物は蕎麦', '2026-09-04T00:00:00.000Z');
    expect(store.promptProjection('owner-a')).toContain('ユーザーの好きな食べ物は蕎麦');
    expect(store.knowledgeAnswers('owner-a')[0]).toMatchObject({ source: 'user', confirmed: true, confidence: 1 });
    store.close();
  });

  it('persists token usage by lane and calculates the background monthly spend', () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: sequenceClock() });
    store.recordLlmUsage({
      scopeKey: 'owner-a', lane: 'chat', model: 'gpt-5.6-luna', inputTokens: 100,
      cachedInputTokens: 20, outputTokens: 30, totalTokens: 130,
      estimatedCostUsd: 0.000056, occurredAt: '2026-09-02T00:00:00.000Z',
    });
    store.recordLlmUsage({
      scopeKey: 'owner-a', lane: 'sleep', model: 'gpt-5.6-luna', inputTokens: 500,
      cachedInputTokens: 0, outputTokens: 100, totalTokens: 600,
      estimatedCostUsd: 0.00022, occurredAt: '2026-09-03T00:00:00.000Z',
    });
    store.recordLlmUsage({
      scopeKey: 'owner-a', lane: 'voice', model: 'gpt-transcribe', inputTokens: 0,
      cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: 0.000075, occurredAt: '2026-09-03T00:01:00.000Z',
    });
    expect(store.llmUsageSummary('owner-a', '2026-09')).toEqual([
      expect.objectContaining({ lane: 'chat', calls: 1, totalTokens: 130 }),
      expect.objectContaining({ lane: 'sleep', calls: 1, totalTokens: 600 }),
      expect.objectContaining({ lane: 'voice', calls: 1, estimatedCostUsd: 0.000075 }),
    ]);
    expect(store.backgroundLlmCostUsd('2026-09')).toBeCloseTo(0.00022, 9);
    expect(store.backgroundLlmCostUsdForDay('2026-09-03')).toBeCloseTo(0.00022, 9);
    expect(store.backgroundLlmCostUsdForDay('2026-09-02')).toBe(0);
    store.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
    database.close();
  });

  it('atomically reserves the Realtime daily allowance and releases failed call attempts', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: sequenceClock() });
    const request = {
      scopeKey: 'owner-a',
      dayKey: '2026-09-11',
      reservedSeconds: 600,
      dailyLimitSeconds: 1_200,
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    const firstReservation = first.reserveRealtimeVoiceSession(request);
    const secondReservation = first.reserveRealtimeVoiceSession({
      ...request, createdAt: '2026-09-11T00:10:00.000Z',
    });
    expect(firstReservation?.remainingSeconds).toBe(600);
    expect(secondReservation?.remainingSeconds).toBe(0);
    expect(first.reserveRealtimeVoiceSession(request)).toBeNull();
    expect(first.realtimeVoiceReservedSecondsForDay('owner-a', '2026-09-11')).toBe(1_200);
    expect(first.reserveRealtimeVoiceSession({ ...request, scopeKey: 'owner-b' })).not.toBeNull();

    first.releaseRealtimeVoiceSessionReservation(secondReservation!.reservationId);
    expect(first.realtimeVoiceReservedSecondsForDay('owner-a', '2026-09-11')).toBe(600);
    expect(first.reserveRealtimeVoiceSession({
      ...request, createdAt: '2026-09-11T00:20:00.000Z',
    })?.remainingSeconds).toBe(0);
    first.close();

    const reopened = new SQLiteShannonStore({ path, now: sequenceClock() });
    expect(reopened.realtimeVoiceReservedSecondsForDay('owner-a', '2026-09-11')).toBe(1_200);
    expect(reopened.realtimeVoiceReservedSecondsForDay('owner-a', '2026-09-12')).toBe(0);
    reopened.close();
  });

  it('adds auditable same-day Realtime allowance without deleting reservations', () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: sequenceClock() });
    const dayKey = '2026-09-19';
    const request = {
      scopeKey: 'owner-a', dayKey, reservedSeconds: 600, dailyLimitSeconds: 3_600,
      createdAt: '2026-09-19T03:00:00.000Z',
    };
    for (let index = 0; index < 6; index += 1) {
      expect(store.reserveRealtimeVoiceSession({
        ...request, createdAt: `2026-09-19T03:${String(index * 10).padStart(2, '0')}:00.000Z`,
      })).not.toBeNull();
    }
    expect(store.reserveRealtimeVoiceSession(request)).toBeNull();
    expect(store.realtimeVoiceAllowanceStatus('owner-a', dayKey, 3_600)).toMatchObject({
      reservedSeconds: 3_600, additionalAllowanceSeconds: 0, remainingSeconds: 0,
    });

    const extended = store.extendRealtimeVoiceAllowance(
      'owner-a', dayKey, 3_600, 3_600, 86_400, '2026-09-19T04:00:00.000Z',
    );
    expect(extended).toMatchObject({
      baseAllowanceSeconds: 3_600,
      additionalAllowanceSeconds: 3_600,
      totalAllowanceSeconds: 7_200,
      reservedSeconds: 3_600,
      remainingSeconds: 3_600,
    });
    expect(store.realtimeVoiceReservedSecondsForDay('owner-a', dayKey)).toBe(3_600);
    expect(store.realtimeVoiceAllowanceStatus('owner-b', dayKey, 3_600)).toMatchObject({
      additionalAllowanceSeconds: 0, remainingSeconds: 3_600,
    });
    store.close();

    const reopened = new SQLiteShannonStore({ path, now: sequenceClock() });
    expect(reopened.realtimeVoiceAllowanceStatus('owner-a', dayKey, 3_600)).toMatchObject({
      additionalAllowanceSeconds: 3_600, reservedSeconds: 3_600, remainingSeconds: 3_600,
    });
    reopened.close();
  });

  it('migrates v8 LLM usage to the voice lane without losing existing cost history', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: sequenceClock() });
    first.recordLlmUsage({
      scopeKey: 'owner-a', lane: 'chat', model: 'gpt-5.6-luna', inputTokens: 10,
      cachedInputTokens: 0, outputTokens: 5, totalTokens: 15,
      estimatedCostUsd: 0.00001, occurredAt: '2026-09-05T00:00:00.000Z',
    });
    first.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE llm_usage_events RENAME TO llm_usage_events_with_voice;
      CREATE TABLE llm_usage_events (
        usage_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('chat', 'sleep')),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
        occurred_at TEXT NOT NULL
      );
      INSERT INTO llm_usage_events SELECT * FROM llm_usage_events_with_voice;
      DROP TABLE llm_usage_events_with_voice;
      CREATE INDEX llm_usage_events_month_lane ON llm_usage_events (occurred_at, lane);
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = new SQLiteShannonStore({ path, now: sequenceClock() });
    expect(migrated.llmUsageSummary('owner-a', '2026-09')).toEqual([
      expect.objectContaining({ lane: 'chat', calls: 1, totalTokens: 15 }),
    ]);
    migrated.recordLlmUsage({
      scopeKey: 'owner-a', lane: 'voice', model: 'gpt-transcribe', inputTokens: 0,
      cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: 0.000075, occurredAt: '2026-09-05T00:01:00.000Z',
    });
    expect(migrated.llmUsageSummary('owner-a', '2026-09')).toEqual([
      expect.objectContaining({ lane: 'chat', calls: 1, totalTokens: 15 }),
      expect.objectContaining({ lane: 'voice', calls: 1, estimatedCostUsd: 0.000075 }),
    ]);
    migrated.close();
  });

  it('migrates v9 conversation threads to optional rolling summaries without losing history', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: sequenceClock() });
    const threadId = first.createThread('owner-a', '既存トーク');
    first.appendTurn(
      'owner-a', threadId, '今どこ？', '検索まで完了しました。', '2026-09-05T00:00:00.000Z',
    );
    first.close();

    const legacy = new DatabaseSync(path);
    // A real v9 database predates the v15 search triggers that reference the summary column.
    legacy.exec('DROP TRIGGER memory_search_thread_insert; DROP TRIGGER memory_search_thread_update; ALTER TABLE conversation_threads DROP COLUMN summary; PRAGMA user_version = 9;');
    legacy.close();

    const migrated = new SQLiteShannonStore({ path, now: sequenceClock() });
    expect(migrated.conversationHistory('owner-a', threadId).map(item => item.content))
      .toEqual(['今どこ？', '検索まで完了しました。']);
    expect(migrated.listThreads('owner-a')[0]).toMatchObject({
      threadId,
      title: '既存トーク',
      summary: '検索まで完了しました。',
    });
    migrated.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
    expect(database.prepare("PRAGMA table_info('conversation_threads')").all())
      .toContainEqual(expect.objectContaining({ name: 'summary' }));
    database.close();
  });

  it('migrates v10 with a restart-safe Realtime allowance ledger', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: sequenceClock() });
    const threadId = first.createThread('owner-a', '残すトーク');
    first.appendTurn('owner-a', threadId, '残して', '残します', '2026-09-10T00:00:00.000Z');
    first.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE realtime_voice_session_reservations; PRAGMA user_version = 10;');
    legacy.close();

    const migrated = new SQLiteShannonStore({ path, now: sequenceClock() });
    expect(migrated.conversationHistory('owner-a', threadId).map(item => item.content))
      .toEqual(['残して', '残します']);
    expect(migrated.reserveRealtimeVoiceSession({
      scopeKey: 'owner-a',
      dayKey: '2026-09-11',
      reservedSeconds: 600,
      dailyLimitSeconds: 3_600,
      createdAt: '2026-09-11T00:00:00.000Z',
    })?.remainingSeconds).toBe(3_000);
    migrated.close();

    const database = new DatabaseSync(path);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
    expect(database.prepare("PRAGMA table_info('realtime_voice_session_reservations')").all())
      .toContainEqual(expect.objectContaining({ name: 'reserved_seconds' }));
    database.close();
  });

  it('continues FCA history after an API process restart and reacts on the current icon', async () => {
    const path = databasePath();
    const now = sequenceClock();
    const firstStore = new SQLiteShannonStore({ path, now });
    const firstModel = new RecordingChatModel();
    const firstApi = createLocalApiKernel(now, {
      stateStore: firstStore,
      conversationStore: firstStore,
      chatModel: firstModel,
    });
    const first = await firstApi.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '完成して嬉しい！' },
    });
    expect(first).toMatchObject({
      status: 200,
      body: { messageEmotion: { expression: 'tender' } },
    });
    await firstApi.waitForBackground('owner-a');
    firstStore.close();

    const secondStore = new SQLiteShannonStore({ path, now });
    const secondModel = new RecordingChatModel();
    const secondApi = createLocalApiKernel(now, {
      stateStore: secondStore,
      conversationStore: secondStore,
      chatModel: secondModel,
    });
    const conversation = await secondApi.dispatch({
      method: 'GET',
      path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(conversation).toMatchObject({
      status: 200,
      body: {
        messages: [
          { role: 'user', content: '完成して嬉しい！' },
          { role: 'assistant', content: '返答1', messageEmotion: { expression: 'tender' } },
        ],
        state: { version: 2 },
      },
    });
    await secondApi.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'さっきの続き' },
    });
    expect(secondModel.requests[0]?.history).toEqual([
      { role: 'user', content: '完成して嬉しい！' },
      { role: 'assistant', content: '返答1' },
    ]);
    await secondApi.waitForBackground('owner-a');
    secondStore.close();
  });

  it('migrates schema v1 without replaying background effects already applied by the old API', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: () => '2026-08-31T00:00:00.000Z' });
    const threadId = first.createThread('owner-a', '旧DB移行');
    first.appendTurn('owner-a', threadId, '完成して嬉しい！', 'よかった。', '2026-08-31T00:00:00.000Z');
    first.apply('owner-a', { type: 'emotion-adjusted', delta: { valence: 0.14 } });
    first.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE background_jobs; PRAGMA user_version = 1;');
    legacy.close();

    const migrated = new SQLiteShannonStore({ path, now: () => '2026-08-31T00:01:00.000Z' });
    expect(migrated.recoverUnqueuedTurnRefinements('2026-08-31T00:01:00.000Z')).toBe(0);
    expect(migrated.pendingBackgroundJobCount()).toBe(0);
    expect(migrated.snapshot('owner-a').emotion.valence).toBe(0.14);
    migrated.close();
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-sqlite-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'shannon.sqlite');
}

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-08-31T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}
