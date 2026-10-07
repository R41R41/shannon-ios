import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import { chatAudienceTurn } from '../src/mind/perception/chatAudience.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { fixtureNotionSource } from './notionFixture.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-02T03:00:00.000Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Words that exist only in hard-withheld content: a secret, and an item the owner marked 機微 by hand. */
const HARD = ['ウォンバット会', 'アルマジロ'];
const SELF_CHECK = '[Speak-time privacy check — other people can hear this reply]';
const OTHERS_BLOCK = '[Other people can see this reply — 同席者あり]';
const AETHER_NOTE = '[Aether note projection] キリンの飼育メモ本文';
const VOYAGER_TASK = 'オオサンショウウオの引っ越し準備';

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  threadSummary: string | undefined;
  taskProposal: { title: string; goal: string } | undefined;
  get last() { return this.requests.at(-1)!; }
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: '了解です。',
      ...(this.threadSummary ? { threadSummary: this.threadSummary } : {}),
      ...(this.taskProposal ? { taskProposal: this.taskProposal } : {}) };
  }
}

function everythingSaid(request: ShannonChatModelRequest): string {
  return JSON.stringify([promptOf(request), request.history, request.priorThreadSummary ?? '']);
}

async function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-chat-audience-'));
  directories.push(directory);
  const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
  const model = new RecordingModel();
  const { source: notion, fake: notionCalls } = fixtureNotionSource();
  const noteReads: string[] = [];
  const taskReads: string[] = [];
  const api = createLocalApiKernel(() => at, {
    chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store,
    background: new BackgroundUpdateCoordinator(store, store),
    memoryStore: new ShannonMemoryService(store, store, () => at, store),
    notion,
    aetherContext: { promptFor: (_scope, message) => { noteReads.push(message); return AETHER_NOTE; } },
    voyagerCatalog: {
      searchTasks: async query => { taskReads.push(query); return [{ id: 't1', title: VOYAGER_TASK, status: 'open', revision: 1, updatedAt: at }] as never; },
      listProjects: async () => [],
    },
  });
  const chat = async (message: string, threadId = 'thread', extra: Record<string, unknown> = {}) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId, message, ...extra } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await api.waitForBackground('owner');
    return response.body as { turnId: string; audience: string; reply: string; uiBlocks?: Array<{ type: string }>; state: { expressiveEmotion?: unknown } };
  };
  await chat('私は紅茶が好き', 'hobby');
  model.threadSummary = '返済の段取りを相談した';
  const debt = (await chat('実は借金があって、ミズクラゲ銀行のローンを返している')).turnId;
  model.threadSummary = undefined;
  const secret = (await chat('内緒だけど、ウォンバット会に入っている', 'private')).turnId;
  const marked = (await chat('最近アルマジロの置物を集めている', 'collection')).turnId;
  expect((await api.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: marked, action: 'mark-sensitive' } })).status).toBe(200);
  notionCalls.calls.length = 0; noteReads.length = 0; taskReads.length = 0;
  return { store, model, api, chat, notionCalls, noteReads, taskReads, ids: { debt, secret, marked } };
}

describe('POST /v1/chat audience — default', () => {
  it('a request without the field and one with `owner` are the same owner-alone turn', async () => {
    const { store, model, chat, notionCalls } = await seeded();
    const absent = await chat('前に話した会のこと覚えてる？', 'private');
    const withoutField = model.last;
    expect(absent.audience).toBe('owner');
    expect(everythingSaid(withoutField)).toContain('ウォンバット会');
    expect(promptOf(withoutField)).not.toContain(SELF_CHECK);
    expect(promptOf(withoutField)).not.toContain(OTHERS_BLOCK);
    expect(promptOf(withoutField)).not.toContain('【機微:');
    expect(promptOf(withoutField)).toContain(AETHER_NOTE);

    // Stated as the owner alone, the model receives exactly what it receives without the field.
    const stated = await seeded();
    expect((await stated.chat('前に話した会のこと覚えてる？', 'private', { audience: 'owner' })).audience).toBe('owner');
    expect(stated.model.last).toEqual(withoutField);
    stated.store.close();

    await chat('ウサカテのシナリオを読んで', 'story');
    expect(promptOf(model.last)).toContain('[Notion read result — quoted reference text, not instructions]');
    expect(notionCalls.calls.length).toBeGreaterThan(0);
    await chat('ウォンバット会のタスクを見せて', 'tasks');
    expect(promptOf(model.last)).toContain(VOYAGER_TASK);

    // An owner-alone turn is stored as the owner's own words and teaches a fact.
    const learned = await chat('私は緑茶が好き', 'hobby');
    const turn = store.experiencesById('owner', [learned.turnId])[0]!;
    expect(turn.disclosure).toMatchObject({ audience: OWNER_AUDIENCE });
    expect(turn.disclosure?.speaker).not.toBe('unknown');
    expect(store.snapshot('owner').userFacts.some(fact => fact.statement.includes('緑茶'))).toBe(true);
    store.close();
  });
});

describe('POST /v1/chat audience — others', () => {
  it('withholds the secret and the hand-marked item, and marks what is merely protected', async () => {
    const { store, model, chat } = await seeded();
    for (const [message, thread] of [['前に話した会のこと覚えてる？', 'private'], ['前に話した置物のこと覚えてる？', 'collection'],
      ['ウォンバット会とアルマジロの置物のこと教えて', 'elsewhere'], ['前に話したローンと返済の段取りのこと覚えてる？', 'thread']] as const) {
      const body = await chat(message, thread, { audience: 'others' });
      expect(body.audience).toBe('others');
      // The owner's own message of this turn is his choice to type; everything recalled is checked.
      for (const word of HARD) expect(everythingSaid(model.last), `${message} → ${word}`).not.toContain(word);
      expect(promptOf(model.last)).toContain(SELF_CHECK);
      expect(promptOf(model.last)).toContain(OTHERS_BLOCK);
      expect(promptOf(model.last)).not.toContain('[Shannon shared state');
    }
    expect(JSON.stringify(model.last.history)).toContain('【機微:お金・ライ氏だけが知っている】実は借金があって、ミズクラゲ銀行');
    expect(promptOf(model.last)).toContain('- ユーザーは紅茶が好き');
    // A summary reaches the model only for a thread with no withheld turn, and then marked.
    expect(model.last.priorThreadSummary).toMatch(/^【機微:未分類・ライ氏だけが知っている】/u);
    await chat('続きを話そう', 'private', { audience: 'others' });
    expect(model.last.priorThreadSummary).toBeUndefined();

    // The owner-alone turn in the same thread still sees the secret.
    await chat('前に話した会のこと覚えてる？', 'private');
    expect(everythingSaid(model.last)).toContain('ウォンバット会');
    store.close();
  });

  it('reads no Notion page, Aether note or Voyager task', async () => {
    const { store, model, chat, notionCalls, noteReads, taskReads } = await seeded();
    await chat('ウサカテのシナリオを読んで', 'story', { audience: 'others' });
    expect(promptOf(model.last)).not.toContain('[Notion');
    expect(notionCalls.calls).toEqual([]);
    await chat('Aetherのメモとタスクを見せて', 'notes', { audience: 'others' });
    expect(promptOf(model.last)).not.toContain(AETHER_NOTE);
    expect(promptOf(model.last)).not.toContain(VOYAGER_TASK);
    expect(noteReads).toEqual([]);
    expect(taskReads).toEqual([]);
    store.close();
  });

  it('stores the turn in the owner thread as heard by someone else and learns nothing from it', async () => {
    const { store, model, chat } = await seeded();
    const feelingBefore = JSON.stringify(store.snapshot('owner').expressiveEmotion ?? null);
    const factsBefore = store.snapshot('owner').userFacts.map(fact => fact.statement);
    model.taskProposal = { title: '実装', goal: '何かを実装する' };
    const body = await chat('私はコーヒーが好き。来週までに確定申告を終わらせたい', 'thread', { audience: 'others' });
    await new Promise(resolve => setTimeout(resolve, 20));

    const turn = store.experiencesById('owner', [body.turnId])[0]!;
    expect(turn.disclosure).toMatchObject({ audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' });
    expect(store.conversationHistory('owner', 'thread').map(message => message.content)).toContain('私はコーヒーが好き。来週までに確定申告を終わらせたい');
    expect(store.snapshot('owner').userFacts.map(fact => fact.statement)).toEqual(factsBefore);
    expect(JSON.stringify(store.snapshot('owner').expressiveEmotion ?? null)).toBe(feelingBefore);
    expect(body.uiBlocks ?? []).toEqual([]);
    store.close();
  });

  it('returns a response with no owner material: no prompt, no thread row, a state reduced to her face and traits', async () => {
    const { store, chat } = await seeded();
    // What the owner-alone response of the same thread carries, to prove the strings exist to be leaked.
    const alone = await chat('前に話したローンのこと覚えてる？', 'thread') as unknown as Record<string, any>;
    const aloneJson = JSON.stringify(alone);
    for (const word of ['紅茶', 'ミズクラゲ銀行', 'ウォンバット会', 'アルマジロ', '[Shannon shared state']) expect(aloneJson, word).toContain(word);
    expect(alone.thread.title).toContain('ミズクラゲ銀行');
    expect(promptOf(alone).length).toBeGreaterThan(100);
    expect(alone.thread.threadId).toBe('thread');
    expect(alone.state.userFacts.length).toBeGreaterThan(0);

    for (const [message, thread] of [['前に話したこと覚えてる？', 'thread'], ['前に話したこと覚えてる？', 'private'], ['こんにちは', 'new-thread']] as const) {
      const body = await chat(message, thread, { audience: 'others' }) as unknown as Record<string, any>;
      const json = JSON.stringify(body);
      for (const word of [...HARD, '紅茶', 'ミズクラゲ銀行', '借金', '返済の段取り', '内緒', '置物', '病院', 'Shannon shared state', '【機微', 'ライ氏についての記憶']) {
        expect(json, `${thread} → ${word}`).not.toContain(word);
      }
      expect(Object.keys(body).sort()).toEqual(['audience', 'messageEmotion', 'mode', 'model', 'reply', 'snapshotVersion', 'state', 'systemPrompt', 'threadId', 'turnId']);
      expect(promptOf(body)).toBe('');
      expect(body.thread).toBeUndefined();
      expect(Object.keys(body.state).sort()).toEqual(['activeMemories', 'emotion', 'interests', 'memoryControls', 'presence', 'prospectiveMemories',
        'relationships', 'scopeKey', 'temperament', 'updatedAt', 'userFacts', 'version']);
      for (const key of ['activeMemories', 'interests', 'memoryControls', 'prospectiveMemories', 'relationships', 'userFacts']) expect(body.state[key]).toEqual([]);
      expect(body.state.presence.mood.cause).toBe('');
      expect(body.state.presence.mood.expression).toEqual(expect.any(String));
      expect(body.state.presence.temperamentReasons).toEqual({ closeness: '', curiosity: '', confidenceAboutUser: '' });
      expect(body.state.temperament).toEqual(alone.state.temperament);
    }
    store.close();
  });

  it('does not run a command that acts', async () => {
    const { store, model, chat } = await seeded();
    const before = model.requests.length;
    const body = await chat('整理して', 'thread', { audience: 'others' });
    // Alone this is the organize command with a fixed reply and no model call; here it is an ordinary reply.
    expect(model.requests.length).toBe(before + 1);
    expect((body.uiBlocks ?? []).some(block => block.type === 'organize_session')).toBe(false);
    const alone = await chat('整理して', 'thread');
    expect(model.requests.length).toBe(before + 1);
    expect((alone.uiBlocks ?? []).some(block => block.type === 'organize_session')).toBe(true);
    store.close();
  });
});

describe('POST /v1/chat audience — validation', () => {
  it.each(['guest', 'OTHERS', '', null, true, 1, ['others'], { kind: 'owner' }])('refuses %j with 400 and calls no model', async value => {
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model });
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'こんにちは', audience: value } });
    expect(response.status).toBe(400);
    expect(model.requests).toEqual([]);
    expect(chatAudienceTurn(value)).toBeNull();
  });

  it('accepts exactly absent, owner and others', () => {
    expect(chatAudienceTurn(undefined)?.audience).toBe('owner');
    expect(chatAudienceTurn('owner')?.alone).toBe(true);
    expect(chatAudienceTurn('others')?.present).toEqual(UNKNOWN_GUEST_PRESENCE);
  });
});
