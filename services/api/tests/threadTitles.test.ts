import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { DurableBackgroundDispatcher } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import type { ChatResponse } from '../src/contracts.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

class ControlledChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly pending: Array<{ resolve: (result: ShannonChatModelResult) => void; reject: (error: Error) => void }> = [];
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  reply(
    threadTitle: string | undefined = '京都の週末旅行',
    threadSummary: string | undefined = '京都への週末旅行を計画中。庭園を巡る案が出ている。',
  ) {
    this.pending.shift()!.resolve({
      mode: this.mode, model: this.model, reply: '京都で庭園を巡ろう。', threadTitle, threadSummary,
    });
  }
}

describe.each(['memory', 'sqlite'] as const)('%s automatic thread titles', kind => {
  function fixture() {
    const now = () => '2026-09-05T00:00:00.000Z';
    const directory = kind === 'sqlite' ? mkdtempSync(join(tmpdir(), 'shannon-title-')) : undefined;
    const store = directory
      ? new SQLiteShannonStore({ path: join(directory, 'test.sqlite'), now })
      : new InMemoryConversationStore();
    cleanup.push(() => {
      if (store instanceof SQLiteShannonStore) store.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const model = new ControlledChatModel();
    const api = createLocalApiKernel(now, {
      conversationStore: store, chatModel: model,
      ...(store instanceof SQLiteShannonStore ? {
        stateStore: store, background: new DurableBackgroundDispatcher(store, store),
      } : {}),
    });
    const create = async (title?: string) => {
      const result = await api.dispatch({ method: 'POST', path: '/v1/threads', body: { scopeKey: 'owner', title } });
      return (result.body as { threadId: string }).threadId;
    };
    const send = (threadId?: string) => api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId, message: '週末、京都に旅行したい' },
    });
    const rename = (threadId: string, title: string) => api.dispatch({
      method: 'POST', path: '/v1/threads/title', body: { scopeKey: 'owner', threadId, title },
    });
    return { api, store, model, create, send, rename };
  }

  it('replaces the default only after the first user/assistant pair commits and returns it immediately', async () => {
    const { api, store, model, create, send } = fixture();
    const threadId = await create();
    const pending = send(threadId);
    expect(model.requests[0]).toMatchObject({ generateThreadTitle: true, history: [], message: '週末、京都に旅行したい' });
    expect(store.listThreads('owner')[0]).toMatchObject({ title: '新しいトーク', messageCount: 0 });
    model.reply();
    expect(await pending).toMatchObject({ status: 200, body: {
      reply: '京都で庭園を巡ろう。',
      thread: {
        threadId, title: '京都の週末旅行', messageCount: 2,
        summary: '京都への週末旅行を計画中。庭園を巡る案が出ている。',
      },
    } });
    expect(store.conversationHistory('owner', threadId).map(item => item.role)).toEqual(['user', 'assistant']);
    expect(await api.dispatch({ method: 'GET', path: '/v1/threads', query: new URLSearchParams({ scopeKey: 'owner' }) }))
      .toMatchObject({ body: { threads: [expect.objectContaining({ title: '京都の週末旅行' })] } });
    const second = send(threadId);
    expect(model.requests[1]?.generateThreadTitle).toBe(false);
    expect(model.requests[1]?.priorThreadSummary)
      .toBe('京都への週末旅行を計画中。庭園を巡る案が出ている。');
    model.reply('別のタイトル');
    expect(await second).toMatchObject({ body: { thread: { title: '京都の週末旅行', messageCount: 4 } } });
    await api.waitForBackground('owner');
  });

  it.each(['保存したタイトル', '新しいトーク'])('protects the explicit title %s before and during a reply', async title => {
    const { api, model, create, send, rename } = fixture();
    const custom = await create(title);
    const customSend = send(custom);
    expect(model.requests[0]?.generateThreadTitle).toBe(false);
    model.reply();
    expect(await customSend).toMatchObject({ body: { thread: { title } } });

    const threadId = await create();
    const pending = send(threadId);
    expect(model.requests[1]?.generateThreadTitle).toBe(true);
    expect(await rename(threadId, title)).toMatchObject({ status: 200 });
    model.reply();
    expect(await pending).toMatchObject({ body: { thread: { title } } });
    const next = send(threadId);
    expect(model.requests[2]?.generateThreadTitle).toBe(false);
    model.reply();
    expect(await next).toMatchObject({ body: { thread: { title } } });
    await api.waitForBackground('owner');
  });

  it('allows manual edits after automatic generation without affecting another thread or scope', async () => {
    const { api, store, model, create, send, rename } = fixture();
    const first = await create();
    const second = await create();
    const pending = send(first);
    model.reply();
    await pending;
    await rename(first, '旅のメモ');
    expect(store.renameThread('someone-else', first, '上書き')).toBe(false);
    const later = send(first);
    model.reply();
    expect(await later).toMatchObject({ body: { thread: { title: '旅のメモ' } } });
    expect(store.listThreads('owner').find(thread => thread.threadId === second)?.title).toBe('新しいトーク');
    await api.waitForBackground('owner');
  });

  it('returns a bounded latest-reply summary and Markdown sections for navigation', async () => {
    const { store, create } = fixture();
    const threadId = await create('Mac版の相談');
    store.appendTurn(
      'owner',
      threadId,
      '今どこまでできている？',
      '# 現在地\n作業と会話を接続しました。\n```swift\n# コード内\n```\n## 次にやること\n横断検索を追加します。',
      '2026-09-05T00:01:00.000Z',
    );

    expect(store.listThreads('owner')[0]).toMatchObject({
      threadId,
      summary: '現在地 作業と会話を接続しました。 次にやること 横断検索を追加します。',
      sections: ['現在地', '次にやること'],
    });
  });

  it('updates the rolling summary on later turns and keeps deterministic fallback', async () => {
    const { store, create } = fixture();
    const threadId = await create('Mac版の相談');
    store.appendTurn(
      'owner', threadId, '設計を始めよう', 'まず画面構成を決めます。', '2026-09-05T00:01:00.000Z',
    );
    expect(store.listThreads('owner')[0]?.summary).toBe('まず画面構成を決めます。');

    store.appendTurn(
      'owner', threadId, '実装まで進めて', '検索を実装しました。', '2026-09-05T00:02:00.000Z',
      {
        threadSummary: 'Mac版を実装中。画面構成が決まり、検索まで完了。次は実接続を確認する。',
        capturedStateVersion: 1,
        messageEmotion: {
          valence: 0.2, arousal: 0.4, openness: 0.7, expression: 'curious',
        },
      },
    );
    expect(store.listThreads('owner')[0]?.summary)
      .toBe('Mac版を実装中。画面構成が決まり、検索まで完了。次は実接続を確認する。');
  });

  it('leaves a failed first turn untitled and generates on retry, including implicit threads', async () => {
    const { api, store, model, send } = fixture();
    const failed = send();
    const rejection = expect(failed).rejects.toThrow('provider unavailable');
    model.pending.shift()!.reject(new Error('provider unavailable'));
    await rejection;
    expect(store.listThreads('owner').every(thread => thread.title === '新しいトーク' && thread.messageCount === 0)).toBe(true);
    const retry = send();
    expect(model.requests[1]?.generateThreadTitle).toBe(true);
    model.reply();
    expect(await retry).toMatchObject({ body: { thread: { title: '京都の週末旅行' } } });
    await api.waitForBackground('owner');
  });

  it('keeps the first committed title when two first-turn requests overlap', async () => {
    const { api, model, create, send } = fixture();
    const threadId = await create();
    const first = send(threadId);
    const second = send(threadId);
    model.reply('最初に保存された話題');
    await first;
    model.reply('遅れて届いた話題');
    expect(await second).toMatchObject({ body: { thread: { title: '最初に保存された話題' } } });
    await api.waitForBackground('owner');
  });

  it('falls back to a bounded user excerpt when title metadata is absent', async () => {
    const { api, model, send } = fixture();
    const pending = send();
    model.reply('   ');
    const result = (await pending).body as ChatResponse;
    expect(result.reply).toBe('京都で庭園を巡ろう。');
    expect(result.thread?.title).toBe('週末、京都に旅行したい');
    await api.waitForBackground('owner');
  });
});
