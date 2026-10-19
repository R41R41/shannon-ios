import { describe, expect, it } from 'vitest';
import {
  PROMISE_ON_TIME_BOUNDARY, PROMISE_SLOT_BOUNDARY, buildCompanionStatePrompt, createInitialCompanionState, promiseStanding, promiseTopic,
  promiseWithDate, type CompanionStateSnapshot, type ProspectiveMemory,
} from '@shannon/cognition';
import { matchPromise } from '../src/mind/action/respond/promiseRules.js';
import { commitmentFactSentence, commitmentFacts } from '../src/mind/action/respond/commitmentLine.js';
import { reminderCapabilityBoundary } from '../src/mind/action/respond/reminderCapability.js';
import { closeToldRequests, commitmentItemId } from '../src/mind/action/respond/commitmentInitiative.js';

/** 「明日の9:20に起こして」, said on 2026-10-13 21:58 JST. */
const SAID = '2026-10-13T12:58:00.000Z';
const DUE = '2026-10-14T00:20:00.000Z';
const wake = (extra: Partial<ProspectiveMemory> = {}): ProspectiveMemory => ({
  id: 'p1', summary: '明日の9:20に起こして', status: 'pending', createdAt: SAID, updatedAt: SAID, dueAt: DUE, dueDate: '2026-10-14',
  timeZone: 'Asia/Tokyo', ...extra,
});
const withPromises = (items: ProspectiveMemory[]): CompanionStateSnapshot => ({ ...createInitialCompanionState('owner', SAID), prospectiveMemories: items });

describe('a promise is worded by what it is about and the date it meant (owner 2026-10-19)', () => {
  it('drops the day it was said with, and turns a relative day into its date', () => {
    expect(promiseTopic('明日の9:20に起こして')).toBe('起こして');
    expect(promiseTopic('明日プレゼンの練習しよう')).toBe('プレゼンの練習しよう');
    expect(promiseTopic('薬を飲む')).toBe('薬を飲む');
    expect(promiseWithDate('明日の9:20に起こして', '2026-10-14')).toBe('10月14日の9:20に起こして');
    expect(promiseWithDate('薬を飲む', '2026-10-14')).toBe('薬を飲む');
  });

  it('tells the notice by what it is about, its time beside it', () => {
    const at = '2026-10-14T00:20:30.000Z';
    expect(commitmentFactSentence(commitmentFacts({ title: '明日の9:20に起こして', published_at: DUE }, at, 'Asia/Tokyo', false))).toBe('9時20分の約束：「起こして」');
  });

  it('stands upcoming, due for a few hours after its time, then past', () => {
    expect(promiseStanding(wake(), '2026-10-13T23:00:00.000Z')).toBe('upcoming');
    expect(promiseStanding(wake(), '2026-10-14T01:07:00.000Z')).toBe('due');
    expect(promiseStanding(wake(), '2026-10-15T11:00:00.000Z')).toBe('past');
    expect(promiseStanding({ dueDate: '2026-10-14' }, '2026-10-15T03:00:00.000Z')).toBe('past');
  });

  it('is no longer an open promise in her prompt once long past, and says so while just past', () => {
    const state = withPromises([wake()]);
    expect(buildCompanionStatePrompt(state, { now: '2026-10-13T13:30:00.000Z' })).toContain('- 10月14日の9:20に起こして [');
    expect(buildCompanionStatePrompt(state, { now: '2026-10-14T01:07:00.000Z' })).toContain('（時刻は過ぎた。済んだかは分からない）');
    expect(buildCompanionStatePrompt(state, { now: '2026-10-15T11:00:00.000Z' })).toContain('未完了の約束・未来記憶: なし');
  });
});

describe('what is and is not a promise (owner 2026-10-19)', () => {
  it('does not take his own plan for the talk as a promise', () => {
    expect(matchPromise('今日はそれで会話終わりにする')).toBeNull();
    expect(matchPromise('今日はこの話はもう終わりにする')).toBeNull();
    expect(matchPromise('明日プレゼンの練習しよう')).not.toBeNull();
    expect(matchPromise('明日の9:20に起こして')).not.toBeNull();
  });

  it('says what she will do at a clock time when promises are told at their time', () => {
    expect(reminderCapabilityBoundary('明日の9:20に起こして', SAID, true)).toBe(PROMISE_ON_TIME_BOUNDARY);
    expect(reminderCapabilityBoundary('明日の9:20に起こして', SAID, false)).toBe(PROMISE_SLOT_BOUNDARY);
    expect(PROMISE_ON_TIME_BOUNDARY).toContain('phone alarm');
  });
});

describe('a wake-up she told him is kept, and closed (owner 2026-10-19)', () => {
  it('closes a told request hours after its time, and nothing else', () => {
    const plan: ProspectiveMemory = { id: 'p2', summary: '明日プレゼンの練習しよう', status: 'pending', createdAt: SAID, updatedAt: SAID, dueDate: '2026-10-14',
      timeZone: 'Asia/Tokyo' };
    let state = withPromises([wake(), plan]);
    const applied: string[] = [];
    const store = { snapshot: () => state, apply: (_scope: string, event: { memoryId: string }) => {
      applied.push(event.memoryId);
      state = { ...state, prospectiveMemories: state.prospectiveMemories.map(item => item.id === event.memoryId ? { ...item, status: 'completed' as const } : item) };
    } };
    const told = new Set([commitmentItemId(wake())]);
    // Within the hours after its time a 「あとで」 may still re-arm it: nothing is closed yet.
    expect(closeToldRequests(store, 'owner', '2026-10-14T01:07:00.000Z', (_scope, item) => told.has(item))).toEqual([]);
    expect(closeToldRequests(store, 'owner', '2026-10-14T09:00:00.000Z', (_scope, item) => told.has(item))).toEqual(['p1']);
    expect(applied).toEqual(['p1']);
    // Not told: not closed.
    state = withPromises([wake()]);
    expect(closeToldRequests(store, 'owner', '2026-10-14T09:00:00.000Z', () => false)).toEqual([]);
    // Review of the heart branch: a request for more than the notice of the time (a result to tell) is never closed by the notice.
    const result = wake({ id: 'p3', summary: '明日の9:20に結果を教えて' });
    state = withPromises([result]);
    expect(closeToldRequests(store, 'owner', '2026-10-14T09:00:00.000Z', () => true)).toEqual([]);
  });

  it('keeps the head of a noun and a day\'s 「中」 out of what is cut (review of the heart branch)', () => {
    expect(promiseTopic('夜景を見に行く')).toBe('夜景を見に行く');
    expect(promiseTopic('明日朝食を作る')).toBe('朝食を作る');
    expect(promiseTopic('今日中に資料をまとめる')).toBe('資料をまとめる');
    expect(promiseTopic('明日の朝に起こして')).toBe('起こして');
  });
});
