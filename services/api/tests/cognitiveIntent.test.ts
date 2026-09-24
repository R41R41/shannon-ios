import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import {
  extractExplicitUserIntent,
  InMemoryCognitiveIntentStore,
  SQLiteCognitiveIntentStore,
} from '../src/cognitiveIntent.js';
import type { ShannonChatModelRequest } from '../src/chatModel.js';

const at = '2026-09-25T03:00:00.000Z';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('durable cognitive intentions', () => {
  it('extracts only explicit goals and ignores vague continuations or negation', () => {
    expect(extractExplicitUserIntent('シャノンを一貫した人格として感じられるように改善したい。', 'thread-a', at))
      .toMatchObject({ status: 'active', threadId: 'thread-a' });
    expect(extractExplicitUserIntent('引き続きお願いします', 'thread-a', at)).toBeNull();
    expect(extractExplicitUserIntent('引き続き進めてください', 'thread-a', at)).toBeNull();
    expect(extractExplicitUserIntent('その機能は実装したくない', 'thread-a', at)).toBeNull();
  });

  it('deduplicates active goals and persists owner-visible cycle receipts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-intents-'));
    directories.push(directory);
    const store = new SQLiteCognitiveIntentStore(join(directory, 'shannon.sqlite'));
    const first = extractExplicitUserIntent('目標はシャノンの人格をもっと自然にする', 'thread-a', at)!;
    const saved = store.capture('owner', first, 'experience-a');
    store.capture('owner', { ...first, id: 'duplicate', updatedAt: '2026-09-25T04:00:00.000Z' }, 'experience-b');
    expect(store.list('owner', 'active')).toHaveLength(1);
    const frame = { situation: { occurredAt: at, channel: 'text' as const }, primaryIntent: saved,
      supportingIntentIDs: [], recalledMemoryIDs: ['memory-a'], responseMode: 'answer' as const };
    store.recordCycle('owner', frame, { threadId: 'thread-a', channel: 'text', recalledMemoryIDs: ['memory-a'],
      action: 'respond', outcome: 'completed', summary: '返答した', occurredAt: at });
    expect(store.recentCycles('owner')).toEqual([expect.objectContaining({ primaryIntentID: saved.id, recalledMemoryIDs: ['memory-a'] })]);
    expect(store.updateStatus('owner', saved.id, 'completed', at)?.status).toBe('completed');
    store.close();
  });

  it('uses one intention frame in consecutive text turns and exposes its audit projection', async () => {
    const requests: ShannonChatModelRequest[] = [];
    const cognitiveIntents = new InMemoryCognitiveIntentStore();
    const api = createLocalApiKernel(() => at, {
      cognitiveIntents,
      chatModel: { mode: 'local-stub', model: 'test', generate: async request => {
        requests.push(request); return { mode: 'local-stub', model: 'test', reply: '進めよう' };
      } },
    });
    const first = await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner', threadId: 'thread-a', message: 'シャノンを一貫した人格として感じられるように改善したい。',
    } });
    expect(first.status).toBe(200);
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner', threadId: 'thread-a', message: 'その方針で続けて',
    } });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.systemPrompt).toContain('[Current intention frame');
    expect(requests[1]?.systemPrompt).toContain('シャノンを一貫した人格');
    expect(api.realtimeVoiceSession('owner', 'thread-a').instructions).toContain('シャノンを一貫した人格');
    expect(api.realtimeVoiceSession('owner', 'thread-a', { participantMode: 'guest' }).instructions).not.toContain('シャノンを一貫した人格');
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner', threadId: 'thread-a', transcript: '今の目標を踏まえて次を考えて',
    } });
    expect(requests[2]?.systemPrompt).toContain('シャノンを一貫した人格');
    const projection = await api.dispatch({ method: 'GET', path: '/v1/cognition', query: new URLSearchParams({ scopeKey: 'owner' }) });
    expect(projection).toMatchObject({ status: 200, body: { intents: [expect.objectContaining({ status: 'active' })] } });
    expect((projection.body as { recentCycles: unknown[] }).recentCycles).toHaveLength(3);
  });
});
