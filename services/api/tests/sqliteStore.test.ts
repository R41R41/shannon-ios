import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

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
  it('restores shared state, conversation, message emotion, and experiences after reopen', () => {
    const path = databasePath();
    const now = sequenceClock();
    const first = new SQLiteShannonStore({ path, now });
    first.apply('owner-a', { type: 'emotion-adjusted', delta: { valence: 0.4, arousal: 0.2 } });
    const expected = first.apply('owner-a', { type: 'interest-observed', interest: '脳科学' });
    first.appendTurn('owner-a', '脳科学の続きを話そう', 'うん、続きを聞かせて。', now(), {
      capturedStateVersion: expected.version,
      messageEmotion: { valence: 0.4, arousal: 0.5, openness: 0.35, expression: 'curious' },
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
        state: { version: 1 },
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
