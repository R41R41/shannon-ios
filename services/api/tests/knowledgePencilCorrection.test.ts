import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { consolidateSleepMemory, LocalRuleSleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const saidAt = '2026-09-30T02:00:00.000Z';
const correctedAt = '2026-09-30T03:00:00.000Z';
const sleepAt = '2026-09-30T18:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-pencil-'));
  directories.push(directory);
  let now = saidAt;
  const store = new SQLiteShannonStore({ path: join(directory, 'fixture.sqlite'), now: () => now });
  const kernel = createLocalApiKernel(() => now, {
    stateStore: store, conversationStore: store, knowledgeStore: store,
    memoryStore: new ShannonMemoryService(store, store, () => now, store),
  });
  const turn = store.appendTurn('owner', 'thread', '私は紅茶が好き。', '紅茶が好きなんですね。', saidAt);
  new TurnRefinementProcessor(store, store).process('owner', turn.userMessage, turn.id, saidAt);
  const fact = store.snapshot('owner').userFacts[0]!;
  return { store, kernel, turn, fact, setNow: (value: string) => { now = value; } };
}

describe('pencil correction in 覚えていること (TM-08)', () => {
  it('survives the same utterance and the next sleep batch as an authoritative owner correction', async () => {
    const { store, kernel, turn, fact, setNow } = fixture();
    setNow(correctedAt);
    const response = await kernel.dispatch({
      method: 'POST', path: '/v1/knowledge/correct',
      body: { scopeKey: 'owner', answerId: fact.id, answer: 'ユーザーはコーヒーが好き' },
    });
    expect(response.status).toBe(200);

    // The owner says the original sentence again in the same day.
    const repeated = store.appendTurn('owner', 'thread', '私は紅茶が好き。', 'そうでしたね。', correctedAt);
    new TurnRefinementProcessor(store, store).process('owner', repeated.userMessage, repeated.id, correctedAt);

    // The nightly batch reviews both utterances of that day.
    setNow(sleepAt);
    const outcome = await consolidateSleepMemory(new LocalRuleSleepMemoryAnalyzer(), [
      { content: turn.userMessage, observedAt: saidAt, sourceExperienceId: turn.id },
      { content: repeated.userMessage, observedAt: correctedAt, sourceExperienceId: repeated.id },
    ], store.snapshot('owner'), sleepAt);
    for (const item of outcome.facts) store.apply('owner', { type: 'user-fact-upserted', fact: item, source: 'sleep' });

    const answer = store.knowledgeAnswers('owner').find(item => item.answerId === fact.id);
    expect(answer?.answer).toBe('ユーザーはコーヒーが好き');
    expect(answer?.source).toBe('user');
    const control = store.snapshot('owner').memoryControls.find(item => item.memoryId === fact.id);
    expect(control).toMatchObject({ status: 'active', overrideText: 'ユーザーはコーヒーが好き' });
    const prompt = store.promptProjection('owner') ?? '';
    expect(prompt).toContain('コーヒー');
    expect(prompt).not.toContain('紅茶');
    const managed = new ShannonMemoryService(store, store, () => sleepAt, store).dashboard('owner')
      .items.find(item => item.id === fact.id);
    expect(managed?.text).toBe('ユーザーはコーヒーが好き');
    expect(store.knowledgeRevisions('owner', fact.id).map(item => item.nextAnswer)).toEqual(['ユーザーはコーヒーが好き']);
    store.close();
  });

  it('rejects an unknown answer and an oversized correction without changing memory', async () => {
    const { store, kernel, fact } = fixture();
    expect((await kernel.dispatch({ method: 'POST', path: '/v1/knowledge/correct',
      body: { scopeKey: 'owner', answerId: 'missing', answer: '別の内容' } })).status).toBe(404);
    expect((await kernel.dispatch({ method: 'POST', path: '/v1/knowledge/correct',
      body: { scopeKey: 'owner', answerId: fact.id, answer: 'あ'.repeat(321) } })).status).toBe(400);
    expect(store.knowledgeAnswers('owner').find(item => item.answerId === fact.id)?.answer).toBe('ユーザーは紅茶が好き');
    expect(store.snapshot('owner').memoryControls).toEqual([]);
    store.close();
  });
});
