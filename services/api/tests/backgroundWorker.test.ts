import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { DurableBackgroundDispatcher } from '../src/backgroundUpdates.js';
import { ShannonBackgroundWorker } from '../src/backgroundWorker.js';
import {
  consolidateUserFacts,
  LocalRuleSleepMemoryAnalyzer,
  OpenAISleepMemoryAnalyzer,
} from '../src/sleepConsolidation.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Shannon durable background worker', () => {
  it('keeps FCA fast and applies queued emotion only in the separate worker', async () => {
    const path = databasePath();
    const apiStore = new SQLiteShannonStore({ path, now: () => '2026-08-31T10:00:00.000Z' });
    const api = createLocalApiKernel(() => '2026-08-31T10:00:00.000Z', {
      stateStore: apiStore,
      conversationStore: apiStore,
      background: new DurableBackgroundDispatcher(apiStore, apiStore),
    });
    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '完成して嬉しい！' },
    });
    expect(response).toMatchObject({ status: 200, body: { snapshotVersion: 0 } });
    expect(apiStore.snapshot('owner-a')).toMatchObject({ version: 0, emotion: { valence: 0 } });
    expect(apiStore.pendingBackgroundJobCount()).toBe(1);
    apiStore.close();

    const workerStore = new SQLiteShannonStore({ path, now: () => '2026-08-31T10:00:01.000Z' });
    const worker = new ShannonBackgroundWorker(
      workerStore,
      workerStore,
      workerStore,
      new LocalRuleSleepMemoryAnalyzer(),
      { workerId: 'test-worker', now: () => new Date('2026-08-31T10:00:01.000Z') },
    );
    expect(await worker.runOnce()).toBe('processed');
    expect(workerStore.snapshot('owner-a')).toMatchObject({ version: 1, emotion: { valence: 0.14 } });
    expect(workerStore.pendingBackgroundJobCount()).toBe(0);
    workerStore.close();
  });

  it('captures directly stated preferences and relationship wishes in the first turn-refinement job', async () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: () => '2026-09-01T10:00:01.000Z' });
    store.appendTurn(
      'owner-a',
      '僕は水色が好き。結論から話してほしい。最近エージェント設計に興味がある。',
      '覚えておくね。',
      '2026-09-01T10:00:00.000Z',
    );
    const worker = new ShannonBackgroundWorker(
      store,
      store,
      store,
      new LocalRuleSleepMemoryAnalyzer(),
      { workerId: 'immediate-memory-worker', now: () => new Date('2026-09-01T10:00:01.000Z') },
    );

    expect(await worker.runOnce()).toBe('processed');

    const snapshot = store.snapshot('owner-a');
    expect(snapshot.userFacts).toEqual([
      expect.objectContaining({ statement: 'ユーザーは水色が好き', confidence: 0.72 }),
    ]);
    expect(snapshot.relationships).toEqual([
      expect.objectContaining({ statement: 'ユーザーはシャノンに結論から話してほしい', confidence: 0.72 }),
    ]);
    expect(snapshot.interests).toContain('エージェント設計');
    const dashboard = new (await import('../src/memoryService.js')).ShannonMemoryService(
      store, store, () => '2026-09-01T10:00:02.000Z',
    ).dashboard('owner-a');
    expect(dashboard.items.find(item => item.kind === 'user-fact')).toMatchObject({
      changeReason: '会話からすぐにユーザー理解を更新',
      evidence: [expect.objectContaining({ source: 'conversation' })],
    });
    store.close();
  });

  it('reclaims an expired lease without duplicating the job', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => '2026-08-31T00:00:00.000Z' });
    store.enqueueTurnRefinement('owner-a', 'turn-a', 'こんにちは', '2026-08-31T00:00:00.000Z');
    const first = store.claimNextBackgroundJob(
      'worker-a', '2026-08-31T00:00:00.000Z', '2026-08-31T00:01:00.000Z',
    );
    expect(first?.attempts).toBe(1);
    expect(store.claimNextBackgroundJob(
      'worker-b', '2026-08-31T00:00:30.000Z', '2026-08-31T00:02:00.000Z',
    )).toBeNull();
    const recovered = store.claimNextBackgroundJob(
      'worker-b', '2026-08-31T00:01:01.000Z', '2026-08-31T00:03:00.000Z',
    );
    expect(recovered).toMatchObject({ id: first?.id, attempts: 2 });
    store.close();
  });

  it('never leases two jobs for the same scope at the same time', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => '2026-08-31T00:00:00.000Z' });
    store.enqueueTurnRefinement('owner-a', 'turn-a1', '一件目', '2026-08-31T00:00:00.000Z');
    store.enqueueTurnRefinement('owner-a', 'turn-a2', '二件目', '2026-08-31T00:00:01.000Z');
    const first = store.claimNextBackgroundJob(
      'worker-a', '2026-08-31T00:00:02.000Z', '2026-08-31T00:01:00.000Z',
    );
    expect(first?.scopeKey).toBe('owner-a');
    expect(store.claimNextBackgroundJob(
      'worker-b', '2026-08-31T00:00:02.000Z', '2026-08-31T00:01:00.000Z',
    )).toBeNull();
    store.close();
  });

  it('rolls state effects back when a claimed job fails mid-transaction', () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => '2026-08-31T00:00:00.000Z' });
    store.enqueueTurnRefinement('owner-a', 'turn-a', '嬉しい', '2026-08-31T00:00:00.000Z');
    const job = store.claimNextBackgroundJob(
      'worker-a', '2026-08-31T00:00:01.000Z', '2026-08-31T00:01:00.000Z',
    );
    expect(job).not.toBeNull();
    expect(() => store.completeClaimedBackgroundJob(
      job!, 'worker-a', '2026-08-31T00:00:02.000Z', () => {
        store.apply('owner-a', { type: 'emotion-adjusted', delta: { valence: 0.4 } });
        throw new Error('SIMULATED_FAILURE');
      },
    )).toThrow('SIMULATED_FAILURE');
    expect(store.snapshot('owner-a').emotion.valence).toBe(0);
    store.close();
  });

  it('runs one sleep consolidation per local day and learns only explicit user facts', async () => {
    const store = new SQLiteShannonStore({ path: databasePath(), now: () => '2026-09-01T15:00:00.000Z' });
    store.appendTurn(
      'owner-a',
      '僕は青い照明が好き。落ち着くんだ。',
      '覚えておくね。',
      '2026-09-01T03:00:00.000Z',
    );
    const now = new Date('2026-09-01T18:30:00.000Z'); // 2026-09-02 03:30 JST
    const worker = new ShannonBackgroundWorker(
      store,
      store,
      store,
      new LocalRuleSleepMemoryAnalyzer(),
      { workerId: 'sleep-worker', timeZone: 'Asia/Tokyo', sleepHour: 3, now: () => now },
    );
    expect(await worker.runOnce()).toBe('processed'); // recovered turn refinement
    expect(store.snapshot('owner-a').userFacts).toEqual([
      expect.objectContaining({ statement: 'ユーザーは青い照明が好き', confidence: 0.72 }),
    ]);
    expect(await worker.runOnce()).toBe('processed'); // sleep consolidation
    expect(store.snapshot('owner-a').userFacts).toEqual([
      expect.objectContaining({ statement: 'ユーザーは青い照明が好き' }),
    ]);
    expect(store.snapshot('owner-a').userFacts[0]?.confidence).toBeCloseTo(0.8, 5);
    expect(store.events('owner-a').map(event => event.type)).toContain('sleep.completed');
    expect(await worker.runOnce()).toBe('idle');
    store.close();
  });

  it('recovers a turn saved immediately before an API process crash', async () => {
    const path = databasePath();
    const apiStore = new SQLiteShannonStore({ path, now: () => '2026-08-31T00:00:00.000Z' });
    apiStore.appendTurn('owner-a', '嬉しい！', 'よかった。', '2026-08-31T00:00:00.000Z');
    apiStore.close();

    const workerStore = new SQLiteShannonStore({ path, now: () => '2026-08-31T00:00:01.000Z' });
    const worker = new ShannonBackgroundWorker(
      workerStore,
      workerStore,
      workerStore,
      new LocalRuleSleepMemoryAnalyzer(),
      { workerId: 'recovery-worker', now: () => new Date('2026-08-31T00:00:01.000Z') },
    );
    expect(await worker.runOnce()).toBe('processed');
    expect(workerStore.snapshot('owner-a').emotion.valence).toBe(0.14);
    expect(workerStore.pendingBackgroundJobCount()).toBe(0);
    workerStore.close();
  });

  it('uses strict structured output for OpenAI sleep analysis', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const analyzer = new OpenAISleepMemoryAnalyzer({
      apiKey: 'test-key',
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            facts: [{ statement: 'ユーザーは猫が好き', evidence: '入力に存在しない証拠' }],
          }),
        }), { status: 200 });
      },
    });
    const proposals = await analyzer.analyze([{ content: '今日は晴れた', observedAt: '2026-08-31T00:00:00.000Z' }]);
    expect(proposals).toHaveLength(1);
    expect(requestBody).toMatchObject({
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
  });

  it('rejects a proposed fact when its evidence is absent from the transcript', async () => {
    const facts = await consolidateUserFacts(
      {
        mode: 'local-rules',
        analyze: async () => [{ statement: 'ユーザーは猫が好き', evidence: '入力に存在しない証拠' }],
      },
      [{ content: '今日は晴れた', observedAt: '2026-08-31T00:00:00.000Z' }],
      createInitialCompanionState('owner-a', '2026-08-31T00:00:00.000Z'),
      '2026-09-01T00:00:00.000Z',
    );
    expect(facts).toEqual([]);
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-worker-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'shannon.sqlite');
}
