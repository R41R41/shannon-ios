import { OWNER_AUDIENCE } from '@shannon/cognition';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';

const at = '2026-09-30T03:00:00.000Z';
const directories: string[] = [];
const experienceIds = (hits: readonly { kind: string; id: string }[]) => hits.filter(hit => hit.kind === 'experience').map(hit => hit.id);
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-search-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

describe('experience full-text search', () => {
  it('finds long Japanese terms through FTS5 trigram and two-character terms through the substring fallback', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at });
    const thread = store.createThread('owner');
    const voice = store.appendTurn('owner', thread, '音声待機文の長さを短くしたい', '三秒を超える時だけ流そう', at);
    const photo = store.appendTurn('owner', thread, '写真を整理する手順を決めた', 'アルバムごとに分けよう', at);
    store.appendTurn('owner', thread, '朝食にパンを食べた', 'いいね', at);
    expect(experienceIds(store.searchMemory('owner', '待機文の話'))).toEqual([voice.id]);
    expect(experienceIds(store.searchMemory('owner', '写真'))).toEqual([photo.id]);
    expect(experienceIds(store.searchMemory('owner', '写真整理'))).toContain(photo.id);
    expect(store.searchMemory('other', '写真')).toEqual([]);
    expect(store.searchMemory('owner', 'の')).toEqual([]);
    store.close();
  });

  it('indexes rolling thread summaries, follows updates, and hides archived threads', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at });
    const thread = store.createThread('owner', '旅行計画');
    store.appendTurn('owner', thread, '行き先を相談', '候補を出すね', at, {
      capturedStateVersion: 0,
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' },
      threadSummary: '北海道旅行の日程を検討中',
    });
    expect(store.searchMemory('owner', '北海道旅行').map(hit => hit.id)).toContain(`thread:${thread}`);
    store.appendTurn('owner', thread, '行き先を変更', '了解', at, {
      capturedStateVersion: 0,
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' },
      threadSummary: '沖縄旅行に変更した',
    });
    expect(store.searchMemory('owner', '北海道旅行').map(hit => hit.id)).not.toContain(`thread:${thread}`);
    expect(store.searchMemory('owner', '沖縄旅行').map(hit => hit.id)).toContain(`thread:${thread}`);
    store.archiveThread('owner', thread);
    expect(store.searchMemory('owner', '沖縄旅行').map(hit => hit.id)).not.toContain(`thread:${thread}`);
    store.close();
  });

  it('backfills existing experiences when a v14 database is upgraded without changing history', () => {
    const path = databasePath();
    let store = new SQLiteShannonStore({ path, now: () => at });
    const old = store.appendTurn('owner', store.createThread('owner'), '古い設計判断の理由を残した', '記録したよ', at);
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TRIGGER memory_search_experience_insert; DROP TRIGGER memory_search_thread_insert;
      DROP TRIGGER memory_search_thread_update; DROP TABLE memory_search_fts; DROP TABLE memory_search_documents;
      PRAGMA user_version = 14;
    `);
    const messages = Number(legacy.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n);
    legacy.close();
    store = new SQLiteShannonStore({ path, now: () => at });
    expect(experienceIds(store.searchMemory('owner', '設計判断'))).toEqual([old.id]);
    const raw = new DatabaseSync(path);
    expect(Number(raw.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n)).toBe(messages);
    raw.close();
    store.close();
  });

  it('recalls an experience older than the recent candidate window but never a forgotten one', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => at, maximumExperiences: 10 });
    const thread = store.createThread('owner');
    const old = store.appendTurn('owner', thread, 'ペンギン水族館の年パスを買った', 'いいね', '2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 12; index += 1) store.appendTurn('owner', thread, `雑談${index}`, 'うん', at);
    expect(store.experienceCandidates('owner').map(item => item.id)).not.toContain(old.id);
    const context = () => prepareTurnCognitiveContext(store.snapshot('owner'), store, { present: OWNER_AUDIENCE,
      scopeKey: 'owner', message: 'ペンギン水族館ってどうだった？', occurredAt: at, channel: 'text', threadId: thread,
    });
    expect(context().frame.recalledMemoryIDs).toContain(old.id);
    const memory = new ShannonMemoryService(store, store, () => at);
    store.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: old.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
      changeReason: 'test', sourceEvidence: old.userMessage,
    } });
    expect(memory.dashboard('owner').items.find(item => item.id === old.id)?.status).toBe('forgotten');
    expect(context().frame.recalledMemoryIDs).not.toContain(old.id);
    expect(context().prompt).not.toContain('ペンギン');
    store.close();
  });

  it('answers through substring search when the runtime has no FTS5 trigram table', () => {
    const path = databasePath();
    let store = new SQLiteShannonStore({ path, now: () => at });
    const voice = store.appendTurn('owner', store.createThread('owner'), '音声待機文を短くしたい', 'うん', at);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER memory_search_fts_insert; DROP TRIGGER memory_search_fts_delete; DROP TRIGGER memory_search_fts_update; DROP TABLE memory_search_fts;');
    raw.close();
    store = new SQLiteShannonStore({ path, now: () => at });
    expect(experienceIds(store.searchMemory('owner', '音声待機文'))).toEqual([voice.id]);
    store.close();
  });

  it('keeps the in-memory store on the same term semantics', () => {
    const store = new InMemoryConversationStore();
    const thread = store.createThread('owner');
    const photo = store.appendTurn('owner', thread, '写真を整理する', 'うん', at);
    store.appendTurn('owner', thread, '音声待機文を短く', 'うん', at);
    expect(experienceIds(store.searchMemory('owner', '写真'))).toEqual([photo.id]);
  });
});
